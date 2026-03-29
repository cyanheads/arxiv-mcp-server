/**
 * @fileoverview Server-specific configuration for arXiv MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  apiBaseUrl: z.string().default('https://export.arxiv.org/api'),
  requestDelayMs: z.coerce.number().default(3000),
  contentTimeoutMs: z.coerce.number().default(30000),
  apiTimeoutMs: z.coerce.number().default(15000),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from env vars. */
export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    apiBaseUrl: process.env.ARXIV_API_BASE_URL,
    requestDelayMs: process.env.ARXIV_REQUEST_DELAY_MS,
    contentTimeoutMs: process.env.ARXIV_CONTENT_TIMEOUT_MS,
    apiTimeoutMs: process.env.ARXIV_API_TIMEOUT_MS,
  });
  return _config;
}
