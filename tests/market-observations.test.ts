import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSample, createRun, readReport, saveSample, startRun, summarize,
  type ObservationRun, type ObservationSample } from '../src/lab/observations.js';
import { LabError } from '../src/lab/order-book.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() {
  const parent = await mkdtemp(join(tmpdir(), 'crypto-observation-test-'));
  directories.push(parent);
  return join(parent, 'run');
}
function fixture(run: ObservationRun, sequence = 0): ObservationSample {
  const at = run.startedAt + sequence * 10_100;
  return { schema: 1, runId: run.runId, sequence, startedAt: at, checkedAt: at + 100,
    sources: [
      { venue: 'binance', available: true, book: { venue: 'binance', symbol: run.symbol,
        bids: [[99, 1]], asks: [[100, 1]], requestedAt: at, receivedAt: at + 100 } },
      { venue: 'bybit', available: true, book: { venue: 'bybit', symbol: run.symbol,
        bids: [[102, 1]], asks: [[103, 1]], requestedAt: at, receivedAt: at + 100, sourceAt: at } },
      { venue: 'okx', available: false, reason: 'public-http-403' }
    ] };
}

describe('durable, isolated observation runs', () => {
  it('roundtrips snapshots and recomputes the report; unavailable OKX is not a zero spread', async () => {
    const path = await directory();
    const run = createRun('test-host', 'BTC/USDT', .1, 2);
    await startRun(path, run);
    await saveSample(path, run, fixture(run));
    await saveSample(path, run, fixture(run, 1));
    const report = await readReport(path);
    expect(report.recordedSamples).toBe(2);
    expect(report.missingSequences).toEqual([]);
    expect(report.byVenue.okx).toMatchObject({ received: 0, failed: 2, failureReasons: { 'public-http-403': 2 } });
    expect(report.pairs['binance->bybit']).toMatchObject({ valid: 2, positive: 2, rejected: 0 });
    expect(report.pairs['binance->okx']).toMatchObject({ valid: 0, positive: 0, rejected: 2, bestNetBps: null });
    expect(report.byVenue.binance.sourceTimestampPresent).toBe(0);
    expect(report.longestStartGapMs).toBe(10_100);
    expect(report).not.toHaveProperty('profit');
    expect(JSON.parse(await readFile(join(path, '000.json'), 'utf8')).sources[0].book.asks).toEqual([[100, 1]]);
  });
  it('shows missing samples after an interrupted run, without pretending continuous coverage', () => {
    const run = createRun('test-host', 'BTC/USDT', .1, 3);
    const report = summarize(run, [fixture(run, 2), fixture(run)]);
    expect(report.missingSequences).toEqual([1]);
    expect(report.longestStartGapMs).toBe(20_200);
  });
  it('refuses existing directories and duplicate sample writes', async () => {
    const path = await directory(); const run = createRun('test-host');
    await startRun(path, run);
    await expect(startRun(path, run)).rejects.toThrow();
    await saveSample(path, run, fixture(run));
    await expect(saveSample(path, run, fixture(run))).rejects.toThrow();
  });
  it('rejects corrupted, oversized and symlinked evidence without echoing file contents', async () => {
    const path = await directory(); const run = createRun('test-host');
    await startRun(path, run);
    await writeFile(join(path, '000.json'), 'PRIVATE_SENTINEL');
    await expect(readReport(path)).rejects.toThrow(/^invalid-or-unreadable-observation-run$/);
    await writeFile(join(path, '000.json'), 'x'.repeat(100_001));
    await expect(readReport(path)).rejects.toThrow(/^invalid-or-unreadable-observation-run$/);
    await rm(join(path, '000.json'));
    await symlink(join(path, 'run.json'), join(path, '000.json'));
    await expect(readReport(path)).rejects.toThrow(/^invalid-or-unreadable-observation-run$/);
  });
  it('rejects duplicate sequence, different run, mixed symbols and incorrect source attribution', () => {
    const run = createRun('test-host');
    expect(() => summarize(run, [fixture(run), fixture(run)])).toThrow('duplicate');
    const other = fixture(createRun('test-host'));
    expect(() => summarize(run, [other])).toThrow('invalid-observation');
    const wrong = fixture(run);
    if (wrong.sources[0].available) wrong.sources[0].book.symbol = 'ETH/USDT';
    expect(() => summarize(run, [wrong])).toThrow('invalid-observation-book');
    const duplicateSource = fixture(run);
    duplicateSource.sources[2] = duplicateSource.sources[0];
    expect(() => summarize(run, [duplicateSource])).toThrow('invalid-observation');
  });
  it('counts a book received successfully but stale by comparison time separately', () => {
    const run = createRun('test-host'); const sample = fixture(run);
    sample.checkedAt += 5_000;
    const report = summarize(run, [sample]);
    expect(report.byVenue.binance).toMatchObject({ received: 1, freshAtComparison: 0 });
    expect(report.pairs['binance->bybit']).toMatchObject({ valid: 0, rejected: 1 });
  });
  it('bounds each run and rejects invalid cost assumptions', () => {
    expect(() => createRun('host', 'BTC/USDT', .1, 61)).toThrow();
    expect(() => createRun('host', 'BTC/USDT', .1, 2, 9999)).toThrow();
    expect(() => createRun('host', 'BTC/USDT', .1, 2, 10000, NaN)).toThrow();
  });
  it('records all source failures, including redaction of unexpected exception text', async () => {
    const run = createRun('test-host');
    const sample = await collectSample(run, 0, { getBook: async venue => {
      if (venue === 'okx') throw new LabError('public-http-403');
      throw new Error('PRIVATE_SENTINEL');
    } });
    expect(JSON.stringify(sample)).not.toContain('PRIVATE_SENTINEL');
    expect(summarize(run, [sample]).pairs['binance->bybit']).toMatchObject({ valid: 0, rejected: 1 });
  });
});
