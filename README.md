<div align="center">
  <h1>@cyanheads/arxiv-mcp-server</h1>
  <p><b>Search arXiv, fetch paper metadata, and read full-text content via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.6.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/arxiv-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/arxiv-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/arxiv-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `arxiv_search_papers` | Search arXiv papers by query with field prefixes, category, and date filters |
| `arxiv_get_metadata` | Fetch metadata for one or more papers by arXiv ID |
| `arxiv_read_paper` | Read full paper text via HTML, ar5iv, or PDF-extracted fallback |
| `arxiv_list_categories` | List the arXiv category taxonomy, optionally filtered by group |

### Resources

| Resource | Description |
|:---|:---|
| `arxiv://paper/{paperId}` | Paper metadata by arXiv ID |
| `arxiv://categories` | Full arXiv category taxonomy |

## Capability reference

### `arxiv_search_papers` <sub>tool</sub>

- Query supports field prefixes `ti:`, `au:`, `abs:`, `cat:`, `co:`, `jr:`, `all:` and `AND` / `OR` / `ANDNOT`, up to 1000 characters; `category` takes a code (`cs.CL`) or a whole archive (`astro-ph`, `cs`, `math`)
- Sorts by `sort_by` (`relevance` / `submitted` / `updated`) and `sort_order`, with `submitted_from` / `submitted_to` as inclusive UTC `YYYY-MM-DD` bounds; up to 50 results per call (a larger `max_results` returns 50)
- arXiv serves only the first 10,000 results of a query; a `start` of 10,000 fails `start_beyond_result_limit`. Use date windows to go further
- Output echoes the effective query, total match count, and page offset; empty pages carry recovery guidance instead of an error

---

### `arxiv_get_metadata` <sub>tool</sub>

- Takes up to 100 IDs and looks up the first 10; the rest come back in `remaining_ids` for the next call's `paper_ids`
- Accepts versioned (`2401.12345v2`), unversioned, and pre-2007 (`hep-th/9901001`) IDs, with an optional `arXiv:` prefix or an arxiv.org `abs` / `pdf` / `html` URL
- Returns found papers plus a typed `not_found[]` (`not_in_arxiv` / `version_not_in_mirror` / `version_not_served` / `live_lookup_failed` / `invalid_id`) for the rest; `version_not_served` is a superseded pre-2007 version arXiv's API answers HTTP 500 for, and its `detail` names the latest version. With the local mirror, `live_lookup_failed` marks an ID the mirror lacked whose live lookup failed; the papers the mirror served still come back
- Fails `invalid_id` when no ID is well-formed, `no_match` when every ID misses, `version_unavailable` when a version is reachable only on the live API, and `version_not_served` when every ID is a version arXiv will not serve

---

### `arxiv_read_paper` <sub>tool</sub>

- Tries arXiv HTML, then ar5iv, then PDF text extraction; the `source` field reports which answered. PDF text is plain, so math, tables, and headings flatten
- ar5iv keeps one render per paper, so an ar5iv body may be another revision than `paper_id` and carries `revision_unconfirmed: true`, unless the read named no version and the paper's only version is v1; `pdf_url` is exactly the `paper_id` revision
- `max_characters` defaults to 100,000 (pass `null` for the whole paper); page with `start`. The first page carries an `outline` of section headings with offsets
- `paper_id` accepts the same ID spellings as `arxiv_get_metadata`
- Fails `invalid_id`, `content_unavailable` (no render, no PDF), `pdf_extraction_failed` (no text layer), `version_unavailable` (version-pinned ID needs the live API), or `version_not_served` (a superseded pre-2007 version arXiv will not serve; names the latest version and this version's PDF)

---

### `arxiv_list_categories` <sub>tool</sub>

- ~155 categories across 8 top-level groups (`cs`, `econ`, `eess`, `math`, `physics`, `q-bio`, `q-fin`, `stat`)
- Optional `group` filter to narrow results
- Static data — always succeeds

---

### `arxiv://paper/{paperId}` <sub>resource</sub>

- `paperId` accepts the same ID spellings as `arxiv_get_metadata`; percent-encode a legacy ID's slash (`arxiv://paper/hep-th%2F9901001`)
- Fails `empty_id`, `invalid_id`, `no_match`, `version_unavailable`, or `version_not_served`

---

### `arxiv://categories` <sub>resource</sub>

- Returns `{ categories: [...] }`, a flat array with `code` / `name` / `group` per entry
- No parameters; cacheable for 24h

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

arXiv-specific:

- Read-only, no authentication required
- Request queue enforcing arXiv's 3-second crawl delay; rate-limit responses fail fast with a cooldown
- Paper text falls back from arXiv HTML to ar5iv to PDF extraction
- Full arXiv category taxonomy embedded as static data
- Optional local OAI-PMH metadata mirror (SQLite + FTS5) that removes rate-limit exposure for search and metadata. See [Optional: local mirror](#optional-local-mirror)

Agent-friendly output:

- `arxiv_read_paper` names its `source`; `arxiv_search_papers` echoes the effective query
- `arxiv_get_metadata` returns found papers with a typed `not_found[]` reason per miss
- Typed `source` and `not_found[].reason` enums let callers branch on data

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
| `ARXIV_READ_TIMEOUT_MS` | Time budget for one `arxiv_read_paper` call — its metadata lookup and every content request and retry (ms). Keep it under your MCP client's request timeout (60 s by default). | `50000` |
| `ARXIV_MIRROR_ENABLED` | Enable the local OAI-PMH metadata mirror. | `false` |
| `ARXIV_MIRROR_PATH` | SQLite path for the mirror. | `./data/arxiv-mirror.db` |
| `ARXIV_MIRROR_REFRESH_CRON` | UTC cron expression for in-process daily refresh (HTTP mode only). | unset |
| `ARXIV_MIRROR_FALLBACK_LIVE` | Fall through to the live API on a local ID-lookup miss. | `true` |
| `ARXIV_MIRROR_RECENT_DAYS_LIVE` | Positive values send `sort_by=submitted`, descending queries to the live API; `0` disables. | `2` |
| `ARXIV_MIRROR_OAI_BASE_URL` | arXiv OAI-PMH endpoint base URL. | `https://oaipmh.arxiv.org/oai` |
| `ARXIV_MIRROR_OAI_REQUEST_DELAY_MS` | Minimum delay between OAI-PMH requests (ms). | `3000` |
| `ARXIV_MIRROR_REFRESH_TIMEOUT_MS` | Time budget for one scheduled refresh (ms). | `7200000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | `auto`, `stateful`, or `stateless`. | `stateless` |
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

For self-hosted deployments behind a single egress IP, arXiv's ~3-second crawl delay serializes concurrent users. An optional local mirror removes that rate-limit exposure for `arxiv_search_papers` and `arxiv_get_metadata` by serving from a SQLite + FTS5 store harvested via OAI-PMH. `arxiv_read_paper` always uses the live API — full-content harvesting is against arXiv's data policy.

Disabled by default. To enable:

```sh
# 1. Cold-start harvest (~4.4h sequential). One-time per installation.
#    Waits out arXiv outages; Ctrl+C stops it, and a rerun resumes from its checkpoint.
bun run mirror:init

# 2. Enable the mirror.
export ARXIV_MIRROR_ENABLED=true

# 3. Start the server — reads switch to the mirror once the harvest completes.
bun run start:http
```

Keep it current with `bun run mirror:refresh` (cron/systemd/launchd, or `ARXIV_MIRROR_REFRESH_CRON` in HTTP mode) and check it with `bun run mirror:verify`. An interrupted refresh resumes from its saved position on the next run. When a release changes the mirror's schema, the server answers from the live API until a writer migrates the file in place, with no re-harvest: with `ARXIV_MIRROR_REFRESH_CRON` in HTTP mode the server starts that refresh itself; otherwise run `bun run mirror:refresh` or `bun run mirror:verify`. One writer migrates the file at a time: a mirror command started meanwhile changes nothing and exits 75, naming the process that holds the migration, so run it again once that finishes.

Mirror search ranks with FTS5 BM25, so `sort_by=relevance` returns a different top set than the live API. Searches that go to the live API instead: `sort_by=submitted` descending (while `ARXIV_MIRROR_RECENT_DAYS_LIVE` is positive), searches whose free-text terms match 50,000 or more papers, and version-pinned requests (the mirror holds only the latest version).

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
