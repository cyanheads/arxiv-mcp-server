/**
 * @fileoverview Tests for the OAI-PMH parser, its character-reference decoding
 * and the live Atom parser's matching decode (#88), tombstone handling, and
 * `harvestPages`' failed-fetch path: recovery from a rejected resumption token
 * and its progress guard (#50, #59), and the init-only wait through an
 * upstream outage (#61), and an error response whose body stalls or drops
 * after its headers (#72). `fetch` is stubbed per test (the OAI host only);
 * the retry, status mapping, and parsing run for real. The last block serves
 * the OAI endpoint from a loopback socket and passes `fetch` through to it.
 * @module services/arxiv/mirror/harvester.test
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { ArxivService } from '@/services/arxiv/arxiv-service.js';
import {
  type HarvesterOptions,
  harvestPages,
  parseListRecords,
} from '@/services/arxiv/mirror/harvester.js';
import { rawToRow } from '@/services/arxiv/mirror/store.js';

// A test that reaches `fetch` without stubbing it fails instead of going out.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      throw new Error(`unmocked fetch: ${input}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PAGE_WITH_TOKEN = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <responseDate>2026-05-21T00:00:00Z</responseDate>
  <request verb="ListRecords" metadataPrefix="arXivRaw">http://oaipmh.arxiv.org/oai</request>
  <ListRecords>
    <record>
      <header>
        <identifier>oai:arXiv.org:2401.12345</identifier>
        <datestamp>2024-01-22</datestamp>
      </header>
      <metadata>
        <arXivRaw>
          <id>2401.12345</id>
          <title>Sample Paper Title</title>
          <authors>Alice Smith, Bob Jones</authors>
          <categories>cs.LG cs.AI</categories>
          <abstract>An interesting result on transformers.</abstract>
          <comments>15 pages</comments>
          <doi>10.1234/abc</doi>
          <journal-ref>JMLR 2024</journal-ref>
          <license>http://arxiv.org/licenses/nonexclusive-distrib/1.0/</license>
          <version version="v1">
            <date>2024-01-22T00:00:00Z</date>
            <size>1024kb</size>
            <source_type>tex</source_type>
          </version>
          <version version="v2">
            <date>2024-02-10T00:00:00Z</date>
          </version>
        </arXivRaw>
      </metadata>
    </record>
    <record>
      <header status="deleted">
        <identifier>oai:arXiv.org:9912.00099</identifier>
        <datestamp>2024-01-25</datestamp>
      </header>
    </record>
    <resumptionToken expirationDate="2026-05-22T00:00:00Z">verb=ListRecords&amp;skip=1300</resumptionToken>
  </ListRecords>
</OAI-PMH>`;

const TERMINAL_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <responseDate>2026-05-21T00:00:00Z</responseDate>
  <ListRecords>
    <record>
      <header>
        <identifier>oai:arXiv.org:2503.99999</identifier>
        <datestamp>2025-03-15</datestamp>
      </header>
      <metadata>
        <arXivRaw>
          <id>2503.99999</id>
          <title>Last Paper</title>
          <authors>Carol Adams</authors>
          <categories>math.AP</categories>
          <abstract>Final entry of the harvest.</abstract>
          <version version="v1">
            <date>2025-03-15T00:00:00Z</date>
          </version>
        </arXivRaw>
      </metadata>
    </record>
  </ListRecords>
</OAI-PMH>`;

const BAD_TOKEN_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <responseDate>2026-05-21T00:00:00Z</responseDate>
  <error code="badResumptionToken">Token expired or invalid</error>
</OAI-PMH>`;

describe('parseListRecords', () => {
  it('parses a page with records, tombstones, and a resumption token', () => {
    const page = parseListRecords(PAGE_WITH_TOKEN);
    expect(page.records).toHaveLength(1);
    expect(page.tombstones).toHaveLength(1);
    expect(page.resumptionToken).toBe('verb=ListRecords&skip=1300');
  });

  it('normalizes record fields and version history', () => {
    const page = parseListRecords(PAGE_WITH_TOKEN);
    const rec = page.records[0];
    expect(rec).toBeDefined();
    expect(rec?.paper_id).toBe('2401.12345');
    expect(rec?.title).toBe('Sample Paper Title');
    expect(rec?.categories).toBe('cs.LG cs.AI');
    expect(rec?.versions).toHaveLength(2);
    expect(rec?.versions[0]?.version).toBe('v1');
    expect(rec?.versions[1]?.version).toBe('v2');
    expect(rec?.comments).toBe('15 pages');
    expect(rec?.doi).toBe('10.1234/abc');
    expect(rec?.journal_ref).toBe('JMLR 2024');
  });

  it('extracts paper_id from the OAI identifier on tombstones', () => {
    const page = parseListRecords(PAGE_WITH_TOKEN);
    expect(page.tombstones[0]?.paper_id).toBe('9912.00099');
    expect(page.tombstones[0]?.datestamp).toBe('2024-01-25');
  });

  it('returns no resumption token on terminal pages', () => {
    const page = parseListRecords(TERMINAL_PAGE);
    expect(page.records).toHaveLength(1);
    expect(page.tombstones).toHaveLength(0);
    expect(page.resumptionToken).toBeUndefined();
  });

  it('throws a token-rejected McpError when arXiv returns badResumptionToken', () => {
    expect.assertions(3);
    try {
      parseListRecords(BAD_TOKEN_PAGE);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data?.code).toBe('badResumptionToken');
      expect((err as McpError).data?.reason).toBe('token_rejected');
    }
  });
});

describe('parseListRecords — character references (#88)', () => {
  /** A one-record page whose `arXivRaw` holds `fields`, each value written into the XML as is. */
  const pageWith = (fields: Record<string, string>, doctype = '') =>
    `<?xml version="1.0" encoding="UTF-8"?>${doctype}
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <ListRecords>
    <record>
      <header>
        <identifier>oai:arXiv.org:adap-org/9905005</identifier>
        <datestamp>2024-01-22</datestamp>
      </header>
      <metadata>
        <arXivRaw>
          <id>adap-org/9905005</id>
          ${Object.entries(fields)
            .map(([tag, value]) => `<${tag}>${value}</${tag}>`)
            .join('\n          ')}
          <categories>adap-org</categories>
          <version version="v1"><date>Mon, 10 May 1999 12:00:00 GMT</date></version>
        </arXivRaw>
      </metadata>
    </record>
  </ListRecords>
</OAI-PMH>`;

  const titleOf = (raw: string, doctype?: string) =>
    parseListRecords(pageWith({ title: `a${raw}b` }, doctype)).records[0]?.title;

  // OAI encodes every quote of arXiv's text as a numeric reference; arXiv's own
  // literal references arrive with their `&` escaped, as `&amp;#NNN;`.
  it.each([
    ['decimal apostrophe', '&#39;', "a'b"],
    ['decimal quotation mark', '&#34;', 'a"b'],
    ['hex, lowercase x', '&#x27;', "a'b"],
    ['hex, uppercase X', '&#X22;', 'a"b'],
    ['decimal outside ASCII', '&#8722;', 'a−b'],
    ['hex astral', '&#x1D49C;', 'a\u{1D49C}b'],
    ['decimal astral', '&#119964;', 'a\u{1D49C}b'],
    ['a decimal reference in the source text', '&amp;#39;', 'a&#39;b'],
    ['a non-ASCII reference in the source text', '&amp;#8722;', 'a&#8722;b'],
    ['a named reference in the source text', '&amp;amp;', 'a&amp;b'],
    ['the five XML named references', '&lt;&gt;&amp;&quot;&apos;', 'a<>&"\'b'],
    ['a TeX accent beside a quote reference', 'J\\&#39;anos', "aJ\\'anosb"],
  ])('decodes %s in one pass: %s', (_form, raw, expected) => {
    expect(titleOf(raw)).toBe(expected);
  });

  it('decodes the references in every field the mirror stores', () => {
    const [record] = parseListRecords(
      pageWith({
        title: 'Agents&#39; interactions',
        authors: 'J. O&#39;Neil',
        abstract: 'A &#34;quoted&#34; claim',
        comments: 'ICGA&#39;97',
        'journal-ref': 'Proc. &#34;X&#34;',
        doi: '10.1/a&#34;b',
      }),
    ).records;
    expect(record && rawToRow(record)).toMatchObject({
      title: "Agents' interactions",
      authors: "J. O'Neil",
      abstract: 'A "quoted" claim',
      comment: "ICGA'97",
      journal_ref: 'Proc. "X"',
      doi: '10.1/a"b',
    });
  });

  it('leaves a reference to an entity the document declares as written', () => {
    expect(titleOf('&e;', '<!DOCTYPE OAI-PMH [<!ENTITY e "declared">]>')).toBe('a&e;b');
  });

  it('decodes a reference on the live Atom path as the OAI parse does', async () => {
    vi.stubEnv('ARXIV_MIRROR_ENABLED', 'false');
    vi.stubEnv('ARXIV_REQUEST_DELAY_MS', '0');
    resetServerConfig();
    const raw = 'Agents&#39; &#x22;X&#x22; &amp;#8722; &amp;amp;';
    const fetchAtom = vi.fn(
      async () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/adap-org/9905005v1</id>
    <title>${raw}</title>
    <summary>s</summary>
    <author><name>A</name></author>
    <category term="adap-org" />
    <published>1999-05-10T12:00:00Z</published>
    <updated>1999-05-10T12:00:00Z</updated>
  </entry>
</feed>`,
          { status: 200, headers: { 'content-type': 'application/atom+xml' } },
        ),
    );
    vi.stubGlobal('fetch', fetchAtom);
    try {
      const { papers } = await new ArxivService().getPapers(
        ['adap-org/9905005'],
        createMockContext(),
      );
      expect(fetchAtom).toHaveBeenCalledOnce();
      expect(papers.map((p) => p.title)).toEqual(['Agents\' "X" &#8722; &amp;']);
      expect(papers[0]?.title).toBe(parseListRecords(pageWith({ title: raw })).records[0]?.title);
    } finally {
      vi.unstubAllEnvs();
      resetServerConfig();
    }
  });
});

describe('harvestPages — rejected resumption token (#50)', () => {
  const page = (datestamp: string, id: string, token?: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>
  <record>
    <header><identifier>oai:arXiv.org:${id}</identifier><datestamp>${datestamp}</datestamp></header>
    <metadata><arXivRaw><id>${id}</id><title>T</title><authors>A</authors><categories>cs.LG</categories><abstract>X</abstract></arXivRaw></metadata>
  </record>${token ? `<resumptionToken>${token}</resumptionToken>` : ''}
</ListRecords></OAI-PMH>`;

  const options = { baseUrl: 'https://oai.test/oai', requestDelayMs: 0, requestTimeoutMs: 1000 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Drain the generator against queued responses; returns the requested URLs. */
  async function run(from: string | undefined, startToken: string | undefined, bodies: string[]) {
    const requests: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (new URL(url).hostname !== 'oai.test') throw new Error(`unmocked fetch: ${url}`);
        requests.push(new URL(url));
        const body = bodies.shift();
        if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
        return new Response(body, { status: 200 });
      }),
    );
    const stamps: string[] = [];
    for await (const p of harvestPages(startToken, from, options, {
      signal: new AbortController().signal,
    })) {
      for (const r of p.records) stamps.push(r.datestamp);
    }
    return { requests, stamps };
  }

  const positions = (requests: URL[]) =>
    requests.map((u) => u.searchParams.get('resumptionToken') ?? u.searchParams.get('from'));

  it('recovers from the latest datestamp it has yielded, not the run start', async () => {
    const { requests, stamps } = await run('2026-06-01', undefined, [
      page('2026-06-01', '2606.00001', 'tok-1'),
      page('2026-06-03', '2606.00002', 'tok-2'),
      BAD_TOKEN_PAGE,
      page('2026-06-03', '2606.00002'),
    ]);

    expect(positions(requests)).toEqual(['2026-06-01', 'tok-1', 'tok-2', '2026-06-03']);
    expect(requests[3]?.searchParams.get('metadataPrefix')).toBe('arXivRaw');
    expect(stamps).toEqual(['2026-06-01', '2026-06-03', '2026-06-03']);
  });

  it('recovers a token-started run from its from datestamp before any page arrives', async () => {
    const { requests } = await run('2026-06-04', 'saved-tok', [
      BAD_TOKEN_PAGE,
      page('2026-06-04', '2606.00003'),
    ]);

    expect(positions(requests)).toEqual(['saved-tok', '2026-06-04']);
  });

  it('rethrows a rejected token when it has no datestamp to recover from', async () => {
    await expect(run(undefined, 'saved-tok', [BAD_TOKEN_PAGE])).rejects.toThrow(
      /badResumptionToken/,
    );
  });
});

// ---------------------------------------------------------------------------
// Failed page fetch: the token-recovery guard (#59) and the init outage wait (#61)
// ---------------------------------------------------------------------------

/** A `ListRecords` page holding one record per datestamp, and a token when given. */
const listPage = (stamps: string[], token?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>${stamps
    .map(
      (d, i) =>
        `<record><header><identifier>oai:arXiv.org:2610.0000${i}</identifier><datestamp>${d}</datestamp></header><metadata><arXivRaw><id>2610.0000${i}</id><title>T</title><authors>A</authors><categories>cs.LG</categories><abstract>X</abstract></arXivRaw></metadata></record>`,
    )
    .join(
      '',
    )}${token ? `<resumptionToken>${token}</resumptionToken>` : ''}</ListRecords></OAI-PMH>`;

/** An OAI-PMH protocol error, answered with HTTP 200 as arXiv answers it. */
const oaiError = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><error code="${code}">rejected</error></OAI-PMH>`;

/** The request timeout firing, in the shape the runtime's `fetch` raises it. */
const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError');

/** A 200 whose body fails partway through the read with `error`. */
const failingBody = (error: Error) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<?xml version="1.0"?><OAI-PMH><ListRecords>'));
        controller.error(error);
      },
    }),
    { status: 200 },
  );

/** A 503 carrying a `Retry-After`. */
const busy = (retryAfter: string) =>
  new Response('busy', { status: 503, headers: { 'retry-after': retryAfter } });

/** A page whose record has no header, so parsing it throws a `TypeError`. */
const MALFORMED_PAGE = `<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords><record><metadata/></record></ListRecords></OAI-PMH>`;

/** A request as sent, with the (possibly faked) clock reading when it went out. */
interface SentRequest {
  at: number;
  url: URL;
}

/**
 * Stub `fetch` for the OAI host. `answer` returns a 200 body, a `Response`, or
 * an error to throw for each request; any other host is rejected.
 */
function stubOai(answer: (url: URL, sent: SentRequest[]) => string | Response | Error) {
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.hostname !== 'oai.test') throw new Error(`unmocked fetch: ${input}`);
      sent.push({ url, at: Date.now() });
      const reply = answer(url, sent);
      if (typeof reply === 'string') return new Response(reply, { status: 200 });
      if (reply instanceof Response) return reply;
      throw reply;
    }),
  );
  return sent;
}

/** Each request's position: its token, `from=<datestamp>`, or `start`. */
const positions = (sent: SentRequest[]) =>
  sent.map(({ url }) => {
    const from = url.searchParams.get('from');
    return url.searchParams.get('resumptionToken') ?? (from ? `from=${from}` : 'start');
  });

const OPTIONS: HarvesterOptions = {
  baseUrl: 'https://oai.test/oai',
  requestDelayMs: 0,
  requestTimeoutMs: 1000,
};
const INIT: HarvesterOptions = { ...OPTIONS, waitOutOutages: true };

const ctxWith = (signal = new AbortController().signal) => ({ log: { warning: vi.fn() }, signal });

/** Run a harvest to its end; resolves with the datestamps of every record yielded. */
async function drain(pages: ReturnType<typeof harvestPages>): Promise<string[]> {
  const stamps: string[] = [];
  for await (const p of pages) for (const r of p.records) stamps.push(r.datestamp);
  return stamps;
}

describe('harvestPages — token-recovery progress guard (#59)', () => {
  const D = '2026-10-16';
  const D1 = '2026-10-17';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Every token is rejected and every `from=D` request answers one page stamped
   * D with a fresh token. Past eight requests it answers HTTP 400, so a harvest
   * that keeps looping ends instead of hanging.
   */
  function rejectEveryToken() {
    let issued = 0;
    return stubOai((url, sent) => {
      if (sent.length > 8) return new Response('stop', { status: 400 });
      if (url.searchParams.has('resumptionToken')) return oaiError('badResumptionToken');
      issued += 1;
      return listPage([D], `t${issued}`);
    });
  }

  it('fails on a second rejection before the checkpoint advances, naming the token and the datestamp', async () => {
    const sent = rejectEveryToken();
    const ctx = ctxWith();

    const err = await drain(harvestPages(undefined, D, OPTIONS, ctx)).catch((e: unknown) => e);

    expect(positions(sent)).toEqual([`from=${D}`, 't1', `from=${D}`, 't2']);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'token_recovery_stalled', resumptionToken: 't2', from: D },
    });
    expect((err as McpError).message).toContain(`'t2'`);
    expect((err as McpError).message).toContain(D);
    expect(ctx.log.warning.mock.calls).toEqual([
      ['Resumption token rejected; recovering from datestamp', { resumptionToken: 't1', from: D }],
    ]);
  });

  it('fails a run started from a saved token after three requests', async () => {
    const sent = rejectEveryToken();

    await expect(drain(harvestPages('saved-tok', D, OPTIONS, ctxWith()))).rejects.toMatchObject({
      data: { reason: 'token_recovery_stalled', resumptionToken: 't1', from: D },
    });
    expect(positions(sent)).toEqual(['saved-tok', `from=${D}`, 't1']);
  });

  it('fails a stall in init too, with no outage wait', async () => {
    const sent = rejectEveryToken();
    const ctx = ctxWith();

    await expect(drain(harvestPages(undefined, D, INIT, ctx))).rejects.toMatchObject({
      data: { reason: 'token_recovery_stalled' },
    });
    expect(sent).toHaveLength(4);
    expect(ctx.log.warning).toHaveBeenCalledTimes(1);
  });

  it('recovers again once the checkpoint has advanced, and drains', async () => {
    let fromD = 0;
    const sent = stubOai((url) => {
      if (url.searchParams.has('resumptionToken')) return oaiError('badResumptionToken');
      if (url.searchParams.get('from') === D1) return listPage([D1]);
      // The first from=D page stays on D; the second reaches D+1.
      fromD += 1;
      return fromD === 1 ? listPage([D], 'a') : listPage([D, D1], 'b');
    });

    const stamps = await drain(harvestPages(undefined, D, OPTIONS, ctxWith()));

    expect(positions(sent)).toEqual([`from=${D}`, 'a', `from=${D}`, 'b', `from=${D1}`]);
    expect(stamps).toEqual([D, D, D1, D1]);
  });

  it('drains after one rejection followed by accepted tokens through a multi-page day', async () => {
    const sent = stubOai((url) => {
      const token = url.searchParams.get('resumptionToken');
      if (token === 'old') return oaiError('badResumptionToken');
      if (!token) return listPage([D], 'p2');
      return token === 'p2' ? listPage([D], 'p3') : listPage([D]);
    });

    const stamps = await drain(harvestPages('old', D, OPTIONS, ctxWith()));

    expect(positions(sent)).toEqual(['old', `from=${D}`, 'p2', 'p3']);
    expect(stamps).toEqual([D, D, D]);
  });

  it.each(['badArgument', 'cannotDisseminateFormat', 'noRecordsMatch', 'badVerb'])(
    'fails the run on %s for a token request, with no fallback',
    async (code) => {
      const sent = stubOai(() => oaiError(code));

      await expect(drain(harvestPages('saved-tok', D, OPTIONS, ctxWith()))).rejects.toThrow(
        `OAI ${code}:`,
      );
      expect(positions(sent)).toEqual(['saved-tok']);
    },
  );

  it('rethrows a rejection answered to a request that sent no token, with no recovery', async () => {
    const sent = stubOai(() => oaiError('badResumptionToken'));

    await expect(drain(harvestPages(undefined, D, OPTIONS, ctxWith()))).rejects.toMatchObject({
      data: { reason: 'token_rejected' },
    });
    expect(positions(sent)).toEqual([`from=${D}`]);
  });

  it('waits the etiquette delay before the recovery request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sent = stubOai((url) =>
      url.searchParams.has('resumptionToken') ? oaiError('badResumptionToken') : listPage([D]),
    );

    const done = drain(
      harvestPages('saved-tok', D, { ...OPTIONS, requestDelayMs: 3000 }, ctxWith()),
    );
    await vi.advanceTimersByTimeAsync(2999);
    expect(positions(sent)).toEqual(['saved-tok']);
    await vi.advanceTimersByTimeAsync(1);

    expect(positions(sent)).toEqual(['saved-tok', `from=${D}`]);
    await expect(done).resolves.toEqual([D]);
  });
});

describe('harvestPages — init outage wait (#61)', () => {
  const D = '2026-10-16';
  const D1 = '2026-10-17';
  const MINUTE = 60_000;
  const WAIT_MSG = 'arXiv OAI-PMH unavailable; waiting, then re-sending the same request';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Run a harvest on the fake clock until it settles, advancing up to `horizonMs`. */
  async function settle(pages: ReturnType<typeof harvestPages>, horizonMs = 6 * 3_600_000) {
    const outcome = drain(pages).then(
      (stamps) => ({ stamps, error: undefined }),
      (error: unknown) => ({ stamps: undefined, error }),
    );
    await vi.advanceTimersByTimeAsync(horizonMs);
    return outcome;
  }

  /** Milliseconds between request `i` and the one after it. */
  const gapAfter = (sent: SentRequest[], i: number) => sent[i + 1]!.at - sent[i]!.at;

  it('waits 1, 2, 4, 8, 15, 15 minutes between failed cycles, re-sending the same token, and starts again at 1 minute once a page lands', async () => {
    let failures = 0;
    const sent = stubOai((url) => {
      const token = url.searchParams.get('resumptionToken');
      if (!token) return listPage([D], 'T1');
      // Six failed cycles of three attempts on T1, then one cycle on T2.
      failures += 1;
      if (token === 'T1') return failures <= 18 ? timedOut() : listPage([D], 'T2');
      return failures <= 22 ? timedOut() : listPage([D1]);
    });
    const ctx = ctxWith();

    const { stamps, error } = await settle(harvestPages(undefined, undefined, INIT, ctx));

    expect(error).toBeUndefined();
    expect(stamps).toEqual([D, D, D1]);
    expect(positions(sent)).toEqual(['start', ...Array(19).fill('T1'), ...Array(4).fill('T2')]);
    // From each cycle's last attempt to the next cycle's first.
    expect([3, 6, 9, 12, 15, 18, 22].map((i) => gapAfter(sent, i) / MINUTE)).toEqual([
      1, 2, 4, 8, 15, 15, 1,
    ]);
    expect(ctx.log.warning.mock.calls).toEqual(
      [1, 2, 4, 8, 15, 15, 1].map((minutes, i) => [
        WAIT_MSG,
        {
          error: expect.stringMatching(/timed out after 1000ms \(failed after 3 attempts\)$/),
          request: { resumptionToken: i < 6 ? 'T1' : 'T2' },
          waitMs: minutes * MINUTE,
        },
      ]),
    );
  });

  it('waits out a Retry-After longer than the step, after one request', async () => {
    let calls = 0;
    const sent = stubOai((url) => {
      if (!url.searchParams.has('resumptionToken')) return listPage([D], 'T1');
      calls += 1;
      return calls === 1 ? busy('600') : listPage([D1]);
    });
    const ctx = ctxWith();

    const { stamps } = await settle(harvestPages(undefined, undefined, INIT, ctx));

    expect(stamps).toEqual([D, D1]);
    expect(positions(sent)).toEqual(['start', 'T1', 'T1']);
    expect(gapAfter(sent, 1)).toBe(600_000);
    expect(ctx.log.warning).toHaveBeenCalledWith(WAIT_MSG, {
      error: expect.stringContaining('arxiv-oai returned HTTP 503'),
      request: { resumptionToken: 'T1' },
      waitMs: 600_000,
    });
  });

  it('reads a Retry-After given as an HTTP date', async () => {
    let calls = 0;
    const sent = stubOai((url) => {
      if (!url.searchParams.has('resumptionToken')) return listPage([D], 'T1');
      calls += 1;
      return calls === 1 ? busy(new Date(Date.now() + 600_000).toUTCString()) : listPage([D1]);
    });

    await settle(harvestPages(undefined, undefined, INIT, ctxWith()));

    expect(positions(sent)).toEqual(['start', 'T1', 'T1']);
    expect(gapAfter(sent, 1)).toBe(600_000);
  });

  it('waits the step when a Retry-After is shorter than it', async () => {
    let calls = 0;
    const sent = stubOai((url) => {
      if (!url.searchParams.has('resumptionToken')) return listPage([D], 'T1');
      calls += 1;
      return calls <= 3 ? busy('1') : listPage([D1]);
    });

    await settle(harvestPages(undefined, undefined, INIT, ctxWith()));

    expect(positions(sent)).toEqual(['start', 'T1', 'T1', 'T1', 'T1']);
    // The page retries honor the 1 s Retry-After; the wait after them is the 1-minute step.
    expect([1, 2, 3].map((i) => gapAfter(sent, i))).toEqual([1000, 1000, MINUTE]);
  });

  it('holds a Retry-After past the timer limit at that limit instead of re-sending at once', async () => {
    const MAX_TIMER_MS = 2 ** 31 - 1;
    let calls = 0;
    const sent = stubOai((url) => {
      if (!url.searchParams.has('resumptionToken')) return listPage([D], 'T1');
      calls += 1;
      return calls === 1 ? busy('99999999') : listPage([D1]);
    });

    const done = drain(harvestPages(undefined, undefined, INIT, ctxWith()));
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS - 1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toHaveLength(3);
    await expect(done).resolves.toEqual([D, D1]);
  });

  // The clock reads 2026-10-18T00:00:00Z, so each current date below is 10 minutes ahead.
  it.each([
    ['delta-seconds', '600', 600_000],
    ['an IMF-fixdate', 'Sun, 18 Oct 2026 00:10:00 GMT', 600_000],
    ['an rfc850-date', 'Sunday, 18-Oct-26 00:10:00 GMT', 600_000],
    // 2094 would be over 50 years ahead, so "94" is 1994: past, and the step applies.
    ['an rfc850-date from the last century', 'Sunday, 06-Nov-94 08:49:37 GMT', MINUTE],
    ['an asctime-date, which is in GMT', 'Sun Oct 18 00:10:00 2026', 600_000],
    ['a fraction', '600.5', MINUTE],
    ['an exponent', '6e2', MINUTE],
    ['a hex number', '0x258', MINUTE],
    ['a negative number', '-600', MINUTE],
    ['an ISO 8601 date', '2026-10-18T00:10:00Z', MINUTE],
    ['an HTTP-date with an out-of-range hour', 'Sun, 18 Oct 2026 24:10:00 GMT', MINUTE],
  ])(
    'honors a Retry-After given as %s only as RFC 9110 allows',
    async (_label, retryAfter, waitMs) => {
      // Busy through PAGE_RETRY whether or not the retry honors the value, then a page.
      let calls = 0;
      stubOai((url) => {
        if (!url.searchParams.has('resumptionToken')) return listPage([D], 'T1');
        calls += 1;
        return calls <= 3 ? busy(retryAfter) : listPage([D1]);
      });
      const ctx = ctxWith();

      const { stamps } = await settle(harvestPages(undefined, undefined, INIT, ctx));

      expect(stamps).toEqual([D, D1]);
      expect(ctx.log.warning).toHaveBeenNthCalledWith(
        1,
        WAIT_MSG,
        expect.objectContaining({ waitMs }),
      );
    },
  );

  it('re-sends a from= request after a wait and names it in the warning', async () => {
    let fromCalls = 0;
    const sent = stubOai((url) => {
      if (url.searchParams.has('resumptionToken')) return oaiError('badResumptionToken');
      fromCalls += 1;
      return fromCalls === 1 ? busy('120') : listPage([D1]);
    });
    const ctx = ctxWith();

    const { stamps } = await settle(harvestPages('saved-tok', D, INIT, ctx));

    expect(stamps).toEqual([D1]);
    expect(positions(sent)).toEqual(['saved-tok', `from=${D}`, `from=${D}`]);
    expect(gapAfter(sent, 1)).toBe(120_000);
    expect(ctx.log.warning).toHaveBeenLastCalledWith(WAIT_MSG, {
      error: expect.any(String),
      request: { metadataPrefix: 'arXivRaw', from: D },
      waitMs: 120_000,
    });
  });

  it.each([
    ['times out', timedOut, JsonRpcErrorCode.Timeout, /timed out after 1000ms/],
    [
      'drops the connection',
      () => new TypeError('terminated'),
      JsonRpcErrorCode.ServiceUnavailable,
      /network error/,
    ],
  ])(
    'classifies a body read that %s as an OAI-PMH outage',
    async (_label, cause, code, message) => {
      let calls = 0;
      const answer = (url: URL) => {
        if (!url.searchParams.has('resumptionToken')) return listPage([D], 'T1');
        calls += 1;
        return calls <= 3 ? failingBody(cause()) : listPage([D1]);
      };

      // Refresh: the page fails after its retries, as the matching McpError.
      const refreshSent = stubOai(answer);
      const refresh = await settle(harvestPages(undefined, undefined, OPTIONS, ctxWith()));
      expect(refresh.error).toBeInstanceOf(McpError);
      expect(refresh.error).toMatchObject({ code });
      expect((refresh.error as McpError).message).toMatch(message);
      expect((refresh.error as McpError).message).toMatch(/\(failed after 3 attempts\)$/);
      expect(refreshSent).toHaveLength(4);

      // Init: the same failures are waited out, and the harvest drains.
      calls = 0;
      const initSent = stubOai(answer);
      const ctx = ctxWith();
      const init = await settle(harvestPages(undefined, undefined, INIT, ctx));
      expect(init.stamps).toEqual([D, D1]);
      expect(positions(initSent)).toEqual(['start', 'T1', 'T1', 'T1', 'T1']);
      expect(gapAfter(initSent, 3)).toBe(MINUTE);
      expect(ctx.log.warning).toHaveBeenCalledTimes(1);
    },
  );

  /** `error` carrying a transport `code`, as the runtime's `fetch` attaches it. */
  const withCode = (error: Error, code: string) => Object.assign(error, { code });
  /** Node's undici: a bare `TypeError` whose `cause` carries the code. */
  const viaUndici = (message: string, cause: Error) => new TypeError(message, { cause });
  const socketError = () =>
    withCode(
      Object.assign(new Error('other side closed'), { name: 'SocketError' }),
      'UND_ERR_SOCKET',
    );

  it.each([
    [
      'a DNS failure, as Node raises it',
      () =>
        viaUndici(
          'fetch failed',
          withCode(new Error('getaddrinfo ENOTFOUND oai.test'), 'ENOTFOUND'),
        ),
      'network error reaching oai.test: getaddrinfo ENOTFOUND oai.test',
    ],
    [
      'a DNS failure, as Bun raises it',
      () => withCode(new TypeError('getaddrinfo ENOTFOUND oai.test'), 'ENOTFOUND'),
      'network error reaching oai.test: getaddrinfo ENOTFOUND oai.test',
    ],
    [
      'a refused connection, as Node raises it',
      () =>
        viaUndici(
          'fetch failed',
          withCode(new Error('connect ECONNREFUSED 10.0.0.1:443'), 'ECONNREFUSED'),
        ),
      'network error reaching oai.test: connect ECONNREFUSED 10.0.0.1:443',
    ],
    [
      'a refused connection, as Bun raises it',
      () => withCode(new TypeError('ECONNREFUSED: Unable to connect.'), 'ECONNREFUSED'),
      'network error reaching oai.test: ECONNREFUSED: Unable to connect.',
    ],
    [
      'a closed socket, as Node raises it',
      () => viaUndici('fetch failed', socketError()),
      'network error reaching oai.test: UND_ERR_SOCKET: other side closed',
    ],
    [
      'a body dropped mid-read, as Bun raises it',
      () =>
        failingBody(
          withCode(
            new TypeError('ECONNRESET: The socket connection was closed unexpectedly.'),
            'ECONNRESET',
          ),
        ),
      'network error reaching oai.test: ECONNRESET: The socket connection was closed unexpectedly.',
    ],
    [
      'a body dropped mid-read, as Node raises it',
      () => failingBody(viaUndici('terminated', socketError())),
      'network error reaching oai.test: UND_ERR_SOCKET: other side closed',
    ],
    [
      'a cause that repeats the request URL',
      () =>
        withCode(
          new TypeError('connect failed: https://oai.test/oai?verb=ListRecords&resumptionToken=T1'),
          'ECONNABORTED',
        ),
      'network error reaching oai.test: ECONNABORTED: connect failed: https://oai.test/oai',
    ],
    ['the request timeout', timedOut, 'request to oai.test timed out after 1000ms'],
  ])(
    'names the transport cause and host of %s in the refresh error and the init wait warning',
    async (_label, failure, detail) => {
      const expected = `arXiv OAI-PMH ${detail} (failed after 3 attempts)`;
      let calls = 0;
      const answer = (url: URL) => {
        if (!url.searchParams.has('resumptionToken')) return listPage([D], 'T1');
        calls += 1;
        return calls <= 3 ? failure() : listPage([D1]);
      };

      stubOai(answer);
      const refresh = await settle(harvestPages(undefined, undefined, OPTIONS, ctxWith()));
      expect((refresh.error as McpError).message).toBe(expected);

      calls = 0;
      stubOai(answer);
      const ctx = ctxWith();
      await settle(harvestPages(undefined, undefined, INIT, ctx));
      expect(ctx.log.warning).toHaveBeenCalledWith(WAIT_MSG, {
        error: expected,
        request: { resumptionToken: 'T1' },
        waitMs: MINUTE,
      });
    },
  );

  it('recovers a token rejected after a wait from the checkpoint datestamp', async () => {
    let calls = 0;
    const sent = stubOai((url) => {
      const token = url.searchParams.get('resumptionToken');
      if (!token) return url.searchParams.get('from') === D ? listPage([D1]) : listPage([D], 'T1');
      calls += 1;
      return calls <= 3 ? new Response('down', { status: 503 }) : oaiError('badResumptionToken');
    });
    const ctx = ctxWith();

    const { stamps } = await settle(harvestPages(undefined, undefined, INIT, ctx));

    expect(stamps).toEqual([D, D1]);
    expect(positions(sent)).toEqual(['start', 'T1', 'T1', 'T1', 'T1', `from=${D}`]);
    expect(ctx.log.warning.mock.calls.map(([msg]) => msg)).toEqual([
      WAIT_MSG,
      'Resumption token rejected; recovering from datestamp',
    ]);
  });

  it('ends a wait at once when the signal is cancelled, sending nothing more', async () => {
    // Past four requests it answers HTTP 400, so a harvest that skips the wait
    // fails here instead of spinning on the 503.
    const sent = stubOai((url, prior) => {
      if (prior.length > 4) return new Response('stop', { status: 400 });
      return url.searchParams.has('resumptionToken') ? busy('120') : listPage([D], 'T1');
    });
    const controller = new AbortController();
    const ctx = ctxWith(controller.signal);

    const done = drain(harvestPages(undefined, undefined, INIT, ctx)).catch((e: unknown) => e);
    await vi.waitFor(() =>
      expect(ctx.log.warning).toHaveBeenCalledWith(WAIT_MSG, expect.anything()),
    );
    const clock = Date.now();
    controller.abort(new Error('Aborted by SIGINT'));

    // Settles with no further advance of the clock.
    expect(await done).toMatchObject({ message: 'Aborted by SIGINT' });
    expect(Date.now()).toBe(clock);
    expect(positions(sent)).toEqual(['start', 'T1']);
  });

  it("fails a refresh after PAGE_RETRY's three attempts, with no wait", async () => {
    const sent = stubOai((url) =>
      url.searchParams.has('resumptionToken') ? timedOut() : listPage([D], 'T1'),
    );
    const ctx = ctxWith();

    const { error } = await settle(harvestPages(undefined, undefined, OPTIONS, ctx));

    expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect((error as McpError).message).toMatch(
      /timed out after 1000ms \(failed after 3 attempts\)$/,
    );
    expect(positions(sent)).toEqual(['start', 'T1', 'T1', 'T1']);
    expect(ctx.log.warning).not.toHaveBeenCalled();
  });

  it('fails a refresh at once on a Retry-After longer than the page retries allow', async () => {
    const sent = stubOai((url) =>
      url.searchParams.has('resumptionToken') ? busy('120') : listPage([D], 'T1'),
    );

    const { error } = await settle(harvestPages(undefined, undefined, OPTIONS, ctxWith()));

    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(positions(sent)).toEqual(['start', 'T1']);
  });

  it.each([
    ['an HTTP 4xx', () => new Response('gone', { status: 404 }), /HTTP 404/, 2, true],
    ['an HTTP 501', () => new Response('nope', { status: 501 }), /HTTP 501/, 2, true],
    [
      'an OAI error other than a token rejection',
      () => oaiError('badArgument'),
      /OAI badArgument/,
      2,
      true,
    ],
    ['a page that fails to parse', () => MALFORMED_PAGE, /failed after 3 attempts/, 4, false],
  ])('fails init on %s, with no wait', async (_label, failure, message, requests, isMcpError) => {
    const sent = stubOai((url) =>
      url.searchParams.has('resumptionToken') ? failure() : listPage([D], 'T1'),
    );
    const ctx = ctxWith();

    const { error } = await settle(harvestPages(undefined, undefined, INIT, ctx));

    expect((error as Error).message).toMatch(message);
    expect(error instanceof McpError).toBe(isMcpError);
    expect(sent).toHaveLength(requests);
    expect(ctx.log.warning).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// An error response whose body stalls or drops after its headers (#72)
// ---------------------------------------------------------------------------

describe('harvestPages — an error response whose body stalls or drops (#72)', () => {
  /** The runtime's own `fetch`, taken before any test stubs it. */
  const socketFetch = globalThis.fetch;
  const PARTIAL_BODY = '<?xml version="1.0" encoding="UTF-8"?><OAI-PMH';
  const WAIT_MSG = 'arXiv OAI-PMH unavailable; waiting, then re-sending the same request';

  let server: Server;
  /** `host:port` of the loopback endpoint, as error messages name it. */
  let origin: string;
  /** Requests the endpoint received, in order. */
  let served: URL[];
  /** The response the endpoint is writing, for a test to cut off. */
  let open: ServerResponse | undefined;
  /** How the endpoint answers each request. */
  let respond: (res: ServerResponse) => void;
  /** Runs once each `fetch` has resolved, so the client holds the headers. */
  let afterHeaders: (() => void) | undefined;

  beforeEach(async () => {
    served = [];
    open = undefined;
    afterHeaders = undefined;
    server = createServer((req, res) => {
      served.push(new URL(req.url ?? '/', 'http://127.0.0.1'));
      open = res;
      respond(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (new URL(input).host !== origin) throw new Error(`unmocked fetch: ${input}`);
      const response = await socketFetch(input, init);
      afterHeaders?.();
      return response;
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const optionsFor = (waitOutOutages: boolean): HarvesterOptions => ({
    baseUrl: `http://${origin}/oai`,
    requestDelayMs: 0,
    requestTimeoutMs: 1000,
    waitOutOutages,
  });

  /** Headers and the first bytes of a body that never finishes. */
  const stalled =
    (status: number, headers: Record<string, string> = {}) =>
    (res: ServerResponse) => {
      res.writeHead(status, { 'content-type': 'text/xml', ...headers });
      res.write(PARTIAL_BODY);
    };

  /** Drop the connection once the client has the headers. */
  const dropAfterHeaders = () => {
    afterHeaders = () => open?.socket?.destroy();
  };

  const MODES = [
    ['a refresh', false],
    ['init (waitOutOutages)', true],
  ] as const;

  it.each(MODES)(
    'fails %s on a 400 whose body stalls as a Timeout naming the host, sent once, with no wait',
    async (_mode, waitOutOutages) => {
      respond = stalled(400);
      const ctx = ctxWith();

      const err = await drain(
        harvestPages(undefined, undefined, optionsFor(waitOutOutages), ctx),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { status: 400, retryable: false, timeoutMs: 1000 },
      });
      expect((err as McpError).message).toBe(
        `arXiv OAI-PMH request to ${origin} timed out after 1000ms while reading the body of an HTTP 400 response`,
      );
      expect(served).toHaveLength(1);
      expect(ctx.log.warning).not.toHaveBeenCalled();
    },
    30_000,
  );

  it.each(MODES)(
    'fails %s on a 400 whose body drops as ServiceUnavailable naming the host and cause, sent once, with no wait',
    async (_mode, waitOutOutages) => {
      respond = stalled(400);
      dropAfterHeaders();
      const ctx = ctxWith();

      const err = await drain(
        harvestPages(undefined, undefined, optionsFor(waitOutOutages), ctx),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 400, retryable: false },
      });
      const prefix = `arXiv OAI-PMH network error reaching ${origin} while reading the body of an HTTP 400 response: `;
      const { message } = err as McpError;
      expect(message.slice(0, prefix.length)).toBe(prefix);
      expect(message.slice(prefix.length)).toMatch(/^(ECONNRESET|UND_ERR_SOCKET)\b/);
      expect(served).toHaveLength(1);
      expect(ctx.log.warning).not.toHaveBeenCalled();
    },
    30_000,
  );

  it.each(MODES)(
    'fails %s on a 400 whose body arrives in pieces as InvalidRequest carrying the body, sent once',
    async (_mode, waitOutOutages) => {
      const body = `${PARTIAL_BODY}><error code="badArgument">rejected</error></OAI-PMH>`;
      respond = (res) => {
        res.writeHead(400, { 'content-type': 'text/xml' });
        res.write(body.slice(0, 20));
        setTimeout(() => res.end(body.slice(20)), 50);
      };
      const ctx = ctxWith();

      const err = await drain(
        harvestPages(undefined, undefined, optionsFor(waitOutOutages), ctx),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        message: 'arXiv OAI-PMH returned HTTP 400',
        data: { status: 400, body },
      });
      expect(served).toHaveLength(1);
      expect(ctx.log.warning).not.toHaveBeenCalled();
    },
    30_000,
  );

  it.each([
    ['a 400', 400],
    ['a 503', 503],
  ])(
    'ends init with the cancellation itself when the signal fires while %s body stalls',
    async (_label, status) => {
      respond = stalled(status);
      const controller = new AbortController();
      const reason = new Error('Aborted by SIGINT');
      afterHeaders = () => controller.abort(reason);
      const ctx = ctxWith(controller.signal);

      const err = await drain(harvestPages(undefined, undefined, optionsFor(true), ctx)).catch(
        (e: unknown) => e,
      );

      expect(err).toBe(reason);
      expect(served).toHaveLength(1);
      expect(ctx.log.warning).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('keeps a 503 whose body stalls ServiceUnavailable with its Retry-After, failing a refresh and waited out by init', async () => {
    respond = stalled(503, { 'retry-after': '120' });

    // Refresh: a Retry-After past the page-retry cap fails the fetch on its first attempt.
    const refresh = await drain(
      harvestPages(undefined, undefined, optionsFor(false), ctxWith()),
    ).catch((e: unknown) => e);
    expect(refresh).toBeInstanceOf(McpError);
    expect(refresh).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'arxiv-oai returned HTTP 503 Service Unavailable.',
      data: { status: 503, retryAfter: '120' },
    });
    expect(served).toHaveLength(1);

    // Init: the same failure is an outage, waited out for its Retry-After until cancelled.
    served = [];
    const controller = new AbortController();
    const ctx = ctxWith(controller.signal);
    const init = drain(harvestPages(undefined, undefined, optionsFor(true), ctx)).catch(
      (e: unknown) => e,
    );
    await vi.waitFor(() => expect(ctx.log.warning).toHaveBeenCalled(), { timeout: 10_000 });
    expect(ctx.log.warning).toHaveBeenCalledWith(WAIT_MSG, {
      error: 'arxiv-oai returned HTTP 503 Service Unavailable.',
      request: { metadataPrefix: 'arXivRaw' },
      waitMs: 120_000,
    });
    controller.abort(new Error('Aborted by SIGINT'));
    expect(await init).toMatchObject({ message: 'Aborted by SIGINT' });
    expect(served).toHaveLength(1);
  }, 30_000);
});
