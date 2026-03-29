/**
 * @fileoverview Tests for domain types and shared formatters.
 * @module services/arxiv/types.test
 */

import { describe, expect, it } from 'vitest';
import { formatPaper, type PaperMetadata } from '@/services/arxiv/types.js';

const MOCK_PAPER: PaperMetadata = {
  id: '2401.12345v1',
  title: 'Test Paper Title',
  authors: ['Alice', 'Bob'],
  abstract: 'Test abstract text.',
  primary_category: 'cs.AI',
  categories: ['cs.AI', 'cs.LG'],
  published: '2024-01-22T00:00:00Z',
  updated: '2024-01-23T00:00:00Z',
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

describe('formatPaper', () => {
  it('renders basic paper metadata', () => {
    const text = formatPaper(MOCK_PAPER);
    expect(text).toContain('**Test Paper Title**');
    expect(text).toContain('arXiv:2401.12345v1');
    expect(text).toContain('cs.AI');
    expect(text).toContain('2024-01-22');
    expect(text).toContain('Alice, Bob');
    expect(text).toContain('Test abstract text.');
    expect(text).toContain('PDF: https://arxiv.org/pdf/2401.12345v1');
  });

  it('includes optional fields when present', () => {
    const paper: PaperMetadata = {
      ...MOCK_PAPER,
      comment: '10 pages, 3 figures',
      journal_ref: 'Nature 2024',
      doi: '10.1234/test',
    };
    const text = formatPaper(paper);
    expect(text).toContain('Comment: 10 pages, 3 figures');
    expect(text).toContain('Journal: Nature 2024');
    expect(text).toContain('DOI: 10.1234/test');
  });

  it('omits optional fields when absent', () => {
    const text = formatPaper(MOCK_PAPER);
    expect(text).not.toContain('Comment:');
    expect(text).not.toContain('Journal:');
    expect(text).not.toContain('DOI:');
  });
});
