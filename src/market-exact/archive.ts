import { z } from 'zod';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical } from '../paper-v2/ledger.js';
import { PaperError } from '../paper-v2/exact.js';

// Fixed before the first public request. No parameter search or selected window.
export const PLAN = { policy: 'fixed-probe-v1', samples: 6, intervalMs: 30_000, maxDurationMs: 180_000,
  openingUSDT: '1000', buyQuantityBTC: '0.001', sellSequence: 3, sellQuantityBTC: '0.0004',
  feeBps: 10, slippageBps: 5 } as const;
const time = z.number().int().positive().safe();
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/);
const pair = z.tuple([decimal, decimal]);
export const rawBookSchema = z.object({ venue: z.literal('bybit'), symbol: z.literal('BTC/USDT'),
  requestedAt: time, receivedAt: time, systemAt: time, matchingAt: time.optional(),
  bids: z.array(pair).min(1).max(50), asks: z.array(pair).min(1).max(50) }).strict();
export const rawInstrumentSchema = z.object({ venue: z.literal('bybit'), symbol: z.literal('BTC/USDT'),
  requestedAt: time, receivedAt: time, status: z.literal('Trading'), basePrecision: decimal,
  quotePrecision: decimal, minOrderAmt: decimal, maxMarketOrderQty: decimal, tickSize: decimal }).strict();
export const manifestSchema = z.object({ schema: z.literal(1), kind: z.literal('public-decimal-observations'),
  captureId: z.string().uuid(), venue: z.literal('bybit'), symbol: z.literal('BTC/USDT'),
  host: z.string().min(1).max(255), startedAt: time,
  plan: z.object({ policy: z.literal(PLAN.policy), samples: z.literal(PLAN.samples), intervalMs: z.literal(PLAN.intervalMs),
    maxDurationMs: z.literal(PLAN.maxDurationMs), openingUSDT: z.literal(PLAN.openingUSDT),
    buyQuantityBTC: z.literal(PLAN.buyQuantityBTC), sellSequence: z.literal(PLAN.sellSequence),
    sellQuantityBTC: z.literal(PLAN.sellQuantityBTC), feeBps: z.literal(PLAN.feeBps), slippageBps: z.literal(PLAN.slippageBps) }).strict(),
  instrument: rawInstrumentSchema }).strict();
export type Manifest = z.infer<typeof manifestSchema>;
const sampleBase = z.object({ schema: z.literal(1), captureId: z.string().uuid(),
  sequence: z.number().int().min(0).max(PLAN.samples - 1), startedAt: time, checkedAt: time });
export const sampleSchema = z.discriminatedUnion('available', [
  sampleBase.extend({ available: z.literal(true), book: rawBookSchema }).strict(),
  sampleBase.extend({ available: z.literal(false), reason: z.literal('public-book-unavailable') }).strict()
]);
export type Sample = z.infer<typeof sampleSchema>;
export const stateSchema = z.object({ schema: z.literal(1), captureId: z.string().uuid(),
  status: z.enum(['running', 'completed', 'stopped', 'failed']), deadlineAt: time, updatedAt: time, endedAt: time.optional() }).strict();
export type State = z.infer<typeof stateSchema>;
const FILE_LIMIT = 128 * 1024;

export async function newArchive(path: string) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new PaperError('invalid-archive-parent');
  await mkdir(path, { mode: 0o700 });
}
export async function writeArchiveFile(path: string, data: unknown, replace = false) {
  const bytes = canonical(data) + '\n';
  if (Buffer.byteLength(bytes) > FILE_LIMIT) throw new PaperError('archive-file-too-large');
  const temporary = path + '.tmp-' + randomUUID();
  const f = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  if (replace) {
    await rename(temporary, path);
  } else { await link(temporary, path); await unlink(temporary); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readArchiveFile(path: string): Promise<unknown> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) throw new PaperError('invalid-archive-file');
    const buf = Buffer.alloc(FILE_LIMIT + 1);
    let count = 0;
    while (count < buf.length) {
      const chunk = await f.read(buf, count, buf.length - count, null);
      if (chunk.bytesRead === 0) break;
      count += chunk.bytesRead;
    }
    if (count > FILE_LIMIT) throw new PaperError('archive-file-too-large');
    return JSON.parse(buf.subarray(0, count).toString('utf8'));
  } finally { await f.close(); }
}

// Partial/failed archives are retained for diagnostics, never silently filtered.
export async function readCompleteArchive(directory: string) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const expected = ['manifest.json', 'state.json', ...Array.from({ length: PLAN.samples }, (_, i) => `${String(i).padStart(3, '0')}.json`)];
    const names = await readdir(directory);
    if (canonical(names.sort()) !== canonical(expected.sort())) throw new Error();
    const manifest = manifestSchema.parse(await readArchiveFile(join(directory, 'manifest.json')));
    const state = stateSchema.parse(await readArchiveFile(join(directory, 'state.json')));
    if (state.captureId !== manifest.captureId || state.status !== 'completed' || state.endedAt === undefined ||
        state.endedAt !== state.updatedAt || state.deadlineAt !== manifest.startedAt + PLAN.maxDurationMs ||
        state.endedAt > state.deadlineAt || state.endedAt < manifest.startedAt ||
        manifest.instrument.requestedAt < manifest.startedAt || manifest.instrument.receivedAt < manifest.instrument.requestedAt) throw new Error();
    const samples: Sample[] = [];
    for (let i = 0; i < PLAN.samples; i++) {
      const sample = sampleSchema.parse(await readArchiveFile(join(directory, `${String(i).padStart(3, '0')}.json`)));
      const due = manifest.startedAt + i * PLAN.intervalMs;
      if (sample.captureId !== manifest.captureId || sample.sequence !== i || !sample.available ||
          sample.startedAt < due || sample.startedAt >= due + PLAN.intervalMs ||
          sample.startedAt < manifest.instrument.receivedAt || sample.checkedAt < sample.startedAt ||
          sample.checkedAt > state.endedAt || sample.book.requestedAt < sample.startedAt ||
          sample.book.receivedAt > sample.checkedAt || sample.book.receivedAt < sample.book.requestedAt ||
          (samples.length && sample.startedAt <= samples.at(-1)!.checkedAt)) throw new Error();
      samples.push(sample);
    }
    return { manifest, samples, state };
  } catch { throw new PaperError('incomplete-or-invalid-exact-archive'); }
}
