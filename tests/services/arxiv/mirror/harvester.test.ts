/**
 * @fileoverview Tests for the OAI-PMH parser, tombstone handling, and
 * resumption-token recovery semantics. The harvester's HTTP path is exercised
 * via direct response parsing (no live network).
 * @module services/arxiv/mirror/harvester.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { parseListRecords } from '@/services/arxiv/mirror/harvester.js';

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

  it('throws a token-expired McpError when arXiv returns badResumptionToken', () => {
    expect.assertions(3);
    try {
      parseListRecords(BAD_TOKEN_PAGE);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data?.code).toBe('badResumptionToken');
      expect((err as McpError).data?.reason).toBe('token_expired');
    }
  });
});
