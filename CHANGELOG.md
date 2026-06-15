# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [1.2.14](changelog/1.2.x/1.2.14.md) — 2026-06-15

Adopt @cyanheads/mcp-ts-core 0.10.6: server identity name/title, arxiv_search truncation disclosure, env booleans via z.stringbool(), MCPB bundle cleaner

## [1.2.13](changelog/1.2.x/1.2.13.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21: per-request log context fix, secret redaction in fetchWithTimeout, withRetry fail-fast on non-retryable errors

## [1.2.12](changelog/1.2.x/1.2.12.md) — 2026-06-01

Scheduled mirror refresh runs in a child process — harvest SQLite writes no longer block the request event loop

## [1.2.11](changelog/1.2.x/1.2.11.md) — 2026-05-31

Incremental and failed mirror refreshes no longer drop arxiv_search to the rate-limited live API

## [1.2.10](changelog/1.2.x/1.2.10.md) — 2026-05-30

arxiv_search and arxiv_list_categories surface query echoes, true result totals, and empty-result guidance in a typed enrichment block

## [1.2.9](changelog/1.2.x/1.2.9.md) — 2026-05-29

mirror schema v2: ISO 8601 date normalization for chronological sort (#18), index-backed category filter via junction table (#19)

## [1.2.8](changelog/1.2.x/1.2.8.md) — 2026-05-28

mcp-ts-core ^0.9.6 → ^0.9.13: 413 body cap, HTTP session-init gate, quieter client-error logging, GET /mcp keywords

## [1.2.7](changelog/1.2.x/1.2.7.md) — 2026-05-26

Mirror fallback when live API fails: search recency bypass and readContent metadata paths now recover gracefully instead of surfacing upstream errors.

## [1.2.6](changelog/1.2.x/1.2.6.md) — 2026-05-23

mcp-ts-core ^0.9.1 → ^0.9.6. Error factories in harvester (McpError → validationError/notFound). manifest.json and .mcpbignore scaffolded for MCPB bundle support. Skills synced. fast-xml-parser unpinned.

## [1.2.5](changelog/1.2.x/1.2.5.md) — 2026-05-22

Mirror translator's `cat:` extraction no longer leaves dangling boolean operators or empty `( )` groups inside parens ([#14](https://github.com/cyanheads/arxiv-mcp-server/issues/14)). New `cleanupDanglingOps` post-pass collapses empty groups and drops orphaned operators to a fixed point, covering all six failing shapes from the issue.

## [1.2.4](changelog/1.2.x/1.2.4.md) — 2026-05-22

Mirror query translator inserts explicit `AND` at every parenthesis boundary so `all:` expansions and user-typed groups stop emitting FTS5-invalid expressions. Defense-in-depth catch in `ArxivService.searchMirror` rethrows any leaked `fts5:` SQLiteError as `validationError` with the original query and recovery hint.

## [1.2.3](changelog/1.2.x/1.2.3.md) — 2026-05-21

Dockerfile production stage writes a minimal `tsconfig.json` mapping `@/*` → `./dist/*` so Bun resolves the path alias the mirror scripts import through. v1.2.2 shipped the scripts but Bun couldn't resolve `@/config/server-config.js`. Final piece for an end-to-end deployable mirror.

## [1.2.2](changelog/1.2.x/1.2.2.md) — 2026-05-21

Ship the `mirror:*` scripts in the published artifacts. v1.2.0 added `scripts/arxiv-mirror-{init,refresh,verify}.ts` but omitted them from the Docker production stage and the npm `files` array — `bun run mirror:init` failed with `Module not found` inside the container and in npm-installed copies. Runtime code unchanged; packaging only.

## [1.2.1](changelog/1.2.x/1.2.1.md) — 2026-05-21

Dockerfile build stage adds `--ignore-scripts` to `bun install` so `better-sqlite3`'s `node-gyp` native build doesn't fail in the `oven/bun:1.3` base image (no `python3`/`make`/`g++`). Runtime is Bun-only and uses `bun:sqlite`, so the compiled binary is never loaded — skipping it is strictly an improvement. No source changes.

## [1.2.0](changelog/1.2.x/1.2.0.md) — 2026-05-21

Optional OAI-PMH metadata mirror for `arxiv_search` and `arxiv_get_metadata` — local SQLite + FTS5 eliminates per-IP rate-limit exposure. Opt-in via `ARXIV_MIRROR_ENABLED=true` and `bun run mirror:init` (~4.4h cold harvest). Falls back to the live API on incomplete harvest or lookup miss; `arxiv_read_paper` still uses the live API.

## [0.1.19](changelog/0.1.x/0.1.19.md) — 2026-05-18

Field-test fixes from issues #4 — #10: `arxiv_get_metadata` preserves input order; `arxiv_read_paper` honors version suffix in HTML URLs and collapses MathML to dollar-delimited LaTeX (2-3× shrink); category suggestions rank by edit distance; rate-limit cooldown grows geometrically (5s → 10s → 20s → 30s capped) per consecutive hit.

## [0.1.18](changelog/0.1.x/0.1.18.md) — 2026-05-16

Adopt server-level `instructions` from `@cyanheads/mcp-ts-core` 0.9.x — spec-compliant clients now forward arXiv tool orientation to the model on every `initialize`. Framework refresh 0.8.19 → 0.9.1 (portability lint family, Workers `nodejs_compat` boot fix, SSRF hardening, changelog summary cap 250 → 350 chars).

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-05-08

Fix retry storm on AbortSignal.timeout — connection-layer arXiv throttle now classified as Timeout (non-retryable) instead of ServiceUnavailable (retryable), cutting caller-visible latency from 60-90s to 15s. Framework refresh 0.8.15 → 0.8.19.

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-05-05

Error-contract conformance pass — every non-baseline throw on every API-using surface now carries a typed contract entry and resolves its recovery hint at runtime. Bumps mcp-ts-core 0.8.7 → 0.8.15.

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-04-30

arxiv_read_paper adds `start` offset for chunk-by-chunk pagination on long papers; HTML cleaner preserves ltx_section/title structural markers; description clarifies arxiv.org/html → ar5iv fallback (no PDF auto-extract)

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-04-30 · ⚠️ Breaking

Bump @cyanheads/mcp-ts-core 0.7.5 → 0.8.7; typed error contracts on every tool/resource; arxiv_get_metadata adopts partialResult; fixes arxiv_search retry-storm on rate-limit (#8) — fail-fast + Retry-After cooldown + User-Agent

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-04-27

Bump @cyanheads/mcp-ts-core 0.6.17 → 0.7.5; arxiv_search validates categories with near-match suggestions and parens-scopes multi-word queries to prevent category leakage; arxiv_read_paper strips LaTeXML noise (3-4× shrinkage)

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-04-24

Bump @cyanheads/mcp-ts-core 0.6.16 → 0.6.17 (HTTP transport hardening) and adopt upstream CLAUDE.md guidance on external API wrapping and format() parity

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-04-24

Fail fast on permanent 4xx from arXiv API, and harden arxiv_search / arxiv_read_paper input schemas to reject values arXiv would return 400/500 for

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-04-24

Framework refresh to @cyanheads/mcp-ts-core 0.6.16 — adopted directory-based changelog, recursive describe-on-fields lint fixes, synced skills/scripts

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-04-20

Framework refresh to @cyanheads/mcp-ts-core 0.5.3 — format-parity fixes across tools, parseEnvConfig for better env-var validation errors

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-04-19

Tool/resource quality improvements aligned with new framework skill patterns, plus a dependency refresh to mcp-ts-core 0.3.7

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-03-30

Public hosted instance at arxiv.caseyjhand.com/mcp, README tagline rewrite, npm/Docker badges, funding links

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-03-30

arxiv_read_paper max_characters defaults to 100k, strips HTML head/boilerplate before truncation, descriptive input validation

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-03-30

Search reliability — raw-colon field prefixes instead of percent-encoded, better empty-result messaging, mcp-ts-core 0.2.10

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-03-30

mcp-ts-core 0.2.9 refresh, description cleanup (no string concat), Map.groupBy() modernization

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-03-29

Comprehensive test suite (9 files, all tools/resources/services covered); finalized TypeScript build and Vitest config

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-03-28

Full MCP surface implemented — 4 tools, 2 resources, ArxivService with rate-limited request queue and HTML fallback chain

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-03-28

Project metadata, documentation, and packaging finalized for initial publish — README, LICENSE, scoped package name

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-03-28

Initial release — scaffolded from @cyanheads/mcp-ts-core with full MCP surface design for arXiv paper search, metadata, and content reading
