import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ExactBybitClient } from './bybit.js';
import { PaperError } from '../paper-v2/exact.js';
import { newArchive, writeArchiveFile, manifestSchema, sampleSchema, PLAN, type State } from './archive.js';

interface Dependencies { client: Pick<ExactBybitClient, 'getBook' | 'getInstrument'>;
  clock: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void>; host: string }
export async function collectExact(directory: string, signal: AbortSignal, dependencies: Dependencies = {
  client: new ExactBybitClient(), clock: Date.now, host: hostname(),
  sleep: async (ms, signal) => { await sleep(ms, undefined, { signal }); }
}) {
  // Refuse an existing directory before performing any public request.
  await newArchive(directory);
  const startedAt = dependencies.clock(), captureId = randomUUID();
  const state: State = { schema: 1, captureId, status: 'running', deadlineAt: startedAt + PLAN.maxDurationMs, updatedAt: startedAt };
  await writeArchiveFile(join(directory, 'state.json'), state);
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), PLAN.maxDurationMs);
  timer.unref();
  const abort = AbortSignal.any([signal, deadlineController.signal]);
  let recorded = 0;
  try {
    if (abort.aborted) throw new Error();
    const instrument = await dependencies.client.getInstrument(abort);
    const manifest = manifestSchema.parse({ schema: 1, kind: 'public-decimal-observations', captureId,
      venue: 'bybit', symbol: 'BTC/USDT', host: dependencies.host, startedAt, plan: PLAN, instrument });
    await writeArchiveFile(join(directory, 'manifest.json'), manifest);
    for (let sequence = 0; sequence < PLAN.samples; sequence++) {
      const due = startedAt + sequence * PLAN.intervalMs;
      if (abort.aborted || dependencies.clock() >= state.deadlineAt) break;
      if (dependencies.clock() < due) await dependencies.sleep(due - dependencies.clock(), abort);
      if (abort.aborted || dependencies.clock() >= state.deadlineAt || dependencies.clock() >= due + PLAN.intervalMs) break;
      const sampleStarted = dependencies.clock();
      let source;
      try { source = { available: true as const, book: await dependencies.client.getBook(abort) }; }
      catch { source = { available: false as const, reason: 'public-book-unavailable' as const }; }
      const sample = sampleSchema.parse({ schema: 1, captureId, sequence,
        startedAt: sampleStarted, checkedAt: dependencies.clock(), ...source });
      await writeArchiveFile(join(directory, `${String(sequence).padStart(3, '0')}.json`), sample);
      recorded++;
      state.updatedAt = dependencies.clock();
      await writeArchiveFile(join(directory, 'state.json'), state, true);
    }
    state.status = recorded === PLAN.samples && !abort.aborted && dependencies.clock() <= state.deadlineAt ? 'completed' : 'stopped';
  } catch (error) {
    state.status = abort.aborted ? 'stopped' : 'failed';
    if (!abort.aborted) throw new PaperError('exact-capture-failed');
  } finally {
    clearTimeout(timer);
    state.endedAt = state.updatedAt = dependencies.clock();
    await writeArchiveFile(join(directory, 'state.json'), state, true);
  }
  return { captureId, recorded, status: state.status };
}
