/**
 * @fileoverview The ASCII spelling the mirror gives author names (issue #100).
 * arXiv's author search folds `ł`, `ø`, `ß`, and the other letters below to
 * ASCII, so `au:Tworzydlo` and `au:Tworzydło` match the same papers live. The
 * FTS5 tokenizer (`unicode61 remove_diacritics 2`) folds only a letter that
 * decomposes into a base letter and a mark (`á`, `ü`, `ğ`), and leaves these as
 * written. One table feeds both sides: {@link foldAuthorsSql} folds the
 * `authors` column in the schema's content view and sync triggers, and
 * {@link foldAuthorText} folds an `au:` value, or the authors arm of an `all:`
 * or unprefixed term, in the query. arXiv's title and abstract search folds
 * nothing, so no other column is folded.
 * @module services/arxiv/mirror/author-fold
 */

/**
 * Each letter the fold maps and its ASCII spelling, lower and upper case. Every
 * one is a single UTF-16 code unit. `ı` has no upper case of its own (it is
 * `I`). Each lower-case letter but `ħ`, `ŋ`, and `œ` was measured against
 * arXiv's author search; no author name holding one of those three was found,
 * so they take their ASCII-folding spelling.
 */
const AUTHOR_FOLDS: readonly (readonly [letter: string, ascii: string])[] = [
  ['ł', 'l'],
  ['Ł', 'L'],
  ['ı', 'i'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['þ', 'th'],
  ['Þ', 'Th'],
  ['ħ', 'h'],
  ['Ħ', 'H'],
  ['ŋ', 'n'],
  ['Ŋ', 'N'],
  ['ə', 'a'],
  ['Ə', 'A'],
  ['æ', 'ae'],
  ['Æ', 'Ae'],
  ['œ', 'oe'],
  ['Œ', 'Oe'],
  ['ß', 'ss'],
  ['ẞ', 'Ss'],
];

const FOLD_BY_LETTER: ReadonlyMap<string, string> = new Map(AUTHOR_FOLDS);

/**
 * `expr` with every letter of the table replaced by its ASCII spelling, as one
 * SQL expression of nested `replace()` calls, so every writer and driver — the
 * sqlite3 CLI and a writer built before the fold included — computes it alike.
 * `expr` is trusted SQL (a column reference); the table's literals hold no quote.
 */
export function foldAuthorsSql(expr: string): string {
  return AUTHOR_FOLDS.reduce(
    (acc, [letter, ascii]) => `replace(${acc}, '${letter}', '${ascii}')`,
    expr,
  );
}

/** `value` with every letter of the table replaced by its ASCII spelling, in one pass. */
export function foldAuthorText(value: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    const ascii = FOLD_BY_LETTER.get(value.charAt(i));
    if (ascii === undefined) continue;
    out += value.slice(from, i) + ascii;
    from = i + 1;
  }
  return from === 0 ? value : out + value.slice(from);
}
