# Agent Protocol

**Server:** arxiv-mcp-server — arXiv academic paper search, metadata retrieval, and full-text reading for LLM agents.
**Version:** 0.1.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.
> **Design doc:** `docs/design.md` has full tool schemas, service design, API reference, and domain decisions.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
9. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Secrets in env vars only** — never hardcoded.

---

## Domain Notes

- **Read-only, no auth.** All tools are `readOnlyHint: true`. No API keys needed. `MCP_AUTH_MODE: none`.
- **Rate limiting.** arXiv enforces a 3-second crawl delay between API requests. The `ArxivService` manages an internal request queue. HTML fetches to `arxiv.org/html` and `ar5iv` are separate domains and don't share this queue.
- **HTML fallback.** `arxiv_read_paper` tries native arXiv HTML first (`arxiv.org/html/{id}`), falls back to ar5iv (`ar5iv.labs.arxiv.org/html/{id}`). ar5iv returns 307 redirect (not 404) for missing papers — don't follow redirects, treat 3xx as not-found.
- **API quirks.** arXiv API returns HTTP 200 for everything — empty results, not-found IDs, and rate limiting. Rate limiting returns plain text `"Rate exceeded."` (not XML) — check content-type before parsing.
- **Raw HTML output.** `arxiv_read_paper` returns raw HTML — no parsing or extraction. The LLM interprets the content directly. Responses can be large (500KB-3MB+); `max_characters` is the only size control.
- **Paper ID normalization.** arXiv API always returns versioned IDs (`2401.12345v1`). Inputs accept both versioned and unversioned forms. Service strips version for API queries, preserves versioned ID from response. Returned `id` fields always include the version.
- **Dependencies:** `fast-xml-parser` (v5, class-based API) for Atom XML parsing. No HTML parsing library needed.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const arxivSearch = tool('arxiv_search', {
  description: 'Search arXiv papers by query with category and sort filters.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z.string().describe('Search query with field prefixes: ti:, au:, abs:, cat:, all:. Boolean: AND, OR, ANDNOT.'),
    max_results: z.number().min(1).max(50).default(10).describe('Maximum results to return (1-50).'),
  }),
  output: z.object({
    total_results: z.number().describe('Total matching papers.'),
    papers: z.array(PaperMetadataSchema).describe('Matching papers.'),
  }),

  async handler(input, ctx) {
    const service = getArxivService();
    const result = await service.search(input.query, { maxResults: input.max_results }, ctx);
    ctx.log.info('Search completed', { query: input.query, count: result.papers.length });
    return result;
  },

  format: (result) => [{
    type: 'text',
    text: result.papers.map(p =>
      `**${p.title}**\narXiv:${p.id} | ${p.primary_category} | ${p.published}\n${p.authors.join(', ')}\n${p.abstract}`
    ).join('\n\n---\n\n'),
  }],
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const paperResource = resource('arxiv://paper/{paperId}', {
  description: 'Paper metadata by arXiv ID.',
  params: z.object({ paperId: z.string().describe('arXiv paper ID (e.g., "2401.12345").') }),
  async handler(params, ctx) {
    const service = getArxivService();
    const result = await service.getPapers([params.paperId], ctx);
    if (result.papers.length === 0) throw new Error(`Paper ${params.paperId} not found`);
    return result.papers[0];
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
const ServerConfigSchema = z.object({
  apiBaseUrl: z.string().default('https://export.arxiv.org/api').describe('arXiv API base URL'),
  requestDelayMs: z.coerce.number().default(3000).describe('Minimum delay between arXiv API requests (ms)'),
  contentTimeoutMs: z.coerce.number().default(30000).describe('Timeout for HTML content fetches (ms)'),
  apiTimeoutMs: z.coerce.number().default(15000).describe('Timeout for API requests (ms)'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= ServerConfigSchema.parse({
    apiBaseUrl: process.env.ARXIV_API_BASE_URL,
    requestDelayMs: process.env.ARXIV_REQUEST_DELAY_MS,
    contentTimeoutMs: process.env.ARXIV_CONTENT_TIMEOUT_MS,
    apiTimeoutMs: process.env.ARXIV_API_TIMEOUT_MS,
  });
  return _config;
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.signal` | `AbortSignal` for cancellation. Pass to all `fetch()` calls. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Paper 2401.12345 not found');     // → NotFound
throw new Error('Invalid arXiv ID format');         // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Paper not found', { paperId });
throw serviceUnavailable('arXiv API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Rate exceeded', { retryAfterMs: 3000 });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # arXiv env vars (Zod schema)
  services/
    arxiv/
      arxiv-service.ts                  # ArxivService — search, getPapers, readContent
      types.ts                          # PaperMetadata, SearchResult, PaperContent types
      categories.ts                     # Static arXiv category taxonomy (~155 categories)
  mcp-server/
    tools/definitions/
      arxiv-search.tool.ts              # arxiv_search — query search with filters
      arxiv-get-metadata.tool.ts        # arxiv_get_metadata — lookup by ID(s)
      arxiv-read-paper.tool.ts          # arxiv_read_paper — raw HTML content
      arxiv-list-categories.tool.ts     # arxiv_list_categories — category taxonomy
    resources/definitions/
      paper.resource.ts                 # arxiv://paper/{paperId}
      categories.resource.ts            # arxiv://categories
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `arxiv-search.tool.ts` |
| Tool/resource/prompt names | snake_case | `arxiv_search` |
| Directories | kebab-case | `src/services/arxiv/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search arXiv papers by query.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, re-copy to pick up changes.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Sync skills and dependencies after updates |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/resource definitions |
| `bun run test` | Run tests (vitest) |
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Publishing

When running `git_wrapup_instructions`, always apply a minimum **0.0.1** version bump unless the user specifies otherwise. After a successful wrapup flow:

1. Create an annotated tag: `git tag -a v<version> -m "v<version>"`
2. Push the commit and tag: `git push && git push --tags`
3. Publish to npm and GHCR:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/arxiv-mcp-server:<version> \
  -t ghcr.io/cyanheads/arxiv-mcp-server:latest \
  --push .
```

Remind the user to run publish commands after completing a release flow.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — `content[]` is the only field most clients forward to the model
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
