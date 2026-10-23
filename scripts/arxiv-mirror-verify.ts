/**
 * @fileoverview Verify the mirror SQLite file: its schema version, each index
 * and trigger schema v4 defines against the schema module's definition, then
 * PRAGMA integrity_check and quick_check. Exits non-zero on any failure so
 * cron / health-check jobs can surface it immediately. A missing or redefined
 * v4 index or trigger is reported with the statements that rebuild it; no
 * open rebuilds one, this script's included.
 *
 * Usage:
 *   bun run mirror:verify
 *
 * Exit status:
 *   0   the file is on the current schema, holds every v4 index and trigger as
 *       the schema defines it, and passes both checks
 *   1   a check or the schema migration failed
 *   75  another writer is migrating the mirror file's schema; nothing changed,
 *       verify again once it finishes (the message names its pid)
 *
 * @module scripts/arxiv-mirror-verify
 */

import { getServerConfig } from '@/config/server-config.js';
import { openStore } from '@/services/arxiv/mirror/index.js';
import { exitIfMirrorBusy } from './_mirror-context.js';

async function main(): Promise<void> {
  const config = getServerConfig();
  console.log(`Verifying mirror at ${config.mirrorPath}`);
  try {
    // Opening the store applies any pending schema migration, so the version
    // reported below is the one this run left behind.
    const store = await openStore(config.mirrorPath);
    const state = store.readHarvestState();
    console.log(
      `Harvest status: ${state.status} (records=${state.total_records ?? '?'} lastDatestamp=${state.last_datestamp ?? '?'})`,
    );
    const schema = store.schemaVersion();
    console.log(`Schema version: ${schema.current} (expected ${schema.expected})`);
    if (schema.current !== schema.expected) {
      console.error(`Schema migration to v${schema.expected} did not complete`);
      process.exit(1);
    }
    const objects = store.checkSchemaObjects();
    const described = (o: (typeof objects)[number]) =>
      o.status === 'differs' ? 'differs from schema v4' : o.status;
    console.log('Schema objects:');
    for (const o of objects) console.log(`  ${o.type} ${o.name}: ${described(o)}`);
    const broken = objects.filter((o) => o.status !== 'ok');
    if (broken.length > 0) {
      const named = broken.map(
        (o) => `${o.type} ${o.name} ${o.status === 'missing' ? 'is missing' : described(o)}`,
      );
      console.error(
        `Schema objects FAILED: ${named.join('; ')}. Opening the file does not rebuild them; run these statements against it, then verify again:`,
      );
      for (const sql of broken.flatMap((o) => o.restore)) console.error(`${sql};`);
      process.exit(1);
    }
    const result = store.integrityCheck();
    for (const line of result.results) console.log(`  ${line}`);
    if (!result.ok) {
      console.error('Integrity check FAILED');
      process.exit(1);
    }
    console.log('Mirror OK');
  } catch (err) {
    exitIfMirrorBusy('Verify', err);
    console.error('Verify failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
