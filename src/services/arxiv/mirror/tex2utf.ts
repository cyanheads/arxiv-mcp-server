/**
 * @fileoverview arXiv's TeX-to-Unicode conversion and author-list split, ported
 * from arXiv's own `arxiv-base` (https://github.com/arxiv/arxiv-base):
 * `tex2utf` from `arxiv/util/tex2utf.py` and `split_authors` / `_tidy_name`
 * from `arxiv/authors/__init__.py`, both as of commit `fcd706b9b1`
 * (2024-03-26). The mirror stores arXivRaw text as OAI-PMH serves it, TeX
 * escapes included; the arXiv API serves the same text after this conversion
 * and with one `<author>` per name, so the harvest converts the text columns
 * with {@link tex2utf} and a read splits the stored author string with
 * {@link splitAuthors} (issue #89).
 *
 * Two deviations from the Python port, both in its greek table, follow what the
 * arXiv API returns: `\phi` becomes φ (U+03C6) where the port gives ϕ (U+03D5),
 * and `\varphi` stays as written where the port gives φ. Everything else,
 * including the port's quirks, is reproduced: the first substitution never
 * fires (its pattern opens with a stray `/`), so `{\i}` stays the dotless ı; an
 * accent the tables lack drops its accent mark; `\upsion` is the table's
 * spelling of upsilon.
 *
 * The Python port uses regular expressions with conditional groups and
 * Unicode-aware `\b`, which JavaScript lacks, and a loop that strips one brace
 * level per pass; the macro and brace passes here are hand scanners that give
 * the same output in one linear pass.
 *
 * arxiv-base is distributed under this notice:
 *
 * Copyright (c) 2017-2025 Cornell University
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 * @module services/arxiv/mirror/tex2utf
 */

/** One-character accents, keyed by the accent and the letter: `\'e` and `\c{c}`. */
const ACCENTS: ReadonlyMap<string, number> = new Map([
  ["'A", 0x00c1],
  ["'C", 0x0106],
  ["'E", 0x00c9],
  ["'I", 0x00cd],
  ["'L", 0x0139],
  ["'N", 0x0143],
  ["'O", 0x00d3],
  ["'R", 0x0154],
  ["'S", 0x015a],
  ["'U", 0x00da],
  ["'Y", 0x00dd],
  ["'Z", 0x0179],
  ["'a", 0x00e1],
  ["'c", 0x0107],
  ["'e", 0x00e9],
  ["'i", 0x00ed],
  ["'l", 0x013a],
  ["'n", 0x0144],
  ["'o", 0x00f3],
  ["'r", 0x0155],
  ["'s", 0x015b],
  ["'u", 0x00fa],
  ["'y", 0x00fd],
  ["'z", 0x017a],
  ['"A', 0x00c4],
  ['"E', 0x00cb],
  ['"I', 0x00cf],
  ['"O', 0x00d6],
  ['"U', 0x00dc],
  ['"Y', 0x0178],
  ['"a', 0x00e4],
  ['"e', 0x00eb],
  ['"i', 0x00ef],
  ['"o', 0x00f6],
  ['"u', 0x00fc],
  ['"y', 0x00ff],
  ['.A', 0x0226],
  ['.C', 0x010a],
  ['.E', 0x0116],
  ['.G', 0x0120],
  ['.I', 0x0130],
  ['.O', 0x022e],
  ['.Z', 0x017b],
  ['.a', 0x0227],
  ['.c', 0x010b],
  ['.e', 0x0117],
  ['.g', 0x0121],
  ['.o', 0x022f],
  ['.z', 0x017c],
  ['=A', 0x0100],
  ['=E', 0x0112],
  ['=I', 0x012a],
  ['=O', 0x014c],
  ['=U', 0x016a],
  ['=Y', 0x0232],
  ['=a', 0x0101],
  ['=e', 0x0113],
  ['=i', 0x012b],
  ['=o', 0x014d],
  ['=u', 0x016b],
  ['=y', 0x0233],
  ['^A', 0x00c2],
  ['^C', 0x0108],
  ['^E', 0x00ca],
  ['^G', 0x011c],
  ['^H', 0x0124],
  ['^I', 0x00ce],
  ['^J', 0x0134],
  ['^O', 0x00d4],
  ['^S', 0x015c],
  ['^U', 0x00db],
  ['^W', 0x0174],
  ['^Y', 0x0176],
  ['^a', 0x00e2],
  ['^c', 0x0109],
  ['^e', 0x00ea],
  ['^g', 0x011d],
  ['^h', 0x0125],
  ['^i', 0x00ee],
  ['^j', 0x0135],
  ['^o', 0x00f4],
  ['^s', 0x015d],
  ['^u', 0x00fb],
  ['^w', 0x0175],
  ['^y', 0x0177],
  ['`A', 0x00c0],
  ['`E', 0x00c8],
  ['`I', 0x00cc],
  ['`O', 0x00d2],
  ['`U', 0x00d9],
  ['`a', 0x00e0],
  ['`e', 0x00e8],
  ['`i', 0x00ec],
  ['`o', 0x00f2],
  ['`u', 0x00f9],
  ['~A', 0x00c3],
  ['~I', 0x0128],
  ['~N', 0x00d1],
  ['~O', 0x00d5],
  ['~U', 0x0168],
  ['~a', 0x00e3],
  ['~i', 0x0129],
  ['~n', 0x00f1],
  ['~o', 0x00f5],
  ['~u', 0x0169],
  // Letter-prefixed accents: \H{o}, \c{c}, \k{a}, \r{a}, \u{a}, \v{c}.
  ['HO', 0x0150],
  ['HU', 0x0170],
  ['Ho', 0x0151],
  ['Hu', 0x0171],
  ['cC', 0x00c7],
  ['cE', 0x0228],
  ['cG', 0x0122],
  ['cK', 0x0136],
  ['cL', 0x013b],
  ['cN', 0x0145],
  ['cR', 0x0156],
  ['cS', 0x015e],
  ['cT', 0x0162],
  ['cc', 0x00e7],
  ['ce', 0x0229],
  ['cg', 0x0123],
  ['ck', 0x0137],
  ['cl', 0x013c],
  // arxiv-base leaves out 'ci' (ARXIVDEV-2322).
  ['cn', 0x0146],
  ['cr', 0x0157],
  ['cs', 0x015f],
  ['ct', 0x0163],
  ['kA', 0x0104],
  ['kE', 0x0118],
  ['kI', 0x012e],
  ['kO', 0x01ea],
  ['kU', 0x0172],
  ['ka', 0x0105],
  ['ke', 0x0119],
  ['ki', 0x012f],
  ['ko', 0x01eb],
  ['ku', 0x0173],
  ['rA', 0x00c5],
  ['rU', 0x016e],
  ['ra', 0x00e5],
  ['ru', 0x016f],
  ['uA', 0x0102],
  ['uE', 0x0114],
  ['uG', 0x011e],
  ['uI', 0x012c],
  ['uO', 0x014e],
  ['uU', 0x016c],
  ['ua', 0x0103],
  ['ue', 0x0115],
  ['ug', 0x011f],
  ['ui', 0x012d],
  ['uo', 0x014f],
  ['uu', 0x016d],
  ['vA', 0x01cd],
  ['vC', 0x010c],
  ['vD', 0x010e],
  ['vE', 0x011a],
  ['vG', 0x01e6],
  ['vH', 0x021e],
  ['vI', 0x01cf],
  ['vK', 0x01e8],
  ['vL', 0x013d],
  ['vN', 0x0147],
  ['vO', 0x01d1],
  ['vR', 0x0158],
  ['vS', 0x0160],
  ['vT', 0x0164],
  ['vU', 0x01d3],
  ['vZ', 0x017d],
  ['va', 0x01ce],
  ['vc', 0x010d],
  ['vd', 0x010f],
  ['ve', 0x011b],
  ['vg', 0x01e7],
  ['vh', 0x021f],
  ['vi', 0x01d0],
  ['vk', 0x01e9],
  ['vl', 0x013e],
  ['vn', 0x0148],
  ['vo', 0x01d2],
  ['vr', 0x0159],
  ['vs', 0x0161],
  ['vt', 0x0165],
  ['vu', 0x01d4],
  ['vz', 0x017e],
]);

/** Letter macros: `\o`, `\ss`, `\AA`. */
const TEXT_LETTERS: ReadonlyMap<string, number> = new Map([
  ['AA', 0x00c5],
  ['AE', 0x00c6],
  ['DH', 0x00d0],
  ['DJ', 0x0110],
  ['ETH', 0x00d0],
  ['L', 0x0141],
  ['NG', 0x014a],
  ['O', 0x00d8],
  ['oe', 0x0153],
  ['OE', 0x0152],
  ['TH', 0x00de],
  ['aa', 0x00e5],
  ['ae', 0x00e6],
  ['dh', 0x00f0],
  ['dj', 0x0111],
  ['eth', 0x00f0],
  ['i', 0x0131],
  ['l', 0x0142],
  ['ng', 0x014b],
  ['o', 0x00f8],
  ['ss', 0x00df],
  ['th', 0x00fe],
]);

/** Greek macros, as the arXiv API converts them: `\phi` is φ and `\varphi` is absent. */
const TEXT_GREEK: ReadonlyMap<string, number> = new Map([
  ['Gamma', 0x0393],
  ['Delta', 0x0394],
  ['Theta', 0x0398],
  ['Lambda', 0x039b],
  ['Xi', 0x039e],
  ['Pi', 0x03a0],
  ['Sigma', 0x03a3],
  ['Upsilon', 0x03a5],
  ['Phi', 0x03a6],
  ['Psi', 0x03a8],
  ['Omega', 0x03a9],
  ['alpha', 0x03b1],
  ['beta', 0x03b2],
  ['gamma', 0x03b3],
  ['delta', 0x03b4],
  ['epsilon', 0x03b5],
  ['zeta', 0x03b6],
  ['eta', 0x03b7],
  ['theta', 0x03b8],
  ['iota', 0x03b9],
  ['kappa', 0x03ba],
  ['lambda', 0x03bb],
  ['mu', 0x03bc],
  ['nu', 0x03bd],
  ['xi', 0x03be],
  ['omicron', 0x03bf],
  ['pi', 0x03c0],
  ['rho', 0x03c1],
  ['varsigma', 0x03c2],
  ['sigma', 0x03c3],
  ['tau', 0x03c4],
  ['upsion', 0x03c5],
  ['phi', 0x03c6],
  ['chi', 0x03c7],
  ['psi', 0x03c8],
  ['omega', 0x03c9],
]);

/** Symbol macros: `\copyright`, `\dag`, `\S`. */
const TEXT_SYMBOLS: ReadonlyMap<string, number> = new Map([
  ['P', 0x00b6],
  ['S', 0x00a7],
  ['copyright', 0x00a9],
  ['guillemotleft', 0x00ab],
  ['guillemotright', 0x00bb],
  ['pounds', 0x00a3],
  ['dag', 0x2020],
  ['ddag', 0x2021],
  ['div', 0x00f7],
  ['deg', 0x00b0],
]);

/**
 * The run of name characters after a backslash: Python's Unicode `\w` less
 * `_`. A name the tables hold must end where the name characters do — before
 * `_` (a subscript), a non-word character, or the end — so the run either is a
 * table key or matches nothing. Sticky: matched at `lastIndex` only.
 */
const NAME_RUN = /[\p{L}\p{N}]*/uy;

/**
 * Replace each macro of `table` — `\name` or `{\name}` — with its character.
 * An unbraced macro also takes one terminator: a `\` before a space, a space,
 * or `{}`. Ports arxiv-base's `({)?\\(names)(\b|(?=_))(?(1)}|(\\(?= )| |{}|)?)`.
 */
function replaceMacros(text: string, table: ReadonlyMap<string, number>): string {
  let at = text.indexOf('\\');
  if (at === -1) return text;
  let out = '';
  let copied = 0;
  while (at !== -1) {
    NAME_RUN.lastIndex = at + 1;
    const end = at + 1 + (NAME_RUN.exec(text)?.[0].length ?? 0);
    const code = table.get(text.slice(at + 1, end));
    if (code === undefined) {
      at = text.indexOf('\\', at + 1);
      continue;
    }
    let start = at;
    let stop = end;
    if (at - 1 >= copied && text[at - 1] === '{' && text[end] === '}') {
      start = at - 1;
      stop = end + 1;
    } else if (text.startsWith('\\ ', end) || text[end] === ' ') {
      stop = end + 1;
    } else if (text.startsWith('{}', end)) {
      stop = end + 2;
    }
    out += text.slice(copied, start) + String.fromCodePoint(code);
    copied = stop;
    at = text.indexOf('\\', stop);
  }
  return out + text.slice(copied);
}

/**
 * Reduce `{{x}}`, `{{{x}}}`, … to `{x}` as arxiv-base's loop does, without its
 * pass per brace level. Its pattern, `\{\{([^}]*)\}\}`, ties each run of two or
 * more `}` to the text since the `}` before it: each pass deletes one `{` of
 * that text's leftmost `{{` and one `}` of the run, until the text holds no
 * `{{` or the run is down to one `}`. Runs never interact, so each settles on
 * its own: up to `run - 1` deletions, taken from the `{` runs left to right,
 * each run kept to one.
 */
function reduceDoubleBraces(text: string): string {
  if (!text.includes('{{')) return text;
  let out = '';
  let segmentStart = 0;
  let at = text.indexOf('}');
  while (at !== -1) {
    let runEnd = at;
    while (text[runEnd] === '}') runEnd++;
    let deletions = runEnd - at - 1;
    let segment = text.slice(segmentStart, at);
    if (deletions > 0 && segment.includes('{{')) {
      let kept = '';
      let open = 0;
      for (let i = 0; i < segment.length; i++) {
        if (segment[i] === '{') {
          open++;
          continue;
        }
        const drop = Math.min(Math.max(open - 1, 0), deletions);
        deletions -= drop;
        kept += '{'.repeat(open - drop) + segment[i];
        open = 0;
      }
      const drop = Math.min(Math.max(open - 1, 0), deletions);
      deletions -= drop;
      segment = kept + '{'.repeat(open - drop);
    }
    const deleted = runEnd - at - 1 - deletions;
    out += segment + '}'.repeat(runEnd - at - deleted);
    segmentStart = runEnd;
    at = text.indexOf('}', runEnd);
  }
  return out + text.slice(segmentStart);
}

/** An accent the tables hold, or the accent's letter alone: `\'x` is `x`, `\H{q}` is `Hq`. */
function accented(accent: string): string {
  const code = ACCENTS.get(accent);
  return code === undefined ? accent.replace(/\W+/g, '') : String.fromCodePoint(code);
}

/**
 * Convert arXiv's TeX accents, letter macros, greek letters, and symbols to
 * Unicode, as the arXiv API does for titles, abstracts, comments, journal
 * references, and author names. Text holding no `\` and no `{{` comes back
 * unchanged. Linear in the length of `tex`.
 */
export function tex2utf(tex: string): string {
  if (!tex.includes('\\') && !tex.includes('{{')) return tex;
  // arxiv-base's first substitution (dotless i/j under an accent). Its pattern
  // opens with a stray `/`, so it fires only on text holding that slash.
  let utf = tex.replace(/\/(\\['`^"~=.uvH])\{\\([ij])\}/g, '$1\\{$2\\}');
  utf = replaceMacros(utf, TEXT_LETTERS);
  utf = replaceMacros(utf, TEXT_GREEK);
  utf = replaceMacros(utf, TEXT_SYMBOLS);
  utf = utf.replace(/\{\\j\}|\\j\s/g, 'j');
  utf = reduceDoubleBraces(utf);
  utf = utf.replace(/\\(['`^"~=.][a-zA-Z])/g, (_m, accent: string) => accented(accent));
  utf = utf.replace(/\\(['`^"~=.])\{([a-zA-Z])\}/g, (_m, accent: string, letter: string) =>
    accented(accent + letter),
  );
  utf = utf.replace(/\\([Hckoruv])\{([a-zA-Z])\}/g, (_m, accent: string, letter: string) =>
    accented(accent + letter),
  );
  // \t{oo} (tie) is left as written; a \t{x} around one character drops the macro.
  return utf.replace(/\\t\{([^}])\}/gu, '$1');
}

/**
 * {@link tex2utf} for an author line, applied between its ` and ` and ` & `
 * separators, which stay as written. arXiv splits the line first and converts
 * each name; converting the whole line would let a macro at a name's end take
 * the space a separator needs (`Gr\o and B` → `Grøand B`), and the names would
 * no longer split there.
 */
export function tex2utfAuthors(authors: string): string {
  return authors
    .split(/(\s(?:and|&)\s)/)
    .map((piece, i) => (i % 2 === 0 ? tex2utf(piece) : piece))
    .join('');
}

/**
 * arxiv-base's `split_authors`: the author line cut into names, `,` and `:`
 * separators, and parenthesized blocks (affiliations, an enumerated affiliation
 * list), with ` and `, `, and`, and `&` read as commas and a `, Jr.` suffix
 * rejoined to the name before it.
 */
function splitAuthorParts(authors: string): string[] {
  if (!authors) return [];
  const bits = authors.split(/(\(|\))/).filter((bit) => bit !== '');
  const blocks: string[] = [];
  if (bits.length === 1) {
    blocks.push(authors);
  } else {
    let block = '';
    let depth = 0;
    for (const bit of bits) {
      if (bit === '(') {
        depth++;
        if (depth === 1) {
          blocks.push(block);
          block = '(';
        } else {
          block += bit;
        }
      } else if (bit === ')') {
        depth--;
        block += bit;
        if (depth === 0) {
          blocks.push(block);
          block = '';
        }
      } else {
        block += bit;
      }
    }
    if (block) blocks.push(block);
  }

  const parts: string[] = [];
  for (const raw of blocks) {
    const block = raw.replace(/\s+/g, ' ');
    if (block.startsWith('(')) {
      parts.push(block);
      continue;
    }
    for (const piece of block.replace(/,?\s+(and|&)\s/g, ',').split(/(,|:)\s*/)) {
      const name = piece.trim();
      if (name) parts.push(name);
    }
  }

  const joined: string[] = [];
  for (const part of parts) {
    const separator = joined.at(-1);
    const last = joined.at(-2);
    // arxiv-base's pattern, `^(Jr\.?|Sr\.?\[IV]{2,})$`, rejoins Jr. alone.
    if (
      /^(Jr\.?|Sr\.?\[IV\]{2,})$/.test(part) &&
      separator === ',' &&
      last !== undefined &&
      last !== ')'
    ) {
      joined.splice(-2, 2, `${last}${separator} ${part}`);
    } else {
      joined.push(part);
    }
  }
  return joined;
}

/**
 * The author names in an arXivRaw author line, as the arXiv API lists them:
 * {@link splitAuthorParts} without its separators and parenthesized blocks,
 * each name's whitespace collapsed and a space put after every dot not
 * escaping a TeX accent (`J.A.Hinton` → `J. A. Hinton`). Run it on text
 * {@link tex2utf} has converted. Linear in the length of `authors`.
 */
export function splitAuthors(authors: string): string[] {
  return splitAuthorParts(authors)
    .filter((part) => part !== ',' && part !== ':' && !part.startsWith('('))
    .map((name) => name.replace(/\s\s+/g, ' ').replace(/(?<!\\)\.(\S)/gu, '. $1'));
}
