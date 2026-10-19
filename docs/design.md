# arXiv MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `arxiv_search_papers` | Search arXiv papers by query with category and sort filters. | `query`, `category?`, `submitted_from?`, `submitted_to?`, `max_results?`, `sort_by?`, `sort_order?`, `start?` | `readOnlyHint: true` |
| `arxiv_get_metadata` | Get full metadata for one or more arXiv papers by ID. | `paper_ids` (string[], up to 100; 10 looked up per call) | `readOnlyHint: true` |
| `arxiv_read_paper` | Fetch the full text content of an arXiv paper. Falls back from native HTML to ar5iv to PDF text extraction. | `paper_id`, `max_characters?`, `start?` | `readOnlyHint: true` |
| `arxiv_list_categories` | List arXiv category taxonomy, optionally filtered by group. | `group?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Delegates To |
|:-------------|:------------|:-------------|
| `arxiv://paper/{paperId}` | Paper metadata by arXiv ID. The segment is percent-decoded before lookup, so a legacy ID travels as `hep-th%2F9901001`; an ID that decodes to blank (`empty_id`) or is not an arXiv ID (`invalid_id`) is rejected without an arXiv request. Returns `PaperMetadataSchema` as JSON text. | `ArxivService.getPapers([paperId])` |
| `arxiv://categories` | Full arXiv category taxonomy. Returns `{ categories: [...] }` as JSON text — one flat array of every category with its code, name, and group. Grouping is a `arxiv_list_categories` presentation concern, not a shape this resource emits. | Static taxonomy constant |

### Prompts

None for v1. This is a data-access server — the agent structures its own analysis workflows.

---

## Overview

An MCP server that wraps the arXiv academic paper repository, giving LLM agents the ability to search for papers, retrieve metadata, and read full paper content. Read-only, no authentication required.

**Data sources:**
- **arXiv API** (`export.arxiv.org/api/query`) — Atom XML feed returning paper metadata. Supports boolean search across fields (title, author, abstract, category), pagination, and sorting.
- **arXiv HTML** (`arxiv.org/html/{id}`) — Native LaTeXML-converted HTML of papers. Default for Dec 2023+ submissions; older papers back to ~2017 are being backfilled but coverage varies.
- **ar5iv HTML** (`ar5iv.labs.arxiv.org/html/{id}`) — Community-maintained HTML5 conversion covering the full corpus. ~97% at least partial conversion. It keeps one render per paper and serves it for any version suffix; the page names no revision.
- **arXiv PDF** (`arxiv.org/pdf/{id}`) — The one artifact published for every paper. Text is extracted with the framework's `pdfParser` (lazy-loaded `unpdf`) and used only when neither HTML render exists.

**Target users:** LLM agents doing academic research — literature discovery, paper reading, citation following, topic exploration.

---

## Requirements

- Search papers by query, author, category, and date range
- Fetch full metadata for papers by known arXiv ID(s)
- Read full paper text content via HTML extraction
- List the arXiv category taxonomy for discovery
- Respect arXiv rate limits (3-second crawl delay between API requests)
- Retry transient failures with exponential backoff
- No authentication required (arXiv API is free, metadata is CC0)
- Attribution: include `arXiv:{id}` and link to abstract page in all responses

---

## Tool Designs

### `arxiv_search_papers`

Search arXiv papers by query with optional category, sorting, and pagination.

**Input:**

```ts
z.object({
  query: z.string()
    .describe(
      'Search query. Supports field prefixes: ti: (title), au: (author), '
      + 'abs: (abstract), cat: (category), co: (comment), jr: (journal ref), '
      + 'all: (all fields). Boolean operators: AND, OR, ANDNOT. '
      + 'Examples: "au:bengio AND ti:attention", "all:transformer AND cat:cs.CL".'
    ),
  category: z.string().optional()
    .describe(
      'Restrict results to an arXiv category. A leaf code ("cs.CL", "math.AG") '
      + 'matches exactly; a bare archive code ("astro-ph", "cs", "math") matches '
      + 'the whole archive. Use arxiv_list_categories to discover subject classes.'
    ),
  max_results: z.number().int().min(1).max(10_000).default(10)
    .describe('Maximum results to return. Default 10. At most 50 are returned per call: '
      + 'a larger value returns the first 50, and when more matches exist the response '
      + 'says how to reach them — the start of the next page, or date windows once '
      + 'paging cannot reach them all. arXiv serves only the first 10000 results '
      + 'of a query, so a page reaching past result 10000 can come back cut short at it, '
      + 'and the response says so. Each result includes title, authors, '
      + 'abstract, and metadata — keep low to manage context budget.'),
  sort_by: z.enum(['relevance', 'submitted', 'updated']).default('relevance')
    .describe('Sort criterion. Use "submitted" for newest papers, '
      + '"relevance" for best query matches. '
      + 'Maps to arXiv API: relevance→relevance, submitted→submittedDate, updated→lastUpdatedDate.'),
  sort_order: z.enum(['ascending', 'descending']).default('descending')
    .describe('Sort direction. "descending" returns newest/most relevant first.'),
  start: z.number().min(0).max(10_000).default(0)
    .describe('Pagination offset (0-10000). Use with max_results to page through results. '
      + 'E.g., start=10 with max_results=10 returns results 11-20. arXiv serves only the '
      + 'first 10000 results of a query, so a page reaching past result 10000 can come back '
      + 'cut short at it and a start of 10000 can be refused. To reach later matches, carve '
      + 'the search into submitted_from/submitted_to windows and page within each.'),
  submitted_from: z.string().optional()
    .describe('Earliest submission date to include, inclusive, UTC YYYY-MM-DD.'),
  submitted_to: z.string().optional()
    .describe('Latest submission date to include, inclusive, UTC YYYY-MM-DD.'),
})
```

**Output:**

```ts
z.object({
  papers: z.array(PaperMetadataSchema)
    .describe('Matching papers with full metadata.'),
})
```

**Enrichment** (agent-facing context — merged into `structuredContent` and mirrored into a `content[]` trailer; not part of the domain payload):

```ts
{
  effectiveQuery: z.string()
    .describe('The query as actually searched, carrying every filter applied. '
      + 'Replaying it as `query` with no other filters reproduces this result set.'),
  totalFound: z.number().describe('Total matching papers reported by arXiv.'),
  pageStart: z.number().describe('Pagination offset of this result page.'),
  truncated: z.boolean().optional(),
  shown: z.number().optional(),
  cap: z.number().optional()
    .describe('The page size applied: max_results, or 50 when max_results asks for more — '
      + 'fewer when the page was cut short at result 10000, the last one arXiv serves.'),
  notice: z.string().optional()
    .describe('Guidance when results are empty, paging overshot, or matches exceed '
      + 'the reachable offset.'),
}
```

**`PaperMetadataSchema`** (shared with `arxiv_get_metadata`):

```ts
const PaperMetadataSchema = z.object({
  id: z.string().describe('arXiv paper ID (e.g., "2401.12345v1").'),
  title: z.string().describe('Paper title.'),
  authors: z.array(z.string()).describe('Author names.'),
  abstract: z.string().describe('Full abstract text.'),
  primary_category: z.string().describe('Primary arXiv category (e.g., "cs.CL").'),
  categories: z.array(z.string()).describe('All arXiv categories assigned to this paper.'),
  published: z.string().describe('Original submission date (ISO 8601).'),
  updated: z.string().describe('Last update date (ISO 8601).'),
  comment: z.string().optional().describe('Author comment (e.g., page count, conference).'),
  journal_ref: z.string().optional().describe('Journal reference if published.'),
  doi: z.string().optional().describe('DOI if available.'),
  pdf_url: z.string().describe('Direct PDF download URL.'),
  abstract_url: z.string().describe('arXiv abstract page URL.'),
});
```

**Format:** Renders each paper as a structured block with title, authors, abstract, categories, dates, and links. Counts, the effective query, and pagination guidance ride in the enrichment trailer rather than `format()`.

**Error modes:**

| Failure | Code | Recovery guidance |
|:--------|:-----|:-----------------|
| Unknown category code | `ValidationError` | Near-match suggestions from the searchable set; `arxiv_list_categories` for the full taxonomy. |
| Malformed or inverted date window | `ValidationError` | Both bounds as real UTC calendar dates, `submitted_from` on or before `submitted_to`. |
| `start` of 10,000 or more on a search arXiv answers (`start_beyond_result_limit`) | `ValidationError` | arXiv serves results 1–10,000 of a query: use a `start` below 10,000, or split the search into date windows. Raised before any request. |
| arXiv API unavailable | `ServiceUnavailable` | "arXiv API is temporarily unavailable. Try again in a few seconds." |
| arXiv throttling (429 or `Rate exceeded.` body) | `RateLimited` | Wait `error.data.cooldownAppliedMs` milliseconds and lower concurrency. Never retried server-side. |
| Empty results | Not an error | Return `{ papers: [] }` with a `notice` enrichment explaining how to broaden. |

#### Category resolution

A category filter names either one taxonomy leaf or a whole archive, and both search paths resolve it from the same derived taxonomy so they cannot disagree. This holds for the `category` parameter and for a `cat:` operand written inside `query` — the two are separate filters, but one code means one set:

| Input | Live `search_query` operand | Mirror category filter |
|:------|:----------------------------|:-----------------------|
| `cs.CL` (leaf) | `cat:cs.CL` | `cs.CL` |
| `hep-th` (standalone archive) | `cat:hep-th` | `hep-th` |
| `astro-ph` (subdivided archive) | `cat:astro-ph*` | `astro-ph` + its six subject classes |
| `math` (prefix collides with `math-ph`) | `(cat:math.* OR cat:math)` | `math` + its subject classes, never `math-ph` |

A bare archive code covers the legacy flat papers filed before the archive was subdivided — 105,380 of them under `astro-ph` alone, which a subject-class-only expansion drops. `physics` resolves to the general-physics archive (`physics.*`), not the wider physics group; `astro-ph`, `cond-mat`, `hep-*` and `quant-ph` are separate archive codes.

**Decision — a bare code means its archive, not its display group.** `physics` is the only code that is both an archive and a taxonomy group. Resolving it as the archive is what `cat:physics*` returns upstream, so live and mirror agree exactly; resolving it as the group would have required a thirteen-way `OR` on the live path and still diverged on cross-listed papers.

**Decision — a `cat:` operand inside `query` expands the same way the `category` parameter does.** The parameter always did; the operand did not. The mirror lifted it out and expanded it through the taxonomy, while the live path forwarded it verbatim to an API that matches a bare archive code literally — `cat:cs` reaches nothing at all upstream, because arXiv never assigns the bare group name, and `cat:astro-ph` reaches only the legacy flat papers. One input therefore meant a broader or narrower set depending on whether the mirror happened to be enabled and harvested, with nothing in the response telling the caller which they got. `buildSearchQuery` now rewrites each `cat:` operand to the operand `categorySearchTerm` produces before the query leaves for arXiv. The rewrite is confined to `cat:` — every other byte reaches arXiv as written — and a leaf code, a standalone archive, and an already-wildcarded operand all rewrite to themselves. `effective_query` carries the rewritten form, so the echo still says what was actually searched, and replaying it reproduces the same rows. See [#36](https://github.com/cyanheads/arxiv-mcp-server/issues/36).

**Decision — a query `cat:` and the `category` parameter are separate filters, intersected.** They are independent inputs, and the live path has always AND-ed them (`(… cat:X …) AND cat:Y`). The mirror merged both into a single OR-ed set, so supplying both *widened* its result set while the same pair narrowed arXiv's. The mirror now passes them as separate category groups — codes OR-ed within a group, groups AND-ed — so a paper has to carry a code from each, and two filters that cannot both be satisfied return nothing on either path instead of everything matching either one.

#### Exhaustive retrieval past the offset ceiling

arXiv's API serves only the first 10,000 results of a query: a request whose `start + max_results` passes 10,000 answers HTTP 500 whatever the total — verified live, `start=9990&max_results=10` answers 200 while `max_results=11` and `start=10000&max_results=1` answer 500. On the live path the service therefore cuts a page at result 10,000 and refuses a `start` of 10,000 or more with `start_beyond_result_limit` before any request; the truncation enrichment discloses a cut page, with `cap` reporting the size actually served. The local mirror has no such limit and keeps serving every `start` the schema accepts, which still caps at 10,000, so there paging reaches 10,000 plus the page size (at most 50). A recency-bypass search with a `start` of 10,000 is answered from the mirror when it is ready and the query's free-text term is under the match cap, and refused otherwise; a recency-bypass page that crosses result 10,000 goes live and is cut there like any other. Matches past the reachable bound need `submitted_from` / `submitted_to` to carve the result set into independently pageable windows, and the truncation guidance names them once `totalFound` exceeds what paging can reach on the path that answered. See [#56](https://github.com/cyanheads/arxiv-mcp-server/issues/56).

**Decision — a window's upper bound is midnight of the following day.** arXiv's `submittedDate:[A TO B]` takes `YYYYMMDDHHMM` stamps, includes both endpoints, and compares each against the paper's full-precision submission timestamp rather than a minute bucket (probed live: an upper bound of `…0339` includes a paper submitted at exactly `03:39:00Z`, while `…0149` excludes one at `01:49:16Z`). A same-day `…2359` bound would therefore drop every submission in that day's last 59 seconds into no window at all. Closing at the next midnight instead leaves adjacent windows sharing a single instant — a paper submitted at exactly `00:00:00Z` appears in both — which is the unavoidable residue of a doubly-inclusive operator and strictly preferable to a recurring hole. The mirror applies the identical instants as `published >= ? AND published <= ?`.

### `arxiv_get_metadata`

Get full metadata for one or more papers by arXiv ID. Use when you have known IDs (from citations, prior search results, or memory). Looks up 10 IDs per call; any further IDs come back in `remaining_ids`.

**Input:**

```ts
z.object({
  paper_ids: z.preprocess(wrapLonePaperId, z.array(z.string().trim().min(1)).min(1).max(100))
    .describe(
      'arXiv paper IDs, up to 100. The first 10 well-formed IDs are looked up; the rest '
      + 'come back in remaining_ids to pass to the next call. Accepted forms: "2401.12345", '
      + '"2401.12345v2" (a pinned version), or a pre-2007 ID like "hep-th/9901001" (archive '
      + 'spelled as arXiv issued it), each optionally prefixed "arXiv:", or an arxiv.org abs, '
      + 'pdf, or html URL, with or without https:// or a ?query or #fragment. An ID in any '
      + 'other form is reported in not_found with reason invalid_id and is not looked up.'
    ),
})
```

The field advertises a plain array, never a `string | string[]` union, whose string branch would accept a JSON-stringified array as one ID. `wrapLonePaperId` takes a lone string as the list's one ID, trimmed — line breaks at its edges included, which the framework's own lone-string wrap refuses, and which it never applies behind a `z.preprocess()` anyway. A blank lone string (`""`, `"   "`, `"\n"`) is wrapped too, so it fails as the empty ID it is, with the message a blank array element gets, rather than with a send-an-array hint that following leads to a second, different error. A string that may be a joined list (a comma or a line break inside it) or that is JSON stays a not-an-array: the framework decodes a stringified array and refuses the rest with "Send paper_ids as an array". The preprocess leaves the advertised schema the inner array's.

**Output:**

```ts
z.object({
  papers: z.array(PaperMetadataSchema)
    .describe('Papers found, in request order. Fewer than requested when an ID is '
      + 'malformed, absent from arXiv, a version arXiv will not serve, one whose live lookup '
      + 'failed behind the local mirror, or past the first 10 well-formed IDs.'),
  totalSucceeded: z.number(),
  not_found: z.array(z.object({
    id: z.string(),
    reason: z.enum(['not_in_arxiv', 'version_not_in_mirror', 'version_not_served',
      'live_lookup_failed', 'invalid_id']),
    detail: z.string().optional(),
  })).optional()
    .describe('Requested IDs that returned no data, each with the reason it was missed.'),
  remaining_ids: z.array(z.string()).optional()
    .describe('Well-formed IDs past the first 10, in canonical form and request order, '
      + 'that this call did not look up. Pass them as paper_ids in the next call.'),
})
```

`version_not_in_mirror` distinguishes "unreachable from this deployment" from "absent from arXiv": the mirror stores the latest version only, so a version-pinned ID it lacks is a real paper the caller can still fetch with live fallback enabled or without the pin. `detail` names the version the mirror holds. `version_not_served` marks a superseded version of an old-style paper that arXiv's API answers HTTP 500 for: the version exists, but its metadata cannot be returned. `detail` names the latest version and the pinned version's PDF URL, and, when another such version shared the failed request, says to request this one alone. `live_lookup_failed` marks an ID a ready mirror could not serve whose live lookup failed (arXiv unavailable after its retry, timed out, or throttled): `detail` names the failure, says the same call made again may serve it, and names the version the mirror holds when it holds the paper at another one. `invalid_id` marks an input that is not an arXiv ID; its `id` is the input as sent, while every looked-up ID is reported in canonical form. `not_found` keeps request order.

**Decision — a 500 on an old-style pin is answered with the latest versions, not retried.** arXiv's API answers HTTP 500, every time, for an `id_list` holding some superseded old-style versions (`hep-th/9901001v1`, `cond-mat/0501001v2`), while others answer 200 (`astro-ph/0703001v1`) and no public metadata separates the two, so the handling keys off the failure. On an HTTP 500 (not 502/503) for a first request holding an old-style pinned ID, one request with those IDs unversioned replaces the identical retry, which could not succeed; a lookup still sends at most two requests. Each pin then resolves against the latest version returned: equal is served, above is `not_in_arxiv`, below is `version_not_served`. Sending old-style pins unversioned up front was rejected because it turns the superseded versions arXiv does serve into misses; retrying each ID alone to find the culprit was rejected as up to ten paced requests per call. A transient 500 followed by a good unversioned answer reports a servable pin as `version_not_served`; its detail says only what that lookup returned, and the same call made again serves the pin. See [#53](https://github.com/cyanheads/arxiv-mcp-server/issues/53).

**Decision — a failed live patch-up keeps the mirror's answers.** On a ready mirror with live fallback on, the IDs the mirror cannot serve go to the live API in one lookup. When that lookup fails with an outage a later call can get past (`ServiceUnavailable` after its retry, `Timeout`, `RateLimited` with no extra retry), the papers the mirror served are returned and each unanswered ID is `live_lookup_failed`, since an arXiv outage is what the mirror exists to absorb. The call still fails with the live error when the mirror served none of the IDs, so a lookup that is all live reads as the failure it is, and when arXiv rejected the lookup (`InvalidRequest`), which a later call would repeat. A cancelled call always fails. No call-level `errors[]` entry exists for the reason: no call fails with it. See [#67](https://github.com/cyanheads/arxiv-mcp-server/issues/67).

**Format:** A summary line (`Found N of M papers.`, plus — when IDs remain — that the first 10 well-formed IDs were looked up and how many more are listed under Remaining IDs), then the same structured block per paper as `arxiv_search_papers`. Lists not-found IDs separately, then `remaining_ids` on one line as a JSON array ready to pass as the next call's `paper_ids`.

**Error modes:**

| Failure | Code | Recovery guidance |
|:--------|:-----|:-----------------|
| No ID is an arXiv ID (`invalid_id`) | `ValidationError` | Names the inputs and the accepted forms. No arXiv request is made. |
| All looked-up IDs not found, none remaining | `NotFound` | "No papers found for the given IDs." — plus each miss's `detail` (a version that can be served) and the malformed inputs, when any. The version failures below carry both the same way. |
| All IDs pin a version the mirror lacks, live fallback off | `ServiceUnavailable` | Request the version named in the error detail, or drop the version suffix. The IDs are valid — only unreachable in this configuration. |
| All IDs pin a superseded old-style version arXiv answers HTTP 500 for (`version_not_served`) | `NotFound` | Request the latest version each `not_found` detail names, or drop the version suffix; a version whose detail says to request it alone may be served that way. Not retryable. |
| Partial success | Not an error | Return found papers + `not_found` array (+ `remaining_ids`) |
| Every looked-up ID misses, but IDs remain | Not an error | Return no papers, the `not_found` entries, and `remaining_ids`, so the remainder is never dropped. |
| Live patch-up fails behind a ready mirror that served some IDs | Not an error | Return the mirror's papers, each unanswered ID as `live_lookup_failed` naming the failure. |
| API unavailable (on a ready mirror: the mirror served none of the IDs) | `ServiceUnavailable` | "arXiv API is temporarily unavailable. Try again in a few seconds." |

### `arxiv_read_paper`

Fetch the full body of an arXiv paper. Tries native arXiv HTML first, falls back to ar5iv, then to text extracted from the PDF. An HTML body is the paper's `<article>` element — the site header and footer cut away — with LaTeXML class/id noise stripped, MathML collapsed to LaTeX, and relative `src`/`href`/`data` URLs resolved against the URL that served the page (in-page `#fragment` links stay as written). Beyond that it is HTML, not parsed or extracted, and the LLM interprets it directly.

The first page (`start` 0) also carries an `outline`: the paper's part, chapter, section, subsection, subsubsection, paragraph, appendix, and bibliography headings in document order, each with the offset of its `<hN>` tag in the cleaned body. `level` follows the tag (h2 = 1), not the class, because a paper with no `\section` renders its subsections as `<h2>`. Passing an entry's `start` reads from that heading. The outline stops at 200 entries by dropping the deepest heading level whole until the rest fit; `outline_omitted_levels` names what was dropped. The shallowest level is never dropped: when it alone has more than 200 headings, the outline keeps its first 200 and `outline_continues_at` gives the `start` of the first one left out, so a caller reads on from there. A PDF-extracted body returns `outline: []`.

An ar5iv body carries `revision_unconfirmed: true`. ar5iv keeps one render per paper and serves it whatever version is asked for, and nothing on its page or in its conversion log names the revision, so the body can be another revision than `paper_id`, while `pdf_url` is exactly the `paper_id` revision. The flag is absent on every other body, and on an unversioned read of a paper whose only version is v1, the one ar5iv read that cannot be another revision. No request is added to check it.

**Decision — a failed live metadata lookup is answered from the mirror only for a paper the mirror holds.** Metadata comes from the live API, since the mirror stores the latest version only. When that lookup fails and a ready mirror holds the paper, an unversioned read takes the stored version, and a pinned read is served only when the pin matches it (`version_unavailable` otherwise, so another revision's body is never returned). When the mirror does not hold the paper, the call fails with the live error unchanged, exactly as with no mirror: a mirror miss says nothing about arXiv, and `no_match` would tell the caller to doubt an ID that a retry can serve. A cancelled call fails as cancelled and never reads the mirror. See [#33](https://github.com/cyanheads/arxiv-mcp-server/issues/33), [#68](https://github.com/cyanheads/arxiv-mcp-server/issues/68).

**Input:**

```ts
z.object({
  paper_id: z.string()
    .describe('arXiv paper ID: "2401.12345", "2401.12345v2" (a pinned version), or a pre-2007 '
      + 'ID like "hep-th/9901001" (archive spelled as arXiv issued it), optionally prefixed '
      + '"arXiv:", or an arxiv.org abs, pdf, or html URL, with or without https:// or a '
      + '?query or #fragment.'),
  max_characters: z.number().int().min(1).nullable().default(100_000)
    .describe('Maximum characters of paper body to return, counted after boilerplate stripping. Defaults to 100,000; pass null to return the entire body in one call. Whole-paper reads can exceed a client tool-result size cap — math-heavy bodies run 300KB-1MB+ — so prefer the default plus start-based paging unless the full text is needed. When truncated, a notice and the total character count are included.'),
  start: z.number().int().min(0).default(0)
    .describe("Character offset into the cleaned body to begin reading from. Defaults to 0. Use with max_characters to page through long papers — e.g., start=100000 with max_characters=100000 returns chars 100,000–199,999 — or pass an outline entry's start to read from that heading. The total length is reported as body_characters in the response."),
})
```

The bounded default is deliberate: a default-unlimited read would be rejected client-side on a large paper with no content delivered, whereas truncation still returns a usable slice plus a continue hint. Unbounded reads stay available, but only when the caller asks for one.

**Output:**

```ts
z.object({
  paper_id: z.string().describe('arXiv paper ID.'),
  title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
  content: z.string()
    .describe('Paper body for the requested slice — the article as cleaned HTML, with relative image, object, and link URLs made absolute (in-page #fragment links stay as written), when source is arxiv_html or ar5iv; plain text when source is pdf_text. Empty when start is past body_characters.'),
  source: z.enum(['arxiv_html', 'ar5iv', 'pdf_text'])
    .describe('Which upstream artifact the body was read from. arxiv_html and ar5iv are HTML renders; pdf_text is text extracted from the PDF, where prose is reliable but math, tables, and heading structure are flattened. ar5iv keeps one render per paper, so an ar5iv body can be another revision than paper_id (see revision_unconfirmed).'),
  truncated: z.boolean()
    .describe('True when more body content exists past this slice (start + content.length < body_characters).'),
  start: z.number()
    .describe('Character offset of the first character in content within the cleaned body.'),
  total_characters: z.number()
    .describe('Character count of the body before cleaning — the article HTML, without the site header and footer, for arxiv_html and ar5iv; equal to body_characters for pdf_text, which needs no cleaning.'),
  body_characters: z.number()
    .describe('Character count of the full cleaned body. Use with start and max_characters to page. Typically 3-4× smaller than total_characters for math-heavy HTML papers.'),
  pdf_url: z.string()
    .describe('Direct PDF download URL.'),
  abstract_url: z.string()
    .describe('arXiv abstract page URL for attribution.'),
  revision_unconfirmed: z.literal(true).optional()
    .describe('Present, true, when source is ar5iv: ar5iv keeps one render per paper whatever version is asked for, so the body may be another revision than paper_id, while pdf_url is exactly the paper_id revision. Absent for every other source, and for an unversioned read of a paper whose only version is v1.'),
  outline: z.array(z.object({
      level: z.number().int().describe('Heading depth from its tag number minus one: h2 = 1, h3 = 2, and so on to h6 = 5.'),
      title: z.string().describe('Heading text with markup removed, e.g. "3.1 Encoder and Decoder Stacks"; cut at 120 characters.'),
      start: z.number().int().describe('Offset of the heading in the cleaned body. Pass as start to read from it.'),
    })).optional()
    .describe('Section headings of the whole cleaned body in document order, each with the start that reads from it. Returned only when start is 0. Empty for pdf_text, whose text carries no reliable headings. At most 200 entries — see outline_omitted_levels and outline_continues_at.'),
  outline_continues_at: z.number().int().optional()
    .describe('Present when the shallowest heading level alone has more than 200 headings, so outline stops at its first 200: the start of the first heading left out. Pass it as start to read on from there.'),
  outline_omitted_levels: z.array(z.number().int()).optional()
    .describe('Heading levels left out of outline because the paper has more than 200 headings, deepest first. Present only when levels were left out.'),
})
```

**Format:** A header (title, ID, source, raw and cleaned character counts, abstract and PDF links), the PDF-fidelity caveat when the body came from the PDF, the revision notice when `revision_unconfirmed` is set (ar5iv keeps one render per paper, so the body may be another revision than the ID; the PDF URL is exactly that ID's revision), the slice notice (truncated, final chunk, or past the end), then — on the first page — the outline as one indented `- title (level L, start=N)` line per heading (`Outline: none` when empty, plus a line naming any omitted levels and one naming the `start=` to read on from when the outline was cut), and finally the content.

**Error modes:**

| Failure | Code | Recovery guidance |
|:--------|:-----|:-----------------|
| Not an arXiv ID (`invalid_id`) | `ValidationError` | Names the input and the accepted forms. No arXiv request is made. |
| Paper not found | `NotFound` | "Paper '{id}' not found. Verify the ID format." |
| Superseded old-style version arXiv answers HTTP 500 for (`version_not_served`) | `NotFound` | Read the latest version the message names, or download this version from `error.data.pdfUrl`. Not retryable. |
| No HTML render and no PDF (`content_unavailable`) | `NotFound` | "Read the abstract via `arxiv_get_metadata` — no full-text artifact exists." |
| PDF has no text layer (`pdf_extraction_failed`) | `NotFound` | "Download `error.data.pdfUrl` and run OCR, or read the abstract via `arxiv_get_metadata`." |
| A content host or the API timed out, or the read ran past `ARXIV_READ_TIMEOUT_MS` | `Timeout` | Retryable; the message names the host that timed out or what the read was waiting on. Not retried inside the call. |
| arXiv unavailable, or ar5iv unavailable with no PDF to cover for it | `ServiceUnavailable` | "Content service temporarily unavailable. Try again shortly." |

### `arxiv_list_categories`

List arXiv category codes and names. Useful for discovering valid category filters for `arxiv_search_papers`.

**Input:**

```ts
z.object({
  group: z.string().optional()
    .describe(
      'Filter by top-level group (e.g., "cs", "math", "physics", "q-bio", "q-fin", "stat", "eess", "econ"). '
      + 'Returns all categories if omitted.'
    ),
})
```

**Output:**

```ts
z.object({
  categories: z.array(z.object({
    code: z.string().describe('Category code (e.g., "cs.AI").'),
    name: z.string().describe('Full name (e.g., "Artificial Intelligence").'),
    group: z.string().describe('Top-level group (e.g., "cs").'),
  })).describe('arXiv categories matching the filter.'),
})
```

**Format:** Renders as a grouped list: `cs.AI — Artificial Intelligence`, organized by group.

**Error modes:** None — static data, always succeeds.

---

## Domain Mapping

| Noun | Operations | API Source | MCP Primitive |
|:-----|:-----------|:-----------|:--------------|
| Paper (metadata) | Search by query | `export.arxiv.org/api/query?search_query=` | `arxiv_search_papers` tool |
| Paper (metadata) | Get by ID(s) | `export.arxiv.org/api/query?id_list=` | `arxiv_get_metadata` tool + `arxiv://paper/{id}` resource |
| Paper (content) | Read full text | `arxiv.org/html/{id}` → `ar5iv.labs.arxiv.org/html/{id}` → `arxiv.org/pdf/{id}` | `arxiv_read_paper` tool |
| Category | List taxonomy | Static data embedded in server | `arxiv_list_categories` tool + `arxiv://categories` resource |

---

## Workflow Analysis

### Literature discovery

1. `arxiv_search_papers` with topic query → discover relevant papers
2. `arxiv_get_metadata` for specific papers of interest → full metadata
3. `arxiv_read_paper` for papers worth deep reading → full text

### Citation following

1. `arxiv_read_paper` on a paper → extract referenced arXiv IDs from text
2. `arxiv_get_metadata` with extracted IDs → metadata for cited papers
3. Repeat for deeper citation chains

### Category exploration

1. `arxiv_list_categories` → discover relevant categories
2. `arxiv_search_papers` with `cat:` prefix → recent papers in category

### Known paper lookup

1. `arxiv_get_metadata` with known ID(s) → metadata + abstract
2. `arxiv_read_paper` if full content needed

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ArxivService` | arXiv API (search + ID lookup), HTML content fetching | All 3 data tools (`arxiv_search_papers`, `arxiv_get_metadata`, `arxiv_read_paper`) |

### ArxivService Design

Single service with three method groups:

```ts
class ArxivService {
  // API methods — Atom XML
  search(query: string, options: SearchOptions, ctx: Context): Promise<SearchResult>
  getPapers(ids: string[], ctx: Context): Promise<PaperLookupResult>

  // Content method — full-text fetch, cleaning, and outline
  readContent(id: string, options: ReadContentOptions, ctx: Context): Promise<PaperContent>
}
```

**Resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | `withRetry` wraps full pipeline: fetch + parse (XML) or fetch (HTML) |
| Backoff calibration | 1s base for API calls (rate-limited service), 2s for HTML content (heavier pages) |
| Rate limiting | Internal request queue enforcing 3-second delay between arXiv API calls. Content fetches (arxiv.org/html, ar5iv, arxiv.org/pdf) hit other hosts and don't share this queue. A 429 from the PDF fetch is still classified as `rate_limited` and records the shared cooldown rather than being read as a missing PDF. |
| Response classification | HTTP status first: 5xx → `ServiceUnavailable` (retried), 429 → `RateLimited`, other 4xx → `InvalidRequest`. The one 5xx not retried as sent: a first-attempt HTTP 500 for an `id_list` holding an old-style pinned version, where one request with those IDs unversioned replaces the identical retry and each pin resolves against the latest version (`version_not_served` below it). Then, on a 2xx: an empty body → `ServiceUnavailable` (a transport symptom, retried); a non-XML body carrying `Rate exceeded.` → `RateLimited` (never retried, per the fail-fast policy); any other non-XML body → `SerializationError` (never retried). |
| Content fallback | `arxiv.org/html/{id}` first → on a 404 or a page holding none of the paper, try `ar5iv.labs.arxiv.org/html/{id}` → on any non-2xx, a conversion-failure page, or a page holding none of the paper, fetch `arxiv.org/pdf/{id}` and extract its text → throw NotFound only when the PDF is absent (`content_unavailable`) or holds no text layer (`pdf_extraction_failed`). Both HTML renders run LaTeXML, so they are not independent — a submission that breaks one usually breaks the other, which is why the PDF is the rung that widens coverage. An ar5iv 5xx, network error, or timeout does not end the chain: it is held and re-raised only when the PDF comes up empty too, so an outage on a third-party conversion service narrows coverage rather than failing the call. A body ar5iv serves carries `revision_unconfirmed: true` (ar5iv keeps one render per paper), except on an unversioned read of a paper whose only version is v1. |
| HTML 404 detection | arxiv.org returns clean HTTP 404. ar5iv returns 307 redirect to arxiv.org/abs (which then 404s) — don't follow redirects on ar5iv, treat 3xx as not-found. When a conversion aborted, ar5iv answers 200 with a page whose only text is LaTeXML's "Conversion to HTML had a Fatal error" notice; that page is not-found too, while a partial render that keeps the notice beside paper text is served (arxiv.org answers an aborted conversion with its 404). Both rungs answer 200 for a paper whose source wraps PDFs with `pdfpages`' `\includepdf`, which LaTeXML renders as one "See pages … of" sentence and a link per included file, and both can answer 200 with an empty article (ar5iv's "No content available" page is one). A page whose article has no structural heading (none of the part-through-bibliography headings the outline lists) and holds such a placeholder or no text at all is not-found on either rung (`isPlaceholderRender`); a page with a structural heading is served whatever placeholders it holds, like a thesis whose cover is an included page. |
| HTML page size | Raw HTML is 500KB-3MB+ for math-heavy papers. `max_characters` truncation keeps response size manageable. |
| Timeout | API calls: 15s, content fetches: 30s, each covering the body as well as the headers, so a host that stalls after its headers fails as one that hangs before them. Surface as `Timeout`, never retried. A network error, before the headers or mid-body, is `ServiceUnavailable` (retried). Pass `ctx.signal` to all `fetch()` calls for cancellation. |
| Read deadline | One `arxiv_read_paper` call runs on one deadline (`ARXIV_READ_TIMEOUT_MS`, 50 s): the metadata lookup and its wait for the API queue, every content rung, the retries, and the backoffs between them all draw on it, and the call fails with `Timeout` when it passes. Per-request timeouts alone let a read that waits out a hung ar5iv and then the PDF, or replays the chain, run past the 60 s request timeout of MCP SDK clients. The default leaves room under that window for the work no signal stops (PDF text extraction, HTML cleaning). A cancelled call stays cancelled. See [#69](https://github.com/cyanheads/arxiv-mcp-server/issues/69), [#70](https://github.com/cyanheads/arxiv-mcp-server/issues/70). |

**API efficiency:**

| Concern | Decision |
|:--------|:---------|
| Batch fetching | `getPapers()` sends all IDs in a single `id_list=` request (a second only in place of a retry, as above). Cross-references response entries against requested IDs to detect not-found, matching on the full versioned ID when the request pins a version so two versions of one paper stay in their own slots. |
| Field selection | N/A — arXiv API returns fixed Atom entries, no field selection parameter. |
| Pagination | `search()` uses `start` + `max_results` params. Single request per tool call (no internal pagination). |

**Dependencies:**

| Package | Purpose | Justification |
|:--------|:--------|:--------------|
| `fast-xml-parser` (v5.x) | Parse Atom XML from arXiv API | Zero-dependency, 71M weekly downloads, native TS types, actively maintained. Standard choice for XML in Node.js/Bun. Note: v5 API is class-based (`new XMLParser()`), breaking change from v4. |

### Static Data

**Category taxonomy** is embedded as a static TypeScript constant (~155 entries). The arXiv category list changes rarely (last addition: `econ` group in 2017). No external fetch needed. Source: [Hugging Face arxiv-categories.json](https://huggingface.co/spaces/Yankovsky/arxiv_classifier/raw/main/arxiv-categories.json) for tag + name, augmented with group derivation (prefix before `.`). Hardcoded at build time.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `ARXIV_API_BASE_URL` | No | `https://export.arxiv.org/api` | arXiv API base URL (override for testing) |
| `ARXIV_REQUEST_DELAY_MS` | No | `3000` | Minimum delay between arXiv API requests (ms) |
| `ARXIV_CONTENT_TIMEOUT_MS` | No | `30000` | Timeout for each paper body fetch — HTML renders and PDF downloads (ms) |
| `ARXIV_API_TIMEOUT_MS` | No | `15000` | Timeout for API search/metadata requests (ms) |
| `ARXIV_READ_TIMEOUT_MS` | No | `50000` | Time budget for one `arxiv_read_paper` call — its metadata lookup and every content request, retry, and backoff (ms); keep it under the client's request timeout |
| `ARXIV_MIRROR_ENABLED` | No | `false` | Serve search and metadata from the local OAI-PMH mirror once a full harvest has completed |
| `ARXIV_MIRROR_PATH` | No | `./data/arxiv-mirror.db` | SQLite path for the mirror |
| `ARXIV_MIRROR_REFRESH_CRON` | No | unset | UTC cron expression for the in-process refresh; HTTP transport only, and only with the mirror enabled |
| `ARXIV_MIRROR_FALLBACK_LIVE` | No | `true` | Fetch metadata IDs the mirror lacks from the live API |
| `ARXIV_MIRROR_RECENT_DAYS_LIVE` | No | `2` | Any positive value sends `sort_by=submitted`, descending searches to the live API; `0` disables the bypass |
| `ARXIV_MIRROR_OAI_BASE_URL` | No | `https://oaipmh.arxiv.org/oai` | arXiv OAI-PMH endpoint base URL |
| `ARXIV_MIRROR_OAI_REQUEST_DELAY_MS` | No | `3000` | Minimum delay between OAI-PMH requests (ms) |
| `ARXIV_MIRROR_REFRESH_TIMEOUT_MS` | No | `7200000` | Wall-clock budget for one scheduled refresh subprocess (ms); the child stops starting pages once a worst-case page cycle no longer fits and the next run resumes |

No API keys. No auth. `MCP_AUTH_MODE: none`.

---

## Implementation Order

1. **Config and server setup** — `server-config.ts` with Zod schema for env vars
2. **Static data** — Category taxonomy constant + `arxiv_list_categories` tool
3. **ArxivService** — XML parsing for API, raw HTML fetching for content, rate limiting, retry
4. **`arxiv_search_papers` tool** — search via ArxivService
5. **`arxiv_get_metadata` tool** — ID lookup via ArxivService
6. **`arxiv_read_paper` tool** — content extraction via ArxivService
7. **Resources** — `arxiv://paper/{id}` and `arxiv://categories`
8. **Tests** — mock context tests for each tool, service integration tests

Each step is independently testable. Run `devcheck` after each addition.

---

## Design Decisions

### Why separate `arxiv_search_papers` and `arxiv_get_metadata`?

Both use the same API endpoint (`/api/query`), but they serve different agent mental models: "find papers about X" vs "look up this specific paper." Search takes a query string with filters; get takes known IDs. Different parameter shapes, different use cases. The LLM naturally distinguishes between discovery and lookup.

### Why not consolidate into one tool with an `operation` enum?

Search and get-by-ID share almost no parameters. An operation enum would require most fields to be optional with complex conditional validation ("query required when operation=search, paper_ids required when operation=get"). This adds cognitive overhead for the LLM without reducing tool count meaningfully.

### Why cap `max_results` at 50?

The arXiv API supports up to 2000, but each result includes a full abstract. 50 papers with abstracts is already a substantial amount of text for an LLM context window. The agent can paginate with `start` for more results. Default of 10 keeps responses lightweight for the common case.

**Decision — a larger `max_results` serves 50, it is not rejected.** The 50 is this server's response-size cap, not an upstream limit (arXiv answers `max_results=500` in one response), and a request for more has one obvious reading. Rejecting it only cost the caller a round trip to learn the cap. The schema ceiling is `MAX_START` (10,000), since no `start` sequence reaches past it; between 50 and that ceiling the tool returns the first 50 and the existing truncation disclosure reports `cap: 50` and the next `start`. The reachable-by-paging bound is arXiv's 10,000 on the live path and the applied 50 past `MAX_START` on the mirror, so a large `max_results` never produces guidance naming a `start` that fails. `arxiv_get_metadata` follows the same rule for IDs: up to 100 accepted, 10 looked up, the rest named in `remaining_ids`. See [#51](https://github.com/cyanheads/arxiv-mcp-server/issues/51).

### Why one service instead of two?

The arXiv API and HTML content are separate data sources, but they share the rate limiting constraint (same infrastructure) and the paper ID as the common key. A single `ArxivService` keeps the rate limiter in one place and provides a coherent interface for "all things arXiv."

### Why no prompts?

This is a data-access server. The value is in search, metadata retrieval, and content extraction — not in structuring how the LLM thinks about papers. Agents have their own reasoning patterns for literature review, summarization, etc. Prompts would add surface area without adding capability.

### Why does the mirror's harvest runner, not `MirrorStore.open`, build the write-path index?

Every record write deletes the paper's `paper_categories` rows by `paper_id`, and a tombstone's cascade looks them up the same way. Neither of the junction's other indexes leads with `paper_id`, so without a dedicated index each lookup scans the whole junction, about 5M rows on a full corpus. A 1,300-record page then takes minutes to apply, and a refresh never gets through a large datestamp. The index is built by `runHarvest` before its first page rather than by `MirrorStore.open`: only the harvest looks junction rows up by `paper_id`, and the build takes seconds over a full corpus, which every other writer open (`mirror:verify` included) would otherwise pay. Reads never filter the junction by `paper_id` and plan identically with or without it, so it stays outside the schema version: a version bump would build it in whichever writer opened the file first. See [#50](https://github.com/cyanheads/arxiv-mcp-server/issues/50).

### Why is the server's mirror connection query-only?

**Decision — writers own the schema; the server's connection never writes.** The server reads through `MirrorStore.openReader`: `PRAGMA query_only = ON`, no busy timeout, and no DDL, seed, or migration, so a call never waits on a writer's lock or on a migration. A missing file, one with no recorded schema version, or an older version reads as not ready and the call goes live, as before a first harvest; nothing is created, the connection closes, and the next call opens again, so a file a writer has just migrated is served without a restart. Only writers create or migrate the file: `runHarvest` (`mirror:init`, `mirror:refresh`, the cron's child) and `mirror:verify`, all through `MirrorStore.open`, and only one of them at a time (below). With the HTTP refresh cron, an older version that no writer is migrating starts one refresh child at once, so an upgrade does not wait for the next tick; otherwise the operator runs `mirror:refresh` or `mirror:verify`. Keeping migrations in the server was rejected because the rebuild ran on the request path and every server process that opened the file migrated it too. A reader busy timeout was rejected because the wait is synchronous on both drivers, and an `SQLITE_OPEN_READONLY` connection because `bun:sqlite` on macOS, which uses the system SQLite, cannot open a WAL file that way until its `-shm` and `-wal` files exist. See [#55](https://github.com/cyanheads/arxiv-mcp-server/issues/55).

**Decision — one writer creates or migrates a file.** Two writers that opened an older file at once used to both drop and refill `papers_fts`, and their interleaved refills corrupted it. A writer now applies the schema in one `BEGIN IMMEDIATE` transaction that re-reads `schema_version` under the lock. A file it creates records the current version in that same commit, so nothing ever sees a half-created file, or one at an older version on its way to the current one. A file on an older version is claimed in that transaction under a lease: the single row of `migration_lease` (holder token, pid, start, last renewal), which sits outside the schema version like the write-path index. The migration keeps its 5,000-row batches, each committed on its own; every batch transaction first checks that the lease still names this writer and renews it as it commits, and the transaction that records the new version drops it. A writer that opens meanwhile changes nothing and fails with `conflict` (`migration_in_progress`), naming the holder's pid and when its claim lapses. If the busy wait runs out first (dropping a full-corpus index is one long transaction), it reads the lease without the lock and reports the same. A lease left unrenewed for 5 minutes belongs to a writer that died; the next writer takes the migration over and restarts it from the step the recorded version names. A holder that had only stalled finds its lease gone at its next transaction and stops (`migration_lease_lost`), so no timing lets two writers rebuild the index together. The mirror scripts exit 75 (`EX_TEMPFAIL`) on either conflict, and the refresh child reports `skipped` and exits 0, so neither a cron tick nor the schema-upgrade trigger records a failure or starts another child. The reader reads the lease only on an older file, reports it as `migrating`, and starts no upgrade child while the lease is live. One write transaction across the whole migration was rejected because the WAL then holds the entire rebuilt index until it commits, gigabytes on a full corpus, where the batched rebuild's WAL stays near one batch. Having the second writer wait instead of failing was rejected because the cron child would spend its refresh budget idle behind a migration that runs for minutes on a full corpus. See [#71](https://github.com/cyanheads/arxiv-mcp-server/issues/71).

**Decision — every mirror SQL string runs one statement at a time.** Given several statements, `bun:sqlite`'s `exec` reports only the last one's result and runs on past an earlier failure, and a trailing newline counts as a further, empty statement, so under Bun a schema step or the write-path index could fail with no error. The schema constants are lists of single statements, each run through `prepare().run()` on both drivers: the first failure throws and nothing after it runs. Writer connections wait out another writer's lock for 5 s on both drivers (better-sqlite3's default, set explicitly on Bun), so a lock that now surfaces is waited for rather than failing at once. See [#64](https://github.com/cyanheads/arxiv-mcp-server/issues/64).

### Why does a refresh resume from the OAI resumption token?

An arXiv token already encodes the position inside a datestamp (`from=…&skip=N`), and pages arrive in datestamp order. Restarting at `from=last_datestamp` instead re-reads every page of that day, and a day with more records than one run applies never advances. A run that stopped before draining therefore resumes from its saved token. arXiv stamps each token with an `expirationDate` but never checks it, so a rejected token points to a fault upstream or in a proxy. After the etiquette delay, a rejected token falls back to `from=` the latest checkpointed datestamp, which is inclusive, so nothing is skipped. It does so once per checkpoint. A busy day spans several pages, so the restarted request can land on the same day again; if the next token is rejected too, restarting again would re-read that page until the cron child's budget ran out, or forever under `mirror:refresh` and `mirror:init`. A second rejection before the checkpoint advances fails the run with `token_recovery_stalled`, naming the token and the datestamp. Only a later checkpoint datestamp counts as progress, never re-applied records or a fresh token string. See [#50](https://github.com/cyanheads/arxiv-mcp-server/issues/50), [#59](https://github.com/cyanheads/arxiv-mcp-server/issues/59).

### Why does the refresh child stop itself before its budget?

A refresh killed at its wall-clock budget looked like a broken harvest, even though every page had been checkpointed. A signal also can't interrupt a synchronous SQLite transaction, so a SIGTERM waits until the page in hand finishes. The child instead stops starting pages once one worst-case page cycle (every fetch attempt at the request timeout, each retry wait at its cap, the etiquette delay, and the slowest apply so far) no longer fits. It then checkpoints and exits 0, and the parent resolves `partial`. The parent's SIGTERM and SIGKILL stay as the backstop for a child that overruns anyway. See [#39](https://github.com/cyanheads/arxiv-mcp-server/issues/39).

### Why does `mirror:init` wait out an outage while a refresh fails inside its budget?

A full harvest is about 2,500 pages at least 3 s apart: hours of work that an operator starts by hand. Each page fetch gets `PAGE_RETRY`'s three attempts, which alone let an outage of about a minute, or a 503 whose `Retry-After` passes the 30 s retry cap, end the run until someone reruns it. A longer `ARXIV_API_TIMEOUT_MS` doesn't help, since an outage needs a wait between requests rather than a longer wait on each. Init therefore waits. A page that still fails with `Timeout` or `ServiceUnavailable` (a request timeout, a network error, or a 5xx other than 501) waits 1 minute, doubling to 15, never shorter than the response's `Retry-After` (RFC 9110 delta-seconds or an HTTP-date; any other value is ignored) and back to 1 minute once a page lands. Then it re-sends the same request, because the token holds the exact position inside the day. There is no ceiling: one would only move the point where a long outage ends the harvest. Each wait is logged as a warning naming the request, the host, and the transport cause (`getaddrinfo ENOTFOUND <host>` for a mistyped `ARXIV_MIRROR_OAI_BASE_URL`), and SIGINT or SIGTERM ends a wait at once, leaving the `error` checkpoint the next init resumes from. A 4xx, a 501, an OAI protocol error, a page that fails to parse, and a stalled token recovery can't clear by waiting, so they still end the run with no wait. A 4xx ends it whether or not its body arrives: one whose body stalls or drops after the status fails as a failed request does, `Timeout` or `ServiceUnavailable` naming the host and the status, but it is sent once and never waited out. The status has already refused the request, and waiting out the stalled case would give a 4xx more patience when less of it arrived. A refresh keeps `PAGE_RETRY` alone. The cron child stops inside `ARXIV_MIRROR_REFRESH_TIMEOUT_MS` by reserving one worst-case page fetch, which an open-ended wait would break, and the next tick resumes from the checkpoint anyway. See [#61](https://github.com/cyanheads/arxiv-mcp-server/issues/61), [#72](https://github.com/cyanheads/arxiv-mcp-server/issues/72).

### Why does a broad free-text search go to the live API?

The mirror bounds every search it answers. Before a search with a free-text term, `MirrorStore.matchReachesCap` counts FTS matches, stopping at `MIRROR_SEARCH_MATCH_CAP` (50,000) without reading `papers`. At the cap the search goes to the live API for every sort order, and `total_results` is arXiv's own count. Under the cap the count and the page are driven from the FTS index, so no search ranks more than 50,000 matches. The cap trades more broad queries sent to the rate-limited live API for a tighter bound on every mirror search. The probe ignores category and date filters, which narrow the match set only row by row, after it is read. Category- and date-only searches skip the probe and stay on the mirror, on their index-backed paths. The probe and the search both run in the reader worker, off the request thread (next section). A live failure on a search over the cap is returned as-is, the recency bypass included: the mirror never answers a query over its cap. A caller cancellation on the recency bypass is rethrown whatever the query, so the framework reports it as `RequestCancelled` instead of a mirror answer nobody is waiting for. A failed recency bypass the mirror matches nothing for returns the live failure too: the bypass goes live for the newest papers, which the mirror may not hold yet, so its empty answer would read as "no papers found" and steer the caller away from a retry that can succeed. See [#68](https://github.com/cyanheads/arxiv-mcp-server/issues/68).

A capped count was rejected: an "at least N" total would change what `total_results` means and break the offset-past-the-end check. Ranking only the first N doclist entries was rejected too, since it favors the oldest papers. The FTS-driven page also made mirror relevance BM25 for the first time: the earlier `bm25()` ran on a cursor the `MATCH` didn't constrain, scored every row 0, and returned pages in harvest order. See [#49](https://github.com/cyanheads/arxiv-mcp-server/issues/49).

### Why do mirror searches run in a reader worker?

**Decision — the match-cap probe and `MirrorStore.search` run in one long-lived worker thread; the request thread posts the call and receives the page.** Both SQLite drivers are synchronous, so a statement run on the request thread holds every other call (`arxiv_list_categories`, an ID lookup, `GET /healthz`) until it returns. `searchInWorker` (`src/services/arxiv/mirror/reader.ts`) starts the worker on the first mirror search and reuses it. The worker opens its own `MirrorStore.openReader` connection and runs one search at a time, in arrival order. ID lookups and the harvest-state read stay on the request thread, bounded by primary key.

- **Cancellation.** A cancelled call settles at once with its signal's reason, which the framework reports as `RequestCancelled`. A call still queued is never posted. A statement already running finishes in the worker with its reply discarded, since neither driver can interrupt it.
- **Errors.** A store error crosses the thread with its name and message, and an `McpError` keeps its code and data, so an `fts5:` error still surfaces as `unsupported_query_syntax`. An exit or crash rejects the searches waiting on the worker with `ServiceUnavailable`. The worker's own open is reported as the request thread's is: a file it finds missing or on an older schema reads as not ready, and an open that throws logs a warning, so the store's error and the file's path never reach the caller. Either way the searches waiting on it go live. After any of these the next search starts a new worker.
- **Lifecycle.** The worker holds the process open only while a caller waits on it. `teardown` terminates it without waiting: a running statement holds the thread until it ends. Bun's process exit does not wait for it; Node's waits for the statement in progress, though not for the rest of the search.
- **Entry.** The worker entry sits beside the client and takes its extension: `.ts` from source under Vitest, `.js` from `dist/`.
- **Test seam.** `ArxivServiceOptions.mirrorSearcher` takes `searchInThread`, which runs the same two steps on the request thread's store, where a test can observe the store calls.

Sending mirror searches to the live API instead was rejected: most browsing would leave the mirror, arXiv refuses a `start` at or past 10,000, and it orders term-less `relevance` results differently. A pool of reader workers was left out. See [#58](https://github.com/cyanheads/arxiv-mcp-server/issues/58).

---

## Known Limitations

- **HTML availability varies.** Native arXiv HTML is default for Dec 2023+ and backfill reaches older papers, pre-2007 IDs included, but not all convert successfully. ar5iv covers more, though ~3% of papers fail conversion entirely — and because both run LaTeXML, they fail on largely the same submissions. Those papers are served from the PDF instead, and so are papers built from included PDFs, which both converters render as a placeholder sentence per file.
- **ar5iv bodies name no revision.** ar5iv keeps one render per paper, so a read that reaches it can return another revision than the one asked for, and nothing on its page or in its conversion log can confirm or rule out the requested one. The rung stays on every read, pinned or not, because ar5iv usually holds the latest revision; its body is flagged `revision_unconfirmed`, and `pdf_url` points at the revision asked for.
- **PDF extraction is text-only.** Extraction reads the PDF's text layer: prose survives, but math, tables, and heading structure flatten into the reading order the PDF encodes. Scanned or image-only submissions have no text layer at all and fail with `pdf_extraction_failed` — no OCR, no structured section/reference parsing, and an empty `outline`.
- **HTML responses are large.** Raw pages run 500KB-3MB+ for math-heavy papers, and the cleaned body is still HTML: 300KB-1MB+ is common. `max_characters` plus `start` are the size controls; `max_characters: null` lifts the bound for callers that can absorb a whole paper. LLMs handle HTML well, but callers should set reasonable limits for their context budget.
- **Rate limits are server-wide.** The 3-second delay is per arXiv API request across all concurrent tool calls, not per-agent. Under high concurrency, agents queue behind each other. This matches arXiv's policy but limits throughput. Content fetches hit separate hosts (arxiv.org/html, ar5iv, arxiv.org/pdf) and are not queued.
- **Paper ID normalization.** The arXiv API always returns IDs with a version suffix (e.g., `2401.12345v1`). Every ID input — `arxiv_get_metadata`, `arxiv_read_paper`, and the `arxiv://paper/{paperId}` resource after percent-decoding — runs through one parser (`normalizePaperId`) before any request. It accepts `YYMM.NNNN` (0704–1412) or `YYMM.NNNNN` (1501 on) and `archive/YYMMNNN`, each with an optional `vN`; the archive must be one of the 34 that issued old-style IDs before April 2007 (`hep-th`, `math`, `cond-mat`, …), since arXiv answers HTTP 400 for a whole `id_list` holding any other (`hepth/9901001`). It maps every spelling with one certain reading to the form arXiv answers to: a leading `arXiv:` (any case, optional space) is stripped, an arxiv.org `abs` / `pdf` (with or without `.pdf`) / `html` URL on `arxiv.org`, `www.arxiv.org`, or `export.arxiv.org` yields its ID — scheme optional, and a trailing slash, `?query`, or `#fragment` ignored (`arxiv.org/abs/2401.12345?context=cs.LG`, `https://arxiv.org/html/2401.12345v2#S3`) — the archive and `v` are lowercased, and an old-style subject class is dropped (`math.GT/0309136` → `math/0309136`, the only form arXiv resolves). Anything else is `invalid_id` and never reaches arXiv — where a foreign ID such as `biorxiv:…` would fail the whole `id_list` batch with HTTP 400. The canonical ID is what reaches `id_list` and both HTML endpoints. `id_list` and arxiv.org/html honor a version suffix; ar5iv does not — it keeps one render per paper and serves it for any suffix, so an ar5iv body carries `revision_unconfirmed: true` unless the read is unversioned and the paper's only version is v1. An ID that pins a version resolves only to that version: it never falls back to another version, and the mirror (which stores the latest version only) is a miss for it. An unversioned ID resolves to the latest version. Returned `id` fields always include the version, as do the `pdf_url` and `abstract_url` derived from them on both the mirror and live paths. A superseded old-style version arXiv's API answers HTTP 500 for is `version_not_served`, never `not_in_arxiv`, on every surface.
- **Atom XML quirks.** The arXiv API returns HTTP 200 for empty results, not-found IDs, and rate limiting alike, with varying response bodies; its HTTP 500s are a query reaching past result 10,000 and an `id_list` holding some superseded old-style versions (`version_not_served`). Rate limiting returns plain text "Rate exceeded." (content-type `text/plain`, not XML) — must check content-type before parsing. Additional quirks: `<id>` uses `http://` while `<link>` uses `https://`; `<summary>` has leading/trailing whitespace; version suffix (`v1`, `v7`) is always present in `<id>` and must be stripped for base paper ID; `<arxiv:primary_category>` lacks the `scheme` attribute that `<category>` has. Element text is read as text, never coerced to a number, so a title of `1.10` or a comment of `0` comes back as written; only the two `opensearch:` counters are converted. The mirror harvester parses the same way, so both paths return identical text. See [#45](https://github.com/cyanheads/arxiv-mcp-server/issues/45).
- **No real-time results.** arXiv updates daily. Search results reflect yesterday's index, not papers submitted today.

---

## API Reference

### arXiv API

- **Base URL:** `https://export.arxiv.org/api/query`
- **Parameters:** `search_query`, `id_list`, `start`, `max_results`, `sortBy`, `sortOrder`
- **Response:** Atom 1.0 XML with `opensearch:` extensions for pagination
- **Rate limit:** 3-second crawl delay; burst up to 4 req/sec but sustained ≤1/3s
- **Rate limit response:** Plain text "Rate exceeded." (HTTP 200, not XML)
- **Not found:** HTTP 200, empty feed with `totalResults=0`
- **Namespaces:** `http://www.w3.org/2005/Atom` (default), `http://arxiv.org/schemas/atom` (arxiv:), `http://a9.com/-/spec/opensearch/1.1/` (opensearch:)

### Search field prefixes

| Prefix | Field | Example |
|:-------|:------|:--------|
| `ti` | Title | `ti:attention mechanism` |
| `au` | Author | `au:bengio` |
| `abs` | Abstract | `abs:reinforcement learning` |
| `co` | Comment | `co:accepted at NeurIPS` |
| `jr` | Journal ref | `jr:Nature` |
| `cat` | Category | `cat:cs.AI` |
| `all` | All fields | `all:transformer` |

Every prefix in this table resolves on the mirror path too. `ti` / `au` / `abs` / `co` / `jr` map to the five columns of the `papers_fts` index (`comment` and `journal_ref` joined it in schema v3 — FTS5 has no `ALTER TABLE`, so the upgrade drops the index and its sync triggers and rebuilds both from the rows already stored); `all` fans out across all five, and an unprefixed term reaches them all the same way, as it does upstream. `cat` never reaches FTS at all — it is lifted into a structured filter against the `paper_categories` junction table. See [#37](https://github.com/cyanheads/arxiv-mcp-server/issues/37).

### HTML Content URLs

| Source | URL Pattern | Coverage |
|:-------|:------------|:---------|
| Native HTML | `https://arxiv.org/html/{id}` | Dec 2023+ (expanding) |
| ar5iv | `https://ar5iv.labs.arxiv.org/html/{id}` | Full corpus (~97% success), one render per paper whatever the version suffix |
| PDF | `https://arxiv.org/pdf/{id}` | All papers |

### Atom Entry Fields

| Element | Attribute | Description |
|:--------|:----------|:------------|
| `<id>` | — | Canonical URL: `http://arxiv.org/abs/{id}v{version}` |
| `<title>` | — | Paper title |
| `<summary>` | — | Full abstract |
| `<author><name>` | — | Author name (one per author) |
| `<published>` | — | Original submission date (ISO 8601) |
| `<updated>` | — | Last update date (ISO 8601) |
| `<category>` | `term` | Category code (one per category) |
| `<arxiv:primary_category>` | `term` | Primary category code |
| `<arxiv:comment>` | — | Author comment (pages, figures, conference) |
| `<arxiv:journal_ref>` | — | Journal reference |
| `<arxiv:doi>` | — | DOI identifier |
| `<link rel="alternate">` | `href` | Abstract page URL |
| `<link title="pdf">` | `href` | PDF download URL |
| `<link title="doi">` | `href` | DOI URL |

### Feed-Level Metadata

| Element | Description |
|:--------|:------------|
| `<opensearch:totalResults>` | Total matching papers |
| `<opensearch:startIndex>` | Current pagination offset |
| `<opensearch:itemsPerPage>` | Results in this response |
