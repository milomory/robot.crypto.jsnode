import { join } from 'node:path';
import { hostname } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { atomicJson, enforceRetention, lockStore, publishRun, type Collection } from './observation-store.js';
import { createRun, collectSample, saveSample, startRun } from './observations.js';
import { PublicBookClient } from './public-books.js';
import { fetchInstruments } from './instruments.js';

export const CAMPAIGN = { samples: 30, intervalMs: 60_000, durationMs: 30 * 60_000 } as const;
interface Dependencies {
  client: Pick<PublicBookClient, 'getBook'>;
  instruments: typeof fetchInstruments;
  clock: () => number;
  sleep: (ms: number, abort: AbortSignal) => Promise<void>;
}
export async function runCampaign(root: string, signal: AbortSignal, dependencies: Dependencies = {
  client: new PublicBookClient(), instruments: fetchInstruments, clock: Date.now,
  sleep: async (ms: number, abort: AbortSignal) => { await setTimeout(ms, undefined, { signal: abort }); }
}) {
  const release = await lockStore(root);
  let directory: string | undefined;
  let state: Collection | undefined;
  try {
    const retention = await enforceRetention(root, dependencies.clock());
    const run = createRun(hostname(), 'BTC/USDT', .0001, CAMPAIGN.samples, CAMPAIGN.intervalMs);
    run.startedAt = dependencies.clock();
    run.instruments = await dependencies.instruments(run.symbol);
    directory = join(root, 'runs', run.runId);
    await startRun(directory, run);
    state = { schema: 1, runId: run.runId, state: 'running',
      deadlineAt: run.startedAt + CAMPAIGN.durationMs, updatedAt: dependencies.clock() };
    await atomicJson(join(directory, 'collection.json'), state);
    await publishRun(root, run.runId);
    let recorded = 0;
    for (let sequence = 0; sequence < run.samples; sequence++) {
      const due = run.startedAt + sequence * run.intervalMs;
      if (signal.aborted || dependencies.clock() >= state.deadlineAt) break;
      if (dependencies.clock() < due) await dependencies.sleep(due - dependencies.clock(), signal);
      if (signal.aborted || dependencies.clock() >= state.deadlineAt) break;
      // No rapid catch-up bursts after a stalled process or a large clock jump.
      if (dependencies.clock() >= due + run.intervalMs) break;
      await saveSample(directory, run, await collectSample(run, sequence, dependencies.client, dependencies.clock));
      recorded++;
      state.updatedAt = dependencies.clock();
      await atomicJson(join(directory, 'collection.json'), state, true);
    }
    state.state = recorded === run.samples ? 'completed' : 'stopped';
    state.endedAt = state.updatedAt = dependencies.clock();
    await atomicJson(join(directory, 'collection.json'), state, true);
    return { runId: run.runId, recorded, state: state.state, retention };
  } catch (error) {
    if (state && directory) {
      state.state = signal.aborted ? 'stopped' : 'failed';
      state.endedAt = state.updatedAt = dependencies.clock();
      await atomicJson(join(directory, 'collection.json'), state, true);
    }
    if (!signal.aborted) throw error;
    return { state: 'stopped' };
  } finally { await release(); }
}
