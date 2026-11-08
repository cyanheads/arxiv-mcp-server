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

Cost on a full-size mirror:

| Migration | What it does | Time | Peak WAL | File growth |
|:---|:---|:---|:---|:---|
| v3 → v4 | Adds a column to the category table, fills it, rebuilds five date indexes | ~5 min | ~450 MB | ~9% |
| v4 → v5 | Rewrites each paper whose text holds `&#39;` or `&#34;` with the quote characters (about 1.2M of 3.2M papers), then rebuilds the category index searches use | 4.5–7.5 min, depending on host load | ~160 MB | ~10% |
| v5 → v6 | Converts TeX accents, letters, greek, and symbols in titles, authors, abstracts, comments, and journal refs to Unicode, as the arXiv API serves them (869,563 of 3,230,542 papers) | ~4.7 min | ~50 MB | under 0.1% |
| v6 → v7 | Rebuilds the full-text index with author names spelled in ASCII where arXiv's author search spells them so (`ł` → `l`, `ø` → `o`, `ß` → `ss`, …); no paper row changes | TBD (hosted migration) | ~34 MB | TBD (hosted migration) |

The v5 → v6 time and file growth were measured on a full-size mirror of 3,230,542 papers. Its peak WAL was measured on smaller copies: a v5 file built from one OAI page and replicated with distinct IDs to 130,000 and 390,000 rows peaked at 43–50 MB. The v6 → v7 peak WAL was measured on synthetic v6 files of 200,000 and 400,000 papers, 33–34 MB on both; on the 200,000-paper file, over three alternating runs of each, the folded refill took 1.03–1.07× the CPU per paper of the unfolded refill v3 through v6 ran.

Rolling back to 1.7.1 or earlier and refreshing stores those character references again in each paper the refresh rewrites. After rolling forward, run `UPDATE schema_version SET version = 4` on the file and then `bun run mirror:verify` to repeat the repair. Likewise, a release before schema v6 (1.8.0 or earlier) that refreshes a v6 file stores TeX again in each paper it rewrites; after rolling forward, run `UPDATE schema_version SET version = 5` and then `bun run mirror:verify` to repeat the conversion. A release before schema v7 (1.8.1 or earlier) serves a v7 file, but it searches an author name holding `ł`, `ø`, `ß`, or another letter v7 spells in ASCII as written, while the index holds it in ASCII, so `au:Tworzydło` misses there; `au:Tworzydlo` still matches. Its refreshes keep the index folded, since the triggers that fold it live in the file, so rolling forward needs no repair. Its `mirror:verify` reports the v7 file as a migration that did not complete and exits 1, though serving and refreshing work.

## How mirror answers differ from the live API

- **Paper text is always live.** `arxiv_read_paper` fetches the body from arXiv (full-content harvesting is against arXiv's data policy). It takes metadata from the mirror, with no live lookup, for an ID pinned to the stored version, and otherwise only when the live lookup fails or, for an ID without a version, is still pending after `ARXIV_API_TIMEOUT_MS`. When the mirror answers an ID without a version, the read gets the stored version, which can trail arXiv's latest until the next refresh.
- **Metadata matches the live API, with one exception.** The mirror converts TeX and splits author lists with arXiv's own rules, so titles, authors, abstracts, comments, journal references, and dates read as the live API returns them. `primary_category` and `categories` list the codes the API lists: an alias code (`cs.NA`, `math.MP`, `stat.TH`, …) reads as its canonical code (`math.NA`, `math-ph`, `math.ST`), and a defunct archive (`chao-dyn`, `funct-an`, …) as the category that subsumed it (`nlin.CD`, `math.FA`). A `, Jr.` suffix stays with its name on the mirror (`James F. Leathrum, Jr.`), where the API returns `James F. Leathrum,`.
- **A defunct archive in `cat:`.** arXiv's search matches none of the 18 archives later folded into categories (`cat:chao-dyn` returns nothing live), while the mirror's stored lists still carry them, so the mirror matches the papers filed there. Search the successor (`cat:nlin.CD`) instead. A few old papers list a defunct archive without its successor (`chem-ph/9603001` lists `atom-ph` alone), and the mirror's search for the successor (`cat:physics.atom-ph`) misses those where the live API finds them.
- **Relevance ranking.** Mirror search ranks with FTS5 BM25, so `sort_by=relevance` returns a different top set than the live API.
- **Counts.** A search with no free-text term counts exactly when it filters on one category code. One that spans several codes (`cat:cs`, two categories) or a submitted-date window alone stops counting at 50,000; a total that reaches it carries `totalFoundIsLowerBound: true`, meaning 50,000 or more.
- **Names in an unprefixed or `all:` phrase.** The mirror matches a quoted phrase's words in order, and across the whole author list; arXiv matches a name inside one author's name, in any order. `"hinton geoffrey"` finds 59 papers live and none on the mirror. Search names with `au:`, which agrees on both paths for every spelling but the digraphs in the next item.
- **Author names with `ł`, `ø`, `ß`, and the like.** Both paths match an author name across the ASCII spellings arXiv's author search gives `ł`, `ı`, `ø`, `đ`, `ð`, `þ`, `ħ`, `ŋ`, `ə`, `æ`, `œ`, and `ß`, in either case: `au:Tworzydlo` and `au:Tworzydło` find the same papers on each. Digraph spellings still differ: arXiv's author search also equates `Mueller` with `Müller` and `Muller`, and `Noerskov` with `Nørskov` and `Norskov`, in either direction, while on the mirror `au:Mueller`, `au:Noerskov`, and `au:Kjargaard` match only those spellings, since `Müller`, `Nørskov`, and `Kjærgaard` index as `Muller`, `Norskov`, and `Kjaergaard`.
- **Accents in titles, abstracts, comments, and journal refs.** The mirror's index folds a letter that decomposes into a base letter and an accent in every field, so `ti:Poincaré` matches what `ti:Poincare` does, where arXiv matches `ti:`, `abs:`, `co:`, and `jr:` values as written.
- **Hyphenated title words.** The mirror's index keeps a hyphenated word whole, where arXiv's title search splits it, so `ti:polytopic AND ti:Sobolev` finds two `Sobolev-Poincaré` papers live and none on the mirror. A hyphenated author name agrees on both paths (`au:jarillo-herrero`).
- **Searches that go to the live API instead:**
  - `sort_by=submitted` descending, while `ARXIV_MIRROR_RECENT_DAYS_LIVE` is positive
  - free-text terms that match 50,000 or more papers
  - a `cat:` or `submittedDate:` operand the mirror cannot apply as a filter (joined to the rest by `OR` or by a space, or on the right of an `ANDNOT`), or a query left with only `ANDNOT` terms once those operands are taken out
  - unbalanced parentheses, a field prefix with no value (`ti: x`, `ti:`), an empty quoted phrase, or nothing left to match (`()`)
  - an `rn:`, `id:`, or `lastUpdatedDate:` operand, or a malformed `submittedDate:`
  - a word arXiv's index drops (`of`, `the`, `and`, …) outside a longer quoted phrase
  - an `au:` value of more than one word (`au:"geoffrey hinton"`, `au:J.A.Hinton`) or one holding an underscore (`au:del_maestro`): arXiv matches it inside one author's name, in any order, and reads `_` as a space
  - a `cat:` wildcard that names no category (`cat:zzz.*`)
- **Version-pinned IDs.** The mirror holds each paper at one version, the latest as of its last refresh. `arxiv_get_metadata` and `arxiv_read_paper` answer a pin of that version from the mirror with no live lookup. A pin of any other version goes to the live API: always for `arxiv_read_paper`, and for `arxiv_get_metadata` while `ARXIV_MIRROR_FALLBACK_LIVE` is on (off, it comes back `version_not_in_mirror`).
