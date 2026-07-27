/**
 * @fileoverview Static arXiv category taxonomy (~155 categories).
 * Source: arxiv.org taxonomy, last major addition: econ group (2017).
 * @module services/arxiv/categories
 */

export interface ArxivCategory {
  code: string;
  group: string;
  name: string;
}

/** Archives that belong to the "physics" top-level group. */
const PHYSICS_ARCHIVES = new Set([
  'astro-ph',
  'cond-mat',
  'gr-qc',
  'hep-ex',
  'hep-lat',
  'hep-ph',
  'hep-th',
  'math-ph',
  'nlin',
  'nucl-ex',
  'nucl-th',
  'physics',
  'quant-ph',
]);

/** Derive the top-level group from a category code. */
export function getGroup(code: string): string {
  const prefix = code.split('.')[0] ?? code;
  return PHYSICS_ARCHIVES.has(prefix) ? 'physics' : prefix;
}

/** All valid top-level group names. */
export const GROUPS = ['cs', 'econ', 'eess', 'math', 'physics', 'q-bio', 'q-fin', 'stat'] as const;

function c(code: string, name: string): ArxivCategory {
  return { code, name, group: getGroup(code) };
}

/** Full arXiv category taxonomy. */
export const ARXIV_CATEGORIES: readonly ArxivCategory[] = [
  // Computer Science
  c('cs.AI', 'Artificial Intelligence'),
  c('cs.AR', 'Hardware Architecture'),
  c('cs.CC', 'Computational Complexity'),
  c('cs.CE', 'Computational Engineering, Finance, and Science'),
  c('cs.CG', 'Computational Geometry'),
  c('cs.CL', 'Computation and Language'),
  c('cs.CR', 'Cryptography and Security'),
  c('cs.CV', 'Computer Vision and Pattern Recognition'),
  c('cs.CY', 'Computers and Society'),
  c('cs.DB', 'Databases'),
  c('cs.DC', 'Distributed, Parallel, and Cluster Computing'),
  c('cs.DL', 'Digital Libraries'),
  c('cs.DM', 'Discrete Mathematics'),
  c('cs.DS', 'Data Structures and Algorithms'),
  c('cs.ET', 'Emerging Technologies'),
  c('cs.FL', 'Formal Languages and Automata Theory'),
  c('cs.GL', 'General Literature'),
  c('cs.GR', 'Graphics'),
  c('cs.GT', 'Computer Science and Game Theory'),
  c('cs.HC', 'Human-Computer Interaction'),
  c('cs.IR', 'Information Retrieval'),
  c('cs.IT', 'Information Theory'),
  c('cs.LG', 'Machine Learning'),
  c('cs.LO', 'Logic in Computer Science'),
  c('cs.MA', 'Multiagent Systems'),
  c('cs.MM', 'Multimedia'),
  c('cs.MS', 'Mathematical Software'),
  c('cs.NA', 'Numerical Analysis'),
  c('cs.NE', 'Neural and Evolutionary Computing'),
  c('cs.NI', 'Networking and Internet Architecture'),
  c('cs.OH', 'Other Computer Science'),
  c('cs.OS', 'Operating Systems'),
  c('cs.PF', 'Performance'),
  c('cs.PL', 'Programming Languages'),
  c('cs.RO', 'Robotics'),
  c('cs.SC', 'Symbolic Computation'),
  c('cs.SD', 'Sound'),
  c('cs.SE', 'Software Engineering'),
  c('cs.SI', 'Social and Information Networks'),
  c('cs.SY', 'Systems and Control'),

  // Economics
  c('econ.EM', 'Econometrics'),
  c('econ.GN', 'General Economics'),
  c('econ.TH', 'Theoretical Economics'),

  // Electrical Engineering and Systems Science
  c('eess.AS', 'Audio and Speech Processing'),
  c('eess.IV', 'Image and Video Processing'),
  c('eess.SP', 'Signal Processing'),
  c('eess.SY', 'Systems and Control'),

  // Mathematics
  c('math.AC', 'Commutative Algebra'),
  c('math.AG', 'Algebraic Geometry'),
  c('math.AP', 'Analysis of PDEs'),
  c('math.AT', 'Algebraic Topology'),
  c('math.CA', 'Classical Analysis and ODEs'),
  c('math.CO', 'Combinatorics'),
  c('math.CT', 'Category Theory'),
  c('math.CV', 'Complex Variables'),
  c('math.DG', 'Differential Geometry'),
  c('math.DS', 'Dynamical Systems'),
  c('math.FA', 'Functional Analysis'),
  c('math.GM', 'General Mathematics'),
  c('math.GN', 'General Topology'),
  c('math.GR', 'Group Theory'),
  c('math.GT', 'Geometric Topology'),
  c('math.HO', 'History and Overview'),
  c('math.IT', 'Information Theory'),
  c('math.KT', 'K-Theory and Homology'),
  c('math.LO', 'Logic'),
  c('math.MG', 'Metric Geometry'),
  c('math.MP', 'Mathematical Physics'),
  c('math.NA', 'Numerical Analysis'),
  c('math.NT', 'Number Theory'),
  c('math.OA', 'Operator Algebras'),
  c('math.OC', 'Optimization and Control'),
  c('math.PR', 'Probability'),
  c('math.QA', 'Quantum Algebra'),
  c('math.RA', 'Rings and Algebras'),
  c('math.RT', 'Representation Theory'),
  c('math.SG', 'Symplectic Geometry'),
  c('math.SP', 'Spectral Theory'),
  c('math.ST', 'Statistics Theory'),

  // Physics — Astrophysics
  c('astro-ph.CO', 'Cosmology and Nongalactic Astrophysics'),
  c('astro-ph.EP', 'Earth and Planetary Astrophysics'),
  c('astro-ph.GA', 'Astrophysics of Galaxies'),
  c('astro-ph.HE', 'High Energy Astrophysical Phenomena'),
  c('astro-ph.IM', 'Instrumentation and Methods for Astrophysics'),
  c('astro-ph.SR', 'Solar and Stellar Astrophysics'),

  // Physics — Condensed Matter
  c('cond-mat.dis-nn', 'Disordered Systems and Neural Networks'),
  c('cond-mat.mes-hall', 'Mesoscale and Nanoscale Physics'),
  c('cond-mat.mtrl-sci', 'Materials Science'),
  c('cond-mat.other', 'Other Condensed Matter'),
  c('cond-mat.quant-gas', 'Quantum Gases'),
  c('cond-mat.soft', 'Soft Condensed Matter'),
  c('cond-mat.stat-mech', 'Statistical Mechanics'),
  c('cond-mat.str-el', 'Strongly Correlated Electrons'),
  c('cond-mat.supr-con', 'Superconductivity'),

  // Physics — standalone archives
  c('gr-qc', 'General Relativity and Quantum Cosmology'),
  c('hep-ex', 'High Energy Physics - Experiment'),
  c('hep-lat', 'High Energy Physics - Lattice'),
  c('hep-ph', 'High Energy Physics - Phenomenology'),
  c('hep-th', 'High Energy Physics - Theory'),
  c('math-ph', 'Mathematical Physics'),
  c('nucl-ex', 'Nuclear Experiment'),
  c('nucl-th', 'Nuclear Theory'),
  c('quant-ph', 'Quantum Physics'),

  // Physics — Nonlinear Sciences
  c('nlin.AO', 'Adaptation and Self-Organizing Systems'),
  c('nlin.CD', 'Chaotic Dynamics'),
  c('nlin.CG', 'Cellular Automata and Lattice Gases'),
  c('nlin.PS', 'Pattern Formation and Solitons'),
  c('nlin.SI', 'Exactly Solvable and Integrable Systems'),

  // Physics — general physics archive
  c('physics.acc-ph', 'Accelerator Physics'),
  c('physics.ao-ph', 'Atmospheric and Oceanic Physics'),
  c('physics.app-ph', 'Applied Physics'),
  c('physics.atm-clus', 'Atomic and Molecular Clusters'),
  c('physics.atom-ph', 'Atomic Physics'),
  c('physics.bio-ph', 'Biological Physics'),
  c('physics.chem-ph', 'Chemical Physics'),
  c('physics.class-ph', 'Classical Physics'),
  c('physics.comp-ph', 'Computational Physics'),
  c('physics.data-an', 'Data Analysis, Statistics and Probability'),
  c('physics.ed-ph', 'Physics Education'),
  c('physics.flu-dyn', 'Fluid Dynamics'),
  c('physics.gen-ph', 'General Physics'),
  c('physics.geo-ph', 'Geophysics'),
  c('physics.hist-ph', 'History and Philosophy of Physics'),
  c('physics.ins-det', 'Instrumentation and Detectors'),
  c('physics.med-ph', 'Medical Physics'),
  c('physics.optics', 'Optics'),
  c('physics.plasm-ph', 'Plasma Physics'),
  c('physics.pop-ph', 'Popular Physics'),
  c('physics.soc-ph', 'Physics and Society'),
  c('physics.space-ph', 'Space Physics'),

  // Quantitative Biology
  c('q-bio.BM', 'Biomolecules'),
  c('q-bio.CB', 'Cell Behavior'),
  c('q-bio.GN', 'Genomics'),
  c('q-bio.MN', 'Molecular Networks'),
  c('q-bio.NC', 'Neurons and Cognition'),
  c('q-bio.OT', 'Other Quantitative Biology'),
  c('q-bio.PE', 'Populations and Evolution'),
  c('q-bio.QM', 'Quantitative Methods'),
  c('q-bio.SC', 'Subcellular Processes'),
  c('q-bio.TO', 'Tissues and Organs'),

  // Quantitative Finance
  c('q-fin.CP', 'Computational Finance'),
  c('q-fin.EC', 'Economics'),
  c('q-fin.GN', 'General Finance'),
  c('q-fin.MF', 'Mathematical Finance'),
  c('q-fin.PM', 'Portfolio Management'),
  c('q-fin.PR', 'Pricing of Securities'),
  c('q-fin.RM', 'Risk Management'),
  c('q-fin.ST', 'Statistical Finance'),
  c('q-fin.TR', 'Trading and Market Microstructure'),

  // Statistics
  c('stat.AP', 'Applications'),
  c('stat.CO', 'Computation'),
  c('stat.ME', 'Methodology'),
  c('stat.ML', 'Machine Learning'),
  c('stat.OT', 'Other Statistics'),
  c('stat.TH', 'Statistics Theory'),
];

/** Fast lookup set for validating category codes against the taxonomy. */
export const VALID_CATEGORY_CODES: ReadonlySet<string> = new Set(
  ARXIV_CATEGORIES.map((c) => c.code),
);

/**
 * Archives that were subdivided into dotted subject classes (`astro-ph`, `cs`,
 * `math`, …). Derived from the taxonomy rather than listed, so adding an `x.YY`
 * leaf makes the bare `x` searchable without a second edit. Standalone archives
 * (`hep-th`, `quant-ph`, …) are absent — they have no subtree.
 */
const SUBDIVIDED_ARCHIVES: ReadonlySet<string> = new Set(
  ARXIV_CATEGORIES.flatMap((cat) => {
    const [archive, subject] = cat.code.split('.');
    return archive !== undefined && subject !== undefined ? [archive] : [];
  }),
);

/**
 * Subdivided archives whose code is a string prefix of a *different* archive, so
 * arXiv's `cat:X*` wildcard would also match that neighbour — `cat:math*` pulls
 * in `math-ph`, a physics archive. Those cases spell the subtree out instead of
 * wildcarding it. Derived from the taxonomy, so a future colliding archive is
 * handled without a code change.
 */
const PREFIX_COLLIDING_ARCHIVES: ReadonlySet<string> = new Set(
  [...SUBDIVIDED_ARCHIVES].filter((archive) =>
    ARXIV_CATEGORIES.some(
      (cat) =>
        cat.code !== archive && cat.code.startsWith(archive) && !cat.code.startsWith(`${archive}.`),
    ),
  ),
);

/**
 * Category codes a search-time `category` filter accepts: every taxonomy leaf
 * and standalone archive, plus the bare codes of subdivided archives. A bare
 * archive code means the whole subtree — its dotted subject classes *and* the
 * legacy flat papers filed against the archive itself before it was subdivided.
 *
 * Wider than {@link VALID_CATEGORY_CODES}, which stays the taxonomy `arxiv_list_categories`
 * enumerates: bare archive codes are searchable targets, not catalogue entries.
 */
export const SEARCHABLE_CATEGORY_CODES: ReadonlySet<string> = new Set([
  ...VALID_CATEGORY_CODES,
  ...SUBDIVIDED_ARCHIVES,
]);

/**
 * Concrete category codes a filter covers. A leaf or standalone archive covers
 * only itself; a subdivided archive covers its dotted subject classes plus the
 * bare archive code that legacy flat papers still carry. arXiv's own subtree
 * wildcards are accepted in the same vocabulary — `X*` matches every code with
 * that string prefix (including a neighbouring archive, as on the live API),
 * `X.*` only the dotted children. Unknown codes come back verbatim so callers
 * can decide whether to warn.
 */
export function categorySubtree(code: string): string[] {
  const trimmed = code.trim();
  if (!trimmed) return [];
  if (trimmed.endsWith('.*')) return codesStartingWith(trimmed.slice(0, -1));
  if (trimmed.endsWith('*')) {
    const prefix = trimmed.slice(0, -1);
    const matches = codesStartingWith(prefix);
    return SUBDIVIDED_ARCHIVES.has(prefix) ? [prefix, ...matches] : matches;
  }
  if (!SUBDIVIDED_ARCHIVES.has(trimmed)) return [trimmed];
  return [trimmed, ...codesStartingWith(`${trimmed}.`)];
}

function codesStartingWith(prefix: string): string[] {
  return ARXIV_CATEGORIES.filter((cat) => cat.code.startsWith(prefix)).map((cat) => cat.code);
}

/**
 * The `cat:` operand a category filter becomes on the live arXiv API. Leaves and
 * standalone archives match exactly. A subdivided archive becomes the `cat:X*`
 * subtree wildcard, which covers its subject classes and the legacy flat papers
 * a bare `cat:X` would match alone. Where that wildcard would leak a neighbouring
 * archive sharing the prefix, the subtree is spelled out as `(cat:X.* OR cat:X)`
 * so the neighbour stays out and the legacy flat papers stay in.
 */
export function categorySearchTerm(code: string): string {
  const trimmed = code.trim();
  if (!SUBDIVIDED_ARCHIVES.has(trimmed)) return `cat:${trimmed}`;
  return PREFIX_COLLIDING_ARCHIVES.has(trimmed)
    ? `(cat:${trimmed}.* OR cat:${trimmed})`
    : `cat:${trimmed}*`;
}

/**
 * Suggest up to `limit` searchable category codes closest to an invalid input.
 * Prefers codes sharing the archive prefix, then ranks within that group by
 * edit distance — `"cs.LB"` returns `"cs.LG"`, `"cs.LO"` ahead of `"cs.AI"`.
 * Falls back to closest match across the full searchable set when no prefix
 * matches. Bare archive codes are in the pool, so a mistyped `"condmat"` can
 * be answered with `"cond-mat"` rather than only its subject classes.
 * See issue #6.
 */
export function suggestCategories(code: string, limit = 5): string[] {
  const trimmed = code.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const prefix = lower.split('.')[0];
  const searchable = [...SEARCHABLE_CATEGORY_CODES];

  const rankByDistance = (pool: readonly string[]): string[] =>
    pool
      .map((candidate) => ({ code: candidate, d: editDistance(lower, candidate.toLowerCase()) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((x) => x.code);

  if (prefix) {
    const prefixed = searchable.filter(
      (candidate) =>
        candidate.toLowerCase().startsWith(`${prefix}.`) || candidate.toLowerCase() === prefix,
    );
    if (prefixed.length > 0) return rankByDistance(prefixed);
  }

  return rankByDistance(searchable);
}

/** Iterative Levenshtein distance — O(m*n) time, O(min(m,n)) space. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    prev = [...curr];
  }
  return prev[n] ?? 0;
}
