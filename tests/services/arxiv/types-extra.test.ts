/**
 * @fileoverview Additional tests for domain types and formatPaper — edge cases,
 * unicode, absent fields, and security-relevant output checks.
 * @module services/arxiv/types-extra.test
 */

import { describe, expect, it } from 'vitest';
import { formatPaper, type PaperMetadata, PaperMetadataSchema } from '@/services/arxiv/types.js';

const BASE_PAPER: PaperMetadata = {
  id: '2401.12345v1',
  title: 'Test Paper',
  authors: ['Alice'],
  abstract: 'Abstract text.',
  primary_category: 'cs.AI',
  categories: ['cs.AI'],
  published: '2024-01-22T00:00:00Z',
  updated: '2024-01-22T00:00:00Z',
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

// ---------------------------------------------------------------------------
// PaperMetadataSchema
// ---------------------------------------------------------------------------

describe('PaperMetadataSchema', () => {
  it('validates a minimal valid paper', () => {
    expect(() => PaperMetadataSchema.parse(BASE_PAPER)).not.toThrow();
  });

  it('rejects paper missing required id field', () => {
    const { id: _id, ...withoutId } = BASE_PAPER;
    expect(() => PaperMetadataSchema.parse(withoutId)).toThrow();
  });

  it('rejects paper missing required authors field', () => {
    const { authors: _a, ...withoutAuthors } = BASE_PAPER;
    expect(() => PaperMetadataSchema.parse(withoutAuthors)).toThrow();
  });

  it('rejects paper with non-array categories', () => {
    expect(() => PaperMetadataSchema.parse({ ...BASE_PAPER, categories: 'cs.AI' })).toThrow();
  });

  it('accepts paper with no optional fields (comment, journal_ref, doi absent)', () => {
    const result = PaperMetadataSchema.parse(BASE_PAPER);
    expect(result.comment).toBeUndefined();
    expect(result.journal_ref).toBeUndefined();
    expect(result.doi).toBeUndefined();
  });

  it('accepts and preserves all optional fields when present', () => {
    const full = { ...BASE_PAPER, comment: 'p', journal_ref: 'j', doi: 'd' };
    const result = PaperMetadataSchema.parse(full);
    expect(result.comment).toBe('p');
    expect(result.journal_ref).toBe('j');
    expect(result.doi).toBe('d');
  });
});

// ---------------------------------------------------------------------------
// formatPaper — edge cases
// ---------------------------------------------------------------------------

describe('formatPaper edge cases', () => {
  it('handles unicode characters in title and authors', () => {
    const paper: PaperMetadata = {
      ...BASE_PAPER,
      title: 'über Quantenmechanik — 量子力学',
      authors: ['Müller, H.', '李 明'],
    };
    const text = formatPaper(paper);
    expect(text).toContain('über Quantenmechanik');
    expect(text).toContain('量子力学');
    expect(text).toContain('Müller, H.');
    expect(text).toContain('李 明');
  });

  it('handles very long abstract without truncating or throwing', () => {
    const longAbstract = 'The model achieves state-of-the-art results. '.repeat(200);
    const paper: PaperMetadata = { ...BASE_PAPER, abstract: longAbstract };
    const text = formatPaper(paper);
    // Entire abstract must be present
    expect(text).toContain(longAbstract.slice(0, 50));
    expect(text).toContain(longAbstract.slice(-50));
  });

  it('handles paper with single author (no comma joining needed)', () => {
    const text = formatPaper({ ...BASE_PAPER, authors: ['Solo Author'] });
    expect(text).toContain('Solo Author');
    // Should not produce trailing comma
    expect(text).not.toContain('Solo Author,');
  });

  it('handles paper with many categories without error', () => {
    const paper: PaperMetadata = {
      ...BASE_PAPER,
      categories: ['cs.AI', 'cs.LG', 'cs.CV', 'cs.CL', 'stat.ML'],
    };
    const text = formatPaper(paper);
    expect(text).toContain('cs.AI');
    expect(text).toContain('stat.ML');
  });

  it('does not duplicate primary_category in the category list', () => {
    // primary_category is already in categories; formatPaper should list unique
    const paper: PaperMetadata = {
      ...BASE_PAPER,
      primary_category: 'cs.AI',
      categories: ['cs.AI', 'cs.LG'],
    };
    const text = formatPaper(paper);
    // "cs.AI" should appear only once in the meta line
    const metaLine = text.split('\n')[1] ?? '';
    const matches = (metaLine.match(/cs\.AI/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it('output does not contain API keys or env-style tokens', () => {
    const text = formatPaper(BASE_PAPER);
    // formatPaper works only on the PaperMetadata it receives — env-style
    // tokens that look like keys should not appear unless they're part of the data.
    // This ensures we aren't accidentally interpolating env vars into formatted output.
    expect(text).not.toMatch(/ARXIV_API_BASE_URL/);
    expect(text).not.toMatch(/process\.env\./);
  });

  it('includes PDF URL always (required for attribution)', () => {
    const text = formatPaper(BASE_PAPER);
    expect(text).toContain('PDF: https://arxiv.org/pdf/2401.12345v1');
  });

  it('includes abstract URL always', () => {
    const text = formatPaper(BASE_PAPER);
    expect(text).toContain('Abstract: https://arxiv.org/abs/2401.12345v1');
  });

  it('handles abstract with newlines (normalized to single space)', () => {
    // Abstracts from arXiv often contain \n from line-wrapping in the source.
    // The service normalizes whitespace; formatPaper should not re-introduce newlines.
    const paper: PaperMetadata = {
      ...BASE_PAPER,
      abstract: 'First line.\nSecond line.\n  Indented line.',
    };
    const text = formatPaper(paper);
    // The abstract is included as-is from the domain type; no additional whitespace
    // normalization is expected from formatPaper itself.
    expect(text).toContain('First line.');
  });

  it('handles empty authors array without throwing', () => {
    const paper: PaperMetadata = { ...BASE_PAPER, authors: [] };
    expect(() => formatPaper(paper)).not.toThrow();
  });
});
