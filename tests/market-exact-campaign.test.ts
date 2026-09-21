import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN, STUDY_PLAN, readCompleteArchive, writeArchiveFile, writeReplayFile } from '../src/market-exact/archive.js';
import { collectExact } from '../src/market-exact/collect.js';
import { buildObservedScenario, replayObservedTo } from '../src/market-exact/replay.js';
import { runOffline } from '../src/paper-v2/io.js';
import type { RawBook, RawInstrument } from '../src/market-exact/bybit.js';

const T = 8_000_000;
const roots: string[] = [];
let baseline: string;
async function destination() {
  const root = await mkdtemp(join(tmpdir(), 'crypto-exact-study-test-'));
  roots.push(root);
  return { root, archive: join(root, 'archive') };
}
function fixtures() {
  let now = T;
  const controller = new AbortController();
  const deps = {
    host: 'offline-study-fixture', clock: () => now,
    sleep: vi.fn(async (ms: number, _signal: AbortSignal) => { now += ms; }),
    client: {
      getInstrument: vi.fn(async (_signal?: AbortSignal): Promise<RawInstrument> => {
        const requestedAt = now; now += 20;
        return { venue: 'bybit', symbol: 'BTC/USDT', requestedAt, receivedAt: now, status: 'Trading',
          basePrecision: '0.000001000000000000', quotePrecision: '0.00000001', minOrderAmt: '5.000000000',
          maxMarketOrderQty: '100.000000000000', tickSize: '0.010000000000' };
      }),
      getBook: vi.fn(async (_signal?: AbortSignal): Promise<RawBook> => {
        const requestedAt = now; now += 20;
        return { venue: 'bybit', symbol: 'BTC/USDT', requestedAt, receivedAt: now,
          systemAt: now - 3, matchingAt: now - 5,
          bids: Array.from({ length: 50 }, (_, i) => [`${100000 - i}.123456780000000000`, '1.123456780000000000']),
          asks: Array.from({ length: 50 }, (_, i) => [`${100002 + i}.123456780000000000`, '1.123456780000000000']) };
      })
    }
  };
  return { controller, deps, advance: (ms: number) => { now += ms; } };
}
async function clone() {
  const where = await destination();
  await cp(baseline, where.archive, { recursive: true });
  return where;
}
async function mutate(path: string, change: (data: any) => void) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  change(data);
  await writeFile(path, JSON.stringify(data));
}
beforeAll(async () => {
  const where = await destination(), f = fixtures();
  baseline = where.archive;
  await collectExact(baseline, f.controller.signal, f.deps, STUDY_PLAN);
});
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected-network'); }); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

describe('fixed 30-minute exact study', () => {
  it('captures the whole 60-sample fixed schedule and stops without retry or continuation', async () => {
    const { archive } = await destination(), f = fixtures();
    const originalBook = f.deps.client.getBook.getMockImplementation()!;
    f.deps.client.getBook.mockImplementation(async signal => {
      if (f.deps.client.getBook.mock.calls.length === 1) {
        const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'));
        expect(manifest.plan).toEqual(STUDY_PLAN);
      }
      return originalBook(signal);
    });
    expect(await collectExact(archive, f.controller.signal, f.deps, STUDY_PLAN)).toMatchObject({ recorded: 60, status: 'completed' });
    const saved = await readCompleteArchive(archive);
    expect(saved.manifest.plan).toEqual({ policy: 'fixed-study-30m-v1', samples: 60,
      intervalMs: 30000, maxDurationMs: 1800000, openingUSDT: '1000', buyQuantityBTC: '0.001',
      sellSequence: 30, sellQuantityBTC: '0.0004', feeBps: 10, slippageBps: 5,
      comparisonPolicy: 'lagged-sma-3-6-v1' });
    expect(saved.samples.map(s => s.sequence)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(saved.samples.map(s => s.startedAt)).toEqual(Array.from({ length: 60 }, (_, i) => T + (i ? i * 30000 : 20)));
    expect(saved.state).toMatchObject({ deadlineAt: T + 1800000, endedAt: T + 1770020, status: 'completed' });
    expect(f.deps.client.getInstrument).toHaveBeenCalledTimes(1);
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(60);
    expect(await readdir(archive)).toHaveLength(62);
    expect(saved.samples[59]).toMatchObject({ available: true,
      book: { bids: expect.arrayContaining([['100000.123456780000000000', '1.123456780000000000']]) } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still collects exactly the unchanged six-sample probe when no profile is given', async () => {
    const { archive } = await destination(), f = fixtures();
    expect(await collectExact(archive, f.controller.signal, f.deps)).toMatchObject({ recorded: 6, status: 'completed' });
    const saved = await readCompleteArchive(archive);
    expect(saved.manifest.plan).toEqual(PLAN);
    expect(saved.state.deadlineAt).toBe(T + 180000);
    expect(saved.samples).toHaveLength(6);
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(6);
  });

  it('rejects arbitrary tuning before creating any evidence or issuing requests', async () => {
    const { root, archive } = await destination(), f = fixtures();
    const invalid = { ...STUDY_PLAN, samples: 61 } as unknown as typeof STUDY_PLAN;
    await expect(collectExact(archive, f.controller.signal, f.deps, invalid)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    expect(f.deps.client.getInstrument).not.toHaveBeenCalled();
    expect(f.deps.client.getBook).not.toHaveBeenCalled();
  });

  it.each(['missed slot', 'overall deadline'] as const)('stops at %s without catch-up requests', async boundary => {
    const { archive } = await destination(), f = fixtures();
    f.deps.sleep.mockImplementation(async ms => { f.advance(ms + (boundary === 'missed slot' ? 30000 : 1800000)); });
    expect(await collectExact(archive, f.controller.signal, f.deps, STUDY_PLAN)).toMatchObject({ recorded: 1, status: 'stopped' });
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(1);
    await expect(readCompleteArchive(archive)).rejects.toThrow(/^incomplete-or-invalid-exact-archive$/);
  });

  it.each(['deadline', 'cancellation'] as const)('does not complete when the last request crosses %s', async boundary => {
    const { archive } = await destination(), f = fixtures();
    const original = f.deps.client.getBook.getMockImplementation()!;
    let count = 0;
    f.deps.client.getBook.mockImplementation(async signal => {
      const book = await original(signal);
      if (++count === 60) {
        if (boundary === 'deadline') f.advance(31000);
        else f.controller.abort();
      }
      return book;
    });
    expect(await collectExact(archive, f.controller.signal, f.deps, STUDY_PLAN)).toMatchObject({ recorded: 60, status: 'stopped' });
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(60);
    await expect(readCompleteArchive(archive)).rejects.toThrow(/^incomplete-or-invalid-exact-archive$/);
  });

  it('retains all scheduled unavailable samples while a client cooldown is active; replay cannot select a successful subset', async () => {
    const { root, archive } = await destination(), f = fixtures();
    const original = f.deps.client.getBook.getMockImplementation()!;
    f.deps.client.getBook.mockImplementation(async signal => {
      if (f.deps.clock() >= T + 30000 && f.deps.clock() < T + 90000) throw new Error('rate-limit-private-body');
      return original(signal);
    });
    expect(await collectExact(archive, f.controller.signal, f.deps, STUDY_PLAN)).toMatchObject({ recorded: 60, status: 'completed' });
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(60);
    for (const filename of ['001.json', '002.json']) {
      const bytes = await readFile(join(archive, filename), 'utf8');
      expect(JSON.parse(bytes)).toMatchObject({ available: false, reason: 'public-book-unavailable' });
      expect(bytes).not.toContain('private-body');
    }
    expect(await readdir(archive)).toHaveLength(62);
    await expect(replayObservedTo(archive, join(root, 'partial-result'))).rejects.toThrow();
    expect(await readdir(root)).not.toContain('partial-result');
  });

  it.each([
    ['missing middle sample', async (dir: string) => { await unlink(join(dir, '030.json')); }],
    ['missing last sample', async (dir: string) => { await unlink(join(dir, '059.json')); }],
    ['extra sample outside fixed period', async (dir: string) => { await writeFile(join(dir, '060.json'), '{}'); }],
    ['altered sample count', async (dir: string) => { await mutate(join(dir, 'manifest.json'), s => { s.plan.samples = 59; }); }],
    ['altered comparison policy', async (dir: string) => { await mutate(join(dir, 'manifest.json'), s => { s.plan.comparisonPolicy = 'future-sma'; }); }],
    ['unknown plan parameter', async (dir: string) => { await mutate(join(dir, 'manifest.json'), s => { s.plan.retry = true; }); }],
    ['future last receipt', async (dir: string) => { await mutate(join(dir, '059.json'), s => { s.book.receivedAt = s.checkedAt + 1; }); }],
    ['end before last sample', async (dir: string) => { await mutate(join(dir, 'state.json'), s => { s.endedAt = s.updatedAt = T + 1700000; }); }],
    ['failed series state', async (dir: string) => { await mutate(join(dir, 'state.json'), s => { s.status = 'failed'; }); }],
    ['downgraded study plan', async (dir: string) => { await mutate(join(dir, 'manifest.json'), s => { s.plan = PLAN; }); }]
  ] as const)('refuses %s instead of truncating or choosing another window', async (_name, change) => {
    const { archive } = await clone();
    await change(archive);
    await expect(readCompleteArchive(archive)).rejects.toThrow(/^incomplete-or-invalid-exact-archive$/);
  });

  it('bridges all 60 samples with fixed intents and reproduces outputs larger than one raw snapshot', async () => {
    const { root, archive } = await clone();
    const scenario = await buildObservedScenario(archive);
    expect(scenario).toMatchObject({ schema: 2, funding: 'synthetic', marketData: { policy: 'fixed-study-30m-v1' } });
    expect(scenario.steps).toHaveLength(60);
    expect(scenario.steps.flatMap((step, i) => step.intent ? [[i, step.intent]] : [])).toEqual([
      [0, { side: 'buy', quantity: '0.001' }], [30, { side: 'sell', quantity: '0.0004' }]
    ]);
    const converted = join(root, 'converted'), independent = join(root, 'independent');
    await replayObservedTo(archive, converted);
    const scenarioBytes = await readFile(join(converted, 'scenario.json'));
    expect(scenarioBytes.byteLength).toBeGreaterThan(128 * 1024);
    expect(scenarioBytes.byteLength).toBeLessThan(2 * 1024 * 1024);
    await runOffline(join(converted, 'scenario.json'), independent);
    const first = await readFile(join(converted, 'result.json'));
    expect(await readFile(join(independent, 'result.json'))).toEqual(first);
    expect(JSON.parse(first.toString('utf8')).provenance.sourceFileSha256)
      .toBe(createHash('sha256').update(scenarioBytes).digest('hex'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps raw snapshot size limits while bounding larger replay publication', async () => {
    const { root } = await destination();
    const data = { payload: 'x'.repeat(130 * 1024) };
    await expect(writeArchiveFile(join(root, 'raw.json'), data)).rejects.toThrow('archive-file-too-large');
    await writeReplayFile(join(root, 'replay.json'), data);
    await expect(writeReplayFile(join(root, 'replay.json'), data)).rejects.toThrow();
    await expect(writeReplayFile(join(root, 'huge.json'), { payload: 'x'.repeat(2 * 1024 * 1024) }))
      .rejects.toThrow('archive-file-too-large');
    expect(await readdir(root)).not.toContain('raw.json');
    expect(await readdir(root)).not.toContain('huge.json');
  });
});
