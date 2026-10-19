/**
 * @fileoverview arxiv_read_paper tool — fetch the full HTML content of an arXiv paper.
 * @module mcp-server/tools/definitions/arxiv-read-paper
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArxivService } from '@/services/arxiv/arxiv-service.js';
import { normalizePaperId, PAPER_ID_FORMS } from '@/services/arxiv/paper-id.js';
import {
  type OutlineEntry,
  OutlineEntrySchema,
  PaperContentSourceSchema,
} from '@/services/arxiv/types.js';

/** Outline as text: one line per heading, indented by level, with its level and start. */
function formatOutline(
  outline: OutlineEntry[],
  omittedLevels: number[] | undefined,
  continuesAt: number | undefined,
): string {
  const topLevel = Math.min(...outline.map((entry) => entry.level));
  const lines =
    outline.length === 0
      ? ['Outline: none']
      : [
          "Outline (pass an entry's start to read from that heading):",
          ...outline.map(
            (entry) =>
              `${'  '.repeat(entry.level - topLevel)}- ${entry.title} (level ${entry.level}, start=${entry.start})`,
          ),
        ];
  if (omittedLevels?.length) {
    lines.push(
      `[Outline capped at 200 entries: ${omittedLevels
        .toSorted((a, b) => a - b)
        .map((level) => `level ${level}`)
        .join(' and ')} headings omitted. Page through the body to reach them.]`,
    );
  }
  if (continuesAt !== undefined) {
    lines.push(
      `[Outline cut at 200 entries: more level ${topLevel} headings follow. Read on with start=${continuesAt} to reach them.]`,
    );
  }
  return lines.join('\n');
}

export const arxivReadPaper = tool('arxiv_read_paper', {
  description:
    "Fetch the full text of an arXiv paper. Tries arxiv.org/html first, falls back to ar5iv.labs.arxiv.org, and falls back again to text extracted from the PDF when neither has an HTML render — check the source field to know which one answered. Page through long papers with start and max_characters, or pass max_characters null to get the entire body in one call. To read one section, take the outline from the first page (start 0) and pass an entry's start.",
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'paper_id is not an arXiv identifier in an accepted form.',
      recovery:
        'Send an ID like "2401.12345", "2401.12345v2", or "hep-th/9901001" (a pre-2007 archive spelled as arXiv issued it); an arXiv: prefix or an arxiv.org abs, pdf, or html URL also works.',
    },
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper ID is not present in the arXiv index.',
      recovery:
        'Verify the paper ID format (e.g., "2401.12345") and confirm via arxiv_search_papers before retrying.',
      thrownBy: 'service',
      severity: 'notice',
    },
    {
      reason: 'content_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper exists but neither arxiv.org/html nor ar5iv has an HTML rendering and arXiv served no PDF either.',
      recovery:
        'Read the abstract via arxiv_get_metadata, since no full-text artifact exists for this paper.',
      thrownBy: 'service',
      severity: 'notice',
    },
    {
      reason: 'pdf_extraction_failed',
      code: JsonRpcErrorCode.NotFound,
      when: 'Paper has no HTML rendering and its PDF carries no text layer — an image-only or scanned submission.',
      recovery:
        'Download error.data.pdfUrl and run optical character recognition, or read the abstract via arxiv_get_metadata.',
      thrownBy: 'service',
      severity: 'notice',
    },
    {
      reason: 'version_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A version-pinned paper_id was requested, arXiv is unreachable, and the local mirror holds only a different version — per-version reads require the live API.',
      retryable: true,
      recovery:
        'Retry once arXiv is reachable, or request the version reported in error.data.mirrorVersion.',
      thrownBy: 'service',
    },
    {
      reason: 'version_not_served',
      code: JsonRpcErrorCode.NotFound,
      when: "paper_id pins a superseded version of a pre-2007 paper that arXiv's API answers HTTP 500 for. The version exists, but its metadata cannot be returned.",
      recovery:
        'Read the latest version the error message names, or download this version from error.data.pdfUrl.',
      thrownBy: 'service',
      severity: 'notice',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'arXiv has throttled requests (HTTP 429 or "Rate exceeded." body).',
      retryable: true,
      recovery:
        'Wait error.data.cooldownAppliedMs milliseconds before retrying, and lower concurrent arXiv calls.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'arXiv rejected the metadata lookup (HTTP 4xx other than 429).',
      recovery: 'Verify the paper ID format (e.g., "2401.12345" or "2401.12345v2") and retry.',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    paper_id: z
      .string()
      .trim()
      .min(1, 'Paper ID cannot be empty. Provide an arXiv ID (e.g., "2401.12345").')
      .describe(
        'arXiv paper ID: "2401.12345", "2401.12345v2" (a pinned version), or a pre-2007 ID like "hep-th/9901001" (archive spelled as arXiv issued it), optionally prefixed "arXiv:", or an arxiv.org abs, pdf, or html URL, with or without https:// or a ?query or #fragment.',
      ),
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
        "Character offset into the cleaned body to begin reading from. Defaults to 0. Use with max_characters to page through long papers — e.g., start=100000 with max_characters=100000 returns chars 100,000–199,999 — or pass an outline entry's start to read from that heading. The total length is reported as body_characters in the response.",
      ),
  }),

  output: z.object({
    paper_id: z.string().describe('arXiv paper ID.'),
    title: z.string().describe('Paper title (from metadata, not parsed from HTML).'),
    content: z
      .string()
      .describe(
        'Paper body for the requested slice — the article as cleaned HTML, with relative image, object, and link URLs made absolute (in-page #fragment links stay as written), when source is arxiv_html or ar5iv; plain text when source is pdf_text. Empty when start is past body_characters.',
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
        'Character count of the body before cleaning — the article HTML, without the site header and footer, for arxiv_html and ar5iv; equal to body_characters for pdf_text, which needs no cleaning.',
      ),
    body_characters: z
      .number()
      .describe(
        'Character count of the full cleaned body. Use with start and max_characters to page. Typically 3-4× smaller than total_characters for math-heavy HTML papers.',
      ),
    pdf_url: z.string().describe('Direct PDF download URL.'),
    abstract_url: z.string().describe('arXiv abstract page URL for attribution.'),
    revision_unconfirmed: z
      .literal(true)
      .optional()
      .describe(
        'Present, true, when source is ar5iv: ar5iv keeps one render per paper whatever version is asked for, so the body may be another revision than paper_id, while pdf_url is exactly the paper_id revision. Absent for every other source, and for an unversioned read of a paper whose only version is v1.',
      ),
    outline: z
      .array(OutlineEntrySchema)
      .optional()
      .describe(
        'Section headings of the whole cleaned body in document order, each with the start that reads from it. Returned only when start is 0. Empty for pdf_text, whose text carries no reliable headings. At most 200 entries — see outline_omitted_levels and outline_continues_at.',
      ),
    outline_continues_at: z
      .number()
      .int()
      .optional()
      .describe(
        'Present when the shallowest heading level alone has more than 200 headings, so outline stops at its first 200: the start of the first heading left out. Pass it as start to read on from there.',
      ),
    outline_omitted_levels: z
      .array(z.number().int())
      .optional()
      .describe(
        'Heading levels left out of outline because the paper has more than 200 headings, deepest first. Present only when levels were left out.',
      ),
  }),

  async handler(input, ctx) {
    const paperId = normalizePaperId(input.paper_id);
    if (!paperId) {
      throw ctx.fail(
        'invalid_id',
        `'${input.paper_id}' is not an arXiv ID. Use ${PAPER_ID_FORMS}.`,
        { paperId: input.paper_id },
      );
    }
    const service = getArxivService();
    const result = await service.readContent(
      paperId,
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
    if (result.revision_unconfirmed) {
      lines.push(
        `\n[Revision unconfirmed: ar5iv keeps one render per paper, so this body may be another revision than arXiv:${result.paper_id}. The PDF at ${result.pdf_url} is exactly arXiv:${result.paper_id}.]`,
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
    if (result.outline) {
      lines.push(
        '',
        formatOutline(result.outline, result.outline_omitted_levels, result.outline_continues_at),
      );
    }
    lines.push('', result.content);
    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
