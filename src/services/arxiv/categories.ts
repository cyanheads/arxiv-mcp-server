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
