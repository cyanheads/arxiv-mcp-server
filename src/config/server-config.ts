/**
 * @fileoverview Server-specific configuration for arXiv MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * A request timeout in whole ms from 1 to 2^31 - 1, the range of the timer it
 * runs on: any other value would fail every request rather than bound it.
 * See issues #69, #74.
 */
const TimerMs = z.coerce.number().int().min(1).max(2_147_483_647);

const ServerConfigSchema = z.object({
  apiBaseUrl: z.string().default('https://export.arxiv.org/api'),
  requestDelayMs: z.coerce.number().default(3000),
  contentTimeoutMs: TimerMs.default(30000),
  apiTimeoutMs: TimerMs.default(15000),
  // Wall-clock budget for one arxiv_read_paper call (ms): its metadata lookup,
  // every content request, retry, and wait between them, and PDF text
  // extraction. The default sits under the 60 s request timeout of MCP SDK
  // clients, leaving room for the work no signal stops (HTML cleaning). See
  // issues #69, #73.
  readTimeoutMs: TimerMs.default(50_000),

  // OAI-PMH mirror (issue #12). All optional; mirror is disabled by default.
  mirrorEnabled: z.stringbool().default(false),
  mirrorPath: z.string().default('./data/arxiv-mirror.db'),
  mirrorRefreshCron: z.string().optional(),
  mirrorFallbackLive: z.stringbool().default(true),
  mirrorRecentDaysLive: z.coerce.number().min(0).default(2),
  mirrorOaiBaseUrl: z.string().default('https://oaipmh.arxiv.org/oai'),
  mirrorOaiRequestDelayMs: z.coerce.number().min(0).default(3000),
  // Wall-clock budget for one in-process refresh subprocess (ms). The child
  // stops starting pages once a worst-case page cycle no longer fits, exits
  // cleanly, and the next run resumes from its checkpoint; SIGTERM, then
  // SIGKILL, at the budget are only the backstop for a child that overruns.
  // Default 2h. See issues #22, #39.
  mirrorRefreshTimeoutMs: z.coerce.number().min(0).default(7_200_000),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from env vars. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'ARXIV_API_BASE_URL',
    requestDelayMs: 'ARXIV_REQUEST_DELAY_MS',
    contentTimeoutMs: 'ARXIV_CONTENT_TIMEOUT_MS',
    apiTimeoutMs: 'ARXIV_API_TIMEOUT_MS',
    readTimeoutMs: 'ARXIV_READ_TIMEOUT_MS',
    mirrorEnabled: 'ARXIV_MIRROR_ENABLED',
    mirrorPath: 'ARXIV_MIRROR_PATH',
    mirrorRefreshCron: 'ARXIV_MIRROR_REFRESH_CRON',
    mirrorFallbackLive: 'ARXIV_MIRROR_FALLBACK_LIVE',
    mirrorRecentDaysLive: 'ARXIV_MIRROR_RECENT_DAYS_LIVE',
    mirrorOaiBaseUrl: 'ARXIV_MIRROR_OAI_BASE_URL',
    mirrorOaiRequestDelayMs: 'ARXIV_MIRROR_OAI_REQUEST_DELAY_MS',
    mirrorRefreshTimeoutMs: 'ARXIV_MIRROR_REFRESH_TIMEOUT_MS',
  });
  return _config;
}

/** Reset the cached config — test-only. */
export function resetServerConfig(): void {
  _config = undefined;
}
