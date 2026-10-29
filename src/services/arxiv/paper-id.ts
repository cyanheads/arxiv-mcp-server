/**
 * @fileoverview arXiv paper ID normalization — the one parser every ID input
 * (`arxiv_get_metadata`, `arxiv_read_paper`, `arxiv://paper/{paperId}`) runs
 * before any upstream request.
 * @module services/arxiv/paper-id
 */

/** `arXiv:` citation prefix, any case, optional whitespace after the colon. */
const CITATION_PREFIX = /^arxiv:\s*/i;

/**
 * An arxiv.org `abs`, `pdf`, or `html` page URL, scheme optional; group 1 is the
 * page, group 2 the ID part. A trailing slash, `?query`, or `#fragment` names the
 * same paper (`/abs/2401.12345?context=cs.LG`, `/html/2401.12345v2#S3`).
 */
const ARXIV_URL =
  /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(abs|pdf|html)\/([^?#]+?)\/?(?:[?#].*)?$/i;

/**
 * New-style ID `YYMM.N…`, optional version, `MM` a month `01`–`12`; group 1 is
 * `YYMM`, group 2 the sequence number, whose width is fixed by the era (see
 * {@link normalizePaperId}).
 */
const NEW_STYLE_ID = /^(\d\d(?:0[1-9]|1[0-2]))\.(\d{4,5})(?:v\d+)?$/;

/**
 * Old-style ID `archive[.SC]/YYMMNNN[vN]`, lowercased, `MM` a month `01`–`12`.
 * The two-letter subject class is redundant — sequence numbers are unique per
 * archive — and arXiv answers only the class-less form, so it is dropped.
 */
const OLD_STYLE_ID = /^([a-z]+(?:-[a-z]+)?)(?:\.[a-z]{2})?\/(\d\d(?:0[1-9]|1[0-2])\d{3}(?:v\d+)?)$/;

/**
 * The archives that issued old-style IDs — every arXiv archive opened before
 * new-style IDs began in April 2007. arXiv answers HTTP 400 for a whole
 * `id_list` holding any other archive (`hepth/9901001`), so one is not an ID.
 */
const LEGACY_ARCHIVES = new Set([
  'acc-phys',
  'adap-org',
  'alg-geom',
  'ao-sci',
  'astro-ph',
  'atom-ph',
  'bayes-an',
  'chao-dyn',
  'chem-ph',
  'cmp-lg',
  'comp-gas',
  'cond-mat',
  'cs',
  'dg-ga',
  'funct-an',
  'gr-qc',
  'hep-ex',
  'hep-lat',
  'hep-ph',
  'hep-th',
  'math',
  'math-ph',
  'mtrl-th',
  'nlin',
  'nucl-ex',
  'nucl-th',
  'patt-sol',
  'physics',
  'plasm-ph',
  'q-alg',
  'q-bio',
  'quant-ph',
  'solv-int',
  'supr-con',
]);

/**
 * The `no_match` message for a canonical ID arXiv returned nothing for. The ID
 * passed {@link normalizePaperId}, so its format is not in doubt; arXiv answers
 * an absent paper and a pinned version it lacks with the same empty feed, so a
 * pinned miss names both.
 */
export function noSuchPaperMessage(paperId: string): string {
  return `arXiv has no paper${/v\d+$/.test(paperId) ? ' or version' : ''} with ID '${paperId}'.`;
}

/** Accepted spellings, for error messages. */
export const PAPER_ID_FORMS =
  '"2401.12345", "2401.12345v2", or a pre-2007 ID like "hep-th/9901001" (archive spelled as arXiv issued it), optionally prefixed "arXiv:", or an arxiv.org abs, pdf, or html URL, with or without https:// or a ?query or #fragment';

/**
 * Canonical arXiv ID for `raw`, or `undefined` when it is not an arXiv ID.
 *
 * Every spelling with one certain reading maps to the form arXiv itself
 * answers to: a leading `arXiv:` is stripped, an arxiv.org page URL yields its
 * ID, the archive and `v` are lowercased (`HEP-TH/9901001V2` →
 * `hep-th/9901001v2`), and an old-style subject class is dropped
 * (`math.GT/0309136` → `math/0309136`). A version suffix is kept as given.
 *
 * A new-style sequence number is 4 digits from 0704 through 1412 and 5 digits
 * from 1501 on; the other width, or any new-style ID before 0704, names no
 * paper (`1706.0376`, `0703.12345`), so it is rejected rather than sent upstream.
 * So is a `YYMM`, either style, whose month is not `01`–`12` (`2400.00001`,
 * `hep-th/9913001`).
 */
export function normalizePaperId(raw: string): string | undefined {
  const trimmed = raw.trim();
  const url = ARXIV_URL.exec(trimmed);
  const candidate = (
    url
      ? url[1]?.toLowerCase() === 'pdf'
        ? (url[2] ?? '').replace(/\.pdf$/i, '')
        : (url[2] ?? '')
      : trimmed.replace(CITATION_PREFIX, '')
  ).toLowerCase();
  const newStyle = NEW_STYLE_ID.exec(candidate);
  if (newStyle) {
    const yymm = newStyle[1] ?? '';
    const width = yymm < '0704' ? undefined : yymm <= '1412' ? 4 : 5;
    return newStyle[2]?.length === width ? candidate : undefined;
  }
  const old = OLD_STYLE_ID.exec(candidate);
  return old?.[1] && LEGACY_ARCHIVES.has(old[1]) ? `${old[1]}/${old[2]}` : undefined;
}
