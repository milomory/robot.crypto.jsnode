import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { newArchive, readArchiveFile, writeArchiveFile } from '../market-exact/archive.js';
import { canonical } from '../paper-v2/ledger.js';
import { ExactPairPublicClient, validatePairBook, validatePairInstrument, validatePairUsdIndex } from './public.js';
import type { PairVenue, PairBook, PairInstrument, PairUsdIndex } from './public.js';

export const PAIR_PLAN = Object.freeze({ policy: 'mexc-okx-paired-probe-v1', symbol: 'BTC/USDT',
  samples: 60, intervalMs: 5_000, maxDurationMs: 330_000, quantityBTC: '0.0001',
  slippageBps: '5', openingUsdtPerVenue: '1000', openingBtcPerVenue: '0.01',
  feeAsset: 'USDT', maximumReceiptSkewMs: 1_000, maximumBookAgeMs: 5_000,
  policyNote: 'independent-prefunded-paper-accounts-no-transfers' } as const);
// Separate versioned policy: the legacy probe plan and replay remain unchanged.
export const PAIR_STUDY_PLAN = Object.freeze({ ...PAIR_PLAN, policy: 'mexc-okx-paired-study-30m-v1',
  samples: 360, maxDurationMs: 1_830_000,
  feePolicy: 'initial-observed-fees-frozen', metadataPolicy: 'initial-public-rules-frozen-max-age-1h',
  usdValuation: 'okx-btc-usd-index-proxy-1pct-buffer', feeScenarioPolicy: 'quote-and-received-base-v1' } as const);
export const PAIR_DAY_PLAN = Object.freeze({ ...PAIR_STUDY_PLAN, policy: 'mexc-okx-paired-study-24h-v1',
  samples: 1_440, intervalMs: 60_000, maxDurationMs: 86_430_000,
  metadataPolicy: 'periodic-public-rules-30m-max-age-1h', metadataRefreshSlots: 30,
  maxPublicRequests: 4_416, maximumArchiveBytes: 48 * 1024 * 1024, maximumFileBytes: 32 * 1024 } as const);
export type PairProfile = 'probe' | 'study-30m' | 'study-24h';
export type PairPlan = typeof PAIR_PLAN | typeof PAIR_STUDY_PLAN | typeof PAIR_DAY_PLAN;
function checkedPlan(input: unknown): PairPlan {
  const policy = z.object({ policy: z.string() }).passthrough().parse(input).policy;
  const plan = policy === PAIR_PLAN.policy ? PAIR_PLAN :
    policy === PAIR_STUDY_PLAN.policy ? PAIR_STUDY_PLAN : policy === PAIR_DAY_PLAN.policy ? PAIR_DAY_PLAN : null;
  if (plan === null || canonical(input) !== canonical(plan)) throw new PairCaptureError('invalid-pair-plan');
  return plan;
}
const venues = ['mexc', 'okx'] as const;
const time = z.number().int().positive().safe();
const rate = z.string().regex(/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/);
const feeRow = z.object({ status: z.literal('available'), feeReadVerified: z.literal(true),
  requestedAt: time, receivedAt: time, takerRate: rate,
  ratePrecision: z.enum(['json-number', 'decimal-string']),
  rateConvention: z.enum(['positive-fee', 'negative-fee-positive-rebate']) }).strict();
export const feeEvidenceSchema = z.object({ checkedAt: time,
  fees: z.object({ mexc: feeRow, okx: feeRow }).strict(),
  paymentModes: z.object({ observedAt: time, mexcMxDeduct: z.boolean().nullable(),
    okxFeeType: z.enum(['0', '1']).nullable() }).strict().optional() }).strict();
export type FeeEvidence = z.infer<typeof feeEvidenceSchema>;
export class PairCaptureError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'PairCaptureError'; }
}
const SCALE = 10n ** 18n;
function decimalRate(text: string): bigint {
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  return (negative ? -1n : 1n) * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0')));
}
function decimalText(value: bigint): string {
  return `${value / SCALE}.${String(value % SCALE).padStart(18, '0')}`.replace(/0+$/, '').replace(/\.$/, '');
}
export function feeCosts(input: unknown, now: number) {
  let evidence: FeeEvidence;
  try { evidence = feeEvidenceSchema.parse(input); } catch { throw new PairCaptureError('invalid-fee-evidence'); }
  if (!Number.isSafeInteger(now) || now < evidence.checkedAt || now - evidence.checkedAt > 600_000) {
    throw new PairCaptureError('stale-fee-evidence');
  }
  if (evidence.paymentModes && (evidence.paymentModes.observedAt > evidence.checkedAt ||
      evidence.checkedAt - evidence.paymentModes.observedAt > 120_000)) {
    throw new PairCaptureError('invalid-fee-evidence');
  }
  const costs = {} as Record<PairVenue, { feeBps: string; slippageBps: string; feeAsset: 'USDT' }>;
  for (const venue of venues) {
    const row = evidence.fees[venue];
    if (row.requestedAt > row.receivedAt || row.receivedAt > evidence.checkedAt ||
        evidence.checkedAt - row.requestedAt > 120_000 ||
        row.rateConvention !== (venue === 'mexc' ? 'positive-fee' : 'negative-fee-positive-rebate') ||
        (venue === 'okx' && row.ratePrecision !== 'decimal-string')) throw new PairCaptureError('invalid-fee-evidence');
    const raw = decimalRate(row.takerRate);
    if (raw <= -SCALE || raw >= SCALE || (venue === 'mexc' && raw < 0n)) throw new PairCaptureError('invalid-fee-evidence');
    const cost = venue === 'mexc' ? raw : raw < 0n ? -raw : 0n;
    costs[venue] = { feeBps: decimalText(cost * 10_000n), slippageBps: PAIR_PLAN.slippageBps, feeAsset: 'USDT' };
  }
  return { evidence, costs };
}
const manifestSchema = z.object({ schema: z.literal(1), kind: z.literal('exact-paired-public-probe'),
  captureId: z.string().uuid(), host: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/), startedAt: time,
  plan: z.unknown(), feeEvidence: feeEvidenceSchema, costs: z.unknown() }).strict();
export type PairManifest = z.infer<typeof manifestSchema> & { plan: PairPlan; costs: ReturnType<typeof feeCosts>['costs'] };
export type ReadResult<T> = { available: true; value: T } | { available: false; reason: 'public-data-unavailable' | 'missed-slot' };
export interface PairSample {
  schema: 1; captureId: string; sequence: number; startedAt: number; checkedAt: number;
  books: Record<PairVenue, ReadResult<PairBook>>;
  usdIndex?: ReadResult<PairUsdIndex>;
  instrumentRefresh?: Record<PairVenue, ReadResult<PairInstrument>>;
}
export interface PairInstruments {
  schema: 1; captureId: string; samplingStartedAt: number;
  instruments: Record<PairVenue, ReadResult<PairInstrument>>;
}
interface PairState { schema: 1; captureId: string; status: 'completed' | 'failed'; endedAt: number; samples: number }
interface Reader {
  getBook(venue: PairVenue, signal?: AbortSignal): Promise<PairBook>;
  getInstrument(venue: PairVenue, signal?: AbortSignal): Promise<PairInstrument>;
  getUsdIndex?(signal?: AbortSignal): Promise<PairUsdIndex>;
}
async function safeRead<T>(read: () => Promise<T>): Promise<ReadResult<T>> {
  try { return { available: true, value: await read() }; }
  catch { return { available: false, reason: 'public-data-unavailable' }; }
}
export async function collectPair(directory: string, fees: unknown, options: {
  client?: Reader; clock?: () => number; sleep?: (ms: number) => Promise<void>; host?: string; profile?: PairProfile;
} = {}) {
  if (options.profile !== undefined && options.profile !== 'probe' && options.profile !== 'study-30m' && options.profile !== 'study-24h') {
    throw new PairCaptureError('invalid-pair-profile');
  }
  const plan = options.profile === 'study-24h' ? PAIR_DAY_PLAN : options.profile === 'study-30m' ? PAIR_STUDY_PLAN : PAIR_PLAN;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const client = options.client ?? new ExactPairPublicClient();
  const startedAt = clock();
  const { evidence, costs } = feeCosts(fees, startedAt);
  const manifest: PairManifest = { schema: 1, kind: 'exact-paired-public-probe', captureId: randomUUID(),
    host: options.host ?? hostname(), startedAt, plan, feeEvidence: evidence, costs };
  manifestSchema.parse(manifest);
  await newArchive(directory);
  let archiveBytes = 0;
  const write = async (name: string, data: unknown) => {
    const bytes = Buffer.byteLength(canonical(data) + '\n');
    if (plan.policy === PAIR_DAY_PLAN.policy && (bytes > plan.maximumFileBytes ||
        archiveBytes + bytes > plan.maximumArchiveBytes)) throw new PairCaptureError('capture-archive-limit');
    await writeArchiveFile(join(directory, name), data);
    archiveBytes += bytes;
  };
  await write('manifest.json', manifest);
  const controller = new AbortController();
  const deadline = startedAt + plan.maxDurationMs;
  const timer = setTimeout(() => controller.abort(), plan.maxDurationMs);
  let count = 0;
  try {
    const [mexc, okx] = await Promise.all(venues.map(venue => safeRead(() => client.getInstrument(venue, controller.signal))));
    const samplingStartedAt = clock();
    const instruments: PairInstruments = { schema: 1, captureId: manifest.captureId, samplingStartedAt,
      instruments: { mexc, okx } };
    await write('instruments.json', instruments);
    for (let sequence = 0; sequence < plan.samples; sequence++) {
      const due = samplingStartedAt + sequence * plan.intervalMs;
      // Timers may wake a millisecond early. Recheck the clock before issuing requests;
      // bounded positive waits also fail closed for a stalled or backward-moving clock.
      let waits = 0;
      for (;;) {
        const now = clock();
        if (now >= deadline || controller.signal.aborted) throw new PairCaptureError('capture-deadline');
        if (now >= due) break;
        if (waits++ >= 8) throw new PairCaptureError('capture-clock-not-advancing');
        await sleep(Math.max(1, Math.min(plan.intervalMs, due - now)));
      }
      const at = clock();
      if (at >= deadline || controller.signal.aborted) throw new PairCaptureError('capture-deadline');
      if (at < due) throw new PairCaptureError('capture-clock-moved-backwards');
      const missed = at >= due + plan.intervalMs;
      const refresh = plan.policy === PAIR_DAY_PLAN.policy && sequence > 0 && sequence % plan.metadataRefreshSlots === 0;
      const refreshRows = !refresh ? undefined : missed ?
        venues.map(() => ({ available: false, reason: 'missed-slot' } as const)) :
        await Promise.all(venues.map(venue => safeRead(() => client.getInstrument(venue, controller.signal))));
      const instrumentRefresh = refreshRows ? { mexc: refreshRows[0], okx: refreshRows[1] } : undefined;
      const books = missed ? venues.map(() => ({ available: false, reason: 'missed-slot' } as const)) :
        await Promise.all(venues.map(venue => safeRead(() => client.getBook(venue, controller.signal))));
      // The same OKX client serializes requests; the optional USD proxy follows both book reads.
      const usdIndex = plan.policy !== PAIR_PLAN.policy ? (missed ?
        { available: false, reason: 'missed-slot' } as const : await safeRead(() => {
          if (!client.getUsdIndex) throw new PairCaptureError('usd-index-unavailable');
          return client.getUsdIndex(controller.signal);
        })) : undefined;
      const sample: PairSample = { schema: 1, captureId: manifest.captureId, sequence, startedAt: at,
        checkedAt: clock(), books: { mexc: books[0], okx: books[1] },
        ...(usdIndex === undefined ? {} : { usdIndex }),
        ...(instrumentRefresh === undefined ? {} : { instrumentRefresh }) };
      if (sample.checkedAt > deadline) throw new PairCaptureError('capture-deadline');
      await write(`${String(sequence).padStart(3, '0')}.json`, sample);
      count++;
    }
    const state: PairState = { schema: 1, captureId: manifest.captureId, status: 'completed', endedAt: clock(), samples: count };
    await write('state.json', state);
    return { captureId: manifest.captureId, samples: count, status: state.status };
  } catch {
    await write('state.json', { schema: 1, captureId: manifest.captureId,
      status: 'failed', endedAt: clock(), samples: count });
    throw new PairCaptureError('capture-failed');
  } finally { clearTimeout(timer); controller.abort(); }
}

const readResult = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), value: z.unknown() }).strict(),
  z.object({ available: z.literal(false), reason: z.enum(['public-data-unavailable', 'missed-slot']) }).strict()
]);
const results = z.object({ mexc: readResult, okx: readResult }).strict();
const instrumentsSchema = z.object({ schema: z.literal(1), captureId: z.string().uuid(),
  samplingStartedAt: time, instruments: results }).strict();
const sampleSchema = z.object({ schema: z.literal(1), captureId: z.string().uuid(),
  sequence: z.number().int().min(0).max(PAIR_DAY_PLAN.samples - 1), startedAt: time, checkedAt: time, books: results, usdIndex: readResult.optional(), instrumentRefresh: results.optional() }).strict();
const stateSchema = z.object({ schema: z.literal(1), captureId: z.string().uuid(), status: z.literal('completed'),
  endedAt: time, samples: z.number().int().min(0).max(PAIR_DAY_PLAN.samples) }).strict();
export async function readPairArchive(directory: string, options: { retainEarlySlotsForDiagnostics?: boolean } = {}) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const names = await readdir(directory);
    if (names.length > PAIR_DAY_PLAN.samples + 3) throw new Error();
    const manifest = manifestSchema.parse(await readArchiveFile(join(directory, 'manifest.json'))) as PairManifest;
    const plan = checkedPlan(manifest.plan);
    let archiveBytes = 0;
    const read = async (name: string): Promise<unknown> => {
      if (plan.policy !== PAIR_DAY_PLAN.policy) return readArchiveFile(join(directory, name));
      const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > plan.maximumFileBytes) throw new Error();
        const buffer = Buffer.alloc(plan.maximumFileBytes + 1);
        let count = 0;
        while (count < buffer.length) {
          const chunk = await file.read(buffer, count, buffer.length - count, null);
          if (chunk.bytesRead === 0) break;
          count += chunk.bytesRead;
        }
        archiveBytes += count;
        if (count > plan.maximumFileBytes || archiveBytes > plan.maximumArchiveBytes) throw new Error();
        return JSON.parse(buffer.subarray(0, count).toString('utf8'));
      } finally { await file.close(); }
    };
    // Count the manifest itself and reject a replacement during plan detection.
    if (plan.policy === PAIR_DAY_PLAN.policy && canonical(await read('manifest.json')) !== canonical(manifest)) throw new Error();
    const expected = ['manifest.json', 'instruments.json', 'state.json',
      ...Array.from({ length: plan.samples }, (_, i) => `${String(i).padStart(3, '0')}.json`)];
    if (canonical(names.sort()) !== canonical(expected.sort())) throw new Error();
    const costs = feeCosts(manifest.feeEvidence, manifest.startedAt).costs;
    if (canonical(costs) !== canonical(manifest.costs)) throw new Error();
    const instruments = instrumentsSchema.parse(await read('instruments.json'));
    const state = stateSchema.parse(await read('state.json'));
    if (instruments.captureId !== manifest.captureId || state.captureId !== manifest.captureId || state.samples !== plan.samples ||
        instruments.samplingStartedAt < manifest.startedAt || state.endedAt < instruments.samplingStartedAt ||
        state.endedAt > manifest.startedAt + plan.maxDurationMs) throw new Error();
    for (const venue of venues) {
      const row = instruments.instruments[venue];
      if (row.available) {
        const value = validatePairInstrument(row.value);
        if (value.venue !== venue || value.requestedAt < manifest.startedAt || value.receivedAt > instruments.samplingStartedAt) throw new Error();
        row.value = value;
      } else if (row.reason !== 'public-data-unavailable') throw new Error();
    }
    const samples: PairSample[] = [];
    const scheduleViolations: { sequence: number; earlyByMs: number }[] = [];
    for (let i = 0; i < plan.samples; i++) {
      const sample = sampleSchema.parse(await read(`${String(i).padStart(3, '0')}.json`));
      const due = instruments.samplingStartedAt + i * plan.intervalMs;
      if (sample.startedAt < due) {
        if (options.retainEarlySlotsForDiagnostics !== true) throw new Error();
        scheduleViolations.push({ sequence: i, earlyByMs: due - sample.startedAt });
      }
      if (sample.captureId !== manifest.captureId || sample.sequence !== i ||
          sample.checkedAt < sample.startedAt || sample.checkedAt > state.endedAt ||
          (i > 0 && sample.startedAt < samples[i - 1].checkedAt)) throw new Error();
      const missed = sample.startedAt >= due + plan.intervalMs;
      const refresh = plan.policy === PAIR_DAY_PLAN.policy && i > 0 && i % plan.metadataRefreshSlots === 0;
      if (refresh) {
        if (!sample.instrumentRefresh) throw new Error();
        for (const venue of venues) {
          const row = sample.instrumentRefresh[venue];
          if (row.available) {
            if (missed) throw new Error();
            const value = validatePairInstrument(row.value);
            if (value.venue !== venue || value.requestedAt < sample.startedAt || value.receivedAt > sample.checkedAt ||
                venues.some(bookVenue => {
                  const book = sample.books[bookVenue];
                  return book.available && (book.value as PairBook).requestedAt < value.receivedAt;
                })) throw new Error();
            row.value = value;
          } else if (row.reason !== (missed ? 'missed-slot' : 'public-data-unavailable')) throw new Error();
        }
      } else if (sample.instrumentRefresh !== undefined) throw new Error();
      for (const venue of venues) {
        const row = sample.books[venue];
        if (plan.policy === PAIR_DAY_PLAN.policy && missed && (row.available || row.reason !== 'missed-slot')) throw new Error();
        if (row.available) {
          if (sample.startedAt >= due + plan.intervalMs) throw new Error();
          const value = validatePairBook(row.value);
          if (value.venue !== venue || value.requestedAt < sample.startedAt || value.receivedAt > sample.checkedAt) throw new Error();
          row.value = value;
        } else if (row.reason === 'missed-slot' && sample.startedAt < due + plan.intervalMs) throw new Error();
      }
      if (plan.policy !== PAIR_PLAN.policy) {
        const row = sample.usdIndex;
        if (!row) throw new Error();
        if (plan.policy === PAIR_DAY_PLAN.policy && missed && (row.available || row.reason !== 'missed-slot')) throw new Error();
        if (row.available) {
          if (sample.startedAt >= due + plan.intervalMs) throw new Error();
          const value = validatePairUsdIndex(row.value);
          const lastBookReceipt = Math.max(sample.startedAt, ...venues.map(venue => {
            const book = sample.books[venue];
            return book.available ? (book.value as PairBook).receivedAt : sample.startedAt;
          }), ...venues.map(venue => {
            const refreshRow = sample.instrumentRefresh?.[venue];
            return refreshRow?.available ? (refreshRow.value as PairInstrument).receivedAt : sample.startedAt;
          }));
          if (value.requestedAt < lastBookReceipt || value.receivedAt > sample.checkedAt) throw new Error();
          row.value = value;
        } else if (row.reason === 'missed-slot' && sample.startedAt < due + plan.intervalMs) throw new Error();
      } else if (sample.usdIndex !== undefined) throw new Error();
      samples.push(sample as PairSample);
    }
    const typedInstruments = instruments as PairInstruments;
    const archiveHash = createHash('sha256').update(canonical({ manifest, instruments: typedInstruments, samples, state })).digest('hex');
    return { manifest, instruments: typedInstruments, samples, state, archiveHash, scheduleViolations };
  } catch { throw new PairCaptureError('incomplete-or-invalid-pair-archive'); }
}
