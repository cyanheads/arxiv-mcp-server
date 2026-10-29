/**
 * @fileoverview arXiv query syntax → FTS5 translator with category-subtree
 * expansion. Parses field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `co:`, `jr:`,
 * `all:`), boolean operators, quoted phrases, and parens with arXiv's own
 * grammar: only uppercase `AND`, `OR`, and `ANDNOT` are operators (`AND NOT`
 * reads as `ANDNOT`), operands with no operator between them are joined with
 * `OR`, and every operator shares one precedence and groups to the right
 * (`a op b op c` = `a op (b op c)`). Lifts `cat:` operands into category groups
 * that apply against the indexed category columns instead of FTS, and
 * `submittedDate:[… TO …]` into ISO bounds on the indexed `published` column —
 * but only an operand that is a conjunct of the whole query, the one place a
 * filter beside the FTS match means what arXiv means. Any query the mirror
 * cannot read as arXiv does is routed to the live API. See issues #65, #82.
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
 * Why a query goes to the live API:
 *
 * - `empty_category` — a lifted `cat:` operand, or `cat:`-only `OR` set, whose
 *   subtree names no code in the taxonomy (`cat:zzz.*`): its category group
 *   would be empty, and an empty group filters nothing, so the mirror would
 *   widen the search to every category. A lifted date window always keeps both
 *   bounds, so it never needs this.
 * - `empty_field_value` — a field prefix with nothing, or only whitespace, after
 *   it (`ti:`, `ti: x`, `ti:""`): arXiv binds the next word or refuses the
 *   query, and the mirror would drop the column or the filter.
 * - `empty_phrase` — a quoted phrase with no words in it (`""`, `"  "`).
 * - `empty_query` — no term, no category, and no date window is left to match,
 *   which on the mirror would return every paper it holds.
 * - `field_not_in_mirror` — an `rn:` (report number), `id:`, or
 *   `lastUpdatedDate:` operand, or a `submittedDate:` that is not a whole
 *   `[YYYYMMDDHHMM TO YYYYMMDDHHMM]` range: arXiv reads each from a field the
 *   mirror does not index or as a filter the mirror cannot apply.
 * - `filter_not_conjunct` — a `cat:` or `submittedDate:` operand sits under an
 *   `OR` or on the right of an `ANDNOT`, where no filter beside the FTS match
 *   expresses it.
 * - `multiword_author` — an `au:` value of more than one word as the mirror's
 *   FTS tokenizer splits it (`au:"hinton g"`, `au:J.A.Hinton`, `au:o'brien`), or
 *   one holding an underscore (`au:del_maestro`), wherever it sits. arXiv
 *   matches such a value inside one author's name, its words in any order with
 *   others between them, and reads `_` as a space; the mirror's `authors`
 *   column is the whole author list as one string, so it matches an ordered
 *   phrase that can span two authors, and keeps `_` inside a token. A
 *   hyphenated surname is one word on both paths and stays. See issue #96.
 * - `no_positive_term` — with its filters lifted, the query or a parenthesized
 *   group in it keeps terms only on the right of an `ANDNOT`, which FTS5 cannot
 *   match on their own (`(cat:cs.LG ANDNOT survey) AND transformer` included).
 * - `stopword_term` — an operand that is one word arXiv's index drops
 *   ({@link STOPWORDS}): arXiv matches almost no paper for it and the mirror
 *   almost every paper, so beside `OR` (adjacency included) it would widen the
 *   answer to every paper the rest of the query allows. It goes live wherever it
 *   sits, beside `AND` too.
 * - `unbalanced_parens` — the grouping has no single reading.
 */
export type LiveRouteReason =
  | 'empty_category'
  | 'empty_field_value'
  | 'empty_phrase'
  | 'empty_query'
  | 'field_not_in_mirror'
  | 'filter_not_conjunct'
  | 'multiword_author'
  | 'no_positive_term'
  | 'stopword_term'
  | 'unbalanced_parens';

/** A query only the live API answers as written. */
export interface LiveQuery {
  reason: LiveRouteReason;
  route: 'live';
}

/** Result of translating an arXiv-syntax query to mirror inputs. */
export type TranslatedQuery = MirrorQuery | LiveQuery;

/** Field prefixes the lexer serves. Any other prefix stays a bare term, bar {@link UNSERVED_FIELDS}. */
type Field = 'ti' | 'au' | 'abs' | 'cat' | 'co' | 'jr' | 'all';

/** A field prefix that reaches the FTS index. */
type TextField = Exclude<Field, 'cat'>;

type Operator = 'and' | 'or' | 'andnot';

/** Source span `[start, end)` every token carries, so a rewrite can splice
 * one operand out of the original string and leave the rest byte-identical. */
interface Span {
  end: number;
  start: number;
}

type Token = Span &
  (
    | { kind: Operator | 'lparen' | 'rparen' }
    | { kind: 'daterange'; from: string; to: string }
    | { kind: 'field'; field: Field; value: string }
    | { kind: 'unserved' }
    | { kind: 'term'; value: string; phrase: boolean }
  );

/**
 * arXiv's submitted-date range operand. Only a fully-formed clause with two
 * `YYYYMMDDHHMM` stamps is lifted out; anything else falls through to ordinary
 * tokenization rather than being silently reinterpreted as a date filter.
 */
const DATE_RANGE_PATTERN = /^submittedDate:\[\s*(\d{12})\s+TO\s+(\d{12})\s*\]/i;

/** Keyed by caller text, so a `Map`: a `{}` lookup of `constructor` would reach the prototype. */
const FIELD_MAP: ReadonlyMap<string, Field> = new Map(
  (['ti', 'au', 'abs', 'cat', 'co', 'jr', 'all'] as const).map((field) => [field, field]),
);

/**
 * Prefixes arXiv answers that the mirror cannot: `rn:` reads report numbers,
 * which the mirror does not store, `id:` reads identifiers, and
 * `lastUpdatedDate:` is a date filter on a column the mirror does not filter. A
 * `submittedDate:` that {@link DATE_RANGE_PATTERN} did not take is no range the
 * mirror can lift. Each one sends the query live rather than reaching FTS as
 * literal text. Keys are lowercase, as the lexer lowercases the prefix.
 */
const UNSERVED_FIELDS: ReadonlySet<string> = new Set([
  'rn',
  'id',
  'lastupdateddate',
  'submitteddate',
]);

/**
 * Words arXiv's index drops, each measured live on 2026-10-23 as `all:<word>`
 * against `all:we` (2,685,496) and `all:a` (1,027,834, kept: author initials):
 * `of` 213, `and` 634, `to` 775, `the` 9,144, `for` 370, `in` 1,680, `on` 312,
 * `with` 305, `not` 7, `by` 115, `is` 26, `as` 196, `an` 8,381; `or` from
 * `ti:quantum or ti:graph` (220,581) against `ti:quantum OR ti:graph` (219,678).
 * The mirror's FTS index keeps every one (`of` matches over 3 million papers),
 * so an operand that is one of them goes live. Lucene's other English stop
 * words are unmeasured and stay terms.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'an',
  'and',
  'as',
  'by',
  'for',
  'in',
  'is',
  'not',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

/**
 * A character the mirror's FTS tokenizer keeps inside a token: its
 * `unicode61 … tokenchars '-_'` (schema.ts) splits on everything but letters,
 * numbers, private-use characters, `-`, and `_`. A combining mark counts as a
 * separator here, though the tokenizer folds the Latin diacritics into the
 * letter before them: a value written decomposed goes live, never the reverse.
 */
const FTS_TOKEN_CHAR = /^[\p{L}\p{N}\p{Co}-]$/u;

/**
 * Whether an `au:` value is more than one word to arXiv: two or more tokens as
 * the mirror's FTS tokenizer splits them, or an underscore, which arXiv reads as
 * a space and the tokenizer keeps inside a token. Scans each character once and
 * stops at the second word.
 */
function holdsSeveralWords(value: string): boolean {
  let words = 0;
  let inWord = false;
  for (const ch of value) {
    if (ch === '_') return true;
    if (!FTS_TOKEN_CHAR.test(ch)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      if (++words > 1) return true;
    }
  }
  return false;
}

/**
 * Prefix → `papers_fts` column. Every entry here has to be an indexed column of
 * the FTS5 table (schema v3 indexes all five) — routing a prefix at a column
 * outside the index raises `no such column` at query time, not at build time.
 */
const FTS_COLUMN: Record<Exclude<TextField, 'all'>, string> = {
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

/**
 * Operator words are case-sensitive, as on arXiv: `or` and `andnot` are search
 * terms. `AND` followed by the bare word `NOT` is one `ANDNOT` token, the parse
 * arXiv echoes for it.
 */
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
      const field = FIELD_MAP.get(fieldName);
      if (field || UNSERVED_FIELDS.has(fieldName)) {
        i += fieldMatch[0].length;
        const { value, consumed } = consumeValue(input, i);
        i += consumed;
        tokens.push(
          field
            ? { kind: 'field', field, value, start, end: i }
            : { kind: 'unserved', start, end: i },
        );
        continue;
      }
    }
    // Bare word or quoted phrase
    const { value, phrase, consumed } = consumeValue(input, i);
    i += consumed;
    if (!phrase && value === 'AND') {
      const not = followingNot(input, i);
      if (not !== undefined) {
        i = not;
        tokens.push({ kind: 'andnot', start, end: i });
        continue;
      }
    }
    if (!phrase && (value === 'AND' || value === 'OR' || value === 'ANDNOT')) {
      tokens.push({
        kind: value === 'AND' ? 'and' : value === 'OR' ? 'or' : 'andnot',
        start,
        end: i,
      });
      continue;
    }
    tokens.push({ kind: 'term', value, phrase, start, end: i });
  }
  return tokens;
}

/** The end of a bare `NOT` word that is the next token after `from`, if it is one. */
function followingNot(input: string, from: number): number | undefined {
  let i = from;
  while (i < input.length && /\s/.test(input[i] ?? '')) i++;
  if (input[i] === '"') return;
  const { value, consumed } = consumeValue(input, i);
  return value === 'NOT' ? i + consumed : undefined;
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
 * A node of the parsed query: an operand, a parenthesized group, or an operator
 * with its two operands. A `text` operand is one FTS5 phrase, in the column its
 * prefix names (any column when it has none), or the `all:` disjunction across
 * the columns. `filters` and `catOnly` are settled when the node is built.
 */
type Node = {
  /** Only `cat:` operands, alone or in groups of their own, joined by `OR`: one category group. */
  catOnly: boolean;
  /** The node holds a `cat:` or `submittedDate:` operand at any depth. */
  filters: boolean;
} & (
  | { kind: 'cat'; value: string }
  | { kind: 'window'; from: string; to: string }
  | { kind: 'text'; field?: TextField; value: string }
  | { kind: 'group'; child: Node }
  | { kind: Operator; left: Node; right: Node }
);

type Join = Extract<Node, { kind: Operator }>;

const join = (kind: Operator, left: Node, right: Node): Node => ({
  kind,
  left,
  right,
  filters: left.filters || right.filters,
  catOnly: kind === 'or' && left.catOnly && right.catOnly,
});

const group = (child: Node): Node => ({
  kind: 'group',
  child,
  filters: child.filters,
  catOnly: child.catOnly,
});

/**
 * Parse with arXiv's grammar into a tree. Each paren level is read as a flat
 * chain of operands and operators, then folded from the right as the level
 * closes, so `a op b op c` becomes `a op (b op c)`; adjacent operands are joined
 * with `OR`. Iterative throughout: caller text can nest as deep as it is long.
 *
 * Operators are read tolerantly: one with no left operand, one
 * straight after another (the earlier wins), and a trailing one are dropped,
 * and an empty `()` contributes nothing.
 */
function parse(tokens: readonly Token[]): { root: Node | undefined } | LiveQuery {
  /** A paren level being read: its operands, the operators between them, and the operator read since its last operand. */
  interface Frame {
    items: Node[];
    ops: Operator[];
    pending: Operator | undefined;
  }
  const stack: Frame[] = [{ items: [], ops: [], pending: undefined }];

  const attach = (frame: Frame, item: Node) => {
    if (frame.items.length > 0) frame.ops.push(frame.pending ?? 'or');
    frame.items.push(item);
    frame.pending = undefined;
  };
  const fold = ({ items, ops }: Frame): Node | undefined => {
    let node = items.at(-1);
    for (let i = items.length - 2; i >= 0; i--) {
      node = join(ops[i] as Operator, items[i] as Node, node as Node);
    }
    return node;
  };
  const live = (reason: LiveRouteReason): LiveQuery => ({ route: 'live', reason });

  for (const t of tokens) {
    const frame = stack.at(-1) as Frame;
    switch (t.kind) {
      case 'lparen':
        stack.push({ items: [], ops: [], pending: undefined });
        break;
      case 'rparen': {
        if (stack.length === 1) return live('unbalanced_parens');
        stack.pop();
        const child = fold(frame);
        if (child) attach(stack.at(-1) as Frame, group(child));
        break;
      }
      case 'and':
      case 'or':
      case 'andnot':
        if (frame.items.length > 0 && frame.pending === undefined) frame.pending = t.kind;
        break;
      case 'daterange':
        attach(frame, { kind: 'window', from: t.from, to: t.to, filters: true, catOnly: false });
        break;
      case 'field':
        if (t.value.trim().length === 0) return live('empty_field_value');
        if (t.field !== 'cat' && STOPWORDS.has(t.value.trim().toLowerCase())) {
          return live('stopword_term');
        }
        if (t.field === 'au' && holdsSeveralWords(t.value)) return live('multiword_author');
        attach(
          frame,
          t.field === 'cat'
            ? { kind: 'cat', value: t.value, filters: true, catOnly: true }
            : { kind: 'text', field: t.field, value: t.value, filters: false, catOnly: false },
        );
        break;
      case 'unserved':
        return live('field_not_in_mirror');
      case 'term':
        if (t.value.trim().length === 0) return live('empty_phrase');
        if (STOPWORDS.has(t.value.trim().toLowerCase())) return live('stopword_term');
        attach(frame, { kind: 'text', value: t.value, filters: false, catOnly: false });
        break;
    }
  }
  if (stack.length > 1) return live('unbalanced_parens');
  return { root: fold(stack[0] as Frame) };
}

/** What a mirror search applies beside the FTS match. */
interface Lifted {
  categoryGroups: string[][];
  published: Bounds;
}

/**
 * Lift each filter that is a conjunct of the whole query: every step from the
 * root to it is either side of an `AND` or the left side of an `ANDNOT`, and
 * parentheses are no step. A `cat:`-only `OR` set reached that way is one
 * category group. A filter anywhere else routes the query live, so a lift is
 * used only when the filter beside the match means what arXiv means.
 *
 * Returns the lifted nodes and every operator and group the walk passed
 * through, each before its operands, for {@link residual}.
 */
function lift(
  root: Node,
): { lifted: Lifted; removed: Set<Node>; visited: Node[] } | LiveRouteReason {
  const lifted: Lifted = { categoryGroups: [], published: {} };
  const removed = new Set<Node>();
  const visited: Node[] = [];
  const stack: { conjunct: boolean; node: Node }[] = [{ node: root, conjunct: true }];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { node, conjunct } = next;
    if (!node.filters) continue;
    if (!conjunct) return 'filter_not_conjunct';
    if (node.catOnly) {
      const codes = catOnlyCodes(node);
      // An empty group is no filter at all downstream, so lifting it would widen the search.
      if (codes.length === 0) return 'empty_category';
      lifted.categoryGroups.push(codes);
      removed.add(node);
      continue;
    }
    switch (node.kind) {
      case 'window':
        lifted.published = intersectBounds(lifted.published, {
          from: stampToIso(node.from),
          to: stampToIso(node.to),
        });
        removed.add(node);
        break;
      case 'group':
        visited.push(node);
        stack.push({ node: node.child, conjunct });
        break;
      // Not `catOnly`, so a filter below it is a disjunct of something else.
      case 'or':
        return 'filter_not_conjunct';
      case 'and':
      case 'andnot':
        visited.push(node);
        // The left operand pops first, so category groups keep source order.
        stack.push({ node: node.right, conjunct: node.kind === 'and' });
        stack.push({ node: node.left, conjunct });
        break;
    }
  }
  return { lifted, removed, visited };
}

/** The union of the subtrees a `cat:`-only `OR` set names, in source order. */
function catOnlyCodes(node: Node): string[] {
  const codes = new Set<string>();
  const pending: Node[] = [node];
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (next.kind === 'group') pending.push(next.child);
    else if (next.kind === 'or') pending.push(next.right, next.left);
    else if (next.kind === 'cat') for (const code of categorySubtree(next.value)) codes.add(code);
  }
  return [...codes];
}

/**
 * What a node leaves for the FTS expression once its filters are lifted:
 * nothing, a positive expression, or `negated` — the terms on the right of an
 * `ANDNOT` whose left operand was lifted whole, which FTS5 can only express
 * beside a positive term (`x AND (cat:X ANDNOT r)` emits `x NOT r`).
 */
type Residual = { kind: 'empty' } | { kind: 'positive' | 'negated'; node: Node };

/**
 * The FTS tree left once the lifted filters are taken out, settled bottom-up
 * over the nodes {@link lift} passed through (each after its operands), or the
 * reason the query goes live: a parenthesized group, or the whole query, whose
 * residual is negated alone.
 */
function residual(
  root: Node,
  removed: ReadonlySet<Node>,
  visited: readonly Node[],
): Residual | LiveRouteReason {
  const settled = new Map<Node, Residual>();
  const of = (node: Node): Residual =>
    settled.get(node) ?? (removed.has(node) ? { kind: 'empty' } : { kind: 'positive', node });
  for (let i = visited.length - 1; i >= 0; i--) {
    const node = visited[i] as Node;
    if (node.kind === 'group') {
      const inner = of(node.child);
      if (inner.kind === 'negated') return 'no_positive_term';
      settled.set(
        node,
        inner.kind === 'empty'
          ? inner
          : { kind: 'positive', node: inner.node === node.child ? node : group(inner.node) },
      );
    } else if (node.kind === 'and' || node.kind === 'andnot') {
      settled.set(node, combine(node, of(node.left), of(node.right)));
    }
  }
  const top = of(root);
  return top.kind === 'negated' ? 'no_positive_term' : top;
}

/** An `AND` or `ANDNOT` node's residual, from its operands' residuals. */
function combine(node: Join, left: Residual, right: Residual): Residual {
  // The right of an ANDNOT holds no filter, so it is always positive.
  const r =
    node.kind === 'andnot' && right.kind === 'positive'
      ? { ...right, kind: 'negated' as const }
      : right;
  if (left.kind === 'empty') return r;
  if (r.kind === 'empty') return left;
  if (left.kind === 'positive' && r.kind === 'positive') {
    return {
      kind: 'positive',
      node:
        left.node === node.left && r.node === node.right ? node : join('and', left.node, r.node),
    };
  }
  if (left.kind === 'positive' || r.kind === 'positive') {
    const [kept, negated] = left.kind === 'positive' ? [left, r] : [r, left];
    const unchanged =
      node.kind === 'andnot' && kept.node === node.left && negated.node === node.right;
    return { kind: 'positive', node: unchanged ? node : join('andnot', kept.node, negated.node) };
  }
  return { kind: 'negated', node: join('or', left.node, r.node) };
}

// ---------------------------------------------------------------------------
// FTS5 emission
// ---------------------------------------------------------------------------

const FTS_OPERATOR: Record<Operator, string> = { and: ' AND ', or: ' OR ', andnot: ' NOT ' };

/**
 * Emit the FTS5 expression for a filter-free tree, top-down with an explicit
 * work stack. Every operand of an operator that is itself an operator is
 * parenthesized, so FTS5's own precedence (`NOT` over `AND` over `OR`) and its
 * implicit `AND` never decide a grouping: `a ANDNOT b AND c` emits
 * `"a" NOT ("b" AND "c")`, and adjacent `a b` emits `"a" OR "b"`.
 */
function emitMatch(root: Node): string {
  const out: string[] = [];
  const work: (string | Node)[] = [root];
  const pushOperand = (node: Node) => {
    if (node.kind === 'and' || node.kind === 'or' || node.kind === 'andnot') {
      work.push(')', node, '(');
    } else {
      work.push(node);
    }
  };
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    if (typeof next === 'string') {
      out.push(next);
      continue;
    }
    switch (next.kind) {
      case 'text':
        out.push(ftsOperand(next.field, next.value));
        break;
      case 'group':
        work.push(')', next.child, '(');
        break;
      case 'and':
      case 'or':
      case 'andnot':
        pushOperand(next.right);
        work.push(FTS_OPERATOR[next.kind]);
        pushOperand(next.left);
        break;
    }
  }
  return out.join('');
}

function ftsOperand(field: TextField | undefined, raw: string): string {
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
 * submitted-date window — or route it live. The query is read with arXiv's
 * grammar (see the module header). A `cat:` or `submittedDate:` operand is
 * lifted only when it is a conjunct of the whole query: every step from the top
 * to it is either side of an `AND` or the left side of an `ANDNOT`. There a
 * filter beside the match means exactly what arXiv means; anywhere else
 * (`t OR cat:X`, `t cat:X`, `t ANDNOT cat:X`) it cannot, and the query goes
 * live, as does one the mirror cannot read at all ({@link LiveRouteReason}).
 * See issues #65, #82.
 */
export function translateQuery(query: string): TranslatedQuery {
  const parsed = parse(tokenize(query));
  if ('route' in parsed) return parsed;
  if (!parsed.root) return { route: 'live', reason: 'empty_query' };
  const lifting = lift(parsed.root);
  if (typeof lifting === 'string') return { route: 'live', reason: lifting };
  const left = residual(parsed.root, lifting.removed, lifting.visited);
  if (typeof left === 'string') return { route: 'live', reason: left };
  const { lifted } = lifting;
  if (
    left.kind === 'empty' &&
    lifted.categoryGroups.length === 0 &&
    lifted.published.from === undefined &&
    lifted.published.to === undefined
  ) {
    return { route: 'live', reason: 'empty_query' };
  }
  return {
    route: 'mirror',
    ...(left.kind === 'positive' && { matchExpr: emitMatch(left.node) }),
    ...lifted,
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
 * inside the value are escaped per FTS5 syntax (`""`). The parser routes an
 * empty or whitespace-only value live, so every value here has a word in it.
 */
function quoteFtsValue(value: string): string {
  return `"${value.trim().replace(/"/g, '""')}"`;
}
