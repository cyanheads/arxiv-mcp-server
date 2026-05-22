/**
 * @fileoverview One-shot OAI-PMH harvest into the local mirror.
 * Idempotent and resumable — re-running after an interrupted harvest picks
 * up where the previous attempt left off (via persisted resumption token or
 * datestamp checkpoint).
 *
 * Usage:
 *   bun run mirror:init
 *
 * Env vars:
 *   ARXIV_MIRROR_PATH                  SQLite output (default ./data/arxiv-mirror.db)
 *   ARXIV_MIRROR_OAI_BASE_URL          OAI endpoint (default oaipmh.arxiv.org/oai)
 *   ARXIV_MIRROR_OAI_REQUEST_DELAY_MS  Inter-page delay (default 3000)
 *
 * @module scripts/arxiv-mirror-init
 */

import { runHarvest } from '@/services/arxiv/mirror/index.js';
import { makeScriptContext } from './_mirror-context.js';

async function main(): Promise<void> {
  const ctx = makeScriptContext('mirror:init');
  const start = Date.now();
  ctx.log.notice('Starting OAI-PMH harvest', {});
  let lastReport = start;

  try {
    const result = await runHarvest(ctx, {
      mode: 'init',
      onProgress: ({ pages, records, tombstones, lastDatestamp }) => {
        const now = Date.now();
        // Log every ~10s so a long harvest stays observable without spamming.
        if (now - lastReport < 10_000) return;
        lastReport = now;
        const elapsedMin = ((now - start) / 60_000).toFixed(1);
        console.log(
          `  pages=${pages} records=${records} tombstones=${tombstones} lastDatestamp=${lastDatestamp ?? '?'} elapsed=${elapsedMin}m`,
        );
      },
    });
    const elapsedMin = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(
      `\nHarvest complete: ${result.totalRecords} records, ${result.pagesFetched} pages, ${result.tombstonesApplied} tombstones in ${elapsedMin}m`,
    );
  } catch (err) {
    console.error('\nHarvest failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
