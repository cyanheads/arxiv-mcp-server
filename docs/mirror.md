# Local mirror

For self-hosted deployments behind a single egress IP, arXiv's ~3-second crawl delay serializes concurrent users. The optional local mirror removes that rate-limit exposure for `arxiv_search_papers` and `arxiv_get_metadata` by serving them from a SQLite + FTS5 store harvested via OAI-PMH. It is disabled by default; the `ARXIV_MIRROR_*` variables in the README's [Configuration](../README.md#configuration) table control it.

## Setup

```sh
# 1. Cold-start harvest (~4.4h sequential). One-time per installation.
#    Waits out arXiv outages; Ctrl+C stops it, and a rerun resumes from its checkpoint.
bun run mirror:init

# 2. Enable the mirror.
export ARXIV_MIRROR_ENABLED=true

# 3. Start the server — reads switch to the mirror once the harvest completes.
bun run start:http
```

From an npm install, the `mirror:*` commands belong to the package rather than your project: run them in the package directory (`bun run --cwd node_modules/@cyanheads/arxiv-mcp-server mirror:init`), or run a script directly from your project root (`bun node_modules/@cyanheads/arxiv-mcp-server/scripts/arxiv-mirror-init.ts`). Set `ARXIV_MIRROR_PATH` to an absolute path outside `node_modules`, the same one the server reads, so a reinstall leaves the mirror in place.

## Keeping it current

Run `bun run mirror:refresh` on a schedule (cron, systemd, launchd), or set `ARXIV_MIRROR_REFRESH_CRON` to refresh in-process in HTTP mode. Check the file with `bun run mirror:verify`.

An interrupted refresh picks up on the next run at the last datestamp it checkpointed, re-reading that day. When the in-process refresh runs out of its `ARXIV_MIRROR_REFRESH_TIMEOUT_MS` budget before leaving the day it started on, the next run resumes where it stopped instead.

## Schema upgrades

When a release changes the mirror's schema, the server answers from the live API until a writer migrates the file in place; there is no re-harvest. With `ARXIV_MIRROR_REFRESH_CRON` in HTTP mode the server starts that refresh itself; otherwise run `bun run mirror:refresh` or `bun run mirror:verify`.

One writer migrates the file at a time. A mirror command started meanwhile changes nothing and exits 75, naming the process that holds the migration; run it again once that finishes.

Cost on a full-size mirror (v5 → v6 estimated, see below):

| Migration | What it does | Time | Peak WAL | File growth |
|:---|:---|:---|:---|:---|
| v3 → v4 | Adds a column to the category table, fills it, rebuilds five date indexes | ~5 min | ~450 MB | ~9% |
| v4 → v5 | Rewrites each paper whose text holds `&#39;` or `&#34;` with the quote characters (about 1.2M of 3.2M papers), then rebuilds the category index searches use | 4.5–7.5 min, depending on host load | ~160 MB | ~10% |
| v5 → v6 | Converts TeX accents, letters, greek, and symbols in titles, authors, abstracts, comments, and journal refs to Unicode, as the arXiv API serves them (about a quarter of papers) | ~3 min estimated; plan for up to ~8 | ~50 MB measured | ~6% measured |

The v5 → v6 row is not a full-size measurement. Its basis: on one unbiased OAI page of 1,300 records (datestamp 2026-10-20), 330 rows change. A v5 file built from that page and replicated with distinct IDs to 130,000 and 390,000 rows migrates in 6.7–7.3 s and 22.8 s, about 56–59 µs per row scanned (about 230 µs per row rewritten), with the WAL peaking at 43–50 MB and the file growing 5.8%. At that slope ~3.2M papers take about 3 minutes. The replicas repeat one page's vocabulary, so their FTS index is smaller than a real mirror's and each rewrite there touches fewer index pages; v5's rewrite of 1.2M rows in 4.5–7.5 min bounds the plausible range above.

Rolling back to 1.7.1 or earlier and refreshing stores those character references again in each paper the refresh rewrites. After rolling forward, run `UPDATE schema_version SET version = 4` on the file and then `bun run mirror:verify` to repeat the repair. Likewise, a release before schema v6 (1.8.0 or earlier) that refreshes a v6 file stores TeX again in each paper it rewrites; after rolling forward, run `UPDATE schema_version SET version = 5` and then `bun run mirror:verify` to repeat the conversion.

## How mirror answers differ from the live API

- **Paper text is always live.** `arxiv_read_paper` fetches the body from arXiv (full-content harvesting is against arXiv's data policy). It takes metadata from the mirror only when the live lookup fails or, for an ID without a version, is still pending after `ARXIV_API_TIMEOUT_MS`. It then reads the stored version, which can trail arXiv's latest until the next refresh.
- **Metadata text matches the live API, with two exceptions.** The mirror converts TeX and splits author lists with arXiv's own rules, so titles, authors, abstracts, comments, journal references, and dates read as the live API returns them. A `, Jr.` suffix stays with its name on the mirror (`James F. Leathrum, Jr.`), where the API returns `James F. Leathrum,`. A paper cross-listed under both codes of an alias pair (`math.NA` and `cs.NA`, `math-ph` and `math.MP`, `math.ST` and `stat.TH`) lists both in `categories` on the mirror and one live.
- **Relevance ranking.** Mirror search ranks with FTS5 BM25, so `sort_by=relevance` returns a different top set than the live API.
- **Counts.** A search with no free-text term counts exactly when it filters on one category code. One that spans several codes (`cat:cs`, two categories) or a submitted-date window alone stops counting at 50,000; a total that reaches it carries `totalFoundIsLowerBound: true`, meaning 50,000 or more.
- **Names in an unprefixed or `all:` phrase.** The mirror matches a quoted phrase's words in order, and across the whole author list; arXiv matches a name inside one author's name, in any order. `"hinton geoffrey"` finds 59 papers live and none on the mirror. Search names with `au:`, which agrees on both paths.
- **Searches that go to the live API instead:**
  - `sort_by=submitted` descending, while `ARXIV_MIRROR_RECENT_DAYS_LIVE` is positive
  - free-text terms that match 50,000 or more papers
  - a `cat:` or `submittedDate:` operand the mirror cannot apply as a filter (joined to the rest by `OR` or by a space, or on the right of an `ANDNOT`), or a query left with only `ANDNOT` terms once those operands are taken out
  - unbalanced parentheses, a field prefix with no value (`ti: x`, `ti:`), an empty quoted phrase, or nothing left to match (`()`)
  - an `rn:`, `id:`, or `lastUpdatedDate:` operand, or a malformed `submittedDate:`
  - a word arXiv's index drops (`of`, `the`, `and`, …) outside a longer quoted phrase
  - an `au:` value of more than one word (`au:"geoffrey hinton"`, `au:J.A.Hinton`) or one holding an underscore (`au:del_maestro`): arXiv matches it inside one author's name, in any order, and reads `_` as a space
  - a `cat:` wildcard that names no category (`cat:zzz.*`)
  - version-pinned requests (the mirror holds only the latest version)
