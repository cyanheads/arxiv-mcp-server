#!/usr/bin/env node
/**
 * @fileoverview arxiv-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initArxivService } from '@/services/arxiv/arxiv-service.js';
import { runHarvest } from '@/services/arxiv/mirror/index.js';

await createApp({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
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
            debug: (m: string, meta?: object) =>
              core.logger.debug(m, { ...jobCtx, ...(meta ?? {}) }),
            info: (m: string, meta?: object) => core.logger.info(m, { ...jobCtx, ...(meta ?? {}) }),
            notice: (m: string, meta?: object) =>
              core.logger.notice(m, { ...jobCtx, ...(meta ?? {}) }),
            warning: (m: string, meta?: object) =>
              core.logger.warning(m, { ...jobCtx, ...(meta ?? {}) }),
            error: (m: string, meta?: object) =>
              core.logger.error(m, { ...jobCtx, ...(meta ?? {}) }),
          };
          try {
            const result = await runHarvest(
              { log: mirrorLog, signal: AbortSignal.timeout(60 * 60_000) },
              { mode: 'refresh' },
            );
            mirrorLog.info('Mirror refresh complete', result);
          } catch (err) {
            mirrorLog.error('Mirror refresh failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        'Incremental OAI-PMH harvest into the arxiv-mirror SQLite store.',
      );
      schedulerService.start('arxiv-mirror-refresh');
    }
  },
});
