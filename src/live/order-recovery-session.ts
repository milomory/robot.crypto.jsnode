/** Protected composition building block only. No vault/env lookup, runner installation or journal import. */
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { OrderRecoveryReader, projectRecoveryFills, projectRecoveryOrder } from '../accounts/order-recovery-reader.js';
import { AccountError, validateCredentials, type AccountCredentials } from '../accounts/types.js';
import { persistentFetch, type Cooldowns } from '../accounts/pair-runtime.js';
import { canonicalLiveOrderJson as canonical, deriveLiveClientOrderId } from './order-lifecycle.js';
import { readLiveOrderJournal, type LiveOrderJournalCheckpoint } from './order-journal.js';
import { collectLiveOrderRecovery, ORDER_RECOVERY_POLICY, OrderRecoveryCollectionError, type LiveOrderRecoveryCapture } from './order-recovery-collection.js';

export const ORDER_RECOVERY_SESSION_LIMITS = Object.freeze({ captureBytes: 128 * 1024, archiveBytes: 256 * 1024 });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const clientId = z.string().regex(/^[A-Za-z0-9]{32}$/);
const upstreamId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const millis = z.number().int().safe().positive().max(8_640_000_000_000_000);
const venue = z.enum(['mexc', 'okx']);
const checkpointSchema = z.object({ schema: z.union([z.literal(1), z.literal(2)]),
  kind: z.literal('live-order-rehearsal-checkpoint'), journalId: uuid,
  revision: z.number().int().min(0).max(2000), headHash: hash }).strict();
const metadata = { venue, requestedAt: millis, receivedAt: millis,
  query: z.record(z.string().max(32), z.string().max(128)), data: z.unknown() };
const captureSchema = z.object({ schema: z.literal(1), kind: z.literal('live-order-recovery-capture'), venue,
  account: z.literal('main'), clientOrderId: clientId, requestedAt: millis, receivedAt: millis,
  orderBefore: z.object({ ...metadata, kind: z.literal('order') }).strict(),
  fills: z.object({ ...metadata, kind: z.literal('fills') }).strict(),
  orderAfter: z.object({ ...metadata, kind: z.literal('order') }).strict(),
}).strict();
const bodySchema = z.object({ schema: z.literal(1), kind: z.literal('live-order-recovery-session-archive'),
  archiveId: uuid, nonExecutable: z.literal(true), captureProvenanceVerified: z.literal(false),
  accountIdentityVerified: z.literal(false), venue, account: z.literal('main'), orderIntentId: uuid,
  baseCheckpoint: checkpointSchema, capture: captureSchema, captureDigest: hash,
}).strict();
const archiveSchema = bodySchema.extend({ archiveHash: hash }).strict();
const receiptSchema = z.object({ schema: z.literal(1), kind: z.literal('live-order-recovery-archive-receipt'),
  archiveId: uuid, archiveHash: hash }).strict();
export type LiveOrderRecoveryArchiveReceipt = z.infer<typeof receiptSchema>;
export interface LiveOrderRecoveryArchive {
  readonly schema: 1; readonly kind: 'live-order-recovery-session-archive'; readonly archiveId: string;
  readonly nonExecutable: true; readonly captureProvenanceVerified: false; readonly accountIdentityVerified: false;
  readonly venue: 'mexc' | 'okx'; readonly account: 'main'; readonly orderIntentId: string;
  readonly baseCheckpoint: LiveOrderJournalCheckpoint; readonly capture: LiveOrderRecoveryCapture;
  readonly captureDigest: string; readonly archiveHash: string;
}
export interface LiveOrderRecoverySessionInput {
  journalDirectory: string; expectedCheckpoint: LiveOrderJournalCheckpoint; orderIntentId: string;
  archiveDirectory: string; credentials: AccountCredentials; fetch?: typeof fetch;
  clock?: () => number; wait?: (milliseconds: number) => Promise<void>; context?: OrderRecoverySessionContext;
}
export interface LiveOrderRecoverySessionResult {
  readonly schema: 1; readonly kind: 'live-order-recovery-session'; readonly nonExecutable: true;
  readonly captureProvenanceVerified: false; readonly accountIdentityVerified: false;
  readonly importPerformed: false; readonly requestCount: 3; readonly captureBytes: number;
  /** This was checked before publication; it is not a lock across archive and journal. */
  readonly headMatchedBeforePublication: true; readonly receipt: LiveOrderRecoveryArchiveReceipt;
}
export class OrderRecoverySessionError extends Error {
  constructor(readonly code: 'recovery-session-invalid-input' | 'recovery-session-busy' |
    'recovery-session-journal-unavailable' | 'recovery-session-head-conflict' | 'recovery-session-ineligible-intent' |
    'recovery-session-capture-failed' | 'recovery-session-rate-limited' | 'recovery-session-cooldown-unavailable' | 'recovery-session-secret-contamination' |
    'recovery-archive-invalid' | 'recovery-archive-exists' | 'recovery-archive-limit' |
    'recovery-archive-write-failed' | 'recovery-archive-publish-uncertain') {
    super(code); this.name = 'OrderRecoverySessionError';
  }
}
function fail(code: OrderRecoverySessionError['code']): never { throw new OrderRecoverySessionError(code); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const owned = (stat: Stats) => typeof process.getuid === 'function' && stat.uid === process.getuid();
function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) fail('recovery-session-invalid-input');
  return value;
}
async function privateDirectory(directory: string): Promise<FileHandle> {
  if (directory !== await realpath(directory)) fail('recovery-archive-invalid');
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o777) !== 0o700) fail('recovery-archive-invalid');
    return fd;
  } catch (error) { await fd.close(); throw error; }
}
async function absent(directory: string) {
  try { await lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  fail('recovery-archive-exists');
}
function exactKeys(value: Record<string, string>, keys: string[]): boolean {
  return canonical(Object.keys(value).sort()) === canonical(keys.sort());
}
function parseCapture(input: unknown): LiveOrderRecoveryCapture {
  if (Buffer.byteLength(JSON.stringify(input)) > ORDER_RECOVERY_SESSION_LIMITS.captureBytes) fail('recovery-archive-limit');
  const parsed = captureSchema.safeParse(input);
  if (!parsed.success) fail('recovery-archive-invalid');
  const capture = parsed.data, reads = [capture.orderBefore, capture.fills, capture.orderAfter];
  if (capture.receivedAt < capture.requestedAt || capture.receivedAt - capture.requestedAt > ORDER_RECOVERY_POLICY.maxCaptureDurationMs ||
      reads.some(read => read.venue !== capture.venue || read.receivedAt < read.requestedAt) ||
      capture.requestedAt > capture.orderBefore.requestedAt || capture.receivedAt < capture.orderAfter.receivedAt ||
      capture.orderBefore.receivedAt > capture.fills.requestedAt || capture.fills.receivedAt > capture.orderAfter.requestedAt) fail('recovery-archive-invalid');
  const isMexc = capture.venue === 'mexc', symbolKey = isMexc ? 'symbol' : 'instId', nativeSymbol = isMexc ? 'BTCUSDT' : 'BTC-USDT';
  const orderKey = isMexc ? 'orderId' : 'ordId', clientKey = isMexc ? 'origClientOrderId' : 'clOrdId';
  let selectedId: string | undefined;
  for (const read of [capture.orderBefore, capture.orderAfter]) {
    const projected = projectRecoveryOrder(capture.venue, read.data);
    if (canonical(projected) !== canonical(read.data)) fail('recovery-archive-invalid');
    const row = projected as unknown as Record<string, unknown>;
    const remoteId = row[orderKey], remoteClient = row[isMexc ? 'clientOrderId' : 'clOrdId'];
    if (!upstreamId.safeParse(remoteId).success || remoteClient !== capture.clientOrderId ||
        (selectedId !== undefined && selectedId !== remoteId)) fail('recovery-archive-invalid');
    selectedId = remoteId as string;
    const q = read.query;
    if (q[symbolKey] !== nativeSymbol || !((exactKeys(q, [symbolKey, orderKey]) && q[orderKey] === selectedId) ||
        (read === capture.orderBefore && exactKeys(q, [symbolKey, clientKey]) && q[clientKey] === capture.clientOrderId))) fail('recovery-archive-invalid');
  }
  const q = capture.fills.query;
  if (isMexc) {
    if (!exactKeys(q, ['symbol', 'orderId', 'limit']) || q.symbol !== 'BTCUSDT' || q.orderId !== selectedId || q.limit !== '1000') fail('recovery-archive-invalid');
  } else {
    if (!exactKeys(q, ['instType', 'instId', 'ordId', 'begin', 'end', 'limit']) || q.instType !== 'SPOT' || q.instId !== 'BTC-USDT' ||
        q.ordId !== selectedId || q.limit !== '100' || !/^[1-9]\d{0,15}$/.test(q.begin) || !/^[1-9]\d{0,15}$/.test(q.end) ||
        !Number.isSafeInteger(Number(q.begin)) || !Number.isSafeInteger(Number(q.end)) || Number(q.end) < Number(q.begin) ||
        Number(q.end) - Number(q.begin) > 7 * 86400_000) fail('recovery-archive-invalid');
  }
  const projected = projectRecoveryFills(capture.venue, capture.fills.data);
  if (canonical(projected) !== canonical(capture.fills.data) || projected.some(row =>
      ('orderId' in row ? row.orderId : row.ordId) !== selectedId)) fail('recovery-archive-invalid');
  return freeze(capture) as LiveOrderRecoveryCapture;
}
function parseArchive(input: unknown): LiveOrderRecoveryArchive {
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) fail('recovery-archive-invalid');
  const { archiveHash, ...body } = parsed.data;
  if (digest(body) !== archiveHash || digest(body.capture) !== body.captureDigest ||
      body.capture.venue !== body.venue || body.capture.clientOrderId !== deriveLiveClientOrderId(body.venue, body.orderIntentId)) fail('recovery-archive-invalid');
  parseCapture(body.capture);
  return freeze(parsed.data) as LiveOrderRecoveryArchive;
}
function assertNoCredentials(text: string, credentials: AccountCredentials) {
  // Deliberately conservative for short/common values. Do not truncate secrets or
  // include a matching value, field name, path or upstream text in the failure.
  for (const secret of [credentials.apiKey, credentials.apiSecret, credentials.passphrase].filter((value): value is string => value !== undefined)) {
    if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) fail('recovery-session-secret-contamination');
  }
}
async function exactJournal(directory: string, expected: LiveOrderJournalCheckpoint) {
  try {
    const snapshot = await readLiveOrderJournal(directory, expected);
    if (canonical(snapshot.checkpoint) !== canonical(expected)) fail('recovery-session-head-conflict');
    return snapshot;
  } catch (error) {
    if (error instanceof OrderRecoverySessionError) throw error;
    if (error && typeof error === 'object' && 'reason' in error && error.reason === 'journal-head-conflict') fail('recovery-session-head-conflict');
    fail('recovery-session-journal-unavailable');
  }
}
async function publishArchive(directory: string, text: string, parentFd: FileHandle) {
  let created = false, complete = false;
  try {
    await mkdir(directory, { mode: 0o700 }); created = true; await parentFd.sync();
    const directoryFd = await privateDirectory(directory);
    try {
      const file = await open(join(directory, 'capture.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) fail('recovery-archive-invalid');
        await file.writeFile(text); await file.sync(); complete = true;
      } finally { await file.close(); }
      await directoryFd.sync(); await parentFd.sync();
    } finally { await directoryFd.close(); }
  } catch (error) {
    if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') fail('recovery-archive-exists');
    // No cleanup: preserve the new private partial archive for explicit inspection.
    fail(complete ? 'recovery-archive-publish-uncertain' : 'recovery-archive-write-failed');
  }
}
export interface OrderRecoverySessionContext {
  readonly schema: 1; readonly kind: 'order-recovery-session-context';
}
interface ContextState { cooldowns: Cooldowns; save: () => Promise<void>; failed: boolean; lastClock: number }
const cooldownSchema = z.object({ schema: z.literal(1), mexc: z.number().int().safe().min(0).max(8_640_000_000_000_000),
  okx: z.number().int().safe().min(0).max(8_640_000_000_000_000) }).strict();
const contexts = new WeakMap<OrderRecoverySessionContext, ContextState>();
/** Optional persistence is supplied by a future protected runner. No implicit file
 * write, credential retention or cross-process/account lock is provided here. */
export function createOrderRecoverySessionContext(initial: Readonly<Cooldowns> = { schema: 1, mexc: 0, okx: 0 },
  options: { persist?: (cooldowns: Readonly<Cooldowns>) => Promise<void> } = {}): OrderRecoverySessionContext {
  const parsed = cooldownSchema.safeParse(initial);
  if (!parsed.success || Object.keys(options).some(key => key !== 'persist') ||
      (options.persist !== undefined && typeof options.persist !== 'function')) fail('recovery-session-invalid-input');
  const persist = options.persist, context = freeze({ schema: 1 as const, kind: 'order-recovery-session-context' as const });
  const state: ContextState = { cooldowns: parsed.data, failed: false, lastClock: 0, save: async () => {} };
  let pending = Promise.resolve();
  state.save = async () => {
    const next = pending.then(async () => {
      if (state.failed) throw new AccountError('account-unavailable');
      try { await persist?.(freeze({ ...state.cooldowns })); }
      catch { state.failed = true; throw new AccountError('account-unavailable'); }
    });
    pending = next.catch(() => {}); return next;
  };
  contexts.set(context, state); return context;
}
export function snapshotOrderRecoverySessionCooldowns(context: OrderRecoverySessionContext): Readonly<Cooldowns> {
  const state = contexts.get(context); if (!state) fail('recovery-session-invalid-input');
  return freeze({ ...state.cooldowns });
}
const defaultContext = createOrderRecoverySessionContext();
function contextClock(state: ContextState, clock: () => number): () => number {
  return () => {
    let value: number;
    try { value = clock(); } catch { throw new AccountError('account-invalid-clock'); }
    if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000 || value < state.lastClock) throw new AccountError('account-invalid-clock');
    state.lastClock = value; return value;
  };
}
async function retainRateLimit(state: ContextState, selected: 'mexc' | 'okx', clock: () => number) {
  const until = Math.min(8_640_000_000_000_000, clock() + 60_000);
  if (until > state.cooldowns[selected]) { state.cooldowns[selected] = until; await state.save(); }
}
const active = new Set<string>();
/** Executes only the scoped three-GET capture and publishes its original evidence.
 * No journal event is written. A future pinned broker must add cross-process/account
 * locking; the final journal check and archive publication are not one transaction. */
export async function captureLiveOrderRecoverySession(input: LiveOrderRecoverySessionInput): Promise<LiveOrderRecoverySessionResult> {
  let saved: LiveOrderRecoverySessionInput;
  try {
    if (!input || Object.keys(input).some(key => !['journalDirectory', 'expectedCheckpoint', 'orderIntentId', 'archiveDirectory',
      'credentials', 'fetch', 'clock', 'wait', 'context'].includes(key))) fail('recovery-session-invalid-input');
    const journalDirectory = absolutePath(input.journalDirectory), archiveDirectory = absolutePath(input.archiveDirectory);
    if (archiveDirectory === journalDirectory || archiveDirectory.startsWith(journalDirectory + '/')) fail('recovery-session-invalid-input');
    const checkpoint = checkpointSchema.safeParse(input.expectedCheckpoint), intent = uuid.safeParse(input.orderIntentId);
    const credentials = z.object({ apiKey: z.string(), apiSecret: z.string(), passphrase: z.string().optional() }).strict().parse(input.credentials);
    validateCredentials(credentials);
    if (!checkpoint.success || !intent.success || [input.fetch, input.clock, input.wait].some(value => value !== undefined && typeof value !== 'function')) fail('recovery-session-invalid-input');
    saved = { journalDirectory, archiveDirectory, expectedCheckpoint: checkpoint.data as LiveOrderJournalCheckpoint,
      orderIntentId: intent.data.toLowerCase(), credentials: { ...credentials }, fetch: input.fetch, clock: input.clock, wait: input.wait, context: input.context ?? defaultContext };
    if (!contexts.has(saved.context!)) fail('recovery-session-invalid-input');
  } catch { return fail('recovery-session-invalid-input'); }
  if (active.has(saved.journalDirectory)) fail('recovery-session-busy');
  active.add(saved.journalDirectory);
  let parentFd: FileHandle | undefined;
  try {
    parentFd = await privateDirectory(dirname(saved.archiveDirectory));
    const parentStat = await parentFd.stat();
    await absent(saved.archiveDirectory);
    const snapshot = await exactJournal(saved.journalDirectory, saved.expectedCheckpoint);
    const order = snapshot.state.orders.find(row => row.intent.orderIntentId === saved.orderIntentId);
    if (!order || !order.dispatchAt || order.phase === 'prepared' || order.phase === 'reconciled') fail('recovery-session-ineligible-intent');
    // The only host selection comes from the immutable persisted intent, never caller routing fields.
    let requestCount = 0;
    const performFetch = saved.fetch ?? globalThis.fetch, context = contexts.get(saved.context!)!;
    if (context.failed) fail('recovery-session-cooldown-unavailable');
    const clock = contextClock(context, saved.clock ?? Date.now);
    const request = persistentFetch(context.cooldowns, context.save,
      ((...args: Parameters<typeof fetch>) => {
        if (context.failed) throw new AccountError('account-unavailable');
        requestCount++; return performFetch(...args);
      }) as typeof fetch, clock);
    const reader = new OrderRecoveryReader(order.intent.venue, { credentials: saved.credentials, clock, fetch: request });
    let capture: LiveOrderRecoveryCapture;
    try { capture = parseCapture(await collectLiveOrderRecovery(snapshot.state, saved.orderIntentId, reader, { clock, wait: saved.wait })); }
    catch (error) {
      if (error instanceof OrderRecoverySessionError && error.code === 'recovery-archive-limit') throw error;
      if (context.failed) fail('recovery-session-cooldown-unavailable');
      if (error instanceof OrderRecoveryCollectionError && error.code === 'recovery-rate-limited') {
        try { await retainRateLimit(context, order.intent.venue, clock); } catch { fail('recovery-session-cooldown-unavailable'); }
        fail('recovery-session-rate-limited');
      }
      fail('recovery-session-capture-failed');
    }
    if (context.failed) fail('recovery-session-cooldown-unavailable');
    if (requestCount !== 3) fail('recovery-session-capture-failed');
    const body = { schema: 1 as const, kind: 'live-order-recovery-session-archive' as const, archiveId: randomUUID(),
      nonExecutable: true as const, captureProvenanceVerified: false as const, accountIdentityVerified: false as const,
      venue: order.intent.venue, account: 'main' as const, orderIntentId: saved.orderIntentId,
      baseCheckpoint: snapshot.checkpoint, capture, captureDigest: digest(capture) };
    const archive = parseArchive({ ...body, archiveHash: digest(body) }), text = canonical(archive) + '\n';
    if (Buffer.byteLength(text) > ORDER_RECOVERY_SESSION_LIMITS.archiveBytes) fail('recovery-archive-limit');
    assertNoCredentials(text, saved.credentials);
    await exactJournal(saved.journalDirectory, saved.expectedCheckpoint);
    const currentParent = await privateDirectory(dirname(saved.archiveDirectory));
    try {
      const stat = await currentParent.stat();
      if (stat.dev !== parentStat.dev || stat.ino !== parentStat.ino) fail('recovery-archive-invalid');
    } finally { await currentParent.close(); }
    if (context.failed) fail('recovery-session-cooldown-unavailable');
    await publishArchive(saved.archiveDirectory, text, parentFd);
    return freeze({ schema: 1, kind: 'live-order-recovery-session', nonExecutable: true, captureProvenanceVerified: false,
      accountIdentityVerified: false, importPerformed: false, requestCount: 3, captureBytes: Buffer.byteLength(canonical(capture)),
      headMatchedBeforePublication: true,
      receipt: { schema: 1, kind: 'live-order-recovery-archive-receipt', archiveId: archive.archiveId, archiveHash: archive.archiveHash } });
  } catch (error) {
    if (error instanceof OrderRecoverySessionError) throw error;
    return fail('recovery-archive-invalid');
  } finally {
    active.delete(saved.journalDirectory);
    try { await parentFd?.close(); } catch { fail('recovery-archive-publish-uncertain'); }
  }
}
/** Private data for a separate offline import. A hash/receipt detects alteration,
 * not authenticity. Surviving valid bytes are fsynced before returning on recovery. */
export async function readLiveOrderRecoveryArchive(directoryInput: string, expectedReceipt?: unknown)
  : Promise<LiveOrderRecoveryArchive> {
  try {
    const directory = absolutePath(directoryInput);
    const expected = expectedReceipt === undefined ? undefined : receiptSchema.parse(expectedReceipt);
    const parentFd = await privateDirectory(dirname(directory));
    try {
      const directoryFd = await privateDirectory(directory);
      try {
        if (canonical((await readdir(directory)).sort()) !== canonical(['capture.json'])) fail('recovery-archive-invalid');
        const file = await open(join(directory, 'capture.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) fail('recovery-archive-invalid');
          if (stat.size > ORDER_RECOVERY_SESSION_LIMITS.archiveBytes) fail('recovery-archive-limit');
          const buffer = Buffer.alloc(ORDER_RECOVERY_SESSION_LIMITS.archiveBytes + 1); let length = 0;
          while (length < buffer.length) {
            const part = await file.read(buffer, length, buffer.length - length, null); if (!part.bytesRead) break; length += part.bytesRead;
          }
          if (length > ORDER_RECOVERY_SESSION_LIMITS.archiveBytes) fail('recovery-archive-limit');
          const text = buffer.subarray(0, length).toString('utf8'), archive = parseArchive(JSON.parse(text));
          if (text !== canonical(archive) + '\n' || (expected && (expected.archiveId !== archive.archiveId || expected.archiveHash !== archive.archiveHash))) fail('recovery-archive-invalid');
          await file.sync(); await directoryFd.sync(); await parentFd.sync();
          return archive;
        } finally { await file.close(); }
      } finally { await directoryFd.close(); }
    } finally { await parentFd.close(); }
  } catch (error) {
    if (error instanceof OrderRecoverySessionError) throw error;
    fail('recovery-archive-invalid');
  }
}
