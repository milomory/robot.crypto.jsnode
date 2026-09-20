import { mkdtemp, rm, readdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initStore, lockStore, enforceRetention, atomicJson, readJson, publishRun } from '../src/lab/observation-store.js';
import { createRun, startRun, readReport } from '../src/lab/observations.js';
import { runCampaign, CAMPAIGN } from '../src/lab/campaign.js';
import type { Instruments } from '../src/lab/instruments.js';
import type { Venue } from '../src/lab/order-book.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store() {
  const parent = await mkdtemp(join(tmpdir(), 'crypto-campaign-test-')); roots.push(parent);
  const root = join(parent, 'store'); await initStore(root); return root;
}
async function history(root: string, state: 'completed' | 'running', ageDays: number) {
  const run = createRun('test'); run.startedAt = Date.now() - ageDays * 86_400_000;
  const path = join(root, 'runs', run.runId); await startRun(path, run);
  await atomicJson(join(path, 'collection.json'), { schema: 1, runId: run.runId, state,
    deadlineAt: run.startedAt + 1_800_000, updatedAt: run.startedAt,
    ...(state === 'completed' ? { endedAt: run.startedAt + 1000 } : {}) });
  return run.runId;
}
function dependencies() {
  let time = Date.now();
  let requests = 0;
  const controller = new AbortController();
  const deps = {
    clock: () => time,
    instruments: async (): Promise<Instruments> => Object.fromEntries(['binance', 'bybit', 'okx'].map(venue => [venue, {
      available: true, instrument: { venue, symbol: 'BTC/USDT', fetchedAt: time, trading: true,
        lots: [{ min: '0.00001', max: '10', step: '0.00001' }], minQuote: '5', notionalReference: 'snapshot-estimate' }
    }])) as Instruments,
    sleep: async (ms: number, _abort: AbortSignal) => { time += ms; },
    client: { getBook: async (venue: Venue, symbol: string) => {
      requests++;
      return { venue, symbol, requestedAt: time, receivedAt: time, sourceAt: time,
        bids: [[80000, 1] as const], asks: [[80001, 1] as const] };
    } }
  };
  return { deps, controller, requests: () => requests, jump: (ms: number) => { time += ms; } };
}

describe('bounded campaign and retention', () => {
  it('finishes exactly30 samples on schedule, persists complete evidence, releases its lock', async () => {
    const root = await store(), f = dependencies();
    const result = await runCampaign(root, f.controller.signal, f.deps);
    expect(result).toMatchObject({ recorded: 30, state: 'completed' });
    expect(f.requests()).toBe(90);
    const report = await readReport(root);
    expect(report.recordedSamples).toBe(30);
    expect(report.missingSequences).toEqual([]);
    expect(report.longestStartGapMs).toBe(60_000);
    expect(report.collection?.state).toBe('completed');
    expect(report.pairs['binance->bybit'].sizeChecked).toBe(30);
    expect(await readdir(root)).not.toContain('writer.lock');
  });
  it('preserves a partial series on cancellation and records a stopped state', async () => {
    const root = await store(), f = dependencies();
    f.deps.sleep = async () => { f.controller.abort(); throw new Error('aborted'); };
    await runCampaign(root, f.controller.signal, f.deps);
    const report = await readReport(root);
    expect(report.recordedSamples).toBe(1);
    expect(report.collection?.state).toBe('stopped');
    expect(await readdir(root)).not.toContain('writer.lock');
  });
  it('stops at deadline and never catches up with a burst after a clock jump', async () => {
    for (const jump of [CAMPAIGN.durationMs, 3 * CAMPAIGN.intervalMs]) {
      const root = await store(), f = dependencies();
      f.deps.sleep = async () => { f.jump(jump); };
      expect(await runCampaign(root, f.controller.signal, f.deps)).toMatchObject({ recorded: 1, state: 'stopped' });
      expect(f.requests()).toBe(3);
    }
  });
  it('records failures, releases lock, and refuses a second writer', async () => {
    const root = await store(), f = dependencies();
    const release = await lockStore(root);
    await expect(runCampaign(root, f.controller.signal, f.deps)).rejects.toThrow();
    expect(f.requests()).toBe(0); await release();
    f.deps.sleep = async () => { throw new Error('disk-independent failure'); };
    await expect(runCampaign(root, f.controller.signal, f.deps)).rejects.toThrow();
    expect((await readReport(root)).collection?.state).toBe('failed');
  });
  it('removes only expired completed evidence and protects current, running and recent runs', async () => {
    const root = await store();
    const expired = await history(root, 'completed', 9);
    const current = await history(root, 'completed', 10);
    const active = await history(root, 'running', 11);
    const recent = await history(root, 'completed', 1);
    await publishRun(root, current);
    const result = await enforceRetention(root);
    expect(result.removed).toEqual([expired]);
    expect((await readdir(join(root, 'runs'))).sort()).toEqual([current, active, recent].sort());
    expect((await readReport(root)).collection?.state).toBe('completed');
  });
  it('refuses unknown files or symlinks before deleting any expired run', async () => {
    const root = await store(); const old = await history(root, 'completed', 9);
    const unknown = join(root, 'runs', old, 'user-notes.txt'); await writeFile(unknown, 'user work');
    await expect(enforceRetention(root)).rejects.toThrow('unknown-observation-file');
    expect(await readdir(join(root, 'runs'))).toContain(old);
    await rm(unknown);
    await symlink(join(root, 'store.json'), join(root, 'runs', old, '000.json'));
    await expect(enforceRetention(root)).rejects.toThrow('invalid-observation-file');
    expect(await readdir(join(root, 'runs'))).toContain(old);
  });
  it('stops at storage/run limits without deleting recent evidence', async () => {
    const root = await store(); const fresh = await history(root, 'completed', 1);
    await expect(enforceRetention(root, Date.now(), 100_000_000)).rejects.toThrow('observation-storage-full');
    expect(await readdir(join(root, 'runs'))).toContain(fresh);
    for (let i = 1; i < 20; i++) await history(root, 'completed', 1);
    await expect(enforceRetention(root)).rejects.toThrow('observation-storage-full');
    expect((await readdir(join(root, 'runs'))).length).toBe(20);
  });
  it('keeps final names exclusive and replaces control JSON atomically', async () => {
    const root = await store(), path = join(root, 'test.json');
    await atomicJson(path, { first: true });
    await expect(atomicJson(path, { second: true })).rejects.toThrow();
    expect(await readJson(path)).toEqual({ first: true });
    await atomicJson(path, { second: true }, true);
    expect(await readJson(path)).toEqual({ second: true });
    expect((await readdir(root)).some(name => name.includes('.tmp-'))).toBe(false);
    await expect(atomicJson(path, 'x'.repeat(100_001), true)).rejects.toThrow('observation-file-too-large');
  });
  it('rejects pointer traversal and labels an abandoned active collection interrupted', async () => {
    const root = await store(); const id = await history(root, 'running', 1);
    await publishRun(root, id);
    expect((await readReport(root)).collection?.state).toBe('interrupted');
    await atomicJson(join(root, 'current.json'), { schema: 1, runId: '../outside' }, true);
    await expect(readReport(root)).rejects.toThrow('invalid-or-unreadable-observation-run');
  });
});
