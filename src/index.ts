#!/usr/bin/env node
/**
 * @fileoverview arxiv-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { requestContextService, schedulerService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initArxivService } from '@/services/arxiv/arxiv-service.js';
import { runRefreshSubprocess } from '@/services/arxiv/mirror/index.js';

await createApp({
  name: 'arxiv-mcp-server',
  title: 'arxiv-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  landing: { requireAuth: false },
  instructions:
    'Use the arxiv_* tools to access the arXiv paper corpus: search by query, fetch metadata by ID, read full-text HTML, and list the subject category taxonomy. Papers are addressed by arXiv ID (e.g. 2401.12345 or 2401.12345v2 with version); search queries support field prefixes (ti:, au:, abs:, cat:) and boolean operators (AND, OR, ANDNOT).',
  async setup(core) {
    initArxivService();

    // Schedule the OAI-PMH refresh in-process when configured. Stdio mode
    // ignores the cron — operators run `bun run mirror:refresh` externally.
    const serverConfig = getServerConfig();
    const transport = core.config?.mcpTransportType ?? 'stdio';
    if (serverConfig.mirrorEnabled && serverConfig.mirrorRefreshCron && transport === 'http') {
      const cron = serverConfig.mirrorRefreshCron;
      const bootCtx = requestContextService.createRequestContext({
        operation: 'mirror-refresh-init',
      });
      core.logger.info('Scheduling mirror refresh', bootCtx);
      await schedulerService.schedule(
        'arxiv-mirror-refresh',
        cron,
        async (jobCtx) => {
          const mirrorLog = {
            debug: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.debug(m, withExtra(jobCtx, meta ?? {})),
            info: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.info(m, withExtra(jobCtx, meta ?? {})),
            notice: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.notice(m, withExtra(jobCtx, meta ?? {})),
            warning: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.warning(m, withExtra(jobCtx, meta ?? {})),
            error: (m: string, meta?: Readonly<Record<string, unknown>>) =>
              core.logger.error(m, withExtra(jobCtx, meta ?? {})),
          };
          // Run the harvest in a child process so its synchronous SQLite writes
          // never block the request event loop — the server keeps serving
          // arxiv_search / arxiv_get_metadata throughout. See issue #22.
          await runRefreshSubprocess({
            timeoutMs: serverConfig.mirrorRefreshTimeoutMs,
            log: mirrorLog,
          });
        },
        'Incremental OAI-PMH harvest into the arxiv-mirror SQLite store.',
      );
      schedulerService.start('arxiv-mirror-refresh');
    }
  },
});
