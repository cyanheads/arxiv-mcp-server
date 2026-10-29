/**
 * @fileoverview Tests for normalizePaperId — the shared arXiv ID parser (issue #41).
 * @module services/arxiv/paper-id.test
 */

import { describe, expect, it } from 'vitest';
import { normalizePaperId } from '@/services/arxiv/paper-id.js';

describe('normalizePaperId', () => {
  it('returns canonical IDs unchanged', () => {
    for (const id of [
      '0704.0001',
      '0704.0001v1',
      '1706.03762',
      '1706.03762v7',
      '2401.12345',
      '2412.99999',
      'hep-th/9901001',
      'hep-th/9901001v1',
      'math/0309136',
      'math/0309136v1',
      'cs/0001001',
      'cond-mat/0501001',
      'q-bio/0401001',
    ]) {
      expect(normalizePaperId(id), id).toBe(id);
    }
  });

  it('takes the sequence width the era fixes: 4 digits for 0704–1412, 5 from 1501', () => {
    expect(normalizePaperId('1412.9999')).toBe('1412.9999');
    expect(normalizePaperId('1501.00001')).toBe('1501.00001');
    for (const raw of [
      '1412.09999',
      '1501.0001',
      '1706.0376',
      '0703.0001',
      '0703.12345',
      '1201.00001',
    ]) {
      expect(normalizePaperId(raw), raw).toBeUndefined();
    }
  });

  it('rejects a YYMM whose month cannot exist, new-style and old-style alike (#98)', () => {
    for (const id of ['2401.00001', '2412.00001', '0912.0001', 'hep-th/9912001', 'math/0701001']) {
      expect(normalizePaperId(id), id).toBe(id);
    }
    for (const raw of [
      '9999.99999',
      '2400.00001',
      '2413.00001',
      '1700.12345',
      '0800.0001',
      'arXiv:2400.00001v2',
      'https://arxiv.org/abs/2413.00001',
      'hep-th/9900001',
      'hep-th/9913001',
      'math.GT/0300136',
      'cond-mat/0599001v2',
    ]) {
      expect(normalizePaperId(raw), raw).toBeUndefined();
    }
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePaperId(' \t1706.03762v7\n')).toBe('1706.03762v7');
  });

  it('strips an arXiv: prefix in any case, with or without a space after the colon', () => {
    expect(normalizePaperId('arXiv:1706.03762')).toBe('1706.03762');
    expect(normalizePaperId('ARXIV:1706.03762')).toBe('1706.03762');
    expect(normalizePaperId('arXiv: 1706.03762')).toBe('1706.03762');
    expect(normalizePaperId('arxiv:hep-th/9901001')).toBe('hep-th/9901001');
    expect(normalizePaperId('arXiv:2401.12345v2')).toBe('2401.12345v2');
  });

  it('lowercases the archive and the version marker', () => {
    expect(normalizePaperId('HEP-TH/9901001')).toBe('hep-th/9901001');
    expect(normalizePaperId('HEP-TH/9901001V2')).toBe('hep-th/9901001v2');
    expect(normalizePaperId('1706.03762V7')).toBe('1706.03762v7');
  });

  it('drops an old-style subject class', () => {
    expect(normalizePaperId('math.GT/0309136')).toBe('math/0309136');
    expect(normalizePaperId('cs.AI/0001001v1')).toBe('cs/0001001v1');
    expect(normalizePaperId('arXiv:nlin.CD/0001001')).toBe('nlin/0001001');
  });

  it('extracts the ID from arxiv.org abs, pdf, and html URLs', () => {
    expect(normalizePaperId('https://arxiv.org/abs/1706.03762')).toBe('1706.03762');
    expect(normalizePaperId('https://arxiv.org/pdf/1706.03762v7.pdf')).toBe('1706.03762v7');
    expect(normalizePaperId('https://arxiv.org/pdf/1706.03762v7')).toBe('1706.03762v7');
    expect(normalizePaperId('https://arxiv.org/html/2401.12345v2')).toBe('2401.12345v2');
    expect(normalizePaperId('http://arxiv.org/abs/hep-th/9901001v3')).toBe('hep-th/9901001v3');
    expect(normalizePaperId('https://www.arxiv.org/abs/1706.03762')).toBe('1706.03762');
    expect(normalizePaperId('https://export.arxiv.org/abs/math.GT/0309136')).toBe('math/0309136');
    expect(normalizePaperId('HTTPS://ARXIV.ORG/PDF/1706.03762.PDF')).toBe('1706.03762');
  });

  it('reads an arxiv.org URL past a trailing slash, query, or fragment, scheme optional', () => {
    expect(normalizePaperId('https://arxiv.org/abs/2401.12345?context=cs.LG')).toBe('2401.12345');
    expect(normalizePaperId('https://arxiv.org/html/2401.12345v2#S3')).toBe('2401.12345v2');
    expect(normalizePaperId('https://arxiv.org/html/2401.12345v2/')).toBe('2401.12345v2');
    expect(normalizePaperId('https://arxiv.org/pdf/2401.12345v2.pdf#page=3')).toBe('2401.12345v2');
    expect(normalizePaperId('arxiv.org/abs/hep-th/9901001')).toBe('hep-th/9901001');
  });

  it('accepts only the archives that issued old-style IDs', () => {
    // arXiv answers HTTP 400 for a whole id_list holding an unknown archive.
    for (const raw of ['hepth/9901001', 'astroph/0603449', 'xx-yy/9901001', 'stat/0701001']) {
      expect(normalizePaperId(raw), raw).toBeUndefined();
    }
    for (const id of ['acc-phys/9411001', 'solv-int/9901001', 'q-alg/9701001', 'nlin/0001001']) {
      expect(normalizePaperId(id), id).toBe(id);
    }
  });

  it('rejects anything that is not an arXiv ID', () => {
    for (const raw of [
      'biorxiv:10.64898/2026.07.22.740050',
      '1706.03762v7 | cs.CL',
      'https://example.org/abs/1706.03762',
      'https://arxiv.org/list/1706.03762',
      'https://arxiv.org/abs/1706.03762.pdf',
      'https://arxiv.org/abs/1706.03762//',
      'arXiv:https://arxiv.org/abs/1706.03762',
      '1706.0376',
      '1706.037621',
      '170.03762',
      '1706.03762v',
      '1706.03762.pdf',
      'hep-th/990100',
      'hep-th-ex/9901001',
      'math.GTX/0309136',
      '../../../etc/passwd',
      '10.1234/abcd',
      'arXiv:',
      '',
    ]) {
      expect(normalizePaperId(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });
});

/**
 * Per-call thread CPU of `fn`, in ms: the fastest of three samples, each
 * repeating `fn` until it has used ~20 ms of CPU.
 */
function cpuMs(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let usedMs = 0;
    do {
      fn();
      calls++;
      const used = process.threadCpuUsage(start);
      usedMs = (used.user + used.system) / 1000;
    } while (usedMs < 20);
    best = Math.min(best, usedMs / calls);
  }
  return best;
}

/**
 * Assert `normalizePaperId` stays linear on `make(size)` as `size` doubles from
 * 5k to 320k characters. Each size must meet an absolute CPU bound before the
 * next runs, so a superlinear cost fails at the first doubling it outgrows; the
 * full 64× span must cost under 256× (a quadratic costs ~4,096×).
 */
function expectLinear(make: (size: number) => string): void {
  const times: number[] = [];
  for (let size = 5_000; size <= 320_000; size *= 2) {
    const input = make(size);
    const ms = cpuMs(() => normalizePaperId(input));
    expect(ms, `${size} characters took ${ms.toFixed(3)} ms`).toBeLessThan(2 + size / 2_000);
    times.push(ms);
  }
  expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
}

// The bound is thread CPU; the wall-clock timeout only has to outlast a loaded machine.
describe('normalizePaperId cost on caller-sized input', { timeout: 30_000 }, () => {
  it('keeps the old-style ID match linear in input length', () => {
    expectLinear((size) => 'a'.repeat(size));
    expectLinear((size) => `a-${'a'.repeat(size)}`);
  });

  it('keeps the pdf-URL suffix strip linear in input length', () => {
    expectLinear((size) => `https://arxiv.org/pdf/${'.pd'.repeat(Math.ceil(size / 3))}`);
  });

  it('keeps the arxiv.org URL match linear in input length', () => {
    expectLinear((size) => `https://arxiv.org/abs/${'a'.repeat(size)}\nx`);
  });

  it('keeps the trim and arXiv: prefix strip linear in input length', () => {
    expectLinear((size) => `arxiv:${' '.repeat(size)}x`);
  });
});
