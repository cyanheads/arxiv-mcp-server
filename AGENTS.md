# Developer Protocol

**Server:** arxiv-mcp-server — arXiv academic paper search, metadata retrieval, and full-text reading for LLM agents.
**Version:** 1.7.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.15`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.3.1
**Zod:** ^4.6.7

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.
> **Design doc:** `docs/design.md` has full tool schemas, service design, API reference, and domain decisions.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Declare a typed `errors[]` contract and throw via `ctx.fail(reason, …)` for domain failures; fall back to error factories (`notFound()`, `validationError()`, etc.) for ad-hoc throws. Plain `Error` works in a pinch; the framework auto-classifies.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Use framework `withRetry` and `httpErrorFromResponse`** from `@cyanheads/mcp-ts-core/utils` for HTTP retry + status mapping. Don't hand-roll either.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Domain Notes

- **Read-only, no auth.** All tools are `readOnlyHint: true`. No API keys needed. `MCP_AUTH_MODE: none`.
- **Rate limiting.** arXiv enforces a 3-second crawl delay between API requests. The `ArxivService` manages an internal request queue. Content fetches (`arxiv.org/html`, `ar5iv`, `arxiv.org/pdf`) hit other hosts and aren't queued — but a 429 from the PDF fetch records the shared cooldown, so a throttle picked up there still slows subsequent API calls.
- **Rate-limit policy: fail fast, never retry.** A custom `isArxivTransient` predicate on `withRetry` excludes `RateLimited` from the retry set — when arXiv signals throttle (HTTP 429 or 200 OK with `Rate exceeded.` body), we surface the error to the caller in <1s instead of hammering during the throttle window. Both paths report the applied wait as `error.data.cooldownAppliedMs` — the field every `rate_limited` recovery hint points at, since the 200-body path has no header to report; the 429 path additionally passes `Retry-After` through as `error.data.retryAfter`. Only `ServiceUnavailable` is retried (`maxRetries: 1`); `Timeout` is excluded too, since a hung fetch is overwhelmingly throttling at the connection layer. See [#8](https://github.com/cyanheads/arxiv-mcp-server/issues/8), [#9](https://github.com/cyanheads/arxiv-mcp-server/issues/9).
- **Content fallback.** `arxiv_read_paper` tries native arXiv HTML first (`arxiv.org/html/{id}`), falls back to ar5iv (`ar5iv.labs.arxiv.org/html/{id}`), then to PDF text extraction via the framework's `pdfParser` (`unpdf`). ar5iv returns 307 redirect (not 404) for missing papers — don't follow redirects, treat 3xx as not-found. When a conversion aborted, ar5iv answers 200 with an empty article and LaTeXML's "Conversion to HTML had a Fatal error" notice; a page whose only text is that notice counts as no render and the chain moves on to the PDF (`isConversionFailurePage`), while a partial render that keeps the notice beside paper text is still served. arxiv.org/html answers a failed conversion with a 404. Both rungs answer 200 for a paper whose source wraps PDFs with `\includepdf` (LaTeXML renders each as one "See pages … of" sentence and a link to the file), and both can answer 200 with an empty article (ar5iv's "No content available" page is one): on either rung, a page whose article has no structural heading (none of the headings the outline lists) and holds such a placeholder or no text at all is no render too (`isPlaceholderRender`), while a page with a structural heading is served whatever placeholders it holds. An ar5iv failure never ends the chain either: a 5xx, network error, or timeout there is held and re-raised only when the PDF rung also comes up empty, so a third-party outage narrows coverage instead of failing the call. The two HTML rungs both run LaTeXML and so fail together; the PDF is the artifact every paper has, which is what makes it worth a third rung. A body ar5iv serves carries `revision_unconfirmed: true`: ar5iv keeps one render per paper and its page names no revision, so only an unversioned read whose live lookup found v1 the only version goes unflagged (a mirror row's v1 can trail a later revision, [#79](https://github.com/cyanheads/arxiv-mcp-server/issues/79)), and the flag costs no request. Errors are `content_unavailable` (no render, no PDF) and `pdf_extraction_failed` (PDF has no text layer — scanned/image-only). Every request's timeout covers its body too, so a host that stalls after its headers fails as one that hangs before them (`Timeout`, never replayed; on ar5iv, held like any other failure). The whole read runs on one deadline, `ARXIV_READ_TIMEOUT_MS` (50 s): the metadata lookup and its wait for the API queue, every rung, the replay, and its backoff draw on it, so the call settles with `Timeout` inside the 60 s request timeout of MCP SDK clients; a cancelled read stays cancelled ([#69](https://github.com/cyanheads/arxiv-mcp-server/issues/69), [#70](https://github.com/cyanheads/arxiv-mcp-server/issues/70)). PDF text extraction draws on it too: `extractInWorker` (`src/services/arxiv/pdf-text.ts`) runs each extraction in a worker thread of its own, so it holds no other request, and the deadline or a cancellation terminates it. At most two run at once (`MAX_EXTRACTION_WORKERS`), since each holds a document's worth of memory; a read waiting for one still ends at its deadline or cancellation, starting none. A worker that dies before replying fails the rung with `ServiceUnavailable`. The worker entry imports package specifiers only, since Node's type stripping, which loads it from source under Vitest, does not resolve a relative `./x.js` to `x.ts`. Fake-clock tests that reach the PDF build the service with `pdfTextExtractor: extractInThread` ([#73](https://github.com/cyanheads/arxiv-mcp-server/issues/73)). See [#23](https://github.com/cyanheads/arxiv-mcp-server/issues/23), [#38](https://github.com/cyanheads/arxiv-mcp-server/issues/38), [#54](https://github.com/cyanheads/arxiv-mcp-server/issues/54), [#57](https://github.com/cyanheads/arxiv-mcp-server/issues/57), [#63](https://github.com/cyanheads/arxiv-mcp-server/issues/63).
- **API quirks.** arXiv API returns HTTP 200 for everything — empty results, not-found IDs, and rate limiting. Rate limiting returns plain text `"Rate exceeded."` (not XML) — check content-type before parsing. The exceptions are two HTTP 500s. A query request whose `start + max_results` passes 10,000 answers 500 whatever the total, so the live search path cuts a page at result 10,000 and refuses a `start` at or past it (`start_beyond_result_limit`) before any request; the mirror has no such limit. An `id_list` holding some superseded versions of old-style IDs answers 500 every time (`hep-th/9901001v1` does, `astro-ph/0703001v1` does not, and nothing public tells them apart), so on a first-attempt 500 for a lookup holding an old-style pin, `fetchLivePapers` sends one request with those IDs unversioned in place of the identical retry and resolves each pin against the latest version returned; a lookup still sends at most two requests, and a 500 with no such pin or any 502/503 keeps the identical retry. See [#56](https://github.com/cyanheads/arxiv-mcp-server/issues/56), [#53](https://github.com/cyanheads/arxiv-mcp-server/issues/53).
- **Raw HTML output.** `arxiv_read_paper` cuts the page to its `<article>` — through the last `</article>`, so the site header and footer go while appendices and the bibliography stay — strips LaTeXML class/id noise, collapses MathML to LaTeX, and resolves relative `src`/`href`/`data` values against the URL that served the page (`#fragment`, `mailto:`, and absolute values stay as written), then returns the body HTML — the LLM interprets the content directly. On the `pdf_text` rung the body is plain text and skips all of it, so `total_characters` equals `body_characters`. `max_characters` (default: 100,000, `null` for the entire body) controls slice size; `start` (default: 0) is the character offset into the cleaned body — together they page through long papers without re-reading the prefix. Keep the bounded default: a math-heavy body still runs 300KB-1MB+ after cleaning, past what most clients accept in one tool result, so an unbounded read is an explicit opt-in, not the default. `body_characters` in the response is the full cleaned length and is the upper bound for `start`. A read at `start` 0 also returns `outline`: the part/chapter/section/subsection/subsubsection/paragraph/appendix/bibliography headings with the offset of each `<hN>` tag in the cleaned body, `level` from the tag (h2 = 1), at most 200 entries by dropping the deepest level whole (`outline_omitted_levels`) — the shallowest level is never dropped, and when it alone passes 200 its first 200 stay and `outline_continues_at` names the `start` of the first one left out; `[]` for `pdf_text`, absent past the first page. Offsets index the final cleaned body, so any change to the cleaning pass moves them. Every cleaning pass is linear in page length on any input — keep new passes that way. See [#24](https://github.com/cyanheads/arxiv-mcp-server/issues/24), [#43](https://github.com/cyanheads/arxiv-mcp-server/issues/43), [#44](https://github.com/cyanheads/arxiv-mcp-server/issues/44), [#52](https://github.com/cyanheads/arxiv-mcp-server/issues/52).
- **Query field prefixes mean one thing on both search paths.** `ti:` / `au:` / `abs:` / `co:` / `jr:` route to the five columns of the mirror's FTS5 index; `all:` — like an unprefixed term — spans all five, matching arXiv's own all-fields behavior. `comment` and `journal_ref` joined that index in mirror schema v3, so a prefix added to `FIELD_MAP` must name an indexed column or FTS5 raises `no such column` at query time. A `cat:` operand written inside `query` is expanded through `categorySearchTerm` before the live API sees it, so a bare archive code means its whole subtree whichever backend answers — arXiv matches a bare `cat:cs` literally and returns nothing. A query `cat:` and the `category` parameter stay independent filters that intersect (`store.search` takes category *groups*: OR within a group, AND across them), never one merged OR-set. `translateQuery` parses with arXiv's precedence — `AND`, explicit or implicit, binds tighter than `ANDNOT` and `OR` — and lifts a `cat:` or `submittedDate:` operand only when it is a conjunct of the whole query: reached through `AND` alone, or in the first operand of an `ANDNOT` on a level with no `OR`. Each lifted `cat:` is its own group, and `cat:` operands joined only by `OR` form one. Any other such query (`t OR cat:X`, `t ANDNOT cat:X`, two windows `OR`-ed), one whose residual has no positive term, and one with unbalanced parens returns `route: 'live'`, and `search` goes live before opening the mirror — the recency bypass and the `start` limit included, as for a term over the match cap. The FTS expression parenthesizes a conjunction on the right of `NOT`, which FTS5 binds tighter than `AND`. The parse and the emission use explicit stacks: caller text can nest as deep as it is long, so keep both iterative and linear ([#65](https://github.com/cyanheads/arxiv-mcp-server/issues/65)). A writer's `MirrorStore.open` migrates an older mirror file in place, one writer at a time — v3 drops and rebuilds the FTS index and its three sync triggers, batched by rowid and repeated from the start if interrupted; never a re-harvest, and the triggers must enumerate every indexed column or the index silently drifts from `papers`. See [#36](https://github.com/cyanheads/arxiv-mcp-server/issues/36), [#37](https://github.com/cyanheads/arxiv-mcp-server/issues/37).
- **Writers own the mirror file; the server's connection is query-only.** Only writers create, seed, or migrate the file: `MirrorStore.open`, behind `runHarvest` (`mirror:init`, `mirror:refresh`, the cron's child) and `mirror:verify`. The server reads through `MirrorStore.openReader`: `PRAGMA query_only = ON`, no busy timeout (a WAL reader never waits on the writer), and no DDL, seed, or migration. A missing file, one with no recorded schema version, or an older version reads as not ready: logged at debug, the call goes live, nothing is created, the connection closes, and the next call opens afresh — only an open store is kept. Where the refresh cron runs, an older version no writer is migrating starts one refresh child at once (`schemaUpgradeTrigger`), whose writer open migrates the file; otherwise the operator runs `mirror:refresh` or `mirror:verify`. One writer creates or migrates the file: the schema runs in one `BEGIN IMMEDIATE` transaction that re-reads `schema_version` under the lock (a new file records the current version in its first commit), and a migration runs under the `migration_lease` row, claimed in that transaction, checked and renewed by every batch, dropped with the version write, and lapsing after 5 min unrenewed. Any other writer changes nothing and throws `conflict` with `migration_in_progress` (or `migration_lease_lost`, for a holder that stalled and was taken over): the scripts exit 75, the refresh child resolves `skipped`, and a reader reports a live lease as `migrating` and starts no child. A failed open, reader or writer, closes its connection (`bun:sqlite` closes with `close(true)`, or a live statement holds the file open). Every mirror SQL string runs one statement at a time through `prepare().run()` and throws at the first failure: `bun:sqlite`'s multi-statement `exec` drops every error but the last, so the schema constants are lists of single statements. Writer connections wait out another writer's lock for 5 s on both drivers. See [#55](https://github.com/cyanheads/arxiv-mcp-server/issues/55), [#64](https://github.com/cyanheads/arxiv-mcp-server/issues/64), [#71](https://github.com/cyanheads/arxiv-mcp-server/issues/71).
- **Mirror harvest: the writer owns its index, its resume point, and its stop.** `runHarvest` — the only writer, behind `mirror:init`, `mirror:refresh`, and the cron's child process — ensures `paper_categories(paper_id)` before its first page (each record write and tombstone cascade looks the junction up by `paper_id`; without it every lookup scans the table). The index is outside the schema version and `MirrorStore.open` never builds it. A run that finds a saved token (`in_progress` or `error`) resumes from it; otherwise a refresh, or an init after an interrupted one, starts at `from=last_datestamp` (inclusive). A token is an offset into a list arXiv recomputes on every request, so one resumed after arXiv re-modified a returned record skips a record: a `harvest_state` write keeps the token only while the checkpoint is still on the run's start datestamp and the run stopped at its deadline there or had itself resumed a saved token, and every other write stores none. A rejected token falls back to the latest checkpointed datestamp, never the run's start, after the etiquette delay and once per checkpoint: a second rejection before the checkpoint advances fails the run (`token_recovery_stalled`) instead of re-reading the same page. Only `mirror:init` waits out an outage: a page still failing with `Timeout` or `ServiceUnavailable` after its retries waits 1 minute, doubling to 15 (never under a `Retry-After`, back to 1 once a page lands), then re-sends the same request, until a page lands or SIGINT/SIGTERM ends the wait. A 4xx ends the run whether or not its body arrives: one whose body stalls or drops fails as `Timeout` or `ServiceUnavailable` naming the host and the status, marked not retryable, so it is sent once and never waited out. A refresh and the cron's child fail instead, inside their budget. The cron's child stops starting pages once one worst-case page cycle no longer fits in `ARXIV_MIRROR_REFRESH_TIMEOUT_MS`, checkpoints, and exits 0; `runRefreshSubprocess` resolves `drained` / `partial` / `skipped` and rejects only on a real failure, with SIGTERM then SIGKILL at the budget as the backstop. A cancelled signal is always a failure, never a `partial`. See [#39](https://github.com/cyanheads/arxiv-mcp-server/issues/39), [#50](https://github.com/cyanheads/arxiv-mcp-server/issues/50), [#59](https://github.com/cyanheads/arxiv-mcp-server/issues/59), [#61](https://github.com/cyanheads/arxiv-mcp-server/issues/61), [#62](https://github.com/cyanheads/arxiv-mcp-server/issues/62), [#72](https://github.com/cyanheads/arxiv-mcp-server/issues/72).
- **Mirror search is bounded by its FTS match set.** The probe and the search run in the reader worker (next note). A search with a free-text term first runs `MirrorStore.matchReachesCap`, a doclist count stopped at `MIRROR_SEARCH_MATCH_CAP` (50,000). At the cap the query goes live for every sort order, and a live failure on it is returned, never answered from the mirror (the recency-bypass `catch` included). That `catch` also rethrows a caller cancellation for every query: a cancelled call is never answered from the mirror. It rethrows the live failure when the mirror matches nothing, too, so a failed recency search never reads as one with no matches ([#68](https://github.com/cyanheads/arxiv-mcp-server/issues/68)). Under the cap, `store.search` drives the count and the page from `papers_fts` (`CROSS JOIN` keeps the index as the outer loop) and ranks relevance by BM25 with a rowid tiebreak. Never reintroduce a `papers.rowid IN (… MATCH ?)` shape: the count and the page must stay FTS-driven for the cap to bound them. Category- and date-only searches skip the probe and keep their index-backed paths. See [#19](https://github.com/cyanheads/arxiv-mcp-server/issues/19), [#49](https://github.com/cyanheads/arxiv-mcp-server/issues/49).
- **Mirror searches run in the reader worker.** `searchInWorker` (`src/services/arxiv/mirror/reader.ts`) runs `searchWithinCap` (the probe, then `store.search`) in one long-lived worker thread on its own `MirrorStore.openReader` connection, started by the first mirror search and reused, one search at a time in arrival order, so no mirror search holds the request thread longer than posting the call and receiving its page. ID lookups and the harvest-state read stay on the request thread. A cancelled call settles at once with its signal's reason (`RequestCancelled`); a queued call is never posted, and a running statement finishes in the worker with its reply discarded. Errors cross the thread with name, message, stack, and cause, plus an `McpError`'s code and data, so an `fts5:` error still maps to `unsupported_query_syntax`. Any other error the SQLite driver raises during the probe or the search, on either thread (`isDriverError`, keyed on the driver's error class `SQLiteError` / `SqliteError`, never its wording), logs a warning and the call goes live; the worker keeps serving, and a recency-bypass fallback that throws leaves the live failure standing ([#76](https://github.com/cyanheads/arxiv-mcp-server/issues/76)). An exit or crash rejects the waiting calls with `ServiceUnavailable`. The worker's own open is reported as the request thread's is: a file it cannot serve reads as not ready, and an open that throws logs a warning, so the store's error and the file's path never reach the caller; either way the waiting calls go live. After any of these the next call starts a new worker. The worker is `unref()`'d whenever no caller waits on it. Its entry takes the client's extension: `.ts` under Vitest, `.js` from `dist/`. Tests that spy on `MirrorStore.prototype` build the service with `mirrorSearcher: searchInThread`. See [#58](https://github.com/cyanheads/arxiv-mcp-server/issues/58).
- **Paper ID normalization.** arXiv API always returns versioned IDs (`2401.12345v1`). Every ID input — `arxiv_get_metadata`, `arxiv_read_paper`, and `arxiv://paper/{paperId}` after percent-decoding — goes through `normalizePaperId` (`src/services/arxiv/paper-id.ts`) before any request: an `arXiv:` prefix is stripped, an arxiv.org `abs`/`pdf`/`html` URL yields its ID (scheme optional; a trailing slash, `?query`, or `#fragment` is ignored), the archive and `v` are lowercased, and an old-style subject class is dropped (`math.GT/0309136` → `math/0309136`). An old-style ID must name one of the archives that issued them (`LEGACY_ARCHIVES`) — arXiv answers HTTP 400 for a whole `id_list` holding any other. Anything else fails `invalid_id` without reaching arXiv — in `arxiv_get_metadata` a malformed ID is a per-ID `not_found` entry, and the call fails only when no ID is well-formed. The canonical ID reaches `id_list` and both HTML endpoints; `id_list` and arxiv.org/html honor a version suffix, while ar5iv keeps one render per paper and serves it for any suffix (hence `revision_unconfirmed`, [#63](https://github.com/cyanheads/arxiv-mcp-server/issues/63)). `paper_ids` advertises a plain array: its preprocess takes a lone string as the one ID (trimmed, so a trailing line break still resolves, and a blank one fails as the empty ID it is, never with the send-an-array hint) and leaves a JSON string or one with a comma or inner line break to the framework, which decodes a stringified array and refuses the rest. It takes up to 100 IDs, looks up the first 10 well-formed ones, and names the rest in `remaining_ids`. See [#41](https://github.com/cyanheads/arxiv-mcp-server/issues/41), [#51](https://github.com/cyanheads/arxiv-mcp-server/issues/51). Resolution is version-aware: an ID pinning `vN` matches only that version (a mirror row at another version is a miss, not a substitute), an unversioned ID matches the latest. Returned `id` fields always include the version, and so do the `pdf_url` / `abstract_url` derived from them — mirror path as well as live. A version-pinned ID the mirror cannot serve is reported as `version_not_in_mirror`, never `not_in_arxiv`. A superseded old-style version arXiv's API answers HTTP 500 for is `version_not_served` (`NotFound`, not retryable) on all three surfaces, its detail naming the latest version and the pinned version's PDF; on the mirror path a live miss keeps the reason the live lookup gave it. See [#53](https://github.com/cyanheads/arxiv-mcp-server/issues/53). When that live patch-up fails with an outage (`ServiceUnavailable` after its retry, `Timeout`, `RateLimited` with no extra retry), `getPapers` returns the papers the mirror served and reports each unanswered ID as `live_lookup_failed`, its detail naming the failure; the call fails with the live error only when the mirror served none of the IDs or arXiv rejected the lookup, and a cancelled call always fails. See [#67](https://github.com/cyanheads/arxiv-mcp-server/issues/67). A driver error from `getPapers`' own store lookup logs a warning and sends the whole lookup live, whatever `ARXIV_MIRROR_FALLBACK_LIVE` says ([#76](https://github.com/cyanheads/arxiv-mcp-server/issues/76)). `readContent` answers a failed live metadata lookup from the mirror only for a paper the mirror holds: an unversioned read takes the stored version, and a pin the stored version does not match fails `version_unavailable`. For a paper the mirror lacks, or a mirror read the SQLite driver fails (`isDriverError`), the live error is thrown unchanged, as with no mirror, never `no_match` and never the store's error; a cancelled read fails as cancelled and never reads the mirror. With the mirror enabled, an unversioned read also waits on its lookup at most `ARXIV_API_TIMEOUT_MS` from the read's start, queue wait included: a lookup still pending then, for a paper the mirror holds, is withdrawn (dropped from the API queue, or its open request aborted) and the stored row answers, while a miss or a failed read keeps the read waiting (`readMetadata`). See [#33](https://github.com/cyanheads/arxiv-mcp-server/issues/33), [#68](https://github.com/cyanheads/arxiv-mcp-server/issues/68), [#76](https://github.com/cyanheads/arxiv-mcp-server/issues/76), [#79](https://github.com/cyanheads/arxiv-mcp-server/issues/79).
- **Dependencies:** `fast-xml-parser` (v5, class-based API) for Atom XML parsing. No HTML parsing library needed. `unpdf` is a direct dependency only because the framework's `pdfParser` lazy-loads it as an optional peer — keep the range inside mcp-ts-core's declared peer range; never call `unpdf` directly.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const arxivSearchPapers = tool('arxiv_search_papers', {
  description: 'Search arXiv papers by query with category and sort filters.',
  annotations: { readOnlyHint: true },

  errors: [
    { reason: 'unknown_category', code: JsonRpcErrorCode.ValidationError,
      when: 'Provided category code is not part of the arXiv taxonomy.',
      recovery: 'Call arxiv_list_categories to discover valid category codes and retry.' },
  ],

  input: z.object({
    query: z.string().describe('Search query with field prefixes: ti:, au:, abs:, cat:, all:. Boolean: AND, OR, ANDNOT.'),
    max_results: z.number().int().min(1).max(10_000).default(10).describe('Maximum results to return; at most 50 per call.'),
  }),
  output: z.object({
    total_results: z.number().describe('Total matching papers.'),
    papers: z.array(PaperMetadataSchema).describe('Matching papers.'),
  }),

  async handler(input, ctx) {
    const service = getArxivService();
    const result = await service.search(input.query, { maxResults: Math.min(input.max_results, 50) }, ctx);
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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';

export const paperResource = resource('arxiv://paper/{paperId}', {
  description: 'Paper metadata by arXiv ID.',
  params: z.object({ paperId: z.string().describe('arXiv paper ID (e.g., "2401.12345").') }),
  errors: [
    { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
      when: 'Paper ID is not present in the arXiv index.',
      recovery: 'Verify the paper ID format and confirm via arxiv_search_papers before retrying.' },
  ],
  async handler(params, ctx) {
    const service = getArxivService();
    const result = await service.getPapers([params.paperId], ctx);
    const [paper] = result.papers;
    if (!paper) {
      throw ctx.fail('no_match', `Paper '${params.paperId}' not found.`, {
        paperId: params.paperId,
      });
    }
    return paper;
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z.string().default('https://export.arxiv.org/api').describe('arXiv API base URL'),
  requestDelayMs: z.coerce.number().default(3000).describe('Minimum delay between arXiv API requests (ms)'),
  contentTimeoutMs: z.coerce.number().default(30000).describe('Timeout for HTML content fetches (ms)'),
  apiTimeoutMs: z.coerce.number().default(15000).describe('Timeout for API requests (ms)'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'ARXIV_API_BASE_URL',
    requestDelayMs: 'ARXIV_REQUEST_DELAY_MS',
    contentTimeoutMs: 'ARXIV_CONTENT_TIMEOUT_MS',
    apiTimeoutMs: 'ARXIV_API_TIMEOUT_MS',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`ARXIV_API_BASE_URL`) rather than the internal path (`apiBaseUrl`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Session posture and shutdown

Two more `createApp()` options shape how the server runs rather than how it presents itself:

```ts
await createApp({
  sessionMode: 'stateless',
  setup(core) { /* initArxivService(), schedule the mirror refresh */ },
});
```

`sessionMode` declares the HTTP session posture in `src/` instead of leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). This server declares `stateless`: every tool is a read-only arXiv lookup, none calls `ctx.requestInput`, and `ctx.state` is tenant-scoped storage rather than a session store. `require: 'stateful'` would be the declaration on a server whose tools do gate on `ctx.requestInput`; adding one here means revisiting the mode. See [#40](https://github.com/cyanheads/arxiv-mcp-server/issues/40).

`teardown(core)` is the `setup()` counterpart — release a watcher, socket, or non-`unref()`'d timer there. It runs after the transport stops and before the logger closes, on every shutdown path, and a signal-triggered shutdown then exits the process explicitly (0, or 1 if a step never settles within the framework's 10 s ceiling). This server's `teardown` terminates the mirror reader worker (`closeReaderWorker()`) without awaiting it: termination cannot interrupt a running statement, and the exit that follows need not wait for one (Bun's does not; Node's waits for the statement in progress, not the rest of the search). The worker is `unref()`'d whenever no caller waits on it, so it never holds the process open on its own. The only ref'd timer `setup()` leaves behind is the `node-cron` mirror-refresh job, and the framework disposes `schedulerService` itself further down the same shutdown sequence — a `teardown` calling `destroyAll()` would only run it twice. Both `MirrorStore` handles, the request thread's and the worker's, are opened lazily on first query rather than in `setup()`, and both connections are query-only and never write, so there is no pending WAL at shutdown to checkpoint. See [#58](https://github.com/cyanheads/arxiv-mcp-server/issues/58).

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any JSON-serializable value; reads return its JSON form (a `Date` comes back as an ISO string). |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. |
| `ctx.inputs` | The request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped` — limited to what the client declared (`elicitation` and its form/url modes, `sampling`, `roots`). Client-supplied: a consent gate trusts only a `ctx.state` record it stored when it asked, bound to the operation, caller, and target (see the `api-context` skill). |
| `ctx.clientCapabilities` | What the client declared for this request, `undefined` when no view exists. Decides whether to ask for optional context (e.g. roots); never a reason to skip a consent prompt. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Recommended path: declare a typed contract.

**1. Typed error contract (recommended).** Add `errors[]` to the tool/resource and throw via `ctx.fail(reason, …)`. The contract `recovery` string (≥ 5 words, lint-validated) is the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason', msg)` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. An entry the service layer throws carries `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata nothing at runtime reads. An outcome that is a modeled result rather than a fault (`no_match`, `content_unavailable`, `pdf_extraction_failed`, `version_not_served`) carries `severity: 'notice'`, which moves that one log record's level and nothing client-visible. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) need no declaration; malformed tool arguments return `InvalidParams` (-32602).

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'Requested paper ID is not present in the arXiv index.',
    recovery: 'Verify the paper ID format and confirm via arxiv_search_papers before retrying.' },
],
async handler(input, ctx) {
  const result = await service.getPapers([input.paper_id], ctx);
  if (result.papers.length === 0) {
    throw ctx.fail('no_match', `Paper '${input.paper_id}' not found.`, {
      paperId: input.paper_id,
    });
  }
  return result;
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture (input, output, errors, handler, format). Don't extract a shared `errors[]` constant or contract module to deduplicate; per-tool repetition is the intended cost of locality, and dynamic `recovery` hints often need tool-specific context anyway.

**Service-thrown reasons.** Services don't have `ctx.fail`. A factory throw carries only `{ reason, … }` in `data` — the auto-classifier preserves it, so clients see the same `error.data.reason` they'd see from `ctx.fail`, and the framework fills the contract's `recovery`.

```ts
// arxiv-service.ts
throw validationError(`Unknown arXiv category '${cat}'.${hint}`, {
  category: cat,
  reason: 'unknown_category',
});
```

**2. Factory fallback** — when no contract entry fits (transient errors, ad-hoc throws):

```ts
import { notFound, rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Paper not found', { paperId });
throw rateLimited('arXiv rate limit exceeded', { url });
throw serviceUnavailable('arXiv API network error', { url }, { cause: err });
```

**3. HTTP status mapping** — use `httpErrorFromResponse` for any upstream `Response` you check yourself:

```ts
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
if (!response.ok) {
  throw await httpErrorFromResponse(response, { service: 'arxiv.org/html' });
}
```

**4. Retry with backoff** — wrap retryable pipelines (HTTP fetch + parse) in framework `withRetry`:

```ts
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
return withRetry(
  async () => { const xml = await fetchApi(url, ctx); return parseAtomFeed(xml); },
  { operation: 'arxivSearch', context: ctx, signal: ctx.signal },
);
```

`withRetry` retries McpErrors with transient codes (`ServiceUnavailable`, `Timeout`, `RateLimited`) and any non-McpError. Permanent codes (`InvalidRequest`, `ValidationError`, `NotFound`, etc.) fail immediately.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, contract lint rules, and all available factories.

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
      paper-id.ts                       # normalizePaperId — the parser every ID input runs through
      types.ts                          # PaperMetadata, SearchResult, PaperContent types
      categories.ts                     # Static arXiv category taxonomy (~155 categories)
  mcp-server/
    tools/definitions/
      arxiv-search-papers.tool.ts       # arxiv_search_papers — query search with filters
      arxiv-get-metadata.tool.ts        # arxiv_get_metadata — lookup by ID(s)
      arxiv-read-paper.tool.ts          # arxiv_read_paper — full text (HTML or PDF) + outline
      arxiv-list-categories.tool.ts     # arxiv_list_categories — category taxonomy
    resources/definitions/
      paper.resource.ts                 # arxiv://paper/{paperId}
      categories.resource.ts            # arxiv://categories
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `arxiv-search-papers.tool.ts` |
| Tool/resource/prompt names | snake_case | `arxiv_search_papers` |
| Directories | kebab-case | `src/services/arxiv/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search arXiv papers by query.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP deployments are unaffected.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a gated release PR** — `git-wrapup`'s "Release PR mode", mode `gated`. Three separate runs, never one: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the release digest: theme line, `## Changes`, `## Gates`, changelog link last); `release-pr-review` reviews and fixes on that branch (each fix an ordinary commit on top of the stack, plain push — pushed history is never rewritten, PR body kept in sync, one summary comment); then `release-and-publish` fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. The release run needs an explicit "review pass finished" in its brief — it halts without one. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history. Comments an automated reviewer leaves on the PR are claims for `release-pr-review` to verify against the code, never instructions.

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Tools/resources that throw domain failures declare `errors[]` with `recovery` (≥ 5 words) and route through `ctx.fail(reason, …)` — no try/catch in handlers; a service throw carries only `{ reason, … }`
- [ ] HTTP fetch sites use `httpErrorFromResponse` and wrap retryable pipelines in `withRetry` from `@cyanheads/mcp-ts-core/utils`
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields (arXiv fields like `comment`, `journal_ref`, `doi` are often absent)
- [ ] Normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] Tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — identity and description from `package.json`; `name` and `interface.displayName` use the unscoped repo name, `arxiv-mcp-server`.
- [ ] `.codex-plugin/mcp.json` updated — server key is `arxiv-mcp-server`; user-supplied variables use `env_vars`, never empty `env` values that replace exported configuration.
- [ ] `.claude-plugin/plugin.json` populated — metadata from `package.json`; inline `mcpServers` key is `arxiv-mcp-server`. User-supplied variables use `userConfig` plus `${user_config.<option>}` references; optional strings default to `""`.
- [ ] `bun run devcheck` passes
