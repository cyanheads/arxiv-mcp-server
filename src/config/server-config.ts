/**
 * @fileoverview Server-specific configuration for arXiv MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z.string().default('https://export.arxiv.org/api'),
  requestDelayMs: z.coerce.number().default(3000),
  contentTimeoutMs: z.coerce.number().default(30000),
  apiTimeoutMs: z.coerce.number().default(15000),

  // OAI-PMH mirror (issue #12). All optional; mirror is disabled by default.
  mirrorEnabled: z.coerce.boolean().default(false),
  mirrorPath: z.string().default('./data/arxiv-mirror.db'),
  mirrorRefreshCron: z.string().optional(),
  mirrorFallbackLive: z.coerce.boolean().default(true),
  mirrorRecentDaysLive: z.coerce.number().min(0).default(2),
  mirrorOaiBaseUrl: z.string().default('https://oaipmh.arxiv.org/oai'),
  mirrorOaiRequestDelayMs: z.coerce.number().min(0).default(3000),
  // Wall-clock budget for one in-process refresh subprocess before it is
  // aborted (ms). Default 2h: a nightly delta is small, but arXiv's OAI-PMH
  // endpoint can be slow per page, so the cap is generous. See issue #22.
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
