/**
 * @fileoverview arXiv query syntax → FTS5 translator with category-subtree
 * expansion. Parses field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `all:`),
 * boolean operators (`AND`, `OR`, `ANDNOT`), quoted phrases, and parens.
 * Extracts `cat:` operands into a structured filter so they apply against
 * the indexed category columns instead of FTS, and `submittedDate:[… TO …]`
 * into ISO bounds on the indexed `published` column.
 * @module services/arxiv/mirror/query
 */

import { categorySubtree } from '../categories.js';
import { intersectBounds, stampToIso } from '../date-window.js';

/** Result of translating an arXiv-syntax query to mirror inputs. */
export interface TranslatedQuery {
  /** Distinct category codes (already subtree-expanded). Empty when the user did not use `cat:`. */
  categoryFilters: string[];
  /** FTS5 MATCH expression, or undefined when the user query had no full-text component. */
  matchExpr?: string;
  /**
   * Inclusive ISO 8601 bounds on `papers.published`, from any
   * `submittedDate:[… TO …]` operand. Both members are absent when the query
   * carried no window; multiple operands narrow to their intersection.
   */
  published: { from?: string; to?: string };
}

type Token =
  | { kind: 'and' | 'or' | 'andnot' | 'lparen' | 'rparen' }
  | { kind: 'daterange'; from: string; to: string }
  | { kind: 'field'; field: 'ti' | 'au' | 'abs' | 'cat' | 'all'; value: string; phrase: boolean }
  | { kind: 'term'; value: string; phrase: boolean };

/**
 * arXiv's submitted-date range operand. Only a fully-formed clause with two
 * `YYYYMMDDHHMM` stamps is lifted out; anything else falls through to ordinary
 * tokenization rather than being silently reinterpreted as a date filter.
 */
const DATE_RANGE_PATTERN = /^submittedDate:\[\s*(\d{12})\s+TO\s+(\d{12})\s*\]/i;

const FIELD_MAP: Record<string, 'ti' | 'au' | 'abs' | 'cat' | 'all'> = {
  ti: 'ti',
  au: 'au',
  abs: 'abs',
  cat: 'cat',
  all: 'all',
};

const FTS_COLUMN: Record<'ti' | 'au' | 'abs', string> = {
  ti: 'title',
  au: 'authors',
  abs: 'abstract',
};

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    const rangeMatch = DATE_RANGE_PATTERN.exec(input.slice(i));
    if (rangeMatch?.[1] && rangeMatch[2]) {
      tokens.push({ kind: 'daterange', from: rangeMatch[1], to: rangeMatch[2] });
      i += rangeMatch[0].length;
      continue;
    }
    // Look for word followed by `:` (field prefix), allow quoted value
    const fieldMatch = input.slice(i).match(/^([A-Za-z]+):/);
    if (fieldMatch) {
      const fieldName = (fieldMatch[1] ?? '').toLowerCase();
      const field = FIELD_MAP[fieldName];
      if (field) {
        i += fieldMatch[0].length;
        const { value, phrase, consumed } = consumeValue(input, i);
        i += consumed;
        tokens.push({ kind: 'field', field, value, phrase });
        continue;
      }
    }
    // Bare word or quoted phrase
    const { value, phrase, consumed } = consumeValue(input, i);
    i += consumed;
    if (value.length === 0) continue;
    const upper = value.toUpperCase();
    if (upper === 'AND' && !phrase) {
      tokens.push({ kind: 'and' });
      continue;
    }
    if (upper === 'OR' && !phrase) {
      tokens.push({ kind: 'or' });
      continue;
    }
    if (upper === 'ANDNOT' && !phrase) {
      tokens.push({ kind: 'andnot' });
      continue;
    }
    tokens.push({ kind: 'term', value, phrase });
  }
  return tokens;
}

function consumeValue(
  input: string,
  start: number,
): { consumed: number; phrase: boolean; value: string } {
  const ch = input[start];
  if (ch === '"') {
    const end = input.indexOf('"', start + 1);
    if (end === -1) {
      // Unterminated quote — treat the rest of the string as a phrase
      return { value: input.slice(start + 1), phrase: true, consumed: input.length - start };
    }
    return { value: input.slice(start + 1, end), phrase: true, consumed: end - start + 1 };
  }
  let i = start;
  while (i < input.length) {
    const c = input[i] ?? '';
    if (/\s/.test(c) || c === '(' || c === ')') break;
    i++;
  }
  return { value: input.slice(start, i), phrase: false, consumed: i - start };
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Translate an arXiv-syntax query into an FTS5 MATCH expression plus the
 * structured filters that cannot ride in FTS: category codes and a submitted-date
 * window. Both operand kinds are stripped from the FTS expression — they apply as
 * separate WHERE clauses inside `MirrorStore`.
 */
export function translateQuery(query: string): TranslatedQuery {
  const tokens = tokenize(query);
  const categoryFilters = new Set<string>();
  let published: { from?: string; to?: string } = {};
  const ftsParts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;

    // Strip `cat:` and `submittedDate:` operands into structured filters. The
    // operators they leave behind (and any groups they empty out) are reconciled
    // by `cleanupDanglingOps` after the main pass — local cleanup here is wrong
    // whenever the next token is `)` or another operator, so don't try.
    if (t.kind === 'field' && t.field === 'cat') {
      for (const c of categorySubtree(t.value)) categoryFilters.add(c);
      continue;
    }
    if (t.kind === 'daterange') {
      published = intersectBounds(published, { from: stampToIso(t.from), to: stampToIso(t.to) });
      continue;
    }

    switch (t.kind) {
      case 'and':
        ftsParts.push('AND');
        break;
      case 'or':
        ftsParts.push('OR');
        break;
      case 'andnot':
        ftsParts.push('NOT');
        break;
      case 'lparen':
        ftsParts.push('(');
        break;
      case 'rparen':
        ftsParts.push(')');
        break;
      case 'field': {
        if (t.field === 'cat') break;
        if (t.field === 'all') {
          const v = quoteFtsValue(t.value, t.phrase);
          ftsParts.push(`(title:${v} OR authors:${v} OR abstract:${v})`);
        } else {
          ftsParts.push(`${FTS_COLUMN[t.field]}:${quoteFtsValue(t.value, t.phrase)}`);
        }
        break;
      }
      case 'term':
        ftsParts.push(quoteFtsValue(t.value, t.phrase));
        break;
    }
  }

  const cleaned = cleanupDanglingOps(ftsParts);
  const matchExpr = cleaned.length > 0 ? collapseSpaces(joinFtsParts(cleaned)) : undefined;

  return {
    ...(matchExpr !== undefined && { matchExpr }),
    categoryFilters: [...categoryFilters],
    published,
  };
}

function isBoolOp(s: string | undefined): boolean {
  return s === 'AND' || s === 'OR' || s === 'NOT';
}

/**
 * Reconcile `ftsParts` after `cat:` extraction. Runs to a fixed point:
 * collapses empty `( )` groups, then drops any boolean operator whose
 * neighbors no longer form a valid binary expression — adjacent to `(`,
 * `)`, an array endpoint, or another operator (in which case the earlier
 * operator wins). One pass can expose another (an empty group collapse
 * leaves operators newly adjacent); iterating until stable handles every
 * combination without per-shape special cases.
 */
function cleanupDanglingOps(parts: readonly string[]): string[] {
  let working: readonly string[] = parts;
  for (;;) {
    const next: string[] = [];
    let i = 0;
    while (i < working.length) {
      const cur = working[i] ?? '';
      if (cur === '(' && working[i + 1] === ')') {
        i += 2;
        continue;
      }
      if (isBoolOp(cur)) {
        const prev = next[next.length - 1];
        const after = working[i + 1];
        if (
          prev === undefined ||
          prev === '(' ||
          isBoolOp(prev) ||
          after === undefined ||
          after === ')'
        ) {
          i++;
          continue;
        }
      }
      next.push(cur);
      i++;
    }
    if (next.length === working.length) return next;
    working = next;
  }
}

/**
 * Join `ftsParts` with a space, inserting an explicit `AND` at every
 * adjacency that would otherwise force FTS5 to apply implicit conjunction
 * across a parenthesized boundary. FTS5 only honors implicit-AND between
 * bare phrases — once either side carries parens (a `(` / `)` literal token
 * from user grouping, or a single-string `all:` expansion of the form
 * `(col:val OR …)`), an explicit operator is required.
 */
function joinFtsParts(parts: readonly string[]): string {
  const out: string[] = [];
  for (const cur of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && needsExplicitAnd(prev, cur)) out.push('AND');
    out.push(cur);
  }
  return out.join(' ');
}

function needsExplicitAnd(prev: string, next: string): boolean {
  if (isBoolOp(prev) || isBoolOp(next)) return false;
  // `(` opens a group; `)` closes one — neither boundary needs a sibling AND.
  if (prev === '(' || next === ')') return false;
  return prev.endsWith(')') || next.startsWith('(');
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

/**
 * Encode a value as an FTS5 quoted token. Quoting handles whitespace,
 * punctuation, and FTS5 reserved characters in one stroke; double-quotes
 * inside the value are escaped per FTS5 syntax (`""`).
 */
function quoteFtsValue(value: string, _phrase: boolean): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '""';
  return `"${trimmed.replace(/"/g, '""')}"`;
}
