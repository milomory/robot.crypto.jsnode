import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectExact } from '../src/market-exact/collect.js';
import { PLAN, readCompleteArchive } from '../src/market-exact/archive.js';
import { buildObservedScenario, replayObservedTo } from '../src/market-exact/replay.js';
import type { RawBook, RawInstrument } from '../src/market-exact/bybit.js';

const T = 5_000_000;
const roots: string[] = [];
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected-network'); }); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function destination() {
  const root = await mkdtemp(join(tmpdir(), 'crypto-exact-capture-test-')); roots.push(root);
  return { root, archive: join(root, 'archive') };
}
function fixtures() {
  let now = T;
  const controller = new AbortController();
  const deps = {
    host: 'offline-fixture', clock: () => now,
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
          bids: [['100000.120000000000', '1.000000000000']],
          asks: [['100001.230000000000', '1.000000000000']] };
      }),
    },
  };
  return { deps, controller, advance: (ms: number) => { now += ms; } };
}
async function completed() {
  const where = await destination(), f = fixtures();
  await collectExact(where.archive, f.controller.signal, f.deps);
  return { ...where, ...f };
}
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
async function mutate(path: string, change: (data: any) => void) {
  const data = await json(path); change(data); await writeFile(path, JSON.stringify(data));
}

describe('bounded public decimal capture', () => {
  it('records all six original-decimal books on the fixed schedule with no network', async () => {
    const { archive } = await destination(), f = fixtures();
    const result = await collectExact(archive, f.controller.signal, f.deps);
    expect(result).toMatchObject({ recorded: 6, status: 'completed' });
    const saved = await readCompleteArchive(archive);
    expect(saved.manifest.plan).toEqual({ policy: 'fixed-probe-v1', samples: 6, intervalMs: 30_000,
      maxDurationMs: 180_000, openingUSDT: '1000', buyQuantityBTC: '0.001', sellSequence: 3,
      sellQuantityBTC: '0.0004', feeBps: 10, slippageBps: 5 });
    expect(saved.samples.map(s => s.startedAt)).toEqual([T + 20, T + 30_000, T + 60_000,
      T + 90_000, T + 120_000, T + 150_000]);
    expect(saved.state).toMatchObject({ status: 'completed', deadlineAt: T + 180_000,
      endedAt: T + 150_020, updatedAt: T + 150_020 });
    expect(saved.samples[0]).toMatchObject({ available: true,
      book: { bids: [['100000.120000000000', '1.000000000000']] } });
    expect(f.deps.client.getInstrument).toHaveBeenCalledTimes(1);
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(6);
    expect(f.deps.sleep.mock.calls.map(c => c[0])).toEqual([29_960, 29_980, 29_980, 29_980, 29_980]);
    expect(await readdir(archive)).toHaveLength(8);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an existing directory before instrument or book calls', async () => {
    const { archive } = await destination(), f = fixtures(); await mkdir(archive);
    await writeFile(join(archive, 'user-file'), 'keep');
    await expect(collectExact(archive, f.controller.signal, f.deps)).rejects.toThrow();
    expect(f.deps.client.getInstrument).not.toHaveBeenCalled();
    expect(f.deps.client.getBook).not.toHaveBeenCalled();
    expect(await readFile(join(archive, 'user-file'), 'utf8')).toBe('keep');
  });

  it('stops a cancelled wait and retains its single sample', async () => {
    const { archive } = await destination(), f = fixtures();
    f.deps.sleep.mockImplementation(async () => { f.controller.abort(); throw new Error('cancelled'); });
    expect(await collectExact(archive, f.controller.signal, f.deps)).toMatchObject({ recorded: 1, status: 'stopped' });
    expect(await json(join(archive, 'state.json'))).toMatchObject({ status: 'stopped' });
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(1);
    expect(await readdir(archive)).toContain('000.json');
    await expect(readCompleteArchive(archive)).rejects.toThrow('incomplete-or-invalid-exact-archive');
  });

  it.each([['missed-slot', 30_000], ['deadline', 180_000]] as const)('stops after %s with no catch-up requests', async (_name, jump) => {
    const { archive } = await destination(), f = fixtures();
    f.deps.sleep.mockImplementation(async ms => { f.advance(ms + jump); });
    expect(await collectExact(archive, f.controller.signal, f.deps)).toMatchObject({ recorded: 1, status: 'stopped' });
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(1);
    await expect(readCompleteArchive(archive)).rejects.toThrow('incomplete-or-invalid-exact-archive');
  });

  it.each(['deadline', 'cancellation'] as const)('does not report completion when the final request crosses %s', async boundary => {
    const { archive } = await destination(), f = fixtures();
    const originalBook = f.deps.client.getBook.getMockImplementation()!;
    let calls = 0;
    f.deps.client.getBook.mockImplementation(async signal => {
      const result = await originalBook(signal);
      if (++calls === 6) {
        if (boundary === 'deadline') f.advance(31_000);
        else f.controller.abort();
      }
      return result;
    });
    expect(await collectExact(archive, f.controller.signal, f.deps)).toMatchObject({ recorded: 6, status: 'stopped' });
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(6);
    expect((await readdir(archive)).filter(name => /^\d{3}\.json$/.test(name))).toHaveLength(6);
    const state = await json(join(archive, 'state.json'));
    expect(state.status).toBe('stopped');
    if (boundary === 'deadline') expect(state.endedAt).toBeGreaterThan(state.deadlineAt);
    const requestSignal = f.deps.client.getBook.mock.calls[5][0];
    expect(requestSignal).not.toBe(f.controller.signal);
    if (boundary === 'cancellation') expect(requestSignal?.aborted).toBe(true);
    await expect(readCompleteArchive(archive)).rejects.toThrow('incomplete-or-invalid-exact-archive');
  });

  it('starts no request when cancellation already exists', async () => {
    const { archive } = await destination(), f = fixtures(); f.controller.abort();
    expect(await collectExact(archive, f.controller.signal, f.deps)).toMatchObject({ recorded: 0, status: 'stopped' });
    expect(f.deps.client.getInstrument).not.toHaveBeenCalled();
    expect(f.deps.client.getBook).not.toHaveBeenCalled();
    expect(await json(join(archive, 'state.json'))).toMatchObject({ status: 'stopped' });
  });

  it('retains a failed sample without persisting exception text or cherry-picking a replay', async () => {
    const { archive, root } = await destination(), f = fixtures();
    f.deps.client.getBook.mockRejectedValueOnce(new Error('private-response-body-cookie-marker'));
    expect(await collectExact(archive, f.controller.signal, f.deps)).toMatchObject({ recorded: 6, status: 'completed' });
    const failed = await readFile(join(archive, '000.json'), 'utf8');
    expect(JSON.parse(failed)).toMatchObject({ available: false, sequence: 0, reason: 'public-book-unavailable' });
    expect(failed).not.toContain('private-response');
    expect(f.deps.client.getBook).toHaveBeenCalledTimes(6);
    await expect(readCompleteArchive(archive)).rejects.toThrow('incomplete-or-invalid-exact-archive');
    await expect(replayObservedTo(archive, join(root, 'invalid-result'))).rejects.toThrow();
    expect(await readdir(root)).not.toContain('invalid-result');
  });

  it('retains failed state after metadata failure and makes no book requests', async () => {
    const { archive } = await destination(), f = fixtures();
    f.deps.client.getInstrument.mockRejectedValueOnce(new Error('private-metadata-body-marker'));
    await expect(collectExact(archive, f.controller.signal, f.deps)).rejects.toThrow(/^exact-capture-failed$/);
    const state = await readFile(join(archive, 'state.json'), 'utf8');
    expect(JSON.parse(state)).toMatchObject({ status: 'failed', endedAt: T });
    expect(state).not.toContain('private-metadata');
    expect(f.deps.client.getBook).not.toHaveBeenCalled();
    expect(await readdir(archive)).toEqual(['state.json']);
    await expect(readCompleteArchive(archive)).rejects.toThrow('incomplete-or-invalid-exact-archive');
  });
});

describe('complete archive validation and observed replay bridge', () => {
  it.each([
    ['missing sample', async (dir: string) => { await unlink(join(dir, '001.json')); }],
    ['extra file', async (dir: string) => { await writeFile(join(dir, 'extra.json'), '{}'); }],
    ['symlinked sample', async (dir: string) => { await unlink(join(dir, '002.json')); await symlink(join(dir, '001.json'), join(dir, '002.json')); }],
    ['sequence mismatch', async (dir: string) => { await mutate(join(dir, '001.json'), s => { s.sequence = 0; }); }],
    ['sample id mismatch', async (dir: string) => { await mutate(join(dir, '001.json'), s => { s.captureId = randomUUID(); }); }],
    ['state id mismatch', async (dir: string) => { await mutate(join(dir, 'state.json'), s => { s.captureId = randomUUID(); }); }],
    ['unfinished state', async (dir: string) => { await mutate(join(dir, 'state.json'), s => { s.status = 'running'; }); }],
    ['altered plan', async (dir: string) => { await mutate(join(dir, 'manifest.json'), s => { s.plan.sellSequence = 4; }); }],
    ['altered deadline', async (dir: string) => { await mutate(join(dir, 'state.json'), s => { s.deadlineAt++; }); }],
    ['past deadline', async (dir: string) => { await mutate(join(dir, 'state.json'), s => { s.endedAt = s.updatedAt = s.deadlineAt + 1; }); }],
    ['early sample', async (dir: string) => { await mutate(join(dir, '001.json'), s => { s.startedAt = T + 29_999; }); }],
    ['late sample', async (dir: string) => { await mutate(join(dir, '001.json'), s => { s.startedAt = T + 60_000; }); }],
    ['book preceding sample', async (dir: string) => { await mutate(join(dir, '001.json'), s => { s.book.requestedAt = s.startedAt - 1; }); }],
    ['reversed local receipt time', async (dir: string) => { await mutate(join(dir, '001.json'), s => { s.book.receivedAt = s.book.requestedAt - 1; }); }],
    ['future receipt', async (dir: string) => { await mutate(join(dir, '001.json'), s => { s.book.receivedAt = s.checkedAt + 1; }); }],
    ['wrong metadata chronology', async (dir: string) => { await mutate(join(dir, 'manifest.json'), s => { s.instrument.requestedAt = s.instrument.receivedAt + 1; }); }],
  ] as const)('rejects %s with a fixed generic error', async (_name, corrupt) => {
    const { archive } = await completed(); await corrupt(archive);
    await expect(readCompleteArchive(archive)).rejects.toThrow(/^incomplete-or-invalid-exact-archive$/);
  });

  it('refuses a symlinked archive directory', async () => {
    const { root, archive } = await completed(), linked = join(root, 'linked');
    await symlink(archive, linked);
    await expect(readCompleteArchive(linked)).rejects.toThrow('incomplete-or-invalid-exact-archive');
  });

  it('converts the full window with fixed intents and explicit observed-price/synthetic-funding provenance', async () => {
    const { archive } = await completed();
    const scenario = await buildObservedScenario(archive);
    expect(scenario).toMatchObject({ schema: 2, funding: 'synthetic', opening: { BTC: '0', USDT: '1000' },
      marketData: { kind: 'public-decimal-observations', schema: 1, policy: 'fixed-probe-v1' },
      costs: { feeBps: 10, slippageBps: 5, feeAsset: 'USDT' }, benchmark: { buyQuantityBTC: '0.001' } });
    expect(scenario.steps).toHaveLength(6);
    expect(scenario.steps.map(s => s.at)).toEqual([T + 40, T + 30_020, T + 60_020,
      T + 90_020, T + 120_020, T + 150_020]);
    expect(scenario.steps.map(s => s.intent ?? null)).toEqual([{ side: 'buy', quantity: '0.001' }, null, null,
      { side: 'sell', quantity: '0.0004' }, null, null]);
    expect(scenario.steps[0].book?.bids).toEqual([['100000.12', '1']]);
    expect(await buildObservedScenario(archive)).toEqual(scenario);
  });

  it('produces byte-identical replays and matching scenario provenance without network', async () => {
    const { archive, root } = await completed(), a = join(root, 'a'), b = join(root, 'b');
    const names = (await readdir(archive)).sort();
    const originalArchive = await Promise.all(names.map(name => readFile(join(archive, name), 'utf8')));
    const first = await replayObservedTo(archive, a), second = await replayObservedTo(archive, b);
    expect(second).toEqual(first);
    const scenarioBytes = await readFile(join(a, 'scenario.json'));
    const resultBytes = await readFile(join(a, 'result.json'));
    expect(await readFile(join(b, 'scenario.json'))).toEqual(scenarioBytes);
    expect(await readFile(join(b, 'result.json'))).toEqual(resultBytes);
    const result = JSON.parse(resultBytes.toString('utf8'));
    expect(result).toMatchObject({ schema: 2, funding: 'synthetic',
      comparison: { comparable: true, sameStartingBalances: true, sameValuationSchedule: true },
      provenance: { sourceFileSha256: createHash('sha256').update(scenarioBytes).digest('hex') } });
    expect(result.marketData.datasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provenance.inputHash).toBe(result.inputHash);
    await expect(replayObservedTo(archive, a)).rejects.toThrow();
    expect(await readFile(join(a, 'result.json'))).toEqual(resultBytes);
    expect((await readdir(archive)).sort()).toEqual(names);
    expect(await Promise.all(names.map(name => readFile(join(archive, name), 'utf8')))).toEqual(originalArchive);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects stale or irreducibly precise raw books instead of dropping or rounding a sample', async () => {
    const { archive, root } = await completed();
    await mutate(join(archive, '002.json'), s => { s.book.matchingAt = s.book.receivedAt - 5001; });
    await expect(replayObservedTo(archive, join(root, 'stale-result'))).rejects.toThrow();
    expect(await readdir(root)).not.toContain('stale-result');
    await mutate(join(archive, '002.json'), s => {
      s.book.matchingAt = s.book.receivedAt - 5;
      s.book.bids[0][0] = '100000.120000001';
    });
    await expect(replayObservedTo(archive, join(root, 'precision-result'))).rejects.toThrow();
    expect(await readdir(root)).not.toContain('precision-result');
  });

  it('changes dataset identity if any retained sample changes', async () => {
    const { archive } = await completed();
    const initial = await buildObservedScenario(archive);
    await mutate(join(archive, '004.json'), s => { s.book.bids[0][0] = '100000.130000000000'; });
    const changed = await buildObservedScenario(archive);
    expect(changed.steps).toHaveLength(PLAN.samples);
    expect(changed).not.toEqual(initial);
    if (initial.schema !== 2 || changed.schema !== 2) throw new Error('wrong fixture schema');
    expect(changed.marketData.datasetHash).not.toBe(initial.marketData.datasetHash);
  });
});
