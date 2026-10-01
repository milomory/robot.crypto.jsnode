/** Private, offline lifecycle rehearsal journal. Contains no credentials or exchange transport. */
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parseLiveOrderAdmissionPolicy, assessLiveOrderAdmission, assessLiveOrderDispatch,
  type LiveOrderAdmissionPolicy } from './order-admission-policy.js';
import { applyLiveOrderEvent, canonicalLiveOrderJson as canonical, createLiveOrderState, parseLiveOrderEvent,
  type LiveOrderEvent, type LiveOrderState } from './order-lifecycle.js';

export const LIVE_ORDER_JOURNAL_LIMITS = Object.freeze({ events: 2_000, fileBytes: 64 * 1024,
  directoryBytes: 4 * 1024 * 1024, pendingFiles: 8 });
const committedByteLimit = LIVE_ORDER_JOURNAL_LIMITS.directoryBytes -
  LIVE_ORDER_JOURNAL_LIMITS.pendingFiles * LIVE_ORDER_JOURNAL_LIMITS.fileBytes;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.union([z.literal(1), z.literal(2)]);
const identity = { schema: version, journalId: z.string().uuid() };
const manifestFields = { kind: z.literal('live-order-rehearsal-journal'), journalId: z.string().uuid(),
  nonExecutable: z.literal(true), captureProvenanceVerified: z.literal(false), hash: hashSchema };
const manifestSchema = z.discriminatedUnion('schema', [
  z.object({ ...manifestFields, schema: z.literal(1) }).strict(),
  z.object({ ...manifestFields, schema: z.literal(2), admissionPolicy: z.unknown() }).strict(),
]);
const recordSchema = z.object({ ...identity, kind: z.literal('live-order-rehearsal-event'),
  sequence: z.number().int().min(1).max(LIVE_ORDER_JOURNAL_LIMITS.events),
  previousHash: hashSchema, event: z.unknown(), hash: hashSchema }).strict();
const checkpointSchema = z.object({ ...identity, kind: z.literal('live-order-rehearsal-checkpoint'),
  revision: z.number().int().min(0).max(LIVE_ORDER_JOURNAL_LIMITS.events), headHash: hashSchema }).strict();
export type LiveOrderJournalCheckpoint = z.infer<typeof checkpointSchema>;
export interface LiveOrderJournalSnapshot {
  schema: 1 | 2; kind: 'live-order-rehearsal-journal'; nonExecutable: true; captureProvenanceVerified: false;
  admissionPolicy: LiveOrderAdmissionPolicy | null;
  journalId: string; revision: number; headHash: string; pendingFiles: number;
  checkpoint: LiveOrderJournalCheckpoint; state: LiveOrderState;
}
interface Loaded extends LiveOrderJournalSnapshot { chainHeads: string[]; committedBytes: number }
export class LiveOrderJournalError extends Error {
  constructor(readonly reason: 'journal-invalid' | 'journal-limit' | 'journal-head-conflict' |
    'journal-event-invalid' | 'journal-event-conflict' | 'journal-write-failed' | 'journal-publish-uncertain' |
    'journal-policy-invalid' | 'journal-policy-blocked') {
    super(reason); this.name = 'LiveOrderJournalError';
  }
}
function fail(reason: LiveOrderJournalError['reason']): never { throw new LiveOrderJournalError(reason); }
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const filename = (sequence: number) => String(sequence).padStart(6, '0') + '.json';
const pendingPattern = /^\.pending-0[0-7]$/;
const owned = (stat: Stats) => typeof process.getuid === 'function' && stat.uid === process.getuid();
function privateFile(stat: Stats) {
  if (!stat.isFile() || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink < 1 || stat.nlink > 2 ||
      stat.size > LIVE_ORDER_JOURNAL_LIMITS.fileBytes) fail('journal-invalid');
}
async function directoryHandle(directory: string): Promise<FileHandle> {
  if (resolve(directory) !== await realpath(directory)) fail('journal-invalid');
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o777) !== 0o700) fail('journal-invalid');
    return file;
  } catch (error) { await file.close(); throw error; }
}
async function readPrivate(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(); privateFile(stat);
    const bytes = Buffer.alloc(LIVE_ORDER_JOURNAL_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, null);
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > LIVE_ORDER_JOURNAL_LIMITS.fileBytes) fail('journal-limit');
    return { value: JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown, bytes: length, stat };
  } finally { await file.close(); }
}
function checkpoint(schema: 1 | 2, journalId: string, revision: number, headHash: string): LiveOrderJournalCheckpoint {
  return { schema, kind: 'live-order-rehearsal-checkpoint', journalId, revision, headHash };
}
function snapshot(loaded: Loaded): LiveOrderJournalSnapshot {
  const { chainHeads: _heads, committedBytes: _bytes, ...result } = loaded; return result;
}
function enforcePolicy(state: LiveOrderState, event: LiveOrderEvent, policy: LiveOrderAdmissionPolicy | null) {
  if (!policy) return;
  const assessment = event.type === 'intent-created' ? assessLiveOrderAdmission(state, event, policy)
    : event.type === 'dispatch-marked' ? assessLiveOrderDispatch(state, event, policy) : null;
  if (assessment && !assessment.allowedForRehearsal) fail('journal-policy-blocked');
}
async function load(directory: string): Promise<Loaded> {
  const directoryFd = await directoryHandle(directory);
  try {
    const names = await readdir(directory);
    if (names.length > LIVE_ORDER_JOURNAL_LIMITS.events + LIVE_ORDER_JOURNAL_LIMITS.pendingFiles + 1) fail('journal-limit');
    const events = names.filter(name => /^\d{6}\.json$/.test(name)).sort();
    const pending = names.filter(name => pendingPattern.test(name));
    if (!names.includes('manifest.json') || names.length !== events.length + pending.length + 1 ||
        events.some((name, i) => name !== filename(i + 1))) fail('journal-invalid');
    if (events.length > LIVE_ORDER_JOURNAL_LIMITS.events) fail('journal-limit');
    const pendingStats: Stats[] = [];
    for (const name of pending) {
      try { const stat = await lstat(join(directory, name)); privateFile(stat); pendingStats.push(stat); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    let committedBytes = 0;
    const checkedRead = async (name: string) => {
      const row = await readPrivate(join(directory, name));
      if (row.stat.nlink === 2 && !pendingStats.some(item => item.ino === row.stat.ino && item.dev === row.stat.dev)) {
        // The publisher may have removed its staging link after our directory listing.
        const fresh = await lstat(join(directory, name));
        if (fresh.nlink !== 1 || fresh.ino !== row.stat.ino || fresh.dev !== row.stat.dev) fail('journal-invalid');
      }
      committedBytes += row.bytes;
      if (committedBytes > committedByteLimit) fail('journal-limit');
      return row.value;
    };
    const manifest = manifestSchema.parse(await checkedRead('manifest.json'));
    const { hash: initialHash, ...body } = manifest;
    if (digest(body) !== initialHash) fail('journal-invalid');
    let admissionPolicy: LiveOrderAdmissionPolicy | null = null;
    if (manifest.schema === 2) {
      try { admissionPolicy = parseLiveOrderAdmissionPolicy(manifest.admissionPolicy); }
      catch { fail('journal-policy-invalid'); }
      if (canonical(admissionPolicy) !== canonical(manifest.admissionPolicy)) fail('journal-policy-invalid');
    }
    let state = createLiveOrderState(), headHash = initialHash;
    const chainHeads = [headHash];
    for (let i = 0; i < events.length; i++) {
      const record = recordSchema.parse(await checkedRead(events[i]));
      const { hash: recordHash, ...recordBody } = record;
      if (record.schema !== manifest.schema || record.journalId !== manifest.journalId || record.sequence !== i + 1 ||
          record.previousHash !== headHash || digest(recordBody) !== recordHash) fail('journal-invalid');
      const event = parseLiveOrderEvent(record.event);
      enforcePolicy(state, event, admissionPolicy);
      state = applyLiveOrderEvent(state, event);
      if (state.events.length !== i + 1 || canonical(state.events[i]) !== canonical(record.event)) fail('journal-invalid');
      headHash = recordHash; chainHeads.push(headHash);
    }
    // The file was synced before publication. Seal a surviving link if the previous
    // process died before syncing its directory; never infer an exchange response.
    await directoryFd.sync();
    return { schema: manifest.schema, kind: 'live-order-rehearsal-journal', nonExecutable: true, captureProvenanceVerified: false,
      admissionPolicy,
      journalId: manifest.journalId, revision: events.length, headHash, pendingFiles: pendingStats.length,
      checkpoint: checkpoint(manifest.schema, manifest.journalId, events.length, headHash), state, chainHeads, committedBytes };
  } finally { await directoryFd.close(); }
}
function assertCheckpoint(state: Loaded, expected: LiveOrderJournalCheckpoint) {
  if (expected.schema !== state.schema || expected.journalId !== state.journalId || expected.revision > state.revision ||
      state.chainHeads[expected.revision] !== expected.headHash) fail('journal-head-conflict');
}
/** Exclusive hard-link publication makes the next sequence a cross-process CAS.
 * The owner and filesystem are trusted. This is not a distributed or tamper-proof log. */
async function publish(directory: string, name: string, value: unknown) {
  const bytes = canonical(value) + '\n';
  if (Buffer.byteLength(bytes) > LIVE_ORDER_JOURNAL_LIMITS.fileBytes) fail('journal-limit');
  const directoryFd = await directoryHandle(directory);
  let pending: string | undefined, published = false;
  try {
    let file: FileHandle | undefined;
    for (let i = 0; i < LIVE_ORDER_JOURNAL_LIMITS.pendingFiles; i++) {
      const candidate = join(directory, '.pending-' + String(i).padStart(2, '0'));
      try {
        file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        pending = candidate; break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!file || !pending) fail('journal-limit');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(pending, join(directory, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('journal-head-conflict');
      // An unexpected link error leaves publication uncertain: retain evidence.
      published = true; fail('journal-publish-uncertain');
    }
    published = true; await directoryFd.sync();
    await unlink(pending); pending = undefined; await directoryFd.sync();
  } catch (error) {
    if (published) fail('journal-publish-uncertain');
    if (error instanceof LiveOrderJournalError) throw error;
    fail('journal-write-failed');
  } finally {
    // Never reclaim a staging slot belonging to another process or a prior crash.
    if (pending && !published) { try { await unlink(pending); await directoryFd.sync(); } catch { /* Retain for inspection. */ } }
    await directoryFd.close();
  }
}
async function createJournal(directory: string, admissionPolicy: LiveOrderAdmissionPolicy | null): Promise<LiveOrderJournalSnapshot> {
  try {
    const parent = dirname(resolve(directory));
    if (parent !== await realpath(parent) || !(await lstat(parent)).isDirectory()) fail('journal-invalid');
    await mkdir(directory, { mode: 0o700 });
    const parentFd = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parentFd.sync(); } finally { await parentFd.close(); }
    const body = { schema: admissionPolicy ? 2 as const : 1 as const, kind: 'live-order-rehearsal-journal' as const, journalId: randomUUID(),
      nonExecutable: true as const, captureProvenanceVerified: false as const,
      ...(admissionPolicy ? { admissionPolicy } : {}) };
    await publish(directory, 'manifest.json', { ...body, hash: digest(body) });
    return snapshot(await load(directory));
  } catch (error) { if (error instanceof LiveOrderJournalError) throw error; fail('journal-write-failed'); }
}
export async function createLiveOrderJournal(directory: string): Promise<LiveOrderJournalSnapshot> {
  return createJournal(directory, null);
}
/** New, isolated rehearsal only. The policy is immutable and enforced by every
 * reader/replay/writer; legacy append cannot bypass it. No migration or live permission. */
export async function createPolicyBoundLiveOrderJournal(directory: string, policy: unknown): Promise<LiveOrderJournalSnapshot> {
  let parsed: LiveOrderAdmissionPolicy;
  try { parsed = parseLiveOrderAdmissionPolicy(policy); } catch { fail('journal-policy-invalid'); }
  return createJournal(directory, parsed);
}
/** An independently retained checkpoint detects missing committed suffixes. Without
 * one, a valid prefix cannot establish freshness. This function never dispatches. */
export async function readLiveOrderJournal(directory: string, minimumCheckpoint?: LiveOrderJournalCheckpoint)
  : Promise<LiveOrderJournalSnapshot> {
  try {
    const parsed = minimumCheckpoint === undefined ? undefined : checkpointSchema.safeParse(minimumCheckpoint);
    if (parsed && !parsed.success) fail('journal-head-conflict');
    const current = await load(directory);
    if (parsed?.success) assertCheckpoint(current, parsed.data);
    return snapshot(current);
  } catch (error) { if (error instanceof LiveOrderJournalError) throw error; fail('journal-invalid'); }
}
/** Persist intent and dispatch-marked as separate events before any future network
 * call. This rehearsal API provides no network permission, sender or retry path. */
export async function appendLiveOrderJournal(directory: string, input: unknown, expected: LiveOrderJournalCheckpoint)
  : Promise<LiveOrderJournalSnapshot & { appended: boolean }> {
  try {
    const parsedHead = checkpointSchema.safeParse(expected);
    if (!parsedHead.success) fail('journal-head-conflict');
    let event: LiveOrderEvent;
    // Clone/validate both caller inputs before asynchronous filesystem work.
    try { event = parseLiveOrderEvent(input); } catch { fail('journal-event-invalid'); }
    const current = await load(directory); assertCheckpoint(current, parsedHead.data);
    const duplicate = current.state.events.find(row => row.eventId === event.eventId);
    if (duplicate) {
      if (canonical(duplicate) !== canonical(event)) fail('journal-event-conflict');
      return { ...snapshot(current), appended: false };
    }
    if (parsedHead.data.headHash !== current.headHash) fail('journal-head-conflict');
    enforcePolicy(current.state, event, current.admissionPolicy);
    let next: LiveOrderState;
    try { next = applyLiveOrderEvent(current.state, event); } catch { fail('journal-event-invalid'); }
    if (next.events.length !== current.revision + 1) fail('journal-event-invalid');
    if (current.revision >= LIVE_ORDER_JOURNAL_LIMITS.events || current.pendingFiles >= LIVE_ORDER_JOURNAL_LIMITS.pendingFiles) fail('journal-limit');
    const body = { schema: current.schema, kind: 'live-order-rehearsal-event' as const, journalId: current.journalId,
      sequence: current.revision + 1, previousHash: current.headHash, event: next.events.at(-1)! };
    const record = { ...body, hash: digest(body) };
    if (current.committedBytes + Buffer.byteLength(canonical(record) + '\n') > committedByteLimit) fail('journal-limit');
    try { await publish(directory, filename(body.sequence), record); }
    catch (error) {
      if (error instanceof LiveOrderJournalError && error.reason === 'journal-head-conflict') {
        const recovered = await load(directory); assertCheckpoint(recovered, parsedHead.data);
        const recorded = recovered.state.events.find(row => row.eventId === event.eventId);
        if (recorded) {
          if (canonical(recorded) !== canonical(event)) fail('journal-event-conflict');
          return { ...snapshot(recovered), appended: false };
        }
      }
      throw error;
    }
    return { ...snapshot(current), revision: body.sequence, headHash: record.hash, state: next,
      checkpoint: checkpoint(current.schema, current.journalId, body.sequence, record.hash), appended: true };
  } catch (error) { if (error instanceof LiveOrderJournalError) throw error; fail('journal-invalid'); }
}
