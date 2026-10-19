/**
 * @fileoverview One-shot OAI-PMH harvest into the local mirror.
 * Idempotent and resumable — re-running after an interrupted harvest picks
 * up where the previous attempt left off (via persisted resumption token or
 * datestamp checkpoint). An arXiv outage doesn't end it: a page request that
 * still times out, hits a network error, or gets a 5xx other than 501 after
 * its retries waits (1 minute, doubling to 15, never shorter than a
 * `Retry-After`) and is sent again, each wait logged as a warning. A 4xx still
 * ends it, even one whose body stalls or drops after the status. Ctrl+C or
 * SIGTERM stops it at once, mid-wait included, and the next run resumes from
 * the saved position.
 *
 * Usage:
 *   bun run mirror:init
 *
 * Env vars:
 *   ARXIV_MIRROR_PATH                  SQLite output (default ./data/arxiv-mirror.db)
 *   ARXIV_MIRROR_OAI_BASE_URL          OAI endpoint (default oaipmh.arxiv.org/oai)
 *   ARXIV_MIRROR_OAI_REQUEST_DELAY_MS  Inter-page delay (default 3000)
 *
 * Exit status:
 *   0   the harvest drained
 *   1   the harvest failed or was interrupted
 *   75  another writer is migrating the mirror file's schema; nothing changed,
 *       run again once it finishes (the message names its pid)
 *
 * @module scripts/arxiv-mirror-init
 */

import { runHarvest } from '@/services/arxiv/mirror/index.js';
import { exitIfMirrorBusy, makeScriptContext } from './_mirror-context.js';

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
    exitIfMirrorBusy('Harvest', err);
    console.error('\nHarvest failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
