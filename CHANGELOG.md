# Changelog

## 0.1.5 — 2026-03-30

Search reliability and dependency update.

### Changed

- Built arXiv API URLs without `URLSearchParams` encoding — raw colons in field prefixes (`ti:`, `au:`, `cat:`) are handled ~100x faster by arXiv than percent-encoded `%3A`
- Improved empty search results message with actionable suggestions (broader terms, field prefix removal, category code check)
- Updated `@cyanheads/mcp-ts-core` from ^0.2.9 to ^0.2.10

### Fixed

- Search queries with field prefixes (`ti:`, `au:`, `cat:`) no longer percent-encode colons, which caused arXiv API to return fewer or no results

## 0.1.4 — 2026-03-30

Dependency update, tool description cleanup, and modern API usage.

### Changed

- Updated `@cyanheads/mcp-ts-core` from ^0.2.8 to ^0.2.9
- Added `@opentelemetry/api` as dev dependency (peer dep of mcp-ts-core)
- Replaced string concatenation (`+`) with inline strings in all tool and field descriptions
- Replaced manual Map grouping with `Map.groupBy()` in `arxiv_list_categories` formatter
- Updated CLAUDE.md commands table: added `bun run lint:mcp`, fixed `bun test` → `bun run test`
- Regenerated `docs/tree.md`

## 0.1.3 — 2026-03-29

Added comprehensive test suite and finalized build/test configuration.

### Added

- Test suite with 9 test files covering all tools, resources, services, and domain types
  - Tool tests: `arxiv_search`, `arxiv_get_metadata`, `arxiv_read_paper`, `arxiv_list_categories`
  - Resource tests: `arxiv://paper/{paperId}`, `arxiv://categories`
  - Service tests: `ArxivService` (search, getPapers, readContent with mocked fetch), category taxonomy, shared formatters
- `ARXIV_CONTENT_TIMEOUT_MS` and `ARXIV_API_TIMEOUT_MS` env var definitions in `server.json`

### Changed

- Separated TypeScript build config: `rootDir` and `include` moved to `tsconfig.build.json`, `tsconfig.json` now includes `tests/**/*` for IDE support
- Narrowed Vitest test include pattern to `tests/**/*.test.ts` only
- Updated `CLAUDE.md` structure tree with `categories.ts`
- Regenerated `docs/tree.md` with test file structure

## 0.1.2 — 2026-03-28

Implemented the full MCP surface: all 4 tools, 2 resources, and the arXiv service layer.

### Added

- `ArxivService` — unified service for arXiv API queries, HTML content fetching, rate-limited request queue (3s crawl delay), and retry with exponential backoff
- `arxiv_search` tool — search papers by query with field prefixes, boolean operators, category filter, sorting, and pagination
- `arxiv_get_metadata` tool — batch lookup of paper metadata by arXiv ID (up to 10 per request)
- `arxiv_read_paper` tool — fetch full HTML content with native arXiv HTML → ar5iv fallback chain, optional `max_characters` truncation
- `arxiv_list_categories` tool — list ~155 arXiv categories across 8 groups, with optional group filter
- `arxiv://paper/{paperId}` resource — paper metadata by arXiv ID
- `arxiv://categories` resource — full category taxonomy as JSON
- `ServerConfig` — lazy-parsed Zod schema for arXiv-specific env vars (`ARXIV_API_BASE_URL`, `ARXIV_REQUEST_DELAY_MS`, `ARXIV_CONTENT_TIMEOUT_MS`, `ARXIV_API_TIMEOUT_MS`)
- `PaperMetadataSchema` — shared Zod schema for paper metadata used across tools and resources
- Static arXiv category taxonomy (~155 categories) embedded as typed data
- `fast-xml-parser` v5 dependency for Atom XML parsing

### Changed

- Entry point now registers all tool and resource definitions and initializes ArxivService in `setup()`
- Updated `docs/tree.md` to reflect implemented source structure

## 0.1.1 — 2026-03-28

Project metadata, documentation, and packaging finalized for initial publish.

### Added

- README with full tool/resource docs, configuration table, getting started guide, and project structure
- LICENSE file (Apache 2.0)
- `bunfig.toml` for Bun runtime and install configuration
- arXiv-specific environment variables in `.env.example`
- arXiv env vars (`ARXIV_API_BASE_URL`, `ARXIV_REQUEST_DELAY_MS`) in `server.json` package definitions
- OCI image labels (description, source) in Dockerfile

### Changed

- Scoped package name to `@cyanheads/arxiv-mcp-server`
- Server manifest name to `io.github.cyanheads/arxiv-mcp-server` with `bun` runtimeHint
- Package metadata: added description, keywords, repository/homepage/bugs URLs, author, bun engine requirement, packageManager
- Simplified CLAUDE.md context table — removed unused `ctx.elicit`, `ctx.sample`, `ctx.state`, `ctx.progress` references
- Regenerated `docs/tree.md` with current directory structure
- Added `tsx` to devcheck ignored dependencies

## 0.1.0 — 2026-03-28

Initial release. Scaffolded from `@cyanheads/mcp-ts-core` and designed the full MCP surface for arXiv paper search, metadata retrieval, and content reading.

### Added

- Project scaffold via `@cyanheads/mcp-ts-core` with stdio and HTTP transport support
- Design document (`docs/design.md`) covering tool schemas, service architecture, API reference, and domain decisions
- Agent protocol (`CLAUDE.md`) with arXiv-specific domain notes, patterns, error handling, and naming conventions
- Directory structure documentation (`docs/tree.md`)

### Designed (not yet implemented)

- `arxiv_search` — search papers by query with category and sort filters
- `arxiv_get_metadata` — lookup paper metadata by arXiv ID(s)
- `arxiv_read_paper` — fetch full HTML content with ar5iv fallback
- `arxiv_list_categories` — list arXiv category taxonomy
- `arxiv://paper/{paperId}` resource — paper metadata by ID
- `arxiv://categories` resource — full category taxonomy
- `ArxivService` — unified service for API queries, HTML content fetching, rate limiting, and retry
