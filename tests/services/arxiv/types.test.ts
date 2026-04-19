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

  it('drops empty meta segments instead of rendering trailing pipes', () => {
    const sparse: PaperMetadata = {
      ...MOCK_PAPER,
      primary_category: '',
      categories: [],
      published: '',
      updated: '',
    };
    const text = formatPaper(sparse);
    const metaLine = text.split('\n')[1];
    expect(metaLine).toBe('arXiv:2401.12345v1');
    expect(text).not.toMatch(/\|\s*$/m);
    expect(text).not.toMatch(/\|\s*\|/);
  });

  it('renders all categories when paper is cross-listed', () => {
    const text = formatPaper(MOCK_PAPER);
    const metaLine = text.split('\n')[1];
    expect(metaLine).toContain('cs.AI, cs.LG');
  });

  it('renders updated date alongside published when they differ', () => {
    const text = formatPaper(MOCK_PAPER);
    const metaLine = text.split('\n')[1];
    expect(metaLine).toContain('2024-01-22 (updated 2024-01-23)');
  });

  it('omits the updated suffix when it matches published', () => {
    const samePaper: PaperMetadata = { ...MOCK_PAPER, updated: '2024-01-22T00:00:00Z' };
    const text = formatPaper(samePaper);
    const metaLine = text.split('\n')[1];
    expect(metaLine).toContain('2024-01-22');
    expect(metaLine).not.toContain('updated');
  });

  it('falls back to updated date when published is missing', () => {
    const onlyUpdated: PaperMetadata = { ...MOCK_PAPER, published: '' };
    const text = formatPaper(onlyUpdated);
    const metaLine = text.split('\n')[1];
    expect(metaLine).toContain('2024-01-23');
    expect(metaLine).not.toContain('updated');
  });
});
