/**
 * @fileoverview Tests for the port of arxiv-base's `tex2utf` and `split_authors`
 * (issue #89): the conversions the arXiv API applies, arxiv-base's own test
 * vectors, the two greek-table deviations, the port's quirks kept on purpose,
 * the brace reduction its loop performs, the author split, and linear cost on
 * caller-sized input. The live-path parity over arXiv-served records is in
 * `parity.test.ts`.
 * @module services/arxiv/mirror/tex2utf.test
 */

import { describe, expect, it } from 'vitest';
import { splitAuthors, tex2utf, tex2utfAuthors } from '@/services/arxiv/mirror/tex2utf.js';

describe('tex2utf', () => {
  it.each([
    ['\\AA', '(3300-9700 \\AA)', '(3300-9700 Å)'],
    ['{\\o}', 'From Sm{\\o}r-re-br{\\o}d', 'From Smør-re-brød'],
    ["\\'a", "O. Barrag\\'an", 'O. Barragán'],
    ['\\"o', 'G\\"okt\\"urk', 'Göktürk'],
    ['{\\i}', 'At{\\i}lgan', 'Atılgan'],
    ['$\\alpha$', '[$\\alpha$/Fe] abundances', '[$α$/Fe] abundances'],
    ['\\phi', '$\\ell_\\phi$', '$\\ell_\u03c6$'],
    ['\\varphi', '$\\varphi:C_p^*(X)$', '$\\varphi:C_p^*(X)$'],
    ['\\copyright', '\\copyright 2026 IEEE', '©2026 IEEE'],
    ['{\\dag}', 'Farid Zare{\\dag}', 'Farid Zare†'],
    ['\\H{o}', 'Erd\\H{o}s', 'Erdős'],
    ['\\u{g}', 'Yi\\u{g}it', 'Yiğit'],
    ['{\\l}', 'Tworzyd{\\l}o', 'Tworzydło'],
  ])('converts %s as the arXiv API does', (_form, tex, expected) => {
    expect(tex2utf(tex)).toBe(expected);
  });

  it('maps \\phi to U+03C6 and leaves \\varphi, where arxiv-base maps them to U+03D5 and U+03C6', () => {
    expect(tex2utf('\\phi')).toBe('\u03c6');
    expect(tex2utf('\\Phi')).toBe('\u03a6');
    expect(tex2utf('\\varphi')).toBe('\\varphi');
  });

  // arxiv-base's arxiv/util/tests/test_tex2utf.py, greek on.
  it.each([
    [
      'abc def ghijk lmnop qrs tuv wxyz 1234567890 !@# $%^ &* () _-=+',
      'abc def ghijk lmnop qrs tuv wxyz 1234567890 !@# $%^ &* () _-=+',
    ],
    ["\\'e", 'é'],
    ["\\'E", 'É'],
    ['\\OE', 'Œ'],
    ['\\OE\n', 'Œ\n'],
    ['\\OE\\S', 'Œ§'],
    ['\\OE\\S\n', 'Œ§\n'],
    ['\\ddag \\OE\\S', '‡Œ§'],
    ['\\alpha', 'α'],
    ['\\alpha\\beta\\gamma', 'αβγ'],
    ['\\alpha{\\beta{\\gamma}}', 'α{βγ}'],
    ['\\alpha{\\beta{\\gamma\\macro}', 'α{β{γ\\macro}'],
    ['foo \\alpha\\ bar', 'foo α bar'],
    ['\\alpha\\ \\beta{something}', 'α β{something}'],
    ['foo \\OE\\ bar', 'foo Œ bar'],
    ['foo \\alpha bar', 'foo αbar'],
    ['foo \\alpha{}bar', 'foo αbar'],
    ['foo \\alpha{-}bar', 'foo α{-}bar'],
    ['foo \\alpha_7', 'foo α_7'],
    ['foo \\alpha_\\beta_\\gamma_7', 'foo α_β_γ_7'],
    ["\\'{e}", 'é'],
    ['ARXIVDEV-2322 \\u{A} fix', 'ARXIVDEV-2322 Ă fix'],
    ['ARXIVDEV-2322 \\u{a} fix', 'ARXIVDEV-2322 ă fix'],
    ['ARXIVDEV-2322 \\u{O} fix', 'ARXIVDEV-2322 Ŏ fix'],
    ['ARXIVDEV-2322 \\u{o} fix', 'ARXIVDEV-2322 ŏ fix'],
    ['ARXIVDEV-2322 \\k{i} fix', 'ARXIVDEV-2322 į fix'],
    ['ARXIVDEV-2322 \\v{g} fix', 'ARXIVDEV-2322 ǧ fix'],
    ['ARXIVDEV-2322 \\c{g} fix', 'ARXIVDEV-2322 ģ fix'],
    ['ARXIVDEV-2322 \\DJ  fix', 'ARXIVDEV-2322 Đ fix'],
    ['ARXIVOPS-805 \\aa  fix', 'ARXIVOPS-805 å fix'],
  ])('reproduces arxiv-base on %j', (tex, expected) => {
    expect(tex2utf(tex)).toBe(expected);
  });

  it.each([
    ['a dotless i under an accent, which the stray-slash rule never reaches', "\\'{\\i}", "\\'ı"],
    ['the stray-slash rule itself', "/\\'{\\i} x", "\\'\\{i\\} x"],
    ['an accent the table lacks, which keeps the letter alone', "\\'x \\.q", 'x q'],
    ['a letter accent the table lacks, which keeps both letters', '\\H{q}', 'Hq'],
    ['a macro name that runs on', '\\alphabet \\oe7', '\\alphabet \\oe7'],
    ['a macro name followed by a non-ASCII letter', '\\alphaé', '\\alphaé'],
    ['the misspelled upsilon key', '\\upsion \\upsilon', 'υ\\upsilon'],
    ['\\j before whitespace or in braces', 'a\\j b {\\j}', 'ajb j'],
    ['\\t around one character', '\\t{o}\\t{oo}', 'o\\t{oo}'],
    ['a brace that is not the macro’s own', '{\\o', '{ø'],
  ])('keeps arxiv-base’s behavior for %s', (_case, tex, expected) => {
    expect(tex2utf(tex)).toBe(expected);
  });

  // arxiv-base loops `\{\{([^}]*)\}\}` → `{\1}` until nothing matches; each
  // run of `}` settles against the text since the `}` before it.
  it.each([
    ['{{x}}', '{x}'],
    ['{{{x}}}', '{x}'],
    ['{{{{x}}}}', '{x}'],
    ['{{{x}}', '{{x}'],
    ['{{x}}}', '{x}}'],
    ['{{a{b}}', '{a{b}'],
    ['{{a}{{b}}', '{{a}{b}'],
    ['{{a{{b}}}}', '{a{b}}'],
    ['{{a}} and {{b}}', '{a} and {b}'],
    ['{{\\o}}', '{ø}'],
    ['$10^{{-3}}$', '$10^{-3}$'],
  ])('reduces %s to %s', (tex, expected) => {
    expect(tex2utf(tex)).toBe(expected);
  });

  it('returns text holding no backslash and no {{ as it is', () => {
    const plain = 'A study of {graphs} with ’quotes’ and αβγ';
    expect(tex2utf(plain)).toBe(plain);
    expect(tex2utf('')).toBe('');
  });

  it('is idempotent on its own output', () => {
    for (const tex of [
      "\\'{\\i}",
      'Sm{\\o}r-re-br{\\o}d',
      '{{{x}}}',
      '\\copyright 2026',
      'a\\j b',
    ]) {
      expect(tex2utf(tex2utf(tex))).toBe(tex2utf(tex));
    }
  });
});

describe('tex2utfAuthors', () => {
  it('converts each name between separators, keeping the separators the split needs', () => {
    expect(tex2utfAuthors('Gr\\o and B. Smith')).toBe('Grø and B. Smith');
    expect(tex2utfAuthors('\\ss & {\\o}lsen')).toBe('ß & ølsen');
    expect(tex2utf('Gr\\o and B. Smith')).toBe('Grøand B. Smith');
    expect(splitAuthors(tex2utfAuthors('Gr\\o and B. Smith'))).toEqual(['Grø', 'B. Smith']);
  });

  it('converts a line with no separator as tex2utf does', () => {
    expect(tex2utfAuthors("O. Barrag\\'an, A. Petralia")).toBe('O. Barragán, A. Petralia');
  });
});

describe('splitAuthors', () => {
  it.each([
    ['commas', 'A. Smith, B. Jones', ['A. Smith', 'B. Jones']],
    ['and', 'A. Smith and B. Jones', ['A. Smith', 'B. Jones']],
    [', and', 'A. Smith, B. Jones, and C. Lee', ['A. Smith', 'B. Jones', 'C. Lee']],
    ['&', 'A. Smith & B. Jones', ['A. Smith', 'B. Jones']],
    [
      ':',
      'ATLAS Collaboration: A. Smith, B. Jones',
      ['ATLAS Collaboration', 'A. Smith', 'B. Jones'],
    ],
    [
      'and throughout',
      'Henan Zhao and Garnett W. Bryant and Wesley Griffin and Judith E. Terrill and Jian Chen',
      ['Henan Zhao', 'Garnett W. Bryant', 'Wesley Griffin', 'Judith E. Terrill', 'Jian Chen'],
    ],
    [
      'a closing , and',
      'Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova',
      ['Jacob Devlin', 'Ming-Wei Chang', 'Kenton Lee', 'Kristina Toutanova'],
    ],
    ['a parenthesized affiliation', 'Geoffrey Hinton (University of Toronto)', ['Geoffrey Hinton']],
    [
      'an enumerated affiliation list',
      'D. Wahdany (1) and J. Cresswell (2) ((1) CISPA, (2) Layer 6 AI)',
      ['D. Wahdany', 'J. Cresswell'],
    ],
    [
      'a parenthesized translator list',
      'L. S. Klyachko (Translators: Carlos A A. Ramırez, James Q. Feng, and Rodney J. Kubesh)',
      ['L. S. Klyachko'],
    ],
    ['nested parentheses', 'A. Smith (Dept. (East)), B. Jones', ['A. Smith', 'B. Jones']],
    ['initials run together', 'J.A.Hinton', ['J. A. Hinton']],
    ['a dot escaping a TeX accent', 'J.\\.Zak', ['J. \\.Zak']],
    [
      'a Jr. suffix',
      'Brenda Bradshaw, James F. Leathrum, Jr., and Yuzhong Shen',
      ['Brenda Bradshaw', 'James F. Leathrum, Jr.', 'Yuzhong Shen'],
    ],
    ['a suffix with nothing before it', 'Jr., A. Smith', ['Jr.', 'A. Smith']],
    ['whitespace runs', '  A.   Smith ,\n B. Jones  ', ['A. Smith', 'B. Jones']],
  ])('splits on %s', (_case, authors, expected) => {
    expect(splitAuthors(authors)).toEqual(expected);
  });

  it('returns no names for an empty line or one of separators and blocks alone', () => {
    expect(splitAuthors('')).toEqual([]);
    expect(splitAuthors(', : ,')).toEqual([]);
    expect(splitAuthors('(Affiliation only)')).toEqual([]);
  });

  it('keeps an unbalanced parenthesis in the name it follows, as arxiv-base does', () => {
    expect(splitAuthors('A. Smith), B. Jones')).toEqual(['A. Smith)', 'B. Jones']);
    expect(splitAuthors('A. Smith (Dept, B. Jones')).toEqual(['A. Smith']);
  });
});

// ---------------------------------------------------------------------------
// Linear cost: the harvest converts every stored text column and every mirror
// read splits each returned paper's author line.
// ---------------------------------------------------------------------------

/** Thread CPU microseconds, least of three runs, spent on `fn`. */
function cpuMicros(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const before = process.threadCpuUsage();
    fn();
    const spent = process.threadCpuUsage(before);
    best = Math.min(best, spent.user + spent.system);
  }
  return best;
}

/**
 * Assert `fn(build(size))` stays linear as `size` doubles from `from` to `to`:
 * each size meets an absolute CPU bound before the next runs, and the whole
 * span costs under `maxRatio` times its first size (a quadratic costs the span
 * squared).
 */
function expectLinear(
  fn: (input: string) => unknown,
  build: (size: number) => string,
  { from, to, maxRatio }: { from: number; maxRatio: number; to: number },
): void {
  for (let i = 0; i < 3; i++) fn(build(from));
  const spent: number[] = [];
  for (let size = from; size <= to; size *= 2) {
    const input = build(size);
    const micros = cpuMicros(() => fn(input));
    expect(micros, `${size} characters`).toBeLessThan(5_000 + size);
    spent.push(Math.max(micros, 1));
  }
  expect((spent.at(-1) ?? 1) / (spent[0] ?? 1), JSON.stringify(spent)).toBeLessThan(maxRatio);
}

/** Below 80k characters: past it Bun's regex engine changes mode. 16× span, linear ~16×. */
const TO_80K = { from: 5_000, to: 80_000, maxRatio: 64 };

describe('cost on caller-sized input', { timeout: 60_000 }, () => {
  it.each([
    ['one long name after a backslash', (n: number) => `\\${'a'.repeat(n)}`],
    ['backslashes throughout', (n: number) => '\\'.repeat(n)],
    ['an opener with no closer', (n: number) => '{'.repeat(n)],
    ['nested braces', (n: number) => `${'{'.repeat(n / 2)}x${'}'.repeat(n / 2)}`],
    ['double-brace pairs', (n: number) => '{{x}}'.repeat(n / 5)],
    ['braced backslashes', (n: number) => '{\\'.repeat(n / 2)],
    ['macros and terminators', (n: number) => '{\\o}\\ss \\alpha{}'.repeat(n / 16)],
    ['accents with no letter', (n: number) => "\\'".repeat(n / 2)],
    ['accent openers with no closer', (n: number) => "\\'{".repeat(n / 3)],
    ['tie openers with no closer', (n: number) => '\\t{'.repeat(n / 3)],
    ['\\j throughout', (n: number) => '\\j'.repeat(n / 2)],
    ['a long line ending in a break', (n: number) => `${'\\x '.repeat(n / 3)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ])('keeps tex2utf linear on %s', (_shape, build) => {
    expectLinear(tex2utf, build, TO_80K);
  });

  it.each([
    ['separators throughout', (n: number) => ' and '.repeat(n / 5)],
    ['macros before separators', (n: number) => '\\o and '.repeat(n / 7)],
  ])('keeps tex2utfAuthors linear on %s', (_shape, build) => {
    expectLinear(tex2utfAuthors, build, TO_80K);
  });

  it.each([
    ['separators throughout', (n: number) => ' and '.repeat(n / 5)],
    ['openers with no closer', (n: number) => '('.repeat(n)],
    ['closers with no opener', (n: number) => ')'.repeat(n)],
    ['affiliations throughout', (n: number) => 'A (a) '.repeat(n / 6)],
    ['commas throughout', (n: number) => ', '.repeat(n / 2)],
    ['suffixes throughout', (n: number) => 'A, Jr., '.repeat(n / 8)],
    ['initials throughout', (n: number) => 'J.'.repeat(n / 2)],
    ['a long line ending in a break', (n: number) => `${'x'.repeat(n)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ])('keeps splitAuthors linear on %s', (_shape, build) => {
    expectLinear(splitAuthors, build, TO_80K);
  });

  it('keeps the full 64× span linear on a digit run', () => {
    const span = { from: 5_000, to: 320_000, maxRatio: 256 };
    const digits = (n: number) => '7'.repeat(n);
    expectLinear(tex2utf, digits, span);
    expectLinear(tex2utfAuthors, digits, span);
    expectLinear(splitAuthors, digits, span);
  });
});
