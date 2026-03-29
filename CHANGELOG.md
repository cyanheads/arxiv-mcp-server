# Changelog

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
