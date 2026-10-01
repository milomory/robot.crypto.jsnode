import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPair, PAIR_DAY_PLAN } from '../src/paper-pair/capture.js';
import { parsePairInstrument, type PairVenue } from '../src/paper-pair/public.js';
import { reportPair, writePairReport } from '../src/paper-pair/report.js';
import { writeDayStudyReplayFile, writeReplayFile } from '../src/market-exact/archive.js';
import { canonical } from '../src/paper-v2/ledger.js';
import { T, fakeCaptureOptions, fees, rawInstrument } from './helpers/pair-fixtures.js';

const roots: string[] = [];
async function day(failedRefresh = false) {
  const root = await mkdtemp(join(tmpdir(), 'pair-day-report-test-')); roots.push(root);
  const directory = join(root, 'archive'), base = fakeCaptureOptions();
  const refreshCalls: Record<PairVenue, number> = { mexc: 0, okx: 0 };
  await collectPair(directory, { ...fees(), paymentModes: { observedAt: T, mexcMxDeduct: false, okxFeeType: '1' } }, {
    ...base, profile: 'study-24h', client: {
      ...base.client,
      getInstrument: async venue => {
        const index = refreshCalls[venue]++, original = await base.client.getInstrument(venue);
        if (failedRefresh && index === 1) throw new Error('PRIVATE_REFRESH_PAYLOAD');
        if (venue === 'mexc') return original;
        const raw = rawInstrument('okx');
        raw.data[0].maxMktAmt = index === 0 ? '1000000' : index === 1 ? '4' : index === 47 ? '3' : '2000000';
        return parsePairInstrument('okx', raw, original.requestedAt, original.receivedAt);
      },
      getUsdIndex: async () => {
        const requestedAt = base.clock(); await base.sleep(1);
        return { venue: 'okx', instrument: 'BTC-USD', requestedAt, receivedAt: base.clock(),
          sourceAt: requestedAt, usdPerBtc: '50000.000000000000000001' };
      }
    }
  });
  return { root, directory, refreshCalls, report: await reportPair(directory) };
}

type Day = Awaited<ReturnType<typeof day>>;
let complete: Day, failed: Day;
beforeAll(async () => { complete = await day(); failed = await day(true); }, 30_000);
afterAll(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function buyOkx(value: Day, sequence: number) {
  return value.report.observations[sequence].directions.find(row => row.buyVenue === 'okx')!;
}

describe('daily report refresh evidence and frozen fees', () => {
  it('accounts for all 1,440 minute slots and 48 metadata observations per venue', () => {
    expect(complete.report.plan).toEqual(PAIR_DAY_PLAN);
    expect(complete.refreshCalls).toEqual({ mexc: 48, okx: 48 });
    expect(complete.report.observations).toHaveLength(1440);
    expect(complete.report).toMatchObject({ executable: false, funding: 'synthetic', deterministicReplay: true,
      coverage: { scheduledPairs: 1440, availablePairs: 1440, unavailablePairs: 0, complete: true,
        sourceSynchronizationProven: false },
      counts: { directionalComparisons: 2880, positiveDirections: 1440, ruleEligibleDirections: 0, paperPairs: 0 },
      study: { metadataComplete: true, instrumentRefreshes: { scheduled: 48, availableMexc: 48, availableOkx: 48 },
        usdIndexCoverage: { scheduled: 1440, available: 1440, complete: true } } });
  });

  it('identifies the exact active metadata snapshot at refresh boundaries and the final slot', () => {
    for (const [sequence, metadataSourceSequence] of [[0, -1], [29, -1], [30, 30], [59, 30], [60, 60],
      [1409, 1380], [1410, 1410], [1439, 1410]]) {
      expect(complete.report.observations[sequence]).toMatchObject({ sequence, metadataSourceSequence });
    }
  });

  it('applies an updated USD cap immediately rather than reusing the initial metadata', () => {
    expect(buyOkx(complete, 29).usdLimits?.quote).toMatchObject({ maximumUsd: '1000000', status: 'within-model-cap' });
    for (const sequence of [30, 59]) {
      expect(buyOkx(complete, sequence).usdLimits?.quote).toMatchObject({ maximumUsd: '4', status: 'above-model-cap' });
      expect(buyOkx(complete, sequence).usdLimits?.okxReceivedBase).toMatchObject({ maximumUsd: '4', status: 'above-model-cap' });
      expect(buyOkx(complete, sequence).ruleReasons).toContain('okx:usd-model-limit-unavailable-or-exceeded');
    }
    expect(buyOkx(complete, 60).usdLimits?.quote).toMatchObject({ maximumUsd: '2000000', status: 'within-model-cap' });
  });

  it('uses fresh final metadata almost 24 hours after the initial snapshot', () => {
    const last = complete.report.observations[1439];
    expect(last.at - complete.report.period.startedAt).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(last.metadataSourceSequence).toBe(1410);
    for (const direction of last.directions) {
      expect(direction.usdLimit).toMatchObject({ maximumUsd: '3', status: 'above-model-cap', exchangeAdmissionProven: false });
      expect(direction.ruleReasons).not.toContain('okx:stale-instrument');
      expect(direction.ruleReasons).not.toContain('mexc:stale-instrument');
    }
    expect(buyOkx(complete, 1409).usdLimits?.quote).toMatchObject({ maximumUsd: '2000000', status: 'within-model-cap' });
    expect(buyOkx(complete, 1410).usdLimits?.quote).toMatchObject({ maximumUsd: '3', status: 'above-model-cap' });
  });

  it('retains initial instrumentEvidence instead of presenting final rules as initial evidence', () => {
    expect(complete.report.instrumentEvidence.okx).toMatchObject({ available: true,
      value: { evidence: { maxMktAmt: '1000000' }, requestedAt: T + 2, receivedAt: T + 3 } });
    expect(buyOkx(complete, 1439).usdLimit).toMatchObject({ maximumUsd: '3' });
  });

  it('labels initially observed tariffs as frozen sensitivity evidence and reports their full age', () => {
    expect(complete.report.study).toMatchObject({ feePolicy: 'initial-observed-fees-frozen-sensitivity-only',
      feeRatesContinuouslyVerified: false, settingsFrozenAtStart: true,
      maximumFeeEvidenceAgeMs: complete.report.period.endedAt - (T - 20), selectedFeeScenario: 'quote' });
    expect(complete.report.study!.maximumFeeEvidenceAgeMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(complete.report.feeEvidence.fees).toEqual(fees().fees);
    expect(buyOkx(complete, 1439).feeScenarios).toEqual(buyOkx(complete, 0).feeScenarios);
  });

  it('never promotes a positive frozen-fee sensitivity sample to a paper execution', () => {
    for (const observation of complete.report.observations) {
      expect(observation.paperDecision).toBe('rules-blocked');
      expect(observation.directions).toHaveLength(2);
      for (const direction of observation.directions) {
        expect(direction.ruleReasons).toContain('frozen-fees-sensitivity-only');
        expect(direction.ruleStatus).toBe('blocked');
        expect(direction.usdLimit?.exchangeAdmissionProven).toBe(false);
      }
    }
    expect(complete.report.journal).toEqual([]);
    expect(complete.report.paper.balances).toEqual(complete.report.opening);
    expect(complete.report.counts.paperPairs).toBe(0);
  });
});

describe('failed refresh remains visible until new evidence arrives', () => {
  it('makes metadata and aggregate coverage incomplete even when every market pair and index is present', () => {
    expect(failed.report).toMatchObject({ coverage: { scheduledPairs: 1440, availablePairs: 1440,
      unavailablePairs: 0, complete: false },
      study: { metadataComplete: false, instrumentRefreshes: { scheduled: 48, availableMexc: 47, availableOkx: 47 },
        usdIndexCoverage: { available: 1440, scheduled: 1440, complete: true } } });
    expect(failed.report.counts.directionalComparisons).toBe(2880);
  });

  it('replaces both active snapshots with failed refresh results and does not fall back', () => {
    expect(buyOkx(failed, 29).usdLimit).toMatchObject({ maximumUsd: '1000000', status: 'within-model-cap' });
    for (let sequence = 30; sequence < 60; sequence++) {
      const observation = failed.report.observations[sequence];
      expect(observation.metadataSourceSequence).toBe(30);
      for (const direction of observation.directions) {
        expect(direction.ruleReasons).toEqual(expect.arrayContaining(['mexc:missing-instrument', 'okx:missing-instrument',
          'frozen-fees-sensitivity-only']));
        expect(direction.usdLimits?.quote).toMatchObject({ status: 'unavailable', reason: 'missing-instrument' });
        expect(direction.usdLimits?.okxReceivedBase).toMatchObject({ status: 'unavailable', reason: 'missing-instrument' });
        expect(direction.usdLimit).not.toHaveProperty('maximumUsd');
      }
    }
    expect(canonical(failed.report)).not.toContain('PRIVATE_REFRESH_PAYLOAD');
  });

  it('recovers only when the next refresh succeeds while retaining the historical gap', () => {
    for (const sequence of [60, 61, 89]) {
      const observation = failed.report.observations[sequence];
      expect(observation.metadataSourceSequence).toBe(60);
      for (const direction of observation.directions) {
        expect(direction.ruleReasons).not.toContain('mexc:missing-instrument');
        expect(direction.ruleReasons).not.toContain('okx:missing-instrument');
        expect(direction.usdLimit).toMatchObject({ maximumUsd: '2000000', status: 'within-model-cap' });
      }
    }
    expect(failed.report.study!.metadataComplete).toBe(false);
    expect(failed.report.coverage.complete).toBe(false);
    expect(failed.report.observations[1439].metadataSourceSequence).toBe(1410);
  });
});

describe('bounded private daily report files', () => {
  it('replays the same archive deterministically without modifying the raw refresh sample', async () => {
    const sample = join(complete.directory, '030.json'), before = await readFile(sample);
    expect(canonical(await reportPair(complete.directory))).toBe(canonical(complete.report));
    expect(await readFile(sample)).toEqual(before);
  }, 15_000);

  it('writes the actual report over 2 MiB privately, and preserves it on a second write', async () => {
    const output = join(complete.root, 'report');
    const result = await writePairReport(complete.directory, output);
    const path = join(output, 'report.json'), bytes = await readFile(path);
    expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect((await lstat(output)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(bytes.toString('utf8')).toBe(canonical(complete.report) + '\n');
    expect(result).toMatchObject({ captureId: complete.report.captureId, archiveHash: complete.report.archiveHash,
      coverage: complete.report.coverage, counts: complete.report.counts });
    await expect(writePairReport(complete.directory, output)).rejects.toThrow();
    expect((await readFile(path)).equals(bytes)).toBe(true);
    expect(await readdir(output)).toEqual(['report.json']);
  }, 20_000);

  it('keeps the legacy 2 MiB writer limit instead of globally widening replay files', async () => {
    const path = join(complete.root, 'oversized-legacy.json');
    await expect(writeReplayFile(path, complete.report)).rejects.toThrow('archive-file-too-large');
    await expect(lstat(path)).rejects.toThrow();
  });

  it('rejects payloads exceeding the daily 16 MiB limit before creating any file', async () => {
    const path = join(complete.root, 'oversized-day.json'), before = await readdir(complete.root);
    await expect(writeDayStudyReplayFile(path, { payload: 'x'.repeat(16 * 1024 * 1024) })).rejects.toThrow('archive-file-too-large');
    await expect(lstat(path)).rejects.toThrow();
    expect(await readdir(complete.root)).toEqual(before);
  });
});
