# arXiv MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `arxiv_search` | Search arXiv papers by query with category and sort filters. | `query`, `category?`, `max_results?`, `sort_by?`, `sort_order?`, `start?` | `readOnlyHint: true` |
| `arxiv_get_metadata` | Get full metadata for one or more arXiv papers by ID. | `paper_ids` (string or string[]) | `readOnlyHint: true` |
| `arxiv_read_paper` | Fetch the full text content of an arXiv paper. Falls back from native HTML to ar5iv to PDF text extraction. | `paper_id`, `max_characters?`, `start?` | `readOnlyHint: true` |
| `arxiv_list_categories` | List arXiv category taxonomy, optionally filtered by group. | `group?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Delegates To |
|:-------------|:------------|:-------------|
| `arxiv://paper/{paperId}` | Paper metadata by arXiv ID. The segment is percent-decoded before lookup, so a legacy ID travels as `hep-th%2F9901001`; an ID that decodes to blank is rejected without an arXiv request. Returns `PaperMetadataSchema` as JSON text. | `ArxivService.getPapers([paperId])` |
| `arxiv://categories` | Full arXiv category taxonomy. Returns `{ categories: [...] }` as JSON text — one flat array of every category with its code, name, and group. Grouping is a `arxiv_list_categories` presentation concern, not a shape this resource emits. | Static taxonomy constant |

### Prompts

None for v1. This is a data-access server — the agent structures its own analysis workflows.

---

## Overview

An MCP server that wraps the arXiv academic paper repository, giving LLM agents the ability to search for papers, retrieve metadata, and read full paper content. Read-only, no authentication required.

**Data sources:**
- **arXiv API** (`export.arxiv.org/api/query`) — Atom XML feed returning paper metadata. Supports boolean search across fields (title, author, abstract, category), pagination, and sorting.
- **arXiv HTML** (`arxiv.org/html/{id}`) — Native LaTeXML-converted HTML of papers. Default for Dec 2023+ submissions; older papers back to ~2017 are being backfilled but coverage varies.
- **ar5iv HTML** (`ar5iv.labs.arxiv.org/html/{id}`) — Community-maintained HTML5 conversion covering the full corpus. ~97% at least partial conversion.
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

### `arxiv_search`

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
  max_results: z.number().min(1).max(50).default(10)
    .describe('Maximum results to return (1-50). Default 10. '
      + 'Each result includes title, authors, abstract, and metadata — '
      + 'keep low to manage context budget.'),
  sort_by: z.enum(['relevance', 'submitted', 'updated']).default('relevance')
    .describe('Sort criterion. Use "submitted" for newest papers, '
      + '"relevance" for best query matches. '
      + 'Maps to arXiv API: relevance→relevance, submitted→submittedDate, updated→lastUpdatedDate.'),
  sort_order: z.enum(['ascending', 'descending']).default('descending')
    .describe('Sort direction. "descending" returns newest/most relevant first.'),
  start: z.number().min(0).max(10_000).default(0)
    .describe('Pagination offset (0-10000). Use with max_results to page through results. '
      + 'E.g., start=10 with max_results=10 returns results 11-20.'),
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
  cap: z.number().optional(),
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

`start` caps at 10,000 because arXiv answers HTTP 500 for deeper offsets — verified live at `start=10050` and `start=50000`. Matches beyond `10,000 + max_results` are therefore unreachable by paging alone, so `submitted_from` / `submitted_to` carve the result set into independently pageable windows, and the truncation guidance names them once `totalFound` exceeds what paging can reach.

**Decision — a window's upper bound is midnight of the following day.** arXiv's `submittedDate:[A TO B]` takes `YYYYMMDDHHMM` stamps, includes both endpoints, and compares each against the paper's full-precision submission timestamp rather than a minute bucket (probed live: an upper bound of `…0339` includes a paper submitted at exactly `03:39:00Z`, while `…0149` excludes one at `01:49:16Z`). A same-day `…2359` bound would therefore drop every submission in that day's last 59 seconds into no window at all. Closing at the next midnight instead leaves adjacent windows sharing a single instant — a paper submitted at exactly `00:00:00Z` appears in both — which is the unavoidable residue of a doubly-inclusive operator and strictly preferable to a recurring hole. The mirror applies the identical instants as `published >= ? AND published <= ?`.

### `arxiv_get_metadata`

Get full metadata for one or more papers by arXiv ID. Use when you have known IDs (from citations, prior search results, or memory).

**Input:**

```ts
z.object({
  paper_ids: z.union([
    z.string(),
    z.array(z.string()).min(1).max(10),
  ]).describe(
    'arXiv paper ID or array of up to 10 IDs. '
    + 'Format: "2401.12345" or "2401.12345v2" (with version). '
    + 'Also accepts legacy IDs like "hep-th/9901001".'
  ),
})
```

**Output:**

```ts
z.object({
  papers: z.array(PaperMetadataSchema)
    .describe('Papers found. May be fewer than requested if some IDs are invalid.'),
  totalSucceeded: z.number(),
  not_found: z.array(z.object({
    id: z.string(),
    reason: z.enum(['not_in_arxiv', 'version_not_in_mirror']),
    detail: z.string().optional(),
  })).optional()
    .describe('Requested IDs that returned no data, each with the reason it was missed.'),
})
```

`version_not_in_mirror` distinguishes "unreachable from this deployment" from "absent from arXiv": the mirror stores the latest version only, so a version-pinned ID it lacks is a real paper the caller can still fetch with live fallback enabled or without the pin. `detail` names the version the mirror holds.

**Format:** Same structured block per paper as `arxiv_search`. Lists not-found IDs separately.

**Error modes:**

| Failure | Code | Recovery guidance |
|:--------|:-----|:-----------------|
| All IDs not found | `NotFound` | "No papers found for the given IDs. Verify ID format (e.g., '2401.12345' or '2401.12345v2')." |
| All IDs pin a version the mirror lacks, live fallback off | `ServiceUnavailable` | Request the version named in the error detail, or drop the version suffix. The IDs are valid — only unreachable in this configuration. |
| Partial success | Not an error | Return found papers + `not_found` array |
| Invalid ID format | `InvalidParams` | "Invalid arXiv ID format. Expected '2401.12345', '2401.12345v2', or 'hep-th/9901001'." |
| API unavailable | `ServiceUnavailable` | "arXiv API is temporarily unavailable. Try again in a few seconds." |

### `arxiv_read_paper`

Fetch the full body of an arXiv paper. Tries native arXiv HTML first, falls back to ar5iv, then to text extracted from the PDF. HTML bodies are returned raw — no parsing or extraction — and the LLM interprets the content directly.

**Input:**

```ts
z.object({
  paper_id: z.string()
    .describe('arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
  max_characters: z.number().int().min(1).nullable().default(100_000)
    .describe(
      'Maximum characters of paper body to return. '
      + 'Defaults to 100,000; null returns the entire body in one call. '
      + 'Raw HTML can be 500KB-3MB+ for math-heavy papers, which exceeds most '
      + 'clients tool-result size caps — prefer the default plus start-based paging. '
      + 'When truncated, a notice and total character count are included.'
    ),
  start: z.number().int().min(0).default(0)
    .describe('Character offset into the cleaned body to begin reading from.'),
})
```

The bounded default is deliberate: a default-unlimited read would be rejected client-side on a large paper with no content delivered, whereas truncation still returns a usable slice plus a continue hint. Unbounded reads stay available, but only when the caller asks for one.

**Output:**

```ts
z.object({
  paper_id: z.string().describe('arXiv paper ID.'),
  title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
  content: z.string()
    .describe('Paper body — cleaned HTML for arxiv_html/ar5iv, plain text for pdf_text.'),
  source: z.enum(['arxiv_html', 'ar5iv', 'pdf_text'])
    .describe('Which upstream artifact the body was read from.'),
  truncated: z.boolean()
    .describe('Whether content was truncated due to max_characters.'),
  start: z.number()
    .describe('Character offset of the first returned character within the cleaned body.'),
  total_characters: z.number()
    .describe('Character count of the body before cleaning.'),
  body_characters: z.number()
    .describe('Character count of the full cleaned body — the upper bound for start.'),
  pdf_url: z.string()
    .describe('Direct PDF download URL.'),
  abstract_url: z.string()
    .describe('arXiv abstract page URL for attribution.'),
})
```

**Format:** Returns raw HTML content with title and source attribution prepended. Appends truncation notice if applicable.

**Error modes:**

| Failure | Code | Recovery guidance |
|:--------|:-----|:-----------------|
| Paper not found | `NotFound` | "Paper '{id}' not found. Verify the ID format." |
| No HTML render and no PDF (`content_unavailable`) | `NotFound` | "Read the abstract via `arxiv_get_metadata` — no full-text artifact exists." |
| PDF has no text layer (`pdf_extraction_failed`) | `NotFound` | "Download `error.data.pdfUrl` and run OCR, or read the abstract via `arxiv_get_metadata`." |
| arXiv unavailable, or ar5iv unavailable with no PDF to cover for it | `ServiceUnavailable` | "Content service temporarily unavailable. Try again shortly." |

### `arxiv_list_categories`

List arXiv category codes and names. Useful for discovering valid category filters for `arxiv_search`.

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
| Paper (metadata) | Search by query | `export.arxiv.org/api/query?search_query=` | `arxiv_search` tool |
| Paper (metadata) | Get by ID(s) | `export.arxiv.org/api/query?id_list=` | `arxiv_get_metadata` tool + `arxiv://paper/{id}` resource |
| Paper (content) | Read full text | `arxiv.org/html/{id}` → `ar5iv.labs.arxiv.org/html/{id}` → `arxiv.org/pdf/{id}` | `arxiv_read_paper` tool |
| Category | List taxonomy | Static data embedded in server | `arxiv_list_categories` tool + `arxiv://categories` resource |

---

## Workflow Analysis

### Literature discovery

1. `arxiv_search` with topic query → discover relevant papers
2. `arxiv_get_metadata` for specific papers of interest → full metadata
3. `arxiv_read_paper` for papers worth deep reading → full text

### Citation following

1. `arxiv_read_paper` on a paper → extract referenced arXiv IDs from text
2. `arxiv_get_metadata` with extracted IDs → metadata for cited papers
3. Repeat for deeper citation chains

### Category exploration

1. `arxiv_list_categories` → discover relevant categories
2. `arxiv_search` with `cat:` prefix → recent papers in category

### Known paper lookup

1. `arxiv_get_metadata` with known ID(s) → metadata + abstract
2. `arxiv_read_paper` if full content needed

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ArxivService` | arXiv API (search + ID lookup), HTML content fetching | All 3 data tools (`arxiv_search`, `arxiv_get_metadata`, `arxiv_read_paper`) |

### ArxivService Design

Single service with three method groups:

```ts
class ArxivService {
  // API methods — Atom XML
  search(query: string, options: SearchOptions, ctx: Context): Promise<SearchResult>
  getPapers(ids: string[], ctx: Context): Promise<PaperLookupResult>

  // Content method — raw HTML fetch
  readContent(id: string, ctx: Context): Promise<PaperContent>
}
```

**Resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | `withRetry` wraps full pipeline: fetch + parse (XML) or fetch (HTML) |
| Backoff calibration | 1s base for API calls (rate-limited service), 2s for HTML content (heavier pages) |
| Rate limiting | Internal request queue enforcing 3-second delay between arXiv API calls. Content fetches (arxiv.org/html, ar5iv, arxiv.org/pdf) hit other hosts and don't share this queue. A 429 from the PDF fetch is still classified as `rate_limited` and records the shared cooldown rather than being read as a missing PDF. |
| Response classification | HTTP status first: 5xx → `ServiceUnavailable` (retried), 429 → `RateLimited`, other 4xx → `InvalidRequest`. Then, on a 2xx: an empty body → `ServiceUnavailable` (a transport symptom, retried); a non-XML body carrying `Rate exceeded.` → `RateLimited` (never retried, per the fail-fast policy); any other non-XML body → `SerializationError` (never retried). |
| Content fallback | `arxiv.org/html/{id}` first → on 404, try `ar5iv.labs.arxiv.org/html/{id}` → on any non-2xx, fetch `arxiv.org/pdf/{id}` and extract its text → throw NotFound only when the PDF is absent (`content_unavailable`) or holds no text layer (`pdf_extraction_failed`). Both HTML renders run LaTeXML, so they are not independent — a submission that breaks one usually breaks the other, which is why the PDF is the rung that widens coverage. An ar5iv 5xx, network error, or timeout does not end the chain: it is held and re-raised only when the PDF comes up empty too, so an outage on a third-party conversion service narrows coverage rather than failing the call. |
| HTML 404 detection | arxiv.org returns clean HTTP 404. ar5iv returns 307 redirect to arxiv.org/abs (which then 404s) — don't follow redirects on ar5iv, treat 3xx as not-found. |
| HTML page size | Raw HTML is 500KB-3MB+ for math-heavy papers. `max_characters` truncation keeps response size manageable. |
| Timeout | API calls: 15s, HTML fetches: 30s. Surface as `ServiceUnavailable`. Pass `ctx.signal` to all `fetch()` calls for cancellation. |

**API efficiency:**

| Concern | Decision |
|:--------|:---------|
| Batch fetching | `getPapers()` sends all IDs in a single `id_list=` request. Cross-references response entries against requested IDs to detect not-found, matching on the full versioned ID when the request pins a version so two versions of one paper stay in their own slots. |
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
| `ARXIV_CONTENT_TIMEOUT_MS` | No | `30000` | Timeout for HTML content fetches (ms) |
| `ARXIV_API_TIMEOUT_MS` | No | `15000` | Timeout for API search/metadata requests (ms) |

No API keys. No auth. `MCP_AUTH_MODE: none`.

---

## Implementation Order

1. **Config and server setup** — `server-config.ts` with Zod schema for env vars
2. **Static data** — Category taxonomy constant + `arxiv_list_categories` tool
3. **ArxivService** — XML parsing for API, raw HTML fetching for content, rate limiting, retry
4. **`arxiv_search` tool** — search via ArxivService
5. **`arxiv_get_metadata` tool** — ID lookup via ArxivService
6. **`arxiv_read_paper` tool** — content extraction via ArxivService
7. **Resources** — `arxiv://paper/{id}` and `arxiv://categories`
8. **Tests** — mock context tests for each tool, service integration tests

Each step is independently testable. Run `devcheck` after each addition.

---

## Design Decisions

### Why separate `arxiv_search` and `arxiv_get_metadata`?

Both use the same API endpoint (`/api/query`), but they serve different agent mental models: "find papers about X" vs "look up this specific paper." Search takes a query string with filters; get takes known IDs. Different parameter shapes, different use cases. The LLM naturally distinguishes between discovery and lookup.

### Why not consolidate into one tool with an `operation` enum?

Search and get-by-ID share almost no parameters. An operation enum would require most fields to be optional with complex conditional validation ("query required when operation=search, paper_ids required when operation=get"). This adds cognitive overhead for the LLM without reducing tool count meaningfully.

### Why cap `max_results` at 50?

The arXiv API supports up to 2000, but each result includes a full abstract. 50 papers with abstracts is already a substantial amount of text for an LLM context window. The agent can paginate with `start` for more results. Default of 10 keeps responses lightweight for the common case.

### Why one service instead of two?

The arXiv API and HTML content are separate data sources, but they share the rate limiting constraint (same infrastructure) and the paper ID as the common key. A single `ArxivService` keeps the rate limiter in one place and provides a coherent interface for "all things arXiv."

### Why no prompts?

This is a data-access server. The value is in search, metadata retrieval, and content extraction — not in structuring how the LLM thinks about papers. Agents have their own reasoning patterns for literature review, summarization, etc. Prompts would add surface area without adding capability.

---

## Known Limitations

- **HTML availability varies.** Native arXiv HTML is default for Dec 2023+ and backfill extends to older papers (~2017), but not all convert successfully. ar5iv covers more, though ~3% of papers fail conversion entirely — and because both run LaTeXML, they fail on largely the same submissions. Those papers are served from the PDF instead.
- **PDF extraction is text-only.** Extraction reads the PDF's text layer: prose survives, but math, tables, and heading structure flatten into the reading order the PDF encodes. Scanned or image-only submissions have no text layer at all and fail with `pdf_extraction_failed` — no OCR, no structured section/reference parsing.
- **Raw HTML responses are large.** Since we return unprocessed HTML, responses can be 500KB-3MB+ for math-heavy papers. `max_characters` plus `start` are the size controls; `max_characters: null` lifts the bound for callers that can absorb a whole paper. LLMs handle HTML well, but callers should set reasonable limits for their context budget.
- **Rate limits are server-wide.** The 3-second delay is per arXiv API request across all concurrent tool calls, not per-agent. Under high concurrency, agents queue behind each other. This matches arXiv's policy but limits throughput. Content fetches hit separate hosts (arxiv.org/html, ar5iv, arxiv.org/pdf) and are not queued.
- **Paper ID normalization.** The arXiv API always returns IDs with a version suffix (e.g., `2401.12345v1`). Inputs accept both `2401.12345` and `2401.12345v2` and are passed through to arXiv verbatim — `id_list` and the HTML endpoints both honor a version suffix. An ID that pins a version resolves only to that version: it never falls back to another version, and the mirror (which stores the latest version only) is a miss for it. An unversioned ID resolves to the latest version. Returned `id` fields always include the version, as do the `pdf_url` and `abstract_url` derived from them on both the mirror and live paths.
- **Atom XML quirks.** The arXiv API returns HTTP 200 for all cases — empty results, not-found IDs, and rate limiting all return 200 with varying response bodies. Rate limiting returns plain text "Rate exceeded." (content-type `text/plain`, not XML) — must check content-type before parsing. Additional quirks: `<id>` uses `http://` while `<link>` uses `https://`; `<summary>` has leading/trailing whitespace; version suffix (`v1`, `v7`) is always present in `<id>` and must be stripped for base paper ID; `<arxiv:primary_category>` lacks the `scheme` attribute that `<category>` has.
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
| ar5iv | `https://ar5iv.labs.arxiv.org/html/{id}` | Full corpus (~97% success) |
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
