/**
 * @fileoverview arXiv query syntax → FTS5 translator with category-subtree
 * expansion. Parses field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `co:`, `jr:`,
 * `all:`), boolean operators (`AND`, `OR`, `ANDNOT`), quoted phrases, and
 * parens with arXiv's precedence, where `AND` (explicit or implicit) binds
 * tighter than `ANDNOT` and `OR`. Lifts `cat:` operands into category groups
 * that apply against the indexed category columns instead of FTS, and
 * `submittedDate:[… TO …]` into ISO bounds on the indexed `published` column —
 * but only an operand that is a conjunct of the whole query, the one place a
 * filter beside the FTS match means what arXiv means. Any other query is routed
 * to the live API. See issue #65.
 *
 * Also exports {@link expandCategoryOperands}, the live path's counterpart to
 * the `cat:` subtree expansion this translator applies — one lexer, so a `cat:`
 * operand means the same thing whichever backend answers.
 * @module services/arxiv/mirror/query
 */

import { categorySearchTerm, categorySubtree } from '../categories.js';
import { intersectBounds, stampToIso } from '../date-window.js';

/** Inclusive ISO 8601 bounds on `papers.published`. */
interface Bounds {
  from?: string;
  to?: string;
}

/** A query the mirror answers with the set arXiv returns for it. */
export interface MirrorQuery {
  /**
   * The query's category filters, subtree-expanded: codes OR-ed within a group,
   * groups AND-ed. One group per lifted `cat:` operand, and one per set of
   * `cat:` operands joined only by `OR`. Empty when the query has no `cat:`.
   */
  categoryGroups: string[][];
  /** FTS5 MATCH expression, or undefined when the query has no full-text component. */
  matchExpr?: string;
  /**
   * Bounds from the query's `submittedDate:[… TO …]` operands, narrowed to
   * their intersection. Both members are absent when the query carried no window.
   */
  published: Bounds;
  route: 'mirror';
}

/**
 * Why a query goes to the live API: `filter_not_conjunct` — a `cat:` or
 * `submittedDate:` operand sits under an `OR` or on the right of an `ANDNOT`,
 * where no filter beside the FTS match expresses it; `no_positive_term` — with
 * its filters lifted, the query or a parenthesized group in it keeps terms only
 * on the right of an `ANDNOT`, which FTS5 cannot match on their own
 * (`(cat:cs.LG ANDNOT survey) AND transformer` included); `unbalanced_parens` —
 * the grouping has no single reading.
 */
export type LiveRouteReason = 'filter_not_conjunct' | 'no_positive_term' | 'unbalanced_parens';

/** A query only the live API answers as written. */
export interface LiveQuery {
  reason: LiveRouteReason;
  route: 'live';
}

/** Result of translating an arXiv-syntax query to mirror inputs. */
export type TranslatedQuery = MirrorQuery | LiveQuery;

/** Field prefixes the lexer recognizes. Anything else stays a bare term. */
type Field = 'ti' | 'au' | 'abs' | 'cat' | 'co' | 'jr' | 'all';

/** Source span `[start, end)` every token carries, so a rewrite can splice
 * one operand out of the original string and leave the rest byte-identical. */
interface Span {
  end: number;
  start: number;
}

type Token = Span &
  (
    | { kind: 'and' | 'or' | 'andnot' | 'lparen' | 'rparen' }
    | { kind: 'daterange'; from: string; to: string }
    | { kind: 'field'; field: Field; value: string; phrase: boolean }
    | { kind: 'term'; value: string; phrase: boolean }
  );

/**
 * arXiv's submitted-date range operand. Only a fully-formed clause with two
 * `YYYYMMDDHHMM` stamps is lifted out; anything else falls through to ordinary
 * tokenization rather than being silently reinterpreted as a date filter.
 */
const DATE_RANGE_PATTERN = /^submittedDate:\[\s*(\d{12})\s+TO\s+(\d{12})\s*\]/i;

const FIELD_MAP: Record<string, Field> = {
  ti: 'ti',
  au: 'au',
  abs: 'abs',
  cat: 'cat',
  co: 'co',
  jr: 'jr',
  all: 'all',
};

/**
 * Prefix → `papers_fts` column. Every entry here has to be an indexed column of
 * the FTS5 table (schema v3 indexes all five) — routing a prefix at a column
 * outside the index raises `no such column` at query time, not at build time.
 */
const FTS_COLUMN: Record<Exclude<Field, 'cat' | 'all'>, string> = {
  ti: 'title',
  au: 'authors',
  abs: 'abstract',
  co: 'comment',
  jr: 'journal_ref',
};

/** Columns `all:` fans out across — the whole FTS index, matching arXiv's own
 * all-fields prefix. */
const ALL_COLUMNS: readonly string[] = Object.values(FTS_COLUMN);

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const start = i;
    const ch = input[i] ?? '';
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      i++;
      tokens.push({ kind: 'lparen', start, end: i });
      continue;
    }
    if (ch === ')') {
      i++;
      tokens.push({ kind: 'rparen', start, end: i });
      continue;
    }
    const rangeMatch = DATE_RANGE_PATTERN.exec(input.slice(i));
    if (rangeMatch?.[1] && rangeMatch[2]) {
      i += rangeMatch[0].length;
      tokens.push({ kind: 'daterange', from: rangeMatch[1], to: rangeMatch[2], start, end: i });
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
        tokens.push({ kind: 'field', field, value, phrase, start, end: i });
        continue;
      }
    }
    // Bare word or quoted phrase
    const { value, phrase, consumed } = consumeValue(input, i);
    i += consumed;
    if (value.length === 0) continue;
    const upper = value.toUpperCase();
    if (upper === 'AND' && !phrase) {
      tokens.push({ kind: 'and', start, end: i });
      continue;
    }
    if (upper === 'OR' && !phrase) {
      tokens.push({ kind: 'or', start, end: i });
      continue;
    }
    if (upper === 'ANDNOT' && !phrase) {
      tokens.push({ kind: 'andnot', start, end: i });
      continue;
    }
    tokens.push({ kind: 'term', value, phrase, start, end: i });
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
// Parser
// ---------------------------------------------------------------------------

/**
 * One operand or parenthesized group, as it sits inside a conjunction. A `text`
 * operand is one FTS5 phrase, in the column its prefix names (any column when
 * it has none), or the `all:` disjunction across the columns.
 */
type Item =
  | { kind: 'cat'; value: string }
  | { kind: 'window'; from: string; to: string }
  | { kind: 'text'; field?: Exclude<Field, 'cat'>; value: string }
  | { kind: 'group'; group: Group };

/** Items joined by `AND`, explicit or implicit — the tightest-binding operator. */
interface Conjunction {
  /** `explicit[i]`: an `AND` token joined `items[i]` to the item before it. */
  explicit: boolean[];
  items: Item[];
}

/** A parenthesized expression, or the whole query. */
interface Group {
  /** Only `cat:` operands, alone or in groups of their own, joined by `OR`: one category group. */
  catOnly: boolean;
  conjunctions: Conjunction[];
  /** Every item is a filter lifted out of the FTS expression, so the group emits nothing. */
  empty: boolean;
  /** The group holds a `cat:` or `submittedDate:` operand at any depth. */
  filters: boolean;
  /** `ops[i]` joins `conjunctions[i]` to `conjunctions[i + 1]`. */
  ops: ('or' | 'andnot')[];
}

/** What a mirror search applies beside the FTS match. */
interface Lifted {
  categoryGroups: string[][];
  published: Bounds;
}

const isFilter = (item: Item): boolean =>
  item.kind === 'cat' || item.kind === 'window' || (item.kind === 'group' && item.group.filters);

/** Whether the item reaches the FTS expression: lifted filters and emptied groups do not. */
const isKept = (item: Item): boolean =>
  item.kind === 'text' || (item.kind === 'group' && !item.group.empty);

/**
 * Parse with arXiv's precedence and lift each filter that is a conjunct of the
 * whole query. A group's first conjunction holds its conjuncts when the group
 * has no `OR`: its other conjunctions each sit on the right of an `ANDNOT`.
 * Filters are lifted as each group closes; a filter found anywhere else ends the
 * parse live, so a lift that turns out not to be a conjunct of the whole query
 * is never used. Iterative throughout: caller text can nest as deep as it is long.
 *
 * Operators are read as tolerantly as before: one with no left operand, one
 * straight after another (the earlier wins), and a trailing one are dropped,
 * and an empty `()` contributes nothing.
 */
function parse(tokens: readonly Token[]): { lifted: Lifted; root: Group } | LiveQuery {
  const lifted: Lifted = { categoryGroups: [], published: {} };
  const newGroup = (): Group => ({
    catOnly: false,
    conjunctions: [],
    empty: false,
    filters: false,
    ops: [],
  });
  /** A group being read, and the operator read since its last item. */
  interface Frame {
    group: Group;
    pending: 'and' | 'or' | 'andnot' | undefined;
  }
  const root = newGroup();
  const stack: Frame[] = [{ group: root, pending: undefined }];

  // An `OR` or `ANDNOT` is pending only after an item, so it always has a left operand.
  const attach = (frame: Frame, item: Item) => {
    const { group, pending } = frame;
    frame.pending = undefined;
    const last = group.conjunctions.at(-1);
    if (pending === 'or' || pending === 'andnot') {
      group.ops.push(pending);
      group.conjunctions.push({ items: [item], explicit: [false] });
    } else if (last) {
      last.items.push(item);
      last.explicit.push(pending === 'and');
    } else {
      group.conjunctions.push({ items: [item], explicit: [false] });
    }
  };

  for (const t of tokens) {
    const frame = stack.at(-1) as Frame;
    switch (t.kind) {
      case 'lparen':
        stack.push({ group: newGroup(), pending: undefined });
        break;
      case 'rparen': {
        if (stack.length === 1) return { route: 'live', reason: 'unbalanced_parens' };
        stack.pop();
        const reason = closeGroup(frame.group, lifted);
        if (reason) return { route: 'live', reason };
        if (frame.group.conjunctions.length > 0) {
          attach(stack.at(-1) as Frame, { kind: 'group', group: frame.group });
        }
        break;
      }
      case 'and':
      case 'or':
      case 'andnot':
        if (frame.group.conjunctions.length > 0 && frame.pending === undefined) {
          frame.pending = t.kind;
        }
        break;
      case 'daterange':
        attach(frame, { kind: 'window', from: t.from, to: t.to });
        break;
      case 'field':
        if (t.field === 'cat') attach(frame, { kind: 'cat', value: t.value });
        else attach(frame, { kind: 'text', field: t.field, value: t.value });
        break;
      case 'term':
        attach(frame, { kind: 'text', value: t.value });
        break;
    }
  }
  if (stack.length > 1) return { route: 'live', reason: 'unbalanced_parens' };
  const reason = closeGroup(root, lifted);
  if (reason) return { route: 'live', reason };
  if (root.catOnly) lifted.categoryGroups.push(catOnlyCodes(root));
  return { lifted, root };
}

/**
 * Settle a group whose items have all closed: whether it holds filters, whether
 * it is one `cat:`-only `OR` set, and — taking it as a conjunct of the query —
 * lift its own conjunct filters into `lifted`. Returns the reason the query goes
 * live when a filter sits anywhere a lift would change what the query matches.
 */
function closeGroup(group: Group, lifted: Lifted): LiveRouteReason | undefined {
  group.filters = group.conjunctions.some((c) => c.items.some(isFilter));
  if (!group.filters) return;
  group.catOnly =
    group.ops.every((op) => op === 'or') &&
    group.conjunctions.every(
      ({ items }) =>
        items.length === 1 &&
        (items[0]?.kind === 'cat' || (items[0]?.kind === 'group' && items[0].group.catOnly)),
    );
  // Lifted as one category group by whichever group finds it a conjunct.
  if (group.catOnly) {
    group.empty = true;
    return;
  }
  if (group.ops.includes('or')) return 'filter_not_conjunct';
  const [first, ...negated] = group.conjunctions;
  if (!first || negated.some((c) => c.items.some(isFilter))) return 'filter_not_conjunct';
  for (const item of first.items) {
    if (item.kind === 'cat') {
      lifted.categoryGroups.push(categorySubtree(item.value));
    } else if (item.kind === 'window') {
      lifted.published = intersectBounds(lifted.published, {
        from: stampToIso(item.from),
        to: stampToIso(item.to),
      });
    } else if (item.kind === 'group' && item.group.catOnly) {
      lifted.categoryGroups.push(catOnlyCodes(item.group));
    }
  }
  const kept = first.items.some(isKept);
  group.empty = !kept;
  return !kept && negated.length > 0 ? 'no_positive_term' : undefined;
}

/** The union of the subtrees a `cat:`-only `OR` group names, in source order. */
function catOnlyCodes(group: Group): string[] {
  const codes = new Set<string>();
  const pending: Item[] = [];
  const queue = ({ conjunctions }: Group) => {
    for (let i = conjunctions.length - 1; i >= 0; i--) {
      pending.push(conjunctions[i]?.items[0] as Item);
    }
  };
  queue(group);
  for (let item = pending.pop(); item; item = pending.pop()) {
    if (item.kind === 'group') queue(item.group);
    else if (item.kind === 'cat') for (const code of categorySubtree(item.value)) codes.add(code);
  }
  return [...codes];
}

// ---------------------------------------------------------------------------
// FTS5 emission
// ---------------------------------------------------------------------------

/** Whether an item's emitted form is parenthesized: a group, or an `all:` expansion. */
const isParenthesized = (item: Item): boolean =>
  item.kind === 'group' || (item.kind === 'text' && item.field === 'all');

/**
 * Emit the FTS5 expression for a parsed query, top-down with an explicit work
 * stack. Lifted filters and emptied groups are left out with the join that
 * held them. Two places need more than the source text:
 *
 * - FTS5 binds `NOT` tighter than `AND`, the reverse of arXiv, so a conjunction
 *   of two or more items on the right of an `ANDNOT` is parenthesized:
 *   `a ANDNOT b AND c` emits `"a" NOT ("b" AND "c")`.
 * - FTS5 honors an implicit `AND` only between bare phrases, so an implicit
 *   join beside a parenthesized form becomes an explicit `AND` (issue #13).
 */
function emitMatch(root: Group): string | undefined {
  const out: string[] = [];
  const work: (string | Group)[] = [root];
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    if (typeof next === 'string') {
      out.push(next);
      continue;
    }
    const pieces = groupPieces(next);
    for (let i = pieces.length - 1; i >= 0; i--) work.push(pieces[i] as string | Group);
  }
  return out.length > 0 ? out.join('') : undefined;
}

/** One group's emitted pieces, in order; a nested group stays a `Group` for the work stack. */
function groupPieces(group: Group): (string | Group)[] {
  const pieces: (string | Group)[] = [];
  for (const [index, conjunction] of group.conjunctions.entries()) {
    const kept = conjunction.items.filter(isKept);
    if (kept.length === 0) continue;
    const op = index > 0 ? group.ops[index - 1] : undefined;
    if (op) pieces.push(op === 'or' ? ' OR ' : ' NOT ');
    const wrap = op === 'andnot' && kept.length > 1;
    if (wrap) pieces.push('(');
    let prev: Item | undefined;
    let explicit = false;
    for (const [i, item] of conjunction.items.entries()) {
      explicit ||= conjunction.explicit[i] === true;
      if (!isKept(item)) continue;
      if (prev) {
        pieces.push(explicit || isParenthesized(prev) || isParenthesized(item) ? ' AND ' : ' ');
      }
      if (item.kind === 'group') pieces.push('(', item.group, ')');
      else if (item.kind === 'text') pieces.push(ftsOperand(item.field, item.value));
      prev = item;
      explicit = false;
    }
    if (wrap) pieces.push(')');
  }
  return pieces;
}

function ftsOperand(field: Exclude<Field, 'cat'> | undefined, raw: string): string {
  const value = quoteFtsValue(raw);
  if (field === undefined) return value;
  if (field === 'all') return `(${ALL_COLUMNS.map((col) => `${col}:${value}`).join(' OR ')})`;
  return `${FTS_COLUMN[field]}:${value}`;
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Translate an arXiv-syntax query into an FTS5 MATCH expression plus the
 * structured filters that cannot ride in FTS — category groups and a
 * submitted-date window — or route it live. A `cat:` or `submittedDate:`
 * operand is lifted only when it is a conjunct of the whole query: reached from
 * the top through `AND` alone, or in the first operand of an `ANDNOT` on a
 * level with no `OR`. There a filter beside the match means exactly what arXiv
 * means; anywhere else (`t OR cat:X`, `t ANDNOT cat:X`) it cannot, and the query
 * goes live, as does one whose residual has no positive term. See issue #65.
 */
export function translateQuery(query: string): TranslatedQuery {
  const parsed = parse(tokenize(query));
  if ('route' in parsed) return parsed;
  const matchExpr = emitMatch(parsed.root);
  return {
    route: 'mirror',
    ...(matchExpr !== undefined && { matchExpr }),
    ...parsed.lifted,
  };
}

/**
 * Rewrite every `cat:` operand in a query string to the operand
 * {@link categorySearchTerm} produces, leaving the rest of the string
 * byte-identical.
 *
 * arXiv matches a bare `cat:` code literally: `cat:astro-ph` reaches only the
 * legacy flat papers filed under that exact string, and `cat:cs` reaches
 * nothing at all, because arXiv never assigns the bare group name. The mirror
 * has always read the same operand as its whole subtree. Expanding here gives
 * the live path the subtree the `category` parameter already gets, so one
 * `cat:` operand means one thing regardless of which backend answers — which is
 * also what the tool's `query` description has always claimed. See issue #36.
 *
 * A leaf code, a standalone archive, and an already-wildcarded operand all
 * rewrite to themselves. `translateQuery` needs no counterpart because it
 * expands `cat:` through the same taxonomy on the way into its category filter.
 */
export function expandCategoryOperands(query: string): string {
  let out = '';
  let cursor = 0;
  for (const t of tokenize(query)) {
    if (t.kind !== 'field' || t.field !== 'cat') continue;
    out += query.slice(cursor, t.start) + categorySearchTerm(t.value);
    cursor = t.end;
  }
  return cursor === 0 ? query : out + query.slice(cursor);
}

/**
 * Encode a value as an FTS5 quoted token. Quoting handles whitespace,
 * punctuation, and FTS5 reserved characters in one stroke; double-quotes
 * inside the value are escaped per FTS5 syntax (`""`).
 */
function quoteFtsValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '""';
  return `"${trimmed.replace(/"/g, '""')}"`;
}
