/**
 * @fileoverview arxiv_read_paper tool — fetch the full HTML content of an arXiv paper.
 * @module mcp-server/tools/definitions/arxiv-read-paper
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { PaperContentSourceSchema } from '@/services/arxiv/types.js';

export const arxivReadPaper = tool('arxiv_read_paper', {
  description:
    'Fetch the full text of an arXiv paper. Tries arxiv.org/html first, falls back to ar5iv.labs.arxiv.org, and falls back again to text extracted from the PDF when neither has an HTML render — check the source field to know which one answered. Page through long papers with start and max_characters, or pass max_characters null to get the entire body in one call.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper ID is not present in the arXiv index.',
      recovery:
        'Verify the paper ID format (e.g., "2401.12345") and confirm via arxiv_search before retrying.',
    },
    {
      reason: 'content_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper exists but neither arxiv.org/html nor ar5iv has an HTML rendering and arXiv served no PDF either.',
      recovery:
        'Read the abstract via arxiv_get_metadata, since no full-text artifact exists for this paper.',
    },
    {
      reason: 'pdf_extraction_failed',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper has no HTML rendering and its PDF carries no text layer — an image-only or scanned submission.',
      recovery:
        'Download error.data.pdfUrl and run optical character recognition, or read the abstract via arxiv_get_metadata.',
    },
    {
      reason: 'version_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A version-pinned paper_id was requested, arXiv is unreachable, and the local mirror holds only a different version — per-version reads require the live API.',
      retryable: true,
      recovery:
        'Retry once arXiv is reachable, or request the version reported in error.data.mirrorVersion.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'arXiv has throttled requests (HTTP 429 or "Rate exceeded." body).',
      retryable: true,
      recovery:
        'Wait error.data.cooldownAppliedMs milliseconds before retrying, and lower concurrent arXiv calls.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'arXiv rejected the metadata lookup (HTTP 4xx other than 429), e.g. malformed ID syntax.',
      recovery: 'Verify the paper ID format (e.g., "2401.12345" or "2401.12345v2") and retry.',
    },
  ],

  input: z.object({
    paper_id: z
      .string()
      .trim()
      .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").')
      .describe('arXiv paper ID (e.g., "2401.12345" or "2401.12345v2").'),
    max_characters: z
      .number()
      .int()
      .min(1)
      .nullable()
      .default(100_000)
      .describe(
        'Maximum characters of paper body to return, counted after boilerplate stripping. Defaults to 100,000; pass null to return the entire body in one call. Whole-paper reads can exceed a client tool-result size cap — math-heavy bodies run 300KB-1MB+ — so prefer the default plus start-based paging unless the full text is needed. When truncated, a notice and the total character count are included.',
      ),
    start: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Character offset into the cleaned body to begin reading from. Defaults to 0. Use with max_characters to page through long papers — e.g., start=100000 with max_characters=100000 returns chars 100,000–199,999. The total length is reported as body_characters in the response.',
      ),
  }),

  output: z.object({
    paper_id: z.string().describe('arXiv paper ID.'),
    title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
    content: z
      .string()
      .describe(
        'Paper body for the requested slice — cleaned HTML when source is arxiv_html or ar5iv, plain text when source is pdf_text. Empty when start is past body_characters.',
      ),
    source: PaperContentSourceSchema,
    truncated: z
      .boolean()
      .describe(
        'True when more body content exists past this slice (start + content.length < body_characters).',
      ),
    start: z
      .number()
      .describe('Character offset of the first character in content within the cleaned body.'),
    total_characters: z
      .number()
      .describe(
        'Character count of the body before cleaning — the unprocessed HTML body for arxiv_html and ar5iv, and equal to body_characters for pdf_text, which needs no cleaning.',
      ),
    body_characters: z
      .number()
      .describe(
        'Character count of the full cleaned body. Use with start and max_characters to page. Typically 3-4× smaller than total_characters for math-heavy HTML papers.',
      ),
    pdf_url: z.string().describe('Direct PDF download URL.'),
    abstract_url: z.string().describe('arXiv abstract page URL for attribution.'),
  }),

  async handler(input, ctx) {
    const service = getArxivService();
    const result = await service.readContent(
      input.paper_id,
      { maxCharacters: input.max_characters, start: input.start },
      ctx,
    );
    ctx.log.info('Paper content fetched', {
      paperId: result.paper_id,
      source: result.source,
      truncated: result.truncated,
      start: result.start,
      characters: result.total_characters,
    });
    return result;
  },

  format: (result) => {
    const lines = [
      `# ${result.title}`,
      // Raw integer values in the header so both character counts are discoverable
      // by text-only clients (format-parity) without locale formatting interfering.
      `arXiv:${result.paper_id} | Source: ${result.source} | Raw: ${result.total_characters} chars | Body: ${result.body_characters} chars${result.truncated ? ' (truncated)' : ''}`,
      `Abstract: ${result.abstract_url}`,
      `PDF: ${result.pdf_url}`,
    ];
    if (result.source === 'pdf_text') {
      lines.push(
        '\n[Extracted from the PDF — no HTML render exists for this paper. Prose is reliable; math, tables, and heading structure are flattened into plain text.]',
      );
    }
    const sliceEnd = result.start + result.content.length;
    if (result.start >= result.body_characters && result.body_characters > 0) {
      lines.push(
        `\n[Offset ${result.start.toLocaleString()} is past end of body (${result.body_characters.toLocaleString()} characters). Use start=0 to read from the beginning.]`,
      );
    } else if (result.truncated) {
      lines.push(
        `\n[Truncated: showing chars ${result.start.toLocaleString()}–${(sliceEnd - 1).toLocaleString()} of ${result.body_characters.toLocaleString()} body characters. Call again with start=${sliceEnd} to continue.]`,
      );
    } else if (result.start > 0) {
      lines.push(
        `\n[Showing chars ${result.start.toLocaleString()}–${(sliceEnd - 1).toLocaleString()} of ${result.body_characters.toLocaleString()} body characters (final chunk).]`,
      );
    }
    lines.push('', result.content);
    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
