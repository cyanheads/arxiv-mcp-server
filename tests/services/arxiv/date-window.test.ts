/**
 * @fileoverview Tests for the submitted-date window helpers (issue #27) — the
 * seam where a live `submittedDate:[…]` clause and the mirror's ISO `published`
 * bounds have to describe the identical instant.
 * @module services/arxiv/date-window.test
 */

import { describe, expect, it } from 'vitest';
import {
  intersectBounds,
  isCalendarDate,
  SUBMITTED_DATE_CEILING,
  SUBMITTED_DATE_FLOOR,
  stampToIso,
  submittedDateBounds,
  submittedDateClause,
} from '@/services/arxiv/date-window.js';

describe('isCalendarDate', () => {
  it('accepts real UTC calendar dates', () => {
    expect(isCalendarDate('2024-01-01')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects a day that does not exist in that month', () => {
    // Date parsing rolls these forward instead of failing, so a plain regex
    // check would let them through and arXiv would match nothing.
    expect(isCalendarDate('2020-02-31')).toBe(false);
    expect(isCalendarDate('2021-02-29')).toBe(false);
    expect(isCalendarDate('2024-04-31')).toBe(false);
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    for (const value of ['2024-1-1', '20240101', '01/01/2024', '', 'yesterday', '2024-13-01']) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });
});

describe('submittedDateClause', () => {
  it('is absent when neither bound is set', () => {
    expect(submittedDateClause(undefined, undefined)).toBeUndefined();
    expect(submittedDateClause('', '')).toBeUndefined();
  });

  it('closes at midnight of the day AFTER the upper bound', () => {
    // A same-day `…2359` bound would drop everything submitted in that day's
    // final 59 seconds: arXiv compares the bound against the full-precision
    // submission timestamp, not a minute bucket.
    expect(submittedDateClause('2020-01-01', '2020-01-31')).toBe(
      'submittedDate:[202001010000 TO 202002010000]',
    );
  });

  it('rolls the upper bound across a month and a year end', () => {
    expect(submittedDateClause('2024-02-28', '2024-02-29')).toContain('TO 202403010000]');
    expect(submittedDateClause('2023-12-31', '2023-12-31')).toContain('TO 202401010000]');
  });

  it('substitutes a sentinel for an omitted bound', () => {
    expect(submittedDateClause('2020-01-01', undefined)).toBe(
      `submittedDate:[202001010000 TO ${SUBMITTED_DATE_CEILING}]`,
    );
    expect(submittedDateClause(undefined, '2020-01-31')).toBe(
      `submittedDate:[${SUBMITTED_DATE_FLOOR} TO 202002010000]`,
    );
  });

  it('leaves adjacent windows meeting at one shared instant, never a gap', () => {
    const first = submittedDateClause('2024-01-01', '2024-01-15');
    const second = submittedDateClause('2024-01-16', '2024-01-31');
    expect(first).toContain('TO 202401160000]');
    expect(second).toContain('[202401160000 ');
  });
});

describe('submittedDateBounds', () => {
  it('cuts at the same instants the live clause names', () => {
    const clause = submittedDateClause('2020-01-01', '2020-01-31');
    const bounds = submittedDateBounds('2020-01-01', '2020-01-31');
    const [lower, upper] = /\[(\d{12}) TO (\d{12})\]/.exec(clause ?? '')?.slice(1) ?? [];

    expect(bounds.from).toBe(stampToIso(lower ?? ''));
    expect(bounds.to).toBe(stampToIso(upper ?? ''));
    expect(bounds.from).toBe('2020-01-01T00:00:00.000Z');
    expect(bounds.to).toBe('2020-02-01T00:00:00.000Z');
  });

  it('omits a bound the caller did not set, rather than inventing one', () => {
    expect(submittedDateBounds('2020-01-01', undefined)).toEqual({
      from: '2020-01-01T00:00:00.000Z',
    });
    expect(submittedDateBounds(undefined, undefined)).toEqual({});
  });
});

describe('stampToIso', () => {
  it('names the instant a stamp opens at — the same instant either bound means', () => {
    expect(stampToIso('202001010000')).toBe('2020-01-01T00:00:00.000Z');
    expect(stampToIso('202001312359')).toBe('2020-01-31T23:59:00.000Z');
  });

  it('sorts lexicographically in chronological order', () => {
    const sorted = ['202002010000', '199101010000', '202001010000'].map(stampToIso).sort();
    expect(sorted).toEqual([
      '1991-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2020-02-01T00:00:00.000Z',
    ]);
  });
});

describe('intersectBounds', () => {
  it('keeps the tighter end from each side', () => {
    expect(
      intersectBounds(
        { from: '2020-01-01T00:00:00.000Z', to: '2020-04-01T00:00:00.000Z' },
        { from: '2020-02-01T00:00:00.000Z', to: '2020-06-01T00:00:00.000Z' },
      ),
    ).toEqual({ from: '2020-02-01T00:00:00.000Z', to: '2020-04-01T00:00:00.000Z' });
  });

  it('carries a bound only one side supplied', () => {
    expect(intersectBounds({}, { to: '2020-04-01T00:00:00.000Z' })).toEqual({
      to: '2020-04-01T00:00:00.000Z',
    });
    expect(intersectBounds({ from: '2020-01-01T00:00:00.000Z' }, {})).toEqual({
      from: '2020-01-01T00:00:00.000Z',
    });
  });

  it('reports no window when neither side has one', () => {
    expect(intersectBounds({}, {})).toEqual({});
  });
});
