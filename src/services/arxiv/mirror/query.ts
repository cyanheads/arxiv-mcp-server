/**
 * @fileoverview arXiv query syntax → FTS5 translator with category-hierarchy
 * expansion. Parses field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `all:`),
 * boolean operators (`AND`, `OR`, `ANDNOT`), quoted phrases, and parens.
 * Extracts `cat:` operands into a structured filter so they apply against
 * the indexed `primary_category` / `categories` columns instead of FTS.
 * @module services/arxiv/mirror/query
 */

import { ARXIV_CATEGORIES, GROUPS } from '../categories.js';

/** Result of translating an arXiv-syntax query to mirror inputs. */
export interface TranslatedQuery {
  /** Distinct category codes (already group/archive-expanded). Empty when the user did not use `cat:`. */
  categoryFilters: string[];
  /** FTS5 MATCH expression, or undefined when the user query had no full-text component. */
  matchExpr?: string;
}

type Token =
  | { kind: 'and' | 'or' | 'andnot' | 'lparen' | 'rparen' }
  | { kind: 'field'; field: 'ti' | 'au' | 'abs' | 'cat' | 'all'; value: string; phrase: boolean }
  | { kind: 'term'; value: string; phrase: boolean };

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
// Category expansion
// ---------------------------------------------------------------------------

/**
 * Expand a single `cat:` value to one or more concrete category codes.
 * - `cs` → all `cs.*` codes (group/archive expansion)
 * - `physics` → all categories grouped under physics
 * - `cs.LG` → unchanged
 * Unknown codes are returned verbatim so the caller can decide whether to warn.
 */
export function expandCategory(code: string): string[] {
  const trimmed = code.trim();
  if (!trimmed) return [];
  if (trimmed.includes('.')) return [trimmed];
  // Group-level (e.g. `cs`, `physics`)
  const lower = trimmed.toLowerCase();
  if ((GROUPS as readonly string[]).includes(lower)) {
    return ARXIV_CATEGORIES.filter((cat) => cat.group === lower).map((cat) => cat.code);
  }
  // Archive code without dot (e.g. `hep-th` covers the entire archive)
  const archivePrefix = `${trimmed}.`;
  const archiveMatches = ARXIV_CATEGORIES.filter((cat) => cat.code.startsWith(archivePrefix)).map(
    (cat) => cat.code,
  );
  if (archiveMatches.length > 0) return archiveMatches;
  return [trimmed];
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Translate an arXiv-syntax query into an FTS5 MATCH expression and a list of
 * structured category filters. The category operands are stripped from the
 * FTS expression — they apply as a separate WHERE clause inside `MirrorStore`.
 */
export function translateQuery(query: string): TranslatedQuery {
  const tokens = tokenize(query);
  const categoryFilters = new Set<string>();
  const ftsParts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;

    // Strip `cat:` operands into the category filter set. Any boolean operator
    // bridging two `cat:` tokens is dropped along with the operands.
    if (t.kind === 'field' && t.field === 'cat') {
      for (const c of expandCategory(t.value)) categoryFilters.add(c);
      // Consume an adjacent dangling boolean operator if it sandwiches another
      // `cat:` operand or sits at the boundary of the FTS expression.
      const prev = ftsParts[ftsParts.length - 1];
      const next = tokens[i + 1];
      const dropPrev =
        prev === 'AND' || prev === 'OR' || prev === 'NOT'
          ? next === undefined || (next.kind === 'field' && next.field === 'cat')
          : false;
      if (dropPrev) ftsParts.pop();
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

  // Trim leading/trailing dangling operators that surfaced after `cat:` removal.
  while (ftsParts.length > 0 && isBoolOp(ftsParts[0])) ftsParts.shift();
  while (ftsParts.length > 0 && isBoolOp(ftsParts[ftsParts.length - 1])) ftsParts.pop();

  const matchExpr = ftsParts.length > 0 ? collapseSpaces(joinFtsParts(ftsParts)) : undefined;

  return {
    ...(matchExpr !== undefined && { matchExpr }),
    categoryFilters: [...categoryFilters],
  };
}

function isBoolOp(s: string | undefined): boolean {
  return s === 'AND' || s === 'OR' || s === 'NOT';
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
