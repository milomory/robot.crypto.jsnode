import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { compareVenues, LabError, validateBook, type FillAssumptions, type Venue } from './order-book.js';
import { LAB_SYMBOLS, VENUES, type PublicBookClient } from './public-books.js';
import { checkSize, instrumentsSchema } from './instruments.js';
import { atomicJson, readJson, resolveRun, collectionSchema } from './observation-store.js';

const time = z.number().int().positive().safe();
const venue = z.enum(['binance', 'bybit', 'okx']);
const costs = z.object({ feeBps: z.number().finite().min(0).lt(10_000),
  slippageBps: z.number().finite().min(0).lt(10_000) }).strict();
export const runSchema = z.object({
  schema: z.literal(1), model: z.literal('depth-v2'), runId: z.string().uuid(),
  host: z.string().min(1).max(255), startedAt: time,
  symbol: z.enum(LAB_SYMBOLS), quantity: z.number().finite().positive(),
  samples: z.number().int().min(1).max(60), intervalMs: z.number().int().min(10_000).max(60_000),
  costs: z.object({ binance: costs, bybit: costs, okx: costs }).strict(),
  instruments: instrumentsSchema.optional()
}).strict();
export type ObservationRun = z.infer<typeof runSchema>;
const level = z.tuple([z.number().finite().positive(), z.number().finite().positive()]);
const bookSchema = z.object({ venue, symbol: z.enum(LAB_SYMBOLS), bids: z.array(level).min(1).max(50),
  asks: z.array(level).min(1).max(50), requestedAt: time, receivedAt: time, sourceAt: time.optional() }).strict();
const sourceSchema = z.discriminatedUnion('available', [
  z.object({ venue, available: z.literal(true), book: bookSchema }).strict(),
  z.object({ venue, available: z.literal(false), reason: z.string().regex(/^(public-http-[1-5]\d\d|unavailable|rate-limit-cooldown|invalid-public-book|public-request-failed|stale-or-invalid-receipt-time|stale-or-invalid-source-time|invalid-depth|invalid-level|unsorted-or-duplicate-level|crossed-or-locked-book)$/) }).strict()
]);
const sampleSchema = z.object({ schema: z.literal(1), runId: z.string().uuid(),
  sequence: z.number().int().min(0).max(59), startedAt: time, checkedAt: time,
  sources: z.array(sourceSchema).length(3) }).strict();
export type ObservationSample = z.infer<typeof sampleSchema>;

export function createRun(host: string, symbol = 'BTC/USDT', quantity = .0001,
  samples = 3, intervalMs = 10_000, feeBps = 10, slippageBps = 5): ObservationRun {
  return runSchema.parse({ schema: 1, model: 'depth-v2', runId: randomUUID(), host, startedAt: Date.now(),
    symbol, quantity, samples, intervalMs,
    costs: Object.fromEntries(VENUES.map(v => [v, { feeBps, slippageBps }])) });
}

export async function collectSample(run: ObservationRun, sequence: number,
  client: Pick<PublicBookClient, 'getBook'>, clock = Date.now): Promise<ObservationSample> {
  const startedAt = clock();
  const results = await Promise.allSettled(VENUES.map(async v => {
    if (run.instruments && !run.instruments[v].available) throw new LabError('unavailable');
    return client.getBook(v, run.symbol);
  }));
  const sample = sampleSchema.parse({ schema: 1, runId: run.runId, sequence, startedAt, checkedAt: clock(),
    sources: results.map((result, i) => {
      if (result.status === 'fulfilled') return { venue: VENUES[i], available: true, book: result.value };
      const failure = { venue: VENUES[i], available: false, reason: result.reason instanceof LabError
        ? result.reason.message : 'unavailable' };
      return sourceSchema.safeParse(failure).success ? failure : { ...failure, reason: 'unavailable' };
    }) });
  validateSample(run, sample);
  return sample;
}

function validateSample(run: ObservationRun, sample: ObservationSample): void {
  if (sample.runId !== run.runId || sample.sequence >= run.samples || sample.startedAt < run.startedAt ||
      sample.checkedAt < sample.startedAt || new Set(sample.sources.map(s => s.venue)).size !== 3) {
    throw new LabError('invalid-observation');
  }
  for (const source of sample.sources) if (source.available) {
    if (source.book.venue !== source.venue || source.book.symbol !== run.symbol ||
        source.book.requestedAt < sample.startedAt || source.book.receivedAt > sample.checkedAt) {
      throw new LabError('invalid-observation-book');
    }
    // Validate at receipt; comparison below separately checks freshness at batch end.
    validateBook(source.book, source.book.receivedAt);
  }
}

export async function startRun(directory: string, run: ObservationRun) {
  runSchema.parse(run);
  await mkdir(directory, { mode: 0o700 }); // parent must exist; refuse an existing run directory
  await atomicJson(join(directory, 'run.json'), run);
}
export async function saveSample(directory: string, run: ObservationRun, sample: ObservationSample) {
  sampleSchema.parse(sample);
  validateSample(run, sample);
  await atomicJson(join(directory, `${String(sample.sequence).padStart(3, '0')}.json`), sample);
}

export function summarize(run: ObservationRun, samples: ObservationSample[]) {
  runSchema.parse(run);
  const sequences = new Set<number>();
  const byVenue = Object.fromEntries(VENUES.map(v => [v, { received: 0, freshAtComparison: 0,
    sourceTimestampPresent: 0, failed: 0, failureReasons: {} as Record<string, number> }])) as
    Record<Venue, { received: number; freshAtComparison: number; sourceTimestampPresent: number;
      failed: number; failureReasons: Record<string, number> }>;
  const pairs: Record<string, { valid: number; sizeChecked: number; rejected: number; positive: number; bestNetBps: number | null;
    worstNetBps: number | null; reasons: Record<string, number> }> = {};
  for (const buy of VENUES) for (const sell of VENUES) if (buy !== sell) {
    pairs[`${buy}->${sell}`] = { valid: 0, sizeChecked: 0, rejected: 0, positive: 0, bestNetBps: null, worstNetBps: null, reasons: {} };
  }
  const sorted = [...samples].sort((a, b) => a.sequence - b.sequence);
  let previous: ObservationSample | undefined;
  let longestStartGapMs = 0;
  for (const sample of sorted) {
    sampleSchema.parse(sample); validateSample(run, sample);
    if (sequences.has(sample.sequence) || (previous && sample.startedAt < previous.checkedAt)) {
      throw new LabError('duplicate-or-overlapping-observation');
    }
    sequences.add(sample.sequence);
    if (previous) longestStartGapMs = Math.max(longestStartGapMs, sample.startedAt - previous.startedAt);
    previous = sample;
    for (const source of sample.sources) {
      const stats = byVenue[source.venue];
      if (!source.available) {
        stats.failed++; stats.failureReasons[source.reason] = (stats.failureReasons[source.reason] ?? 0) + 1;
      } else {
        stats.received++;
        if (source.book.sourceAt !== undefined) stats.sourceTimestampPresent++;
        try { validateBook(source.book, sample.checkedAt); stats.freshAtComparison++; } catch { /* counted separately */ }
      }
    }
    for (const buy of sample.sources) for (const sell of sample.sources) {
      if (buy.venue === sell.venue) continue;
      const stats = pairs[`${buy.venue}->${sell.venue}`];
      try {
        if (!buy.available || !sell.available) throw new LabError('source-unavailable');
        const result = compareVenues(buy.book, sell.book, run.quantity,
          run.costs as Record<Venue, FillAssumptions>, sample.checkedAt);
        if (run.instruments) {
          for (const [source, fill] of [[buy, result.purchase], [sell, result.sale]] as const) {
            const metadata = run.instruments[source.venue];
            if (!metadata.available) throw new LabError('instrument-unavailable');
            if (metadata.instrument.venue !== source.venue || metadata.instrument.symbol !== run.symbol) throw new LabError('instrument-mismatch');
            checkSize(metadata.instrument, run.quantity, fill.quoteBeforeSlippage, sample.checkedAt);
          }
          stats.sizeChecked++;
        }
        stats.valid++; if (result.netQuote > 0) stats.positive++;
        stats.bestNetBps = Math.max(stats.bestNetBps ?? -Infinity, result.netBps);
        stats.worstNetBps = Math.min(stats.worstNetBps ?? Infinity, result.netBps);
      } catch (error) {
        stats.rejected++;
        const reason = error instanceof LabError ? error.message : 'comparison-failed';
        stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
      }
    }
  }
  return { model: run.model, runId: run.runId, host: run.host, symbol: run.symbol, quantity: run.quantity,
    startedAt: run.startedAt, lastObservedAt: sorted.at(-1)?.checkedAt ?? null,
    sizeValidation: run.instruments ? 'public-rules-estimate' : 'not-checked',
    instruments: run.instruments ?? null,
    assumptions: run.costs, expectedSamples: run.samples, recordedSamples: samples.length,
    missingSequences: Array.from({ length: run.samples }, (_, i) => i).filter(i => !sequences.has(i)),
    longestStartGapMs, intervalMs: run.intervalMs, byVenue, pairs,
    indicativeOnly: true, interpretation: 'Counts are snapshot observations, not trades or earned P/L. No summation of overlapping opportunities.' };
}

export async function readReport(directory: string) {
  try {
    directory = await resolveRun(directory);
    const run = runSchema.parse(await readJson(join(directory, 'run.json')));
    const files = (await readdir(directory)).filter(name => /^\d{3}\.json$/.test(name));
    if (files.length > run.samples) throw new LabError('too-many-observation-files');
    const samples = [];
    for (const name of files) {
      const sample = sampleSchema.parse(await readJson(join(directory, name)));
      if (Number(name.slice(0, 3)) !== sample.sequence) throw new LabError('observation-name-mismatch');
      samples.push(sample);
    }
    let collection: (Omit<import('./observation-store.js').Collection, 'state'> & {
      state: import('./observation-store.js').Collection['state'] | 'interrupted'
    }) | null = null;
    try {
      const saved = collectionSchema.parse(await readJson(join(directory, 'collection.json')));
      if (saved.runId !== run.runId) throw new LabError('mismatched-collection');
      collection = { ...saved, state: saved.state === 'running' &&
        (Date.now() > saved.deadlineAt || Date.now() - saved.updatedAt > run.intervalMs + 20_000) ? 'interrupted' : saved.state };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { ...summarize(run, samples), collection };
  } catch { throw new LabError('invalid-or-unreadable-observation-run'); }
}
