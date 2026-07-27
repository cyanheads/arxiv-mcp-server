/**
 * @fileoverview Submitted-date window helpers shared by the live and mirror
 * search paths. One definition of a window, emitted two ways — the
 * `submittedDate:[…]` clause the live arXiv API takes, and the ISO bounds the
 * mirror's `published` column is compared against — so the two paths cannot
 * drift apart at a boundary.
 * @module services/arxiv/date-window
 */

/**
 * arXiv range semantics, established against the live API rather than assumed.
 *
 * A `submittedDate:[A TO B]` range takes `YYYYMMDDHHMM` stamps and is inclusive
 * of both endpoints, but each stamp names an exact instant (`HH:MM:00`) and is
 * compared against the paper's full-precision submission timestamp — it is not
 * a minute bucket. Probed on `cat:cs.CL`, 2020-01-16, against a paper submitted
 * at exactly `03:39:00Z`: an upper bound of `…0339` includes it, and so does a
 * lower bound of `…0339`. A paper at `01:49:16Z` is excluded by an upper bound
 * of `…0149` and included by `…0150`.
 *
 * The consequence drives the encoding below: a day window ending at `…2359`
 * would silently drop everything submitted in that day's last 59 seconds, so
 * consecutive day windows would leave a gap. Ending instead at midnight of the
 * following day closes it. The residue is a single shared instant — a paper
 * submitted at exactly `00:00:00.000Z` falls in both adjacent windows — which
 * is unavoidable with an operator that is inclusive at both ends, and is the
 * strictly better trade against a recurring 59-second hole.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Lower sentinel for an open-ended window — arXiv's first submissions are from August 1991. */
export const SUBMITTED_DATE_FLOOR = '199101010000';

/**
 * Upper sentinel for an open-ended window. A fixed far-future instant rather
 * than "now", so an echoed query stays stable: replaying it days later still
 * names the same window.
 */
export const SUBMITTED_DATE_CEILING = '300001010000';

/**
 * True when `date` is a real UTC calendar date in `YYYY-MM-DD` form. `Date`
 * parsing rolls a nonexistent day forward (`2020-02-31` becomes March 2), so
 * the round-trip comparison is what rejects it.
 */
export function isCalendarDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

/** The instant an inclusive window opens at: midnight UTC on `date`. */
function windowLowerStamp(date: string): string {
  return `${date.replaceAll('-', '')}0000`;
}

/**
 * The instant an inclusive window closes at: midnight UTC on the day AFTER
 * `date`. See the note above — a same-day `2359` bound loses the day's final
 * 59 seconds.
 */
function windowUpperStamp(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10).replaceAll('-', '')}0000`;
}

/**
 * The `submittedDate:[…]` clause for an inclusive `YYYY-MM-DD` window, or
 * `undefined` when neither bound is set. An omitted bound becomes the matching
 * sentinel — arXiv requires both endpoints.
 */
export function submittedDateClause(from?: string, to?: string): string | undefined {
  if (!from && !to) return;
  const lower = from ? windowLowerStamp(from) : SUBMITTED_DATE_FLOOR;
  const upper = to ? windowUpperStamp(to) : SUBMITTED_DATE_CEILING;
  return `submittedDate:[${lower} TO ${upper}]`;
}

/**
 * The same window as ISO 8601 bounds on the mirror's `published` column — the
 * twin of {@link submittedDateClause}, built from the same stamps so both paths
 * cut at the identical instant. Compared with `>=` / `<=`, matching arXiv's
 * inclusive endpoints.
 */
export function submittedDateBounds(from?: string, to?: string): { from?: string; to?: string } {
  return {
    ...(from !== undefined && { from: stampToIso(windowLowerStamp(from)) }),
    ...(to !== undefined && { to: stampToIso(windowUpperStamp(to)) }),
  };
}

/**
 * The ISO 8601 instant a `YYYYMMDDHHMM` stamp names. Both ends of an arXiv range
 * are inclusive of exactly this instant, so one conversion serves both bounds.
 * The mirror stores `published` in this normalized form, making lexicographic
 * comparison chronological.
 */
export function stampToIso(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:00.000Z`;
}

/**
 * Narrow an inclusive bound pair to the tighter of two. ISO 8601 timestamps in
 * the mirror's normalized form sort lexicographically, so string comparison is
 * chronological. Used when a window arrives from both the `submitted_*` inputs
 * and a `submittedDate:` operand inside the query — the result honors both.
 */
export function intersectBounds(
  a: { from?: string; to?: string },
  b: { from?: string; to?: string },
): { from?: string; to?: string } {
  const from = [a.from, b.from]
    .filter((v) => v !== undefined)
    .sort()
    .at(-1);
  const to = [a.to, b.to]
    .filter((v) => v !== undefined)
    .sort()
    .at(0);
  return { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
}
