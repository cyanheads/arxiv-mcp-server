# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
