/** Local synthetic settlement persistence. No exchange transport or order submission. */
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../paper-v2/ledger.js';
import { applySettlementEvent, createSettlementState } from './settlement.js';
import type { SettlementBalances, SettlementEvent, SettlementState } from './settlement.js';
import { applyPaperRiskEvent, createPaperRiskState, paperRiskPolicySchema, PaperRiskError } from './risk.js';
import type { PaperRiskPolicy } from './risk.js';

export const SETTLEMENT_JOURNAL_LIMITS = Object.freeze({ events: 2_000, fileBytes: 128 * 1024,
  directoryBytes: 4 * 1024 * 1024, pendingFiles: 16 });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.discriminatedUnion('schema', [
  z.object({ schema: z.literal(1), kind: z.literal('paired-paper-settlement-journal'),
    journalId: z.string().uuid(), initialBalances: z.unknown(), hash }).strict(),
  z.object({ schema: z.literal(2), kind: z.literal('risk-bound-paper-settlement-journal'),
    journalId: z.string().uuid(), initialBalances: z.unknown(), policy: paperRiskPolicySchema, policyHash: hash, hash }).strict()
]);
const recordFields = { journalId: z.string().uuid(),
  sequence: z.number().int().min(1).max(SETTLEMENT_JOURNAL_LIMITS.events), previousHash: hash,
  event: z.unknown(), hash };
const recordSchema = z.discriminatedUnion('schema', [
  z.object({ schema: z.literal(1), ...recordFields }).strict(),
  z.object({ schema: z.literal(2), ...recordFields, policyHash: hash }).strict()
]);
const pendingPattern = /^\.pending-(?:0[0-9]|1[0-5])$/;
const checkpointSchema = z.object({ journalId: z.string().uuid(),
  revision: z.number().int().min(0).max(SETTLEMENT_JOURNAL_LIMITS.events), headHash: hash }).strict();
export type SettlementJournalCheckpoint = z.infer<typeof checkpointSchema>;
const riskCheckpointSchema = checkpointSchema.extend({ schema: z.literal(2), policyHash: hash }).strict();
export type RiskSettlementJournalCheckpoint = z.infer<typeof riskCheckpointSchema>;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const fileName = (sequence: number) => String(sequence).padStart(6, '0') + '.json';
export class SettlementJournalError extends Error {
  constructor(readonly reason: 'journal-invalid' | 'journal-limit' | 'journal-head-conflict' |
    'journal-event-invalid' | 'journal-write-failed' | 'journal-publish-uncertain' |
    'journal-kind-mismatch' | 'journal-risk-rejected') {
    super(reason); this.name = 'SettlementJournalError';
  }
}
function fail(reason: SettlementJournalError['reason']): never { throw new SettlementJournalError(reason); }
function own(uid: number): boolean { return typeof process.getuid !== 'function' || uid === process.getuid(); }
export interface SettlementJournalSnapshot {
  journalId: string; revision: number; headHash: string; pendingFiles: number; state: SettlementState;
}
export interface RiskSettlementJournalSnapshot extends SettlementJournalSnapshot {
  schema: 2; policy: PaperRiskPolicy; policyHash: string; checkpoint: RiskSettlementJournalCheckpoint;
}
interface LoadedSnapshot extends SettlementJournalSnapshot {
  diskBytes: number; chainHeads: string[]; journalSchema: 1 | 2;
  riskPolicy: PaperRiskPolicy | null; policyHash: string | null;
}
async function directoryHandle(directory: string): Promise<FileHandle> {
  if (resolve(directory) !== await realpath(directory)) fail('journal-invalid');
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || !own(stat.uid)) fail('journal-invalid');
    return fd;
  } catch (error) { await fd.close(); throw error; }
}
async function readPrivate(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !own(stat.uid) || (stat.mode & 0o777) !== 0o600 ||
        stat.nlink < 1 || stat.nlink > 2 || stat.size > SETTLEMENT_JOURNAL_LIMITS.fileBytes) fail('journal-invalid');
    const bytes = Buffer.alloc(SETTLEMENT_JOURNAL_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > SETTLEMENT_JOURNAL_LIMITS.fileBytes) fail('journal-limit');
    return { value: JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown, bytes: length, stat };
  } finally { await file.close(); }
}
async function load(directory: string, expectedSchema: 1 | 2 = 1): Promise<LoadedSnapshot> {
  const fd = await directoryHandle(directory);
  try {
    const names = await readdir(directory);
    if (names.length > SETTLEMENT_JOURNAL_LIMITS.events + SETTLEMENT_JOURNAL_LIMITS.pendingFiles + 1) fail('journal-limit');
    const pending = names.filter(name => pendingPattern.test(name));
    if (pending.length > SETTLEMENT_JOURNAL_LIMITS.pendingFiles) fail('journal-limit');
    const events = names.filter(name => /^\d{6}\.json$/.test(name)).sort();
    if (events.length > SETTLEMENT_JOURNAL_LIMITS.events || !names.includes('manifest.json') ||
        names.length !== events.length + pending.length + 1 ||
        events.some((name, i) => name !== fileName(i + 1))) fail('journal-invalid');
    const pendingStats: Stats[] = [];
    let diskBytes = 0;
    for (const name of pending) {
      try {
        const stat = await lstat(join(directory, name));
        if (!stat.isFile() || !own(stat.uid) || (stat.mode & 0o777) !== 0o600 || stat.nlink < 1 || stat.nlink > 2 ||
            stat.size > SETTLEMENT_JOURNAL_LIMITS.fileBytes) fail('journal-invalid');
        diskBytes += stat.size; pendingStats.push(stat);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const checkedRead = async (name: string) => {
      const row = await readPrivate(join(directory, name));
      if (row.stat.nlink === 2 && !pendingStats.some(stat => stat.ino === row.stat.ino && stat.dev === row.stat.dev)) {
        // A publisher may have removed its staging link after the directory listing.
        const fresh = await lstat(join(directory, name));
        if (fresh.nlink !== 1 || fresh.ino !== row.stat.ino || fresh.dev !== row.stat.dev) fail('journal-invalid');
      }
      diskBytes += row.bytes;
      if (diskBytes > SETTLEMENT_JOURNAL_LIMITS.directoryBytes) fail('journal-limit');
      return row.value;
    };
    const manifest = manifestSchema.parse(await checkedRead('manifest.json'));
    if (manifest.schema !== expectedSchema) fail('journal-kind-mismatch');
    const { hash: manifestHash, ...manifestBody } = manifest;
    if (digest(manifestBody) !== manifestHash) fail('journal-invalid');
    if (manifest.schema === 2 && digest(manifest.policy) !== manifest.policyHash) fail('journal-invalid');
    let riskState = manifest.schema === 2
      ? createPaperRiskState(manifest.initialBalances as SettlementBalances, manifest.policy) : null;
    let state = riskState?.settlement ?? createSettlementState(manifest.initialBalances as SettlementBalances);
    if (canonical(state.initialBalances) !== canonical(manifest.initialBalances)) fail('journal-invalid');
    let headHash = manifestHash;
    const chainHeads = [manifestHash];
    for (let i = 0; i < events.length; i++) {
      const record = recordSchema.parse(await checkedRead(events[i]));
      const { hash: recordHash, ...body } = record;
      if (record.schema !== manifest.schema || record.journalId !== manifest.journalId ||
          record.sequence !== i + 1 || record.previousHash !== headHash || digest(body) !== recordHash ||
          (record.schema === 2 && (manifest.schema !== 2 || record.policyHash !== manifest.policyHash))) fail('journal-invalid');
      if (riskState) {
        riskState = applyPaperRiskEvent(riskState, record.event as SettlementEvent);
        state = riskState.settlement;
      } else state = applySettlementEvent(state, record.event as SettlementEvent);
      if (state.journal.length !== i + 1 || canonical(state.journal[i]) !== canonical(record.event)) fail('journal-invalid');
      headHash = recordHash;
      chainHeads.push(recordHash);
    }
    // Published file data was fsynced before its exclusive link. Seal that link on
    // recovery even when the previous process died before its directory fsync.
    await fd.sync();
    return { journalId: manifest.journalId, revision: events.length, headHash,
      pendingFiles: pendingStats.length, state, diskBytes, chainHeads, journalSchema: manifest.schema,
      riskPolicy: riskState?.policy ?? null, policyHash: manifest.schema === 2 ? manifest.policyHash : null };
  } finally { await fd.close(); }
}
function publicSnapshot(snapshot: LoadedSnapshot): SettlementJournalSnapshot {
  const { journalId, revision, headHash, pendingFiles, state } = snapshot;
  return { journalId, revision, headHash, pendingFiles, state };
}
function riskSnapshot(snapshot: LoadedSnapshot): RiskSettlementJournalSnapshot {
  if (snapshot.journalSchema !== 2 || !snapshot.riskPolicy || !snapshot.policyHash) fail('journal-kind-mismatch');
  return { ...publicSnapshot(snapshot), schema: 2, policy: snapshot.riskPolicy, policyHash: snapshot.policyHash,
    checkpoint: { schema: 2, journalId: snapshot.journalId, revision: snapshot.revision,
      headHash: snapshot.headHash, policyHash: snapshot.policyHash } };
}
function assertCheckpoint(snapshot: LoadedSnapshot, checkpoint: SettlementJournalCheckpoint) {
  if (checkpoint.journalId !== snapshot.journalId || checkpoint.revision > snapshot.revision ||
      checkpoint.headHash !== snapshot.chainHeads[checkpoint.revision]) fail('journal-head-conflict');
}
function assertRiskCheckpoint(snapshot: LoadedSnapshot, checkpoint: RiskSettlementJournalCheckpoint) {
  assertCheckpoint(snapshot, checkpoint);
  if (snapshot.journalSchema !== 2 || checkpoint.policyHash !== snapshot.policyHash) fail('journal-head-conflict');
}
/** No overwrite: the next immutable sequence is also the cross-process CAS. */
async function publish(directory: string, name: string, value: unknown) {
  const bytes = canonical(value) + '\n';
  if (Buffer.byteLength(bytes) > SETTLEMENT_JOURNAL_LIMITS.fileBytes) fail('journal-limit');
  let pending: string | undefined;
  const fd = await directoryHandle(directory);
  let staged = false, published = false;
  try {
    let file: FileHandle | undefined;
    // Fixed exclusive slots bound simultaneous writers as well as crash remnants.
    // An occupied slot is never removed or reclaimed by another publisher.
    for (let slot = 0; slot < SETTLEMENT_JOURNAL_LIMITS.pendingFiles; slot++) {
      const candidate = join(directory, '.pending-' + String(slot).padStart(2, '0'));
      try {
        file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        pending = candidate; staged = true; break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!file || !pending) fail('journal-limit');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(pending, join(directory, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('journal-head-conflict');
      // An unexpected publication error may have occurred after the link was
      // made. Preserve evidence and require a fresh read before another decision.
      published = true;
      fail('journal-publish-uncertain');
    }
    published = true;
    await fd.sync();
    await unlink(pending); staged = false;
    await fd.sync();
  } catch (error) {
    if (published) fail('journal-publish-uncertain');
    if (error instanceof SettlementJournalError) throw error;
    fail('journal-write-failed');
  } finally {
    // Only our own unpublished staging file is eligible for cleanup. A committed
    // link after an I/O error is retained for explicit read/reconciliation.
    if (staged && !published && pending) { try { await unlink(pending); await fd.sync(); } catch { /* Retain on cleanup failure. */ } }
    await fd.close();
  }
}
async function createJournal(directory: string, input: SettlementBalances, policy?: PaperRiskPolicy): Promise<LoadedSnapshot> {
  try {
    const riskState = policy === undefined ? null : createPaperRiskState(input, policy);
    const state = riskState?.settlement ?? createSettlementState(input);
    const parent = dirname(resolve(directory));
    if (parent !== await realpath(parent) || !(await lstat(parent)).isDirectory()) fail('journal-invalid');
    await mkdir(directory, { mode: 0o700 });
    const parentFd = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parentFd.sync(); } finally { await parentFd.close(); }
    const identity = { journalId: randomUUID(), initialBalances: state.initialBalances };
    const body = riskState ? { schema: 2 as const, kind: 'risk-bound-paper-settlement-journal' as const,
      ...identity, policy: riskState.policy, policyHash: digest(riskState.policy) }
      : { schema: 1 as const, kind: 'paired-paper-settlement-journal' as const, ...identity };
    await publish(directory, 'manifest.json', { ...body, hash: digest(body) });
    return await load(directory, body.schema);
  } catch (error) {
    if (error instanceof SettlementJournalError) throw error;
    fail('journal-write-failed');
  }
}
export async function createSettlementJournal(directory: string, input: SettlementBalances): Promise<SettlementJournalSnapshot> {
  return publicSnapshot(await createJournal(directory, input));
}
export async function createRiskSettlementJournal(directory: string, input: SettlementBalances, policy: PaperRiskPolicy)
  : Promise<RiskSettlementJournalSnapshot> {
  // An omitted runtime argument must not create a legacy journal as a fallback.
  if (!paperRiskPolicySchema.safeParse(policy).success) fail('journal-risk-rejected');
  return riskSnapshot(await createJournal(directory, input, policy));
}
/** A supplied external checkpoint must remain in the recovered prefix.
 * Without it, a valid chain alone does not establish freshness or detect suffix deletion. */
export async function readSettlementJournal(directory: string, minimumCheckpoint?: SettlementJournalCheckpoint): Promise<SettlementJournalSnapshot> {
  try {
    const checkpoint = minimumCheckpoint === undefined ? undefined : checkpointSchema.safeParse(minimumCheckpoint);
    if (checkpoint && !checkpoint.success) fail('journal-head-conflict');
    const snapshot = await load(directory, 1);
    if (checkpoint?.success) assertCheckpoint(snapshot, checkpoint.data);
    return publicSnapshot(snapshot);
  }
  catch (error) { if (error instanceof SettlementJournalError) throw error; fail('journal-invalid'); }
}
export async function readRiskSettlementJournal(directory: string, minimumCheckpoint?: RiskSettlementJournalCheckpoint)
  : Promise<RiskSettlementJournalSnapshot> {
  try {
    const checkpoint = minimumCheckpoint === undefined ? undefined : riskCheckpointSchema.safeParse(minimumCheckpoint);
    if (checkpoint && !checkpoint.success) fail('journal-head-conflict');
    const snapshot = await load(directory, 2);
    if (checkpoint?.success) assertRiskCheckpoint(snapshot, checkpoint.data);
    return riskSnapshot(snapshot);
  }
  catch (error) { if (error instanceof SettlementJournalError) throw error; fail('journal-invalid'); }
}
async function appendJournal(directory: string, input: SettlementEvent, expected: string | RiskSettlementJournalCheckpoint,
  schema: 1 | 2): Promise<LoadedSnapshot & { appended: boolean }> {
  try {
    // Clone and validate the caller's expectation before any asynchronous work.
    const riskHead = schema === 2 ? riskCheckpointSchema.safeParse(expected) : null;
    if (riskHead && !riskHead.success || schema === 1 && !hash.safeParse(expected).success) fail('journal-head-conflict');
    const checkpoint = riskHead?.success ? riskHead.data : null;
    const expectedHeadHash = checkpoint ? checkpoint.headHash : expected as string;
    const before = await load(directory, schema);
    if (checkpoint) {
      assertRiskCheckpoint(before, checkpoint);
      const duplicate = before.state.journal.find(event => event.id === input?.id);
      if (expectedHeadHash !== before.headHash && (!duplicate || canonical(duplicate) !== canonical(input))) fail('journal-head-conflict');
    }
    let next: SettlementState;
    try {
      next = before.riskPolicy ? applyPaperRiskEvent({ policy: before.riskPolicy, settlement: before.state }, input).settlement
        : applySettlementEvent(before.state, input);
    } catch (error) {
      if (error instanceof PaperRiskError) fail('journal-risk-rejected');
      fail('journal-event-invalid');
    }
    if (next === before.state) return { ...before, appended: false };
    if (expectedHeadHash !== before.headHash) fail('journal-head-conflict');
    if (before.pendingFiles >= SETTLEMENT_JOURNAL_LIMITS.pendingFiles) fail('journal-limit');
    const fields = { journalId: before.journalId, sequence: before.revision + 1,
      previousHash: before.headHash, event: next.journal.at(-1)! };
    const body = schema === 2 ? { schema: 2 as const, ...fields, policyHash: before.policyHash! }
      : { schema: 1 as const, ...fields };
    const record = { ...body, hash: digest(body) };
    const bytes = Buffer.byteLength(canonical(record) + '\n');
    if (before.diskBytes + 2 * bytes > SETTLEMENT_JOURNAL_LIMITS.directoryBytes) fail('journal-limit');
    try { await publish(directory, fileName(body.sequence), record); }
    catch (error) {
      if (error instanceof SettlementJournalError && error.reason === 'journal-head-conflict') {
        const current = await load(directory, schema);
        if (checkpoint) assertRiskCheckpoint(current, checkpoint);
        const duplicate = current.state.journal.find(event => event.id === body.event.id);
        if (duplicate && canonical(duplicate) === canonical(body.event)) return { ...current, appended: false };
      }
      throw error;
    }
    return { ...before, revision: body.sequence, headHash: record.hash,
      state: next, chainHeads: [...before.chainHeads, record.hash], diskBytes: before.diskBytes + bytes, appended: true };
  } catch (error) {
    if (error instanceof SettlementJournalError) throw error;
    fail('journal-invalid');
  }
}
export async function appendSettlementJournal(directory: string, input: SettlementEvent, expectedHeadHash: string)
  : Promise<SettlementJournalSnapshot & { appended: boolean }> {
  const result = await appendJournal(directory, input, expectedHeadHash, 1);
  return { ...publicSnapshot(result), appended: result.appended };
}
/** Rebuild risk under the manifest policy, then atomically compete for the next immutable record. */
export async function appendRiskSettlementJournal(directory: string, input: SettlementEvent, expected: RiskSettlementJournalCheckpoint)
  : Promise<RiskSettlementJournalSnapshot & { appended: boolean }> {
  const result = await appendJournal(directory, input, expected, 2);
  return { ...riskSnapshot(result), appended: result.appended };
}
