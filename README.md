<div align="center">
  <h1>@cyanheads/arxiv-mcp-server</h1>
  <p><b>Search arXiv, fetch paper metadata, and read full-text content via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.5.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/arxiv-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/arxiv-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/arxiv-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/arxiv-mcp-server/releases/latest/download/arxiv-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=arxiv-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYXJ4aXYtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22arxiv-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Farxiv-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://arxiv.caseyjhand.com/mcp](https://arxiv.caseyjhand.com/mcp)

</div>

---

## Overview

arXiv papers, metadata, and full text from the arXiv API and its OAI-PMH metadata feed. Search papers by query, category, and submission date; fetch structured metadata by ID; and read full paper text with automatic fallback across HTML and PDF renders. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `arxiv_search` | Search arXiv papers by query with field prefixes, category, and date filters |
| `arxiv_get_metadata` | Fetch metadata for one or more papers by arXiv ID |
| `arxiv_read_paper` | Read full paper text via HTML, ar5iv, or PDF-extracted fallback |
| `arxiv_list_categories` | List the arXiv category taxonomy, optionally filtered by group |

### Resources

| Resource | Description |
|:---|:---|
| `arxiv://paper/{paperId}` | Paper metadata by arXiv ID |
| `arxiv://categories` | Full arXiv category taxonomy |

## Capability reference

### `arxiv_search` <sub>tool</sub>

- Field prefixes `ti:`, `au:`, `abs:`, `cat:`, `co:` (comment), `jr:` (journal ref), `all:` (all fields); boolean `AND` / `OR` / `ANDNOT`; query capped at 1000 characters
- `category` accepts a leaf code (`cs.CL`) or a whole archive (`astro-ph`, `cs`, `math`) — a bare archive matches its subject classes plus pre-subdivision legacy papers
- `sort_by` (`relevance` / `submitted` / `updated`) and `sort_order` (`ascending` / `descending`); up to 50 results per call (`max_results`)
- `submitted_from` / `submitted_to` bound submission date inclusively (UTC `YYYY-MM-DD`); consecutive windows cover matches with no gap — de-duplicate by ID at the seam — the way to reach results past the 10,000 `start` pagination ceiling
- Response enrichment echoes the effective query (every filter folded in, replayable), total match count, and page offset; empty or overshot pages carry recovery guidance instead of an error

---

### `arxiv_get_metadata` <sub>tool</sub>

- Up to 10 IDs per call (single string or array); versioned (`2401.12345v2`), unversioned, and legacy (`hep-th/9901001`) formats accepted
- Partial-batch results: found papers plus a typed `not_found[]` (`not_in_arxiv` / `version_not_in_mirror`) for the rest — never fails the whole batch for one bad ID
- Fails `no_match` only when every ID misses; fails `version_unavailable` when every miss is a mirror-only version gap reachable on the live API

---

### `arxiv_read_paper` <sub>tool</sub>

- Tries native arXiv HTML first, then ar5iv, then text extracted from the PDF — the `source` field reports which one answered
- Strips HTML head/boilerplate and collapses MathML to dollar-delimited LaTeX (`$…$` inline, `$$…$$` block) so the character budget targets paper content
- Returns raw HTML for HTML sources — the LLM interprets content directly; PDF-extracted bodies are plain text, so prose is reliable but math, tables, and heading structure flatten
- `max_characters` defaults to 100,000; pass `null` for the whole paper in one call. Raw HTML can run 500KB-3MB+ for math-heavy papers — page with `start` instead
- Typed failures: `content_unavailable` (no render, no PDF), `pdf_extraction_failed` (PDF has no text layer), `version_unavailable` (version-pinned ID needs the live API)

---

### `arxiv_list_categories` <sub>tool</sub>

- ~155 categories across 8 top-level groups (`cs`, `econ`, `eess`, `math`, `physics`, `q-bio`, `q-fin`, `stat`)
- Optional `group` filter to narrow results
- Static data — always succeeds

---

### `arxiv://paper/{paperId}` <sub>resource</sub>

- `paperId` accepts versioned, unversioned, and legacy formats — same resolution as `arxiv_get_metadata`
- Percent-encode a legacy ID's slash: `arxiv://paper/hep-th%2F9901001`
- Typed errors: `empty_id`, `no_match`, `version_unavailable`

---

### `arxiv://categories` <sub>resource</sub>

- Full arXiv category taxonomy as `{ categories: [...] }`, one flat array with `code` / `name` / `group` per entry
- Cacheable for 24h (`cacheHint.ttlMs: 86400000`), public scope
- No parameters

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

arXiv-specific:

- Read-only, no authentication required — arXiv API is free, metadata is CC0
- Sequential request queue enforcing arXiv's 3-second crawl delay; rate-limit responses (429, or 200 OK with a `Rate exceeded.` body) fail fast with a server-computed cooldown rather than retrying blindly
- Content fallback chain: `arxiv.org/html` → ar5iv → PDF text extraction, in that order — the `source` field reports which one answered
- Full arXiv category taxonomy embedded as static data
- Optional local OAI-PMH metadata mirror (SQLite + FTS5) — opt-in, eliminates rate-limit exposure for `arxiv_search` and `arxiv_get_metadata`. See [Optional: local mirror](#optional-local-mirror)

Agent-friendly output:

- Provenance on every read — `arxiv_read_paper`'s `source` field names which upstream artifact answered; `arxiv_search` echoes the effective query so results are reproducible
- Graceful partial failure — `arxiv_get_metadata` returns found papers alongside a typed `not_found[]` reason per miss instead of failing the whole batch
- Discriminated output contracts — typed `source` and `not_found[].reason` enums let callers branch on data, not string parsing

## Getting started

### Public Hosted Instance

A public instance is available at `https://arxiv.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "arxiv-mcp-server": {
      "type": "streamable-http",
      "url": "https://arxiv.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "arxiv-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/arxiv-mcp-server@latest"]
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "arxiv-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/arxiv-mcp-server@latest"]
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "arxiv-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/arxiv-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

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
| `ARXIV_CONTENT_TIMEOUT_MS` | Timeout for paper body fetches — HTML renders and PDF downloads (ms). | `30000` |
| `ARXIV_API_TIMEOUT_MS` | Timeout for API search/metadata requests (ms). | `15000` |
| `ARXIV_MIRROR_ENABLED` | Enable the local OAI-PMH metadata mirror for search and metadata. | `false` |
| `ARXIV_MIRROR_PATH` | SQLite path for the mirror. | `./data/arxiv-mirror.db` |
| `ARXIV_MIRROR_REFRESH_CRON` | UTC cron expression for in-process daily refresh (HTTP mode only). | unset |
| `ARXIV_MIRROR_FALLBACK_LIVE` | Fall through to live API on local ID-lookup miss. | `true` |
| `ARXIV_MIRROR_RECENT_DAYS_LIVE` | Positive values route every `sort_by=submitted`, descending query to the live API; `0` disables the bypass. | `2` |
| `ARXIV_MIRROR_OAI_BASE_URL` | arXiv OAI-PMH endpoint base URL. | `https://oaipmh.arxiv.org/oai` |
| `ARXIV_MIRROR_OAI_REQUEST_DELAY_MS` | Minimum delay between OAI-PMH requests (ms). | `3000` |
| `ARXIV_MIRROR_REFRESH_TIMEOUT_MS` | Abort budget for one scheduled refresh subprocess (ms). | `7200000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | `auto`, `stateful`, or `stateless`. The server declares `stateless` in `src/index.ts` — it holds no per-session state — so every run path resolves the same way unless this variable overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security audit
  bun run test       # Vitest test suite
  ```

### Optional: local mirror

For self-hosted deployments behind a single egress IP, arXiv's ~3-second crawl delay serializes concurrent users. An optional local mirror removes that rate-limit exposure for `arxiv_search` and `arxiv_get_metadata` by serving from a SQLite + FTS5 store harvested via OAI-PMH. `arxiv_read_paper` always uses the live API — full-content harvesting is against arXiv's data policy.

Disabled by default. To enable:

```sh
# 1. Cold-start harvest (~4.4h sequential, resumable from checkpoint). One-time per installation.
bun run mirror:init

# 2. Enable the mirror.
export ARXIV_MIRROR_ENABLED=true

# 3. Start the server — reads switch to the mirror once the harvest completes.
bun run start:http
```

Keep it current with `bun run mirror:refresh` (wire to cron/systemd/launchd, or set `ARXIV_MIRROR_REFRESH_CRON` to schedule it in-process in HTTP mode) and check integrity with `bun run mirror:verify`. A newer server migrates an existing mirror's schema in place on first open — never a re-harvest — and an upgrade that rebuilds the full-text index makes that first start noticeably slower on a full-corpus mirror; `mirror:verify` reports the schema version and exits non-zero if a migration didn't complete.

FTS5 BM25 ranking differs from arXiv's own relevance ranking, so `sort_by=relevance` returns a different top-K against the mirror than against the live API. The mirror serves only the latest version of each paper — a version-pinned request falls through to the live API. A stale or failed refresh keeps serving the last completed harvest rather than dropping to the live API mid-request.

### Docker

```sh
docker build -t arxiv-mcp-server .
docker run --rm -p 3010:3010 arxiv-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/arxiv-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and starts the optional mirror-refresh scheduler. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions` | Resource definitions (`*.resource.ts`). |
| `src/services/arxiv` | `ArxivService` — live arXiv API client (search, metadata, HTML). |
| `src/services/arxiv/mirror` | Optional OAI-PMH mirror — harvester, SQLite + FTS5 store, query translator, runner. |
| `scripts/arxiv-mirror-*.ts` | Mirror lifecycle scripts (`init`, `refresh`, `verify`). |
| `tests/` | Unit and integration tests. |
| `docs/` | Design document and directory structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- arXiv API returns HTTP 200 for everything — including rate limits — so check content-type and body before parsing
- Validate raw arXiv responses → normalize to domain types → return the output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
