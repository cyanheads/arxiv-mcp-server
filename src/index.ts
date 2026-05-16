#!/usr/bin/env node
/**
 * @fileoverview arxiv-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initArxivService } from '@/services/arxiv/arxiv-service.js';

await createApp({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  instructions:
    'Use the arxiv_* tools to access the arXiv paper corpus: search by query, fetch metadata by ID, read full-text HTML, and list the subject category taxonomy. Papers are addressed by arXiv ID (e.g. 2401.12345 or 2401.12345v2 with version); search queries support field prefixes (ti:, au:, abs:, cat:) and boolean operators (AND, OR, ANDNOT).',
  setup() {
    initArxivService();
  },
});
