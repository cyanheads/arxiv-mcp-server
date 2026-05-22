/**
 * @fileoverview Incremental OAI-PMH refresh — fetches papers added/modified
 * since the last successful harvest (uses persisted `last_datestamp` as the
 * OAI `from=` parameter). Intended for nightly cron / systemd timer runs.
 *
 * Usage:
 *   bun run mirror:refresh
 *
 * @module scripts/arxiv-mirror-refresh
 */

import { runHarvest } from '@/services/arxiv/mirror/index.js';
import { makeScriptContext } from './_mirror-context.js';

async function main(): Promise<void> {
  const ctx = makeScriptContext('mirror:refresh');
  const start = Date.now();
  ctx.log.notice('Starting OAI-PMH incremental refresh', {});

  try {
    const result = await runHarvest(ctx, { mode: 'refresh' });
    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `Refresh complete: ${result.recordsApplied} records, ${result.tombstonesApplied} tombstones, ${result.pagesFetched} pages in ${elapsedSec}s`,
    );
  } catch (err) {
    console.error('Refresh failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
