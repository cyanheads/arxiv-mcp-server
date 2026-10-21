/**
 * @fileoverview Public barrel for the OAI-PMH mirror module.
 * @module services/arxiv/mirror
 */

export type { HarvesterOptions } from './harvester.js';
export { fetchListRecordsPage, harvestPages, parseListRecords } from './harvester.js';
export type { MirrorQuery, TranslatedQuery } from './query.js';
export { expandCategoryOperands, translateQuery } from './query.js';
export type {
  MirrorNotReady,
  MirrorSearcher,
  MirrorSearchOutcome,
  ReadyMirror,
  WireError,
} from './reader.js';
export { closeReaderWorker, fromWireError, searchInThread, searchInWorker } from './reader.js';
export { runRefreshSubprocess, schemaUpgradeTrigger } from './refresh-subprocess.js';
export type { HarvestResult, ProgressCallback } from './runner.js';
export { runHarvest } from './runner.js';
export type { MirrorReaderOpen } from './store.js';
export {
  isDriverError,
  isMigrationConflict,
  MIRROR_SEARCH_MATCH_CAP,
  MirrorStore,
  normalizeDateToIso,
  openReaderStore,
  openStore,
  rawToRow,
  resetStore,
} from './store.js';
export type {
  ArxivRawRecord,
  ArxivRawVersion,
  ArxivTombstone,
  HarvestState,
  OaiPage,
  PaperRow,
} from './types.js';
