#!/usr/bin/env node
/**
 * @fileoverview arxiv-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import {
  type RequestContext,
  requestContextService,
  schedulerService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initArxivService } from '@/services/arxiv/arxiv-service.js';
import {
  closeReaderWorker,
  runRefreshSubprocess,
  schemaUpgradeTrigger,
} from '@/services/arxiv/mirror/index.js';

await createApp({
  name: 'arxiv-mcp-server',
  title: 'arxiv-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  landing: { requireAuth: false },
  // Every tool here is a read-only arXiv lookup — no tool calls ctx.requestInput,
  // and ctx.state is tenant-scoped storage rather than a session store. Stateless
  // drops the per-session McpServer allocation and lets the process scale
  // horizontally. MCP_SESSION_MODE still overrides this when set. See issue #40.
  sessionMode: 'stateless',
  instructions:
    'Use the arxiv_* tools to access the arXiv paper corpus: search by query, fetch metadata by ID, read full paper text (an HTML render, or text extracted from the PDF), and list the subject category taxonomy. Papers are addressed by arXiv ID (e.g. 2401.12345, 2401.12345v2 with version, or hep-th/9901001 for pre-2007 papers); search queries support field prefixes (ti:, au:, abs:, co:, jr:, cat:, all:) and boolean operators (AND, OR, ANDNOT).',
  async setup(core) {
    // Schedule the OAI-PMH refresh in-process when configured. Stdio mode
    // ignores the cron — operators run `bun run mirror:refresh` externally.
    const serverConfig = getServerConfig();
    const transport = core.config?.mcpTransportType ?? 'stdio';
    const cron =
      serverConfig.mirrorEnabled && transport === 'http'
        ? serverConfig.mirrorRefreshCron
        : undefined;
    if (!cron) {
      initArxivService();
      return;
    }

    const mirrorLog = (ctx: RequestContext) => ({
      debug: (m: string, meta?: Readonly<Record<string, unknown>>) =>
        core.logger.debug(m, withExtra(ctx, meta ?? {})),
      info: (m: string, meta?: Readonly<Record<string, unknown>>) =>
        core.logger.info(m, withExtra(ctx, meta ?? {})),
      notice: (m: string, meta?: Readonly<Record<string, unknown>>) =>
        core.logger.notice(m, withExtra(ctx, meta ?? {})),
      warning: (m: string, meta?: Readonly<Record<string, unknown>>) =>
        core.logger.warning(m, withExtra(ctx, meta ?? {})),
      error: (m: string, meta?: Readonly<Record<string, unknown>>) =>
        core.logger.error(m, withExtra(ctx, meta ?? {})),
    });

    // The server's mirror connection never migrates (issue #55). Where the cron
    // runs, a file on an older schema starts one refresh at once, whose writer
    // open migrates it, rather than waiting for the next tick.
    initArxivService({
      onMirrorSchemaOutdated: schemaUpgradeTrigger({
        timeoutMs: serverConfig.mirrorRefreshTimeoutMs,
        log: mirrorLog(
          requestContextService.createRequestContext({ operation: 'mirror-schema-upgrade' }),
        ),
      }),
    });

    const bootCtx = requestContextService.createRequestContext({
      operation: 'mirror-refresh-init',
    });
    core.logger.info('Scheduling mirror refresh', bootCtx);
    await schedulerService.schedule(
      'arxiv-mirror-refresh',
      cron,
      async (jobCtx) => {
        // Run the harvest in a child process so its synchronous SQLite writes
        // never block the request event loop — the server keeps serving
        // arxiv_search_papers / arxiv_get_metadata throughout. See issue #22.
        // It logs the run's outcome (drained, or stopped at its deadline to
        // resume on the next tick) and rejects only on a real failure, which
        // the scheduler records as a failed job. See issues #31, #39.
        await runRefreshSubprocess({
          timeoutMs: serverConfig.mirrorRefreshTimeoutMs,
          log: mirrorLog(jobCtx),
        });
      },
      'Incremental OAI-PMH harvest into the arxiv-mirror SQLite store.',
    );
    schedulerService.start('arxiv-mirror-refresh');
  },
  // The mirror reader worker never holds the process open, and is terminated
  // here. Not awaited: termination waits for a statement already running to
  // end, and the exit that follows teardown need not. See issue #58.
  teardown() {
    void closeReaderWorker();
  },
});
