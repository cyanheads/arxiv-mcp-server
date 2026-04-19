# Changelog

## 0.1.8 — 2026-04-19

Tool/resource quality improvements aligned with the new framework skill patterns, plus a dependency refresh.

### Added

- `arxiv_read_paper` `format()` now renders both `Abstract:` and `PDF:` URLs in `content[]` so chaining links are visible to LLM clients that don't surface `structuredContent`
- `arxiv_list_categories` `format()` prepends an operational header — `Showing N categories in group "X":` for filtered queries, `Showing N categories across M groups:` for the full taxonomy
- `formatPaper` (shared by search + get_metadata) renders the full categories list and appends `(updated YYYY-MM-DD)` when the paper has been revised
- Sparse-upstream test fixture (`ATOM_SPARSE`) and four new `formatPaper` tests covering trailing-pipe guards, multi-category rendering, and update-date branches

### Changed

- `paper.resource` throws `notFound()` factory instead of plain `Error` — error now surfaces as JSON-RPC `-32001 NotFound` instead of `-32603 InternalError`
- `formatPaper` filters empty meta segments — sparse upstream entries no longer produce trailing-pipe artifacts like `arXiv:X | cs.CL | `
- Updated `@cyanheads/mcp-ts-core` from `^0.2.10` to `^0.3.7`
- Updated `fast-xml-parser` from `^5.5.9` to `^5.7.1`
- Updated `@biomejs/biome`, `@types/node`, `typescript`, `vitest` to latest patch releases
- Synced project skills to framework 0.3.7 (added `add-app-tool`, updated 13 existing)

### Fixed

- Cleared transitive `vite` (8.0.3 → 8.0.8) and `lodash` (4.17.23 → 4.18.1) advisories by regenerating `bun.lock` — `bun audit` now clean

## 0.1.7 — 2026-03-30

Documentation, metadata, and public hosting updates.

### Added

- Public hosted instance at `https://arxiv.caseyjhand.com/mcp` — documented in README and `server.json` remotes
- npm and Docker badges in README header
- Funding links (GitHub Sponsors, Buy Me a Coffee) in `package.json`

### Changed

- Rewrote README tagline to be more descriptive and action-oriented
- Added "Public Hosted Instance" section with Streamable HTTP client config
- Renamed "MCP Client Configuration" to "Self-Hosted / Local" and simplified example (removed unnecessary env var)
- Updated author field in `package.json` with email and homepage
- Added `remotes` entry in `server.json` for the public Streamable HTTP endpoint

## 0.1.6 — 2026-03-30

Input validation and smarter content truncation.

### Changed

- `arxiv_read_paper` `max_characters` now defaults to 100,000 instead of being optional — prevents unbounded responses
- `arxiv_read_paper` strips HTML head/boilerplate before applying `max_characters` so the character budget targets actual paper content
- Added `.min(1)` input validation with descriptive error messages to `arxiv_search` query, `arxiv_get_metadata` paper_ids, and `arxiv_read_paper` paper_id

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
