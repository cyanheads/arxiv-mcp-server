# arXiv MCP Server — Research Handoff

Research notes for building an arXiv MCP server using the mcp-ts-core framework. Covers API capabilities, content formats, rate limits, licensing, and recommended tool design.

## arXiv API Overview

Base URL: `http://export.arxiv.org/api/query` (use `export.` for programmatic access)

The API is a **metadata search interface** — it returns Atom 1.0 XML with paper metadata, not full paper content. Queries support boolean logic, field-specific search, date ranges, sorting, and pagination.

### Query Parameters

| Param | Purpose | Example |
|-------|---------|---------|
| `search_query` | Boolean search across fields | `all:transformer+AND+cat:cs.CL` |
| `id_list` | Fetch specific papers by ID | `2401.12345,2401.12346` |
| `start` | Pagination offset | `0` |
| `max_results` | Results per page (max 2000) | `100` |
| `sortBy` | `relevance`, `lastUpdatedDate`, `submittedDate` | `submittedDate` |
| `sortOrder` | `ascending`, `descending` | `descending` |

### Search Fields

| Prefix | Field |
|--------|-------|
| `ti` | Title |
| `au` | Author |
| `abs` | Abstract |
| `co` | Comment |
| `jr` | Journal ref |
| `cat` | Category (e.g., `cs.AI`, `math.CO`) |
| `all` | All fields |

### Response Format (Atom XML)

Each `<entry>` contains:

- `<id>` — canonical URL (`http://arxiv.org/abs/2401.12345v1`)
- `<title>` — paper title
- `<summary>` — full abstract text
- `<author><name>` — author names
- `<published>` / `<updated>` — ISO timestamps
- `<arxiv:primary_category>` — primary subject
- `<category>` — all categories
- `<link title="pdf">` — PDF URL
- `<link rel="alternate">` — abstract page URL
- `<arxiv:doi>` — DOI if available
- `<arxiv:journal_ref>` — journal reference if published

## Content Access (Beyond Metadata)

The API does **not** return full paper content. Content must be fetched separately by constructing URLs from paper IDs.

### Available Formats

| Format | URL Pattern | Coverage | Notes |
|--------|-------------|----------|-------|
| Native HTML | `arxiv.org/html/{id}` | Dec 2023+ submissions, gradual backfill | LaTeXML conversion; not all papers convert successfully |
| ar5iv HTML5 | `ar5iv.labs.arxiv.org/abs/{id}` | Full corpus through Feb 2026 | ~74% clean conversion, ~97% at least partial. Semi-official (arXiv Labs branding) |
| PDF | `arxiv.org/pdf/{id}` | All papers | Direct download |
| TeX source | `arxiv.org/e-print/{id}` | All TeX submissions | Gzipped tar |

**Recommendation**: Try `arxiv.org/html/{id}` first, fall back to ar5iv, then PDF link as last resort. HTML is parseable and much more useful for an LLM consumer than PDF.

### HTML Content Quality

The HTML versions are full LaTeXML conversions — equations (MathML), figures, tables, references, sections. Not just abstracts. Real structured content suitable for text extraction.

## Rate Limits

| Rule | Detail |
|------|--------|
| Crawl delay | 3 seconds between API requests |
| Burst | Up to 4 req/sec momentarily, but sustained rate must average ≤1/3s |
| Batch size | Up to 2000 results per request (`max_results=2000`) |
| Max depth | 30,000 results total per query (pagination ceiling) |
| Cache cycle | Daily — results update once per day, so aggressive caching is fine |
| Bulk access | S3 buckets available for PDF and source (not HTML) |

The 3-second delay is per-request, but 2000 results/page means you rarely need many requests. A single search returning 100 results is one request. Redis caching with 24-hour TTL aligns with their daily update cycle.

## Licensing

| What | License | Implications |
|------|---------|--------------|
| Metadata (API responses) | CC0 (public domain) | No restrictions whatsoever |
| Paper content | Varies per paper (author-chosen) | Most are CC-BY or similar, but not guaranteed |
| arXiv API usage | Free, requires attribution | Include `arXiv.org` attribution in responses |

**For an MCP server**: Serving metadata and abstracts is completely clear (CC0). Serving full paper content is fine as long as you're proxying/linking, not redistributing. The server should return content with attribution and link to the original. No legal issues with this model — it's the same as any search interface.

## Recommended MCP Tool Design

### Tools

| Tool | Purpose | Data Source |
|------|---------|-------------|
| `search_papers` | Search by query, category, date range | arXiv API |
| `get_paper` | Get full metadata for specific paper ID(s) | arXiv API (`id_list`) |
| `get_paper_content` | Fetch HTML content of a paper | `arxiv.org/html/{id}` with ar5iv fallback |
| `list_categories` | Return arXiv category taxonomy | Static data |

### `search_papers` Input Schema

```typescript
{
  query: string;           // free-text or field-prefixed (e.g., "au:bengio+AND+ti:attention")
  category?: string;       // e.g., "cs.AI", "math.CO"
  max_results?: number;    // default 10, max 2000
  sort_by?: "relevance" | "submitted" | "updated";
  sort_order?: "ascending" | "descending";
  start?: number;          // pagination offset
}
```

### `get_paper` Input Schema

```typescript
{
  ids: string[];  // arXiv IDs, e.g., ["2401.12345", "2401.12346v2"]
}
```

### `get_paper_content` Input Schema

```typescript
{
  id: string;              // arXiv ID
  format?: "html" | "abstract_only";  // default "html"
  max_length?: number;     // truncate extracted text (token budget management)
}
```

### Response Design Notes

- **search_papers** should return structured results: id, title, authors, abstract, categories, dates, links. Not raw XML.
- **get_paper_content** should extract the article body text from HTML, strip navigation/headers, and return clean text with section structure preserved. Include a truncation notice if `max_length` is hit.
- All responses should include `arXiv:{id}` attribution and link to the abstract page.
- Consider returning abstract in search results but making full content a separate tool call — keeps search responses lightweight.

### Caching Strategy

| What | TTL | Rationale |
|------|-----|-----------|
| Search results | 24 hours | arXiv updates daily |
| Paper metadata | 7 days | Metadata is stable after publication |
| Paper HTML content | 7 days | Content doesn't change (versioned by `v1`, `v2`, etc.) |

Redis is already deployed on the Hostinger VPS (port 6379). Use it.

### Infrastructure

Follows the existing pattern for hosted MCP servers:

- Docker container with Bun runtime
- Port allocation: next available in the 3001-3099 Hostinger range
- Cloudflare Tunnel exposure: `arxiv.caseyjhand.com`
- Cloudflare rules: WAF Skip (SBFM) + Config Rule (security off) + Rate Limit (60/min/IP)
- OTel instrumentation for VictoriaMetrics/Tempo
- `MCP_AUTH_MODE: none` — read-only public data, safe for unauthenticated access

### Open Questions

1. **ar5iv vs native HTML**: Which to prefer as primary? Native HTML is official but has gaps in older papers. ar5iv has broader coverage but is batch-converted periodically.
2. **Content extraction depth**: Full paper text can be very long. Need a sensible default `max_length` and/or section-based extraction (e.g., return intro + conclusion only).
3. **Category search UX**: Should `list_categories` be a tool, or should category codes be documented in tool descriptions so the LLM can construct queries directly?
4. **PDF fallback**: Worth implementing PDF text extraction as a last resort, or just return the PDF link and let the consumer handle it?
