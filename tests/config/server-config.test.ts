/**
 * @fileoverview Tests for the server's env config: the three request timers —
 * `ARXIV_READ_TIMEOUT_MS` (the deadline each `arxiv_read_paper` call starts
 * from), `ARXIV_API_TIMEOUT_MS`, and `ARXIV_CONTENT_TIMEOUT_MS` — accept only a
 * value their timer can hold, and refuse any other at startup.
 * @module config/server-config.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

describe.each([
  ['ARXIV_READ_TIMEOUT_MS', 'readTimeoutMs', 50_000],
  ['ARXIV_API_TIMEOUT_MS', 'apiTimeoutMs', 15_000],
  ['ARXIV_CONTENT_TIMEOUT_MS', 'contentTimeoutMs', 30_000],
] as const)('%s', (envVar, field, fallback) => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it.each(['-5', '0', '25.5', '2147483648'])(
    'refuses %s with a configuration error naming the variable',
    (value) => {
      vi.stubEnv(envVar, value);
      let failure: unknown;
      try {
        getServerConfig();
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(McpError);
      expect((failure as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect((failure as McpError).message).toContain(envVar);
    },
  );

  it.each([
    ['1', 1],
    [String(fallback), fallback],
    ['2147483647', 2_147_483_647],
  ])('accepts %s', (value, expected) => {
    vi.stubEnv(envVar, value);
    expect(getServerConfig()[field]).toBe(expected);
  });

  it(`defaults to ${fallback} when empty`, () => {
    vi.stubEnv(envVar, '');
    expect(getServerConfig()[field]).toBe(fallback);
  });
});
