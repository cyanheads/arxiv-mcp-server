/**
 * @fileoverview Verify the mirror SQLite file via PRAGMA integrity_check and
 * quick_check. Exits non-zero on any failure so cron / health-check jobs can
 * surface corruption immediately.
 *
 * Usage:
 *   bun run mirror:verify
 *
 * @module scripts/arxiv-mirror-verify
 */

import { getServerConfig } from '@/config/server-config.js';
import { openStore } from '@/services/arxiv/mirror/index.js';

async function main(): Promise<void> {
  const config = getServerConfig();
  console.log(`Verifying mirror at ${config.mirrorPath}`);
  try {
    const store = await openStore(config.mirrorPath);
    const state = store.readHarvestState();
    console.log(
      `Harvest status: ${state.status} (records=${state.total_records ?? '?'} lastDatestamp=${state.last_datestamp ?? '?'})`,
    );
    const result = store.integrityCheck();
    for (const line of result.results) console.log(`  ${line}`);
    if (!result.ok) {
      console.error('Integrity check FAILED');
      process.exit(1);
    }
    console.log('Mirror OK');
  } catch (err) {
    console.error('Verify failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
