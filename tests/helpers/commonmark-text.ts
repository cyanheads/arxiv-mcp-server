/**
 * @fileoverview Reads Markdown back through a real CommonMark parser
 * (`markdown-it`), so a test asserts what a `content[]` client reads rather
 * than which bytes were written: escapes, references, and hard breaks decode,
 * and any node that is not plain text is named in place, so live syntax fails
 * an expectation written as plain text.
 * @module tests/helpers/commonmark-text
 */

import MarkdownIt, { type MarkdownIt as Parser, type Token } from 'markdown-it';

/** Parser presets the read-back runs under: CommonMark, and CommonMark plus GFM tables and strikethrough. */
export type CommonMarkPreset = 'commonmark' | 'gfm';

export const COMMONMARK_PRESETS: readonly CommonMarkPreset[] = ['commonmark', 'gfm'];

const parsers: Record<CommonMarkPreset, Parser> = {
  commonmark: new MarkdownIt('commonmark'),
  // `default` adds the GFM table and strikethrough rules; raw HTML is on in both.
  gfm: new MarkdownIt('default', { html: true }),
};

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    // markdown-it percent-encodes a destination as it parses; decoded, it reads as the URL written.
    else if (token.type === 'link_open')
      out += `⟨a href=${decodeURI(String(token.attrGet('href')))}⟩`;
    else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/**
 * The text a CommonMark parse of `markdown` reads as: each inline run's text
 * (line breaks as `\n`), joined by a blank line, with every other node named in
 * place — `⟨strong⟩…⟨/strong⟩`, `⟨html_inline:<b>⟩`, `⟨blockquote_open⟩`,
 * `⟨fence:html⟩` (its literal is {@link readCommonMarkFences}).
 */
export function readCommonMarkText(markdown: string, preset: CommonMarkPreset = 'gfm'): string {
  const parts: string[] = [];
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type === 'fence') parts.push(`⟨fence:${token.info}⟩`);
    else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}⟩`);
    }
  }
  return parts.join('\n\n');
}

/** Every fenced code block `markdown` parses to, with its info string and literal content. */
export function readCommonMarkFences(
  markdown: string,
  preset: CommonMarkPreset = 'gfm',
): { info: string; literal: string }[] {
  return parsers[preset]
    .parse(markdown, {})
    .filter((token) => token.type === 'fence')
    .map((token) => ({ info: token.info, literal: token.content }));
}
