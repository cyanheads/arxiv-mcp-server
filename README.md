<div align="center">
  <h1>@cyanheads/arxiv-mcp-server</h1>
  <p><b>Search arXiv, fetch paper metadata, and read full-text content via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.2.11-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/arxiv-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/arxiv-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/arxiv-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/arxiv-mcp-server/releases/latest/download/arxiv-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=arxiv-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYXJ4aXYtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22arxiv-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/arxiv-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://arxiv.caseyjhand.com/mcp](https://arxiv.caseyjhand.com/mcp)

</div>

---

## Tools

Four tools for searching and reading arXiv papers:

| Tool Name | Description |
|:----------|:------------|
| `arxiv_search` | Search arXiv papers by query with category and sort filters. |
| `arxiv_get_metadata` | Get full metadata for one or more arXiv papers by ID. |
| `arxiv_read_paper` | Fetch the full text content of an arXiv paper from its HTML rendering. |
| `arxiv_list_categories` | List arXiv category taxonomy, optionally filtered by group. |

### `arxiv_search`

Search for papers using free-text queries with field prefixes and boolean operators.

- Field prefixes: `ti:` (title), `au:` (author), `abs:` (abstract), `cat:` (category), `all:` (all fields)
- Boolean operators: `AND`, `OR`, `ANDNOT`
- Optional category filter, sorting (relevance, submitted, updated), and pagination
- Returns up to 50 results per request with full metadata including abstract

---

### `arxiv_get_metadata`

Fetch full metadata for one or more papers by known arXiv ID.

- Batch fetch up to 10 papers in a single request
- Accepts both versioned (`2401.12345v2`) and unversioned (`2401.12345`) IDs
- Legacy ID format supported (`hep-th/9901001`)
- Reports not-found IDs separately from found papers

---

### `arxiv_read_paper`

Read the full HTML content of an arXiv paper.

- Tries native arXiv HTML first, falls back to ar5iv for broader coverage
- Strips HTML head/boilerplate and collapses MathML to dollar-delimited LaTeX (`$…$` inline, `$$…$$` block) so the character budget targets paper content
- `max_characters` defaults to 100,000; raw HTML can be 500KB-3MB+ for math-heavy papers
- Returns raw HTML — no parsing or extraction; the LLM interprets content directly

---

### `arxiv_list_categories`

List arXiv category codes and names for discovery.

- ~155 categories across 8 top-level groups (cs, math, physics, q-bio, q-fin, stat, eess, econ)
- Optional group filter to narrow results
- Static data — always succeeds

## Resources

| URI Pattern | Description |
|:------------|:------------|
| `arxiv://paper/{paperId}` | Paper metadata by arXiv ID. |
| `arxiv://categories` | Full arXiv category taxonomy. |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) from the same codebase

arXiv-specific:

- Read-only, no authentication required — arXiv API is free, metadata is CC0
- Rate-limited request queue enforcing arXiv's 3-second crawl delay
- Adaptive cooldown on rate-limit (5s → 10s → 20s → 30s), honors `Retry-After`
- Retry with exponential backoff for transient failures
- HTML content fallback chain: native arXiv HTML → ar5iv
- Full arXiv category taxonomy embedded as static data
- Optional local OAI-PMH metadata mirror (SQLite + FTS5) — opt-in, eliminates rate-limit exposure for `arxiv_search` and `arxiv_get_metadata`. See [Optional: Local Mirror](#optional-local-mirror).

## Getting Started

### Public Hosted Instance

A public instance is available at `https://arxiv.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "arxiv": {
      "type": "streamable-http",
      "url": "https://arxiv.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "arxiv": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/arxiv-mcp-server@latest"]
    }
  }
}
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher.

### Installation

1. **Clone the repository:**
```sh
git clone https://github.com/cyanheads/arxiv-mcp-server.git
```

2. **Navigate into the directory:**
```sh
cd arxiv-mcp-server
```

3. **Install dependencies:**
```sh
bun install
```

## Configuration

All configuration is optional — the server works out of the box with sensible defaults.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `ARXIV_API_BASE_URL` | arXiv API base URL. | `https://export.arxiv.org/api` |
| `ARXIV_REQUEST_DELAY_MS` | Minimum delay between arXiv API requests (ms). | `3000` |
| `ARXIV_CONTENT_TIMEOUT_MS` | Timeout for HTML content fetches (ms). | `30000` |
| `ARXIV_API_TIMEOUT_MS` | Timeout for API search/metadata requests (ms). | `15000` |
| `ARXIV_MIRROR_ENABLED` | Enable local OAI-PMH metadata mirror for search and metadata. | `false` |
| `ARXIV_MIRROR_PATH` | SQLite path for the mirror. | `./data/arxiv-mirror.db` |
| `ARXIV_MIRROR_REFRESH_CRON` | UTC cron expression for in-process daily refresh (HTTP mode only). | unset |
| `ARXIV_MIRROR_FALLBACK_LIVE` | Fall through to live API on local ID-lookup miss. | `true` |
| `ARXIV_MIRROR_RECENT_DAYS_LIVE` | Route `sortBy=submitted` descending queries within this window to the live API. | `2` |
| `ARXIV_MIRROR_OAI_BASE_URL` | arXiv OAI-PMH endpoint base URL. | `https://oaipmh.arxiv.org/oai` |
| `ARXIV_MIRROR_OAI_REQUEST_DELAY_MS` | Minimum delay between OAI-PMH requests (ms). | `3000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |

## Running the Server

### Local Development

- **Build and run:**
  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lint, format, typecheck, audit
  bun run test         # Vitest
  ```

### Optional: Local Mirror

For self-hosted deployments behind a single egress IP, arXiv's ~3-second per-IP crawl delay serializes concurrent users. An optional local mirror eliminates rate-limit exposure for `arxiv_search` and `arxiv_get_metadata` by serving from a SQLite + FTS5 store harvested via OAI-PMH. `arxiv_read_paper` continues to use the live API — full-content harvest is forbidden by arXiv's data policy.

Disabled by default. To enable:

```sh
# 1. Cold-start harvest (~4.4h sequential, resumable from checkpoint). One-time per installation.
bun run mirror:init

# 2. Enable the mirror.
export ARXIV_MIRROR_ENABLED=true

# 3. Start the server — reads switch to the mirror once the harvest completes.
bun run start:http
```

Daily incremental refresh (~30s, <1 page) via:

```sh
bun run mirror:refresh   # wire to cron / systemd timer / launchd, OR
                         # set ARXIV_MIRROR_REFRESH_CRON in HTTP mode to schedule in-process
bun run mirror:verify    # PRAGMA integrity_check + quick_check
```

**Behavior notes.** Ranking divergence: FTS5 BM25 differs from arXiv's internal ranking, so `sortBy=relevance` against the mirror returns a different top-K than the live API. Queries sorted by `submitted` descending within `ARXIV_MIRROR_RECENT_DAYS_LIVE` days route to the live API to cover the nightly-update gap. Refresh resilience: after the initial cold harvest completes, an in-progress or failed daily refresh keeps serving the existing dataset from the mirror — `arxiv_search` and `arxiv_get_metadata` don't drop to the live API during the refresh window ([#21](https://github.com/cyanheads/arxiv-mcp-server/issues/21)). The mirror stores the latest version only; per-version reads continue to use the live API. See [#12](https://github.com/cyanheads/arxiv-mcp-server/issues/12) for the full design.

### Docker

```sh
docker build -t arxiv-mcp-server .
docker run -p 3010:3010 arxiv-mcp-server
```

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/services/arxiv/` | `ArxivService` — live arXiv API client (search, metadata, HTML). |
| `src/services/arxiv/mirror/` | Optional OAI-PMH mirror — harvester, SQLite + FTS5 store, query translator, runner. |
| `src/config/` | Environment variable parsing and validation with Zod. |
| `scripts/arxiv-mirror-*.ts` | Mirror lifecycle scripts (`init`, `refresh`, `verify`). |
| `tests/` | Unit and integration tests. |
| `docs/` | Design document and directory structure. |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging
- Rate limiting is managed by `ArxivService` — don't add per-tool delays
- arXiv API returns HTTP 200 for everything — check content-type and response body

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
