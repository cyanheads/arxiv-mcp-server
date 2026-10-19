/**
 * @fileoverview Incremental OAI-PMH refresh — fetches papers added/modified
 * since the last successful harvest (uses persisted `last_datestamp` as the
 * OAI `from=` parameter, or the saved resumption token when the previous run
 * stopped before draining). Runs until the list drains — no time budget.
 * Intended for nightly cron / systemd timer runs.
 *
 * Usage:
 *   bun run mirror:refresh
 *
 * Exit status:
 *   0   the refresh drained
 *   1   the refresh failed or was interrupted
 *   75  another writer is migrating the mirror file's schema; nothing changed,
 *       run again once it finishes (the message names its pid)
 *
 * @module scripts/arxiv-mirror-refresh
 */

import { runHarvest } from '@/services/arxiv/mirror/index.js';
import { exitIfMirrorBusy, makeScriptContext } from './_mirror-context.js';

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
    exitIfMirrorBusy('Refresh', err);
    console.error('Refresh failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
