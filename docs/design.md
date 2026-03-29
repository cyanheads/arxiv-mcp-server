# arXiv MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `arxiv_search` | Search arXiv papers by query with category and sort filters. | `query`, `category?`, `max_results?`, `sort_by?`, `sort_order?`, `start?` | `readOnlyHint: true` |
| `arxiv_get_metadata` | Get full metadata for one or more arXiv papers by ID. | `paper_ids` (string or string[]) | `readOnlyHint: true` |
| `arxiv_read_paper` | Fetch the full text content of an arXiv paper from its HTML rendering. Falls back from native HTML to ar5iv. | `paper_id`, `max_characters?` | `readOnlyHint: true` |
| `arxiv_list_categories` | List arXiv category taxonomy, optionally filtered by group. | `group?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Delegates To |
|:-------------|:------------|:-------------|
| `arxiv://paper/{paperId}` | Paper metadata by arXiv ID. Returns `PaperMetadataSchema` as JSON text. | `ArxivService.getPapers([paperId])` |
| `arxiv://categories` | Full arXiv category taxonomy. Returns grouped category list as JSON text. | Static taxonomy constant |

### Prompts

None for v1. This is a data-access server — the agent structures its own analysis workflows.

---

## Overview

An MCP server that wraps the arXiv academic paper repository, giving LLM agents the ability to search for papers, retrieve metadata, and read full paper content. Read-only, no authentication required.

**Data sources:**
- **arXiv API** (`export.arxiv.org/api/query`) — Atom XML feed returning paper metadata. Supports boolean search across fields (title, author, abstract, category), pagination, and sorting.
- **arXiv HTML** (`arxiv.org/html/{id}`) — Native LaTeXML-converted HTML of papers. Default for Dec 2023+ submissions; older papers back to ~2017 are being backfilled but coverage varies.
- **ar5iv HTML** (`ar5iv.labs.arxiv.org/html/{id}`) — Community-maintained HTML5 conversion covering the full corpus. ~97% at least partial conversion.

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
      'Filter by arXiv category (e.g., "cs.CL", "math.AG"). '
      + 'Prepended as "AND cat:{category}" to the query. '
      + 'Use arxiv_list_categories to discover valid codes.'
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
  start: z.number().min(0).default(0)
    .describe('Pagination offset. Use with max_results to page through results. '
      + 'E.g., start=10 with max_results=10 returns results 11-20.'),
})
```

**Output:**

```ts
z.object({
  total_results: z.number()
    .describe('Total matching papers (may exceed returned count due to pagination).'),
  start: z.number()
    .describe('Pagination offset of this result set.'),
  papers: z.array(PaperMetadataSchema)
    .describe('Matching papers with full metadata.'),
})
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

**Format:** Renders each paper as a structured block with title, authors, abstract, categories, dates, and links. Includes total count and pagination info.

**Error modes:**

| Failure | Code | Recovery guidance |
|:--------|:-----|:-----------------|
| arXiv API unavailable / rate limited | `ServiceUnavailable` | "arXiv API is temporarily unavailable. Try again in a few seconds." |
| Empty results | Not an error | Return `{ total_results: 0, papers: [] }` |

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
  not_found: z.array(z.string()).optional()
    .describe('Paper IDs that returned no results.'),
})
```

**Format:** Same structured block per paper as `arxiv_search`. Lists not-found IDs separately.

**Error modes:**

| Failure | Code | Recovery guidance |
|:--------|:-----|:-----------------|
| All IDs not found | `NotFound` | "No papers found for the given IDs. Verify ID format (e.g., '2401.12345' or '2401.12345v2')." |
| Partial success | Not an error | Return found papers + `not_found` array |
| Invalid ID format | `InvalidParams` | "Invalid arXiv ID format. Expected '2401.12345', '2401.12345v2', or 'hep-th/9901001'." |
| API unavailable | `ServiceUnavailable` | "arXiv API is temporarily unavailable. Try again in a few seconds." |

### `arxiv_read_paper`

Fetch the full HTML content of an arXiv paper. Tries native arXiv HTML first, falls back to ar5iv. Returns the raw HTML body — no parsing or extraction. The LLM interprets the content directly.

**Input:**

```ts
z.object({
  paper_id: z.string()
    .describe('arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
  max_characters: z.number().optional()
    .describe(
      'Maximum characters of content to return. '
      + 'Raw HTML can be 500KB-3MB+ for math-heavy papers. '
      + 'Recommended: set a limit based on your context budget. '
      + 'When truncated, a notice and total character count are included.'
    ),
})
```

**Output:**

```ts
z.object({
  paper_id: z.string().describe('arXiv paper ID.'),
  title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
  content: z.string().describe('Raw HTML content of the paper.'),
  source: z.enum(['arxiv_html', 'ar5iv'])
    .describe('Which HTML source the content was fetched from.'),
  truncated: z.boolean()
    .describe('Whether content was truncated due to max_characters.'),
  total_characters: z.number()
    .describe('Total character count of the full (untruncated) content.'),
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
| HTML not available (conversion failed) | `NotFound` | "HTML content not available for this paper. The PDF is available at {pdf_url}." |
| arXiv/ar5iv unavailable | `ServiceUnavailable` | "Content service temporarily unavailable. Try again shortly." |

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
| Paper (content) | Read full text | `arxiv.org/html/{id}` → `ar5iv.labs.arxiv.org/html/{id}` | `arxiv_read_paper` tool |
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
| Rate limiting | Internal request queue enforcing 3-second delay between arXiv API calls. HTML fetches to separate domains (arxiv.org/html, ar5iv) don't share this queue — different hosts, no shared rate limit. |
| Parse failure | Detect non-XML responses (e.g., "Rate exceeded." plain text) and throw transient error for retry |
| HTML fallback | `arxiv.org/html/{id}` first → on 404, try `ar5iv.labs.arxiv.org/html/{id}` → on non-200, throw NotFound |
| HTML 404 detection | arxiv.org returns clean HTTP 404. ar5iv returns 307 redirect to arxiv.org/abs (which then 404s) — don't follow redirects on ar5iv, treat 3xx as not-found. |
| HTML page size | Raw HTML is 500KB-3MB+ for math-heavy papers. `max_characters` truncation keeps response size manageable. |
| Timeout | API calls: 15s, HTML fetches: 30s. Surface as `ServiceUnavailable`. Pass `ctx.signal` to all `fetch()` calls for cancellation. |

**API efficiency:**

| Concern | Decision |
|:--------|:---------|
| Batch fetching | `getPapers()` sends all IDs in a single `id_list=` request. Cross-references response entries against requested IDs to detect not-found. |
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

- **HTML availability varies.** Native arXiv HTML is default for Dec 2023+ and backfill extends to older papers (~2017), but not all convert successfully. ar5iv covers more but ~3% of papers fail conversion entirely. Some papers have no HTML at all — the tool returns a NotFound with a PDF link fallback.
- **Raw HTML responses are large.** Since we return unprocessed HTML, responses can be 500KB-3MB+ for math-heavy papers. The `max_characters` parameter is the only size control. LLMs handle HTML well, but callers should set reasonable limits for their context budget.
- **No PDF text extraction.** The server does not parse PDFs. When HTML is unavailable, it returns the PDF URL and lets the consumer handle it. PDF extraction is complex, error-prone, and better handled by specialized tools.
- **Rate limits are server-wide.** The 3-second delay is per arXiv API request across all concurrent tool calls, not per-agent. Under high concurrency, agents queue behind each other. This matches arXiv's policy but limits throughput. HTML fetches hit separate hosts (arxiv.org/html, ar5iv) and are not queued.
- **Paper ID normalization.** The arXiv API always returns IDs with a version suffix (e.g., `2401.12345v1`). Inputs accept both `2401.12345` and `2401.12345v2`. The service normalizes input by stripping the version suffix for API queries and preserves the versioned ID from the response. Returned `id` fields always include the version.
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
