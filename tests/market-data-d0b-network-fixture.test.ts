import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { replayObservationArchive } from '../src/market-data/observations-replay.js';
import { observationPlan } from '../src/market-data/observation-model.js';

// Recorded anonymous public responses, 2026-10-01 11:42 UTC. These tests are fully offline.
// Capture completion is schema/transport acceptance, not current freshness or an executable edge.
const archive = readFileSync(new URL('../fixtures/market-data/d0b-public-20261001.json', import.meta.url));
const manifestText = readFileSync(new URL('../fixtures/market-data/d0b-public-20261001.manifest.json', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestText);
const sha256 = '4facee5bdf083fb22bfb170fc40275479e125e0afb53f5835ce453f0fb164210';
const report = replayObservationArchive(archive, sha256);
const canonicalRate = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;

describe('D0b actual public MEXC/OKX BTC/ETH capture, historical offline acceptance', () => {
  it('pins original bytes and public-only manifest without implying source authentication', () => {
    expect(archive.byteLength).toBe(109876);
    expect(createHash('sha256').update(archive).digest('hex')).toBe(sha256);
    expect(manifestText).toBe(JSON.stringify(manifest) + '\n');
    expect(manifest).toEqual({ schema: 1, kind: 'derivatives-public-d0b-manifest', sha256, publicDataOnly: true, executable: false });
    expect(report).toMatchObject({ status: 'complete', requestCount: 24, failures: [],
      executable: false, accountRequests: false, feesVerified: false, netEdgeBps: null });
    expect(report.endedAt - report.startedAt).toBe(6306);
  });
  it('replays every fixed route and binds metadata to earlier instrument responses in this capture', () => {
    expect(report.observations.map(row => row.route)).toEqual(observationPlan());
    let bound = 0;
    for (const [index, row] of report.observations.entries()) {
      expect(row.receipt.requestedAt).toBeGreaterThanOrEqual(index ? report.observations[index - 1].receipt.receivedAt : report.startedAt);
      if ('metadataReceivedAt' in row.parsed) {
        const spec = report.observations.slice(0, index).find(candidate => candidate.route.exchange === row.route.exchange &&
          candidate.route.base === row.route.base && candidate.route.kind === 'instrument');
        expect(spec).toBeDefined(); expect(row.parsed.metadataReceivedAt).toBe(spec!.receipt.receivedAt);
        expect(row.receipt.receivedAt - row.parsed.metadataReceivedAt).toBeLessThanOrEqual(2591); bound++;
      }
      expect(row.parsed.executable).toBe(false);
    }
    expect(bound).toBe(16);
  });
  it('preserves null MEXC cts and refuses to call system timestamps verified book updates', () => {
    const books = report.observations.filter(row => row.route.exchange === 'mexc' && row.route.kind === 'book');
    expect(books).toHaveLength(2);
    for (const row of books) {
      if (row.parsed.kind !== 'public-perpetual-book') throw Error('fixture book type changed');
      expect(JSON.parse(row.raw).data.cts).toBeNull();
      expect(row.parsed).toMatchObject({ auxiliaryTimestamp: null, auxiliaryTimestampVerified: false,
        sourceFreshnessVerified: false, sourceTime: { meaning: 'exchange-system', representsUpdate: false, ageStatus: 'within-window' } });
      expect(row.parsed.bids).toHaveLength(50); expect(row.parsed.asks).toHaveLength(50);
    }
    expect(report.quality).toEqual([
      { base: 'BTC', evaluatedAt: 1790854945935, booksPresent: true, metadataUsable: true,
        receiptSkewMs: 298, sourceSkewMs: 1267, usableForBookComparison: false,
        reasons: ['book-source-skew', 'mexc-book-update-time-unverified'], executable: false },
      { base: 'ETH', evaluatedAt: 1790854949029, booksPresent: true, metadataUsable: true,
        receiptSkewMs: 273, sourceSkewMs: 709, usableForBookComparison: false,
        reasons: ['mexc-book-update-time-unverified'], executable: false },
    ]);
  });
  it('distinguishes OKX source timestamps for books/index from response times for mark and open interest', () => {
    for (const row of report.observations.filter(row => row.route.exchange === 'okx')) {
      if (!('sourceTime' in row.parsed)) continue;
      const update = row.route.kind === 'book' || row.route.kind === 'index';
      expect(row.parsed.sourceTime.ageStatus).toBe('within-window');
      expect(row.parsed.sourceTime.representsUpdate).toBe(update);
      expect(row.parsed.sourceFreshnessVerified).toBe(update);
      expect(row.parsed.sourceTime.meaning).toBe(row.route.kind === 'book' ? 'book-generation' :
        row.route.kind === 'index' ? 'price-update' : 'response-time');
    }
  });
  it('retains all forty actual OKX settled rates without inferring account income or the funding interval', () => {
    const histories = report.observations.filter(row => row.route.exchange === 'okx' && row.route.kind === 'history');
    expect(histories).toHaveLength(2);
    for (const row of histories) {
      if (row.parsed.kind !== 'public-funding-history') throw Error('fixture history type changed');
      const raw = JSON.parse(row.raw) as { data: { realizedRate: string; fundingRate: string }[] };
      expect(row.parsed.events).toHaveLength(20);
      expect(row.parsed).toMatchObject({ realizedAccountIncome: null, historyComplete: false, continuityVerified: false });
      row.parsed.events.forEach((event, index) => {
        expect(raw.data[index].realizedRate).not.toBe('');
        expect(event.settledRate).toBe(canonicalRate(raw.data[index].realizedRate));
        expect(event.forecastRate).toBe(canonicalRate(raw.data[index].fundingRate));
        expect(event).toMatchObject({ rateMeaning: 'exchange-realized-rate', reportedIntervalMs: null,
          method: 'current_period', formula: 'withRate' });
      });
    }
  });
  it('preserves exact fractional contract-to-base OI and separate reported USD valuation', () => {
    const expected = { BTC: '28255.5443000001206', ETH: '577517.98800000137' };
    for (const row of report.observations.filter(row => row.route.exchange === 'okx' && row.route.kind === 'open-interest')) {
      if (row.parsed.kind !== 'public-market-metrics') throw Error('fixture metrics type changed');
      expect(row.parsed.openInterestBase).toBe(expected[row.route.base]);
      expect(row.parsed.reportedOpenInterestBase).toBe(expected[row.route.base]);
      expect(row.parsed.openInterestBaseConsistency).toBe('matches');
      expect(row.parsed.openInterestUsd).not.toBeNull();
      expect(row.parsed.sourceFreshnessVerified).toBe(false);
    }
  });
  it('cannot promote the byte-valid recorded capture into book-comparison or execution readiness', () => {
    const altered = JSON.parse(archive.toString());
    altered.quality[0].usableForBookComparison = true;
    const changed = Buffer.from(JSON.stringify(altered) + '\n');
    expect(() => replayObservationArchive(changed, createHash('sha256').update(changed).digest('hex'))).toThrow();
  });
});
