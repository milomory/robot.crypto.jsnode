/** Private preparation reservations under one configured root. No transport, production ownership or live authority. */
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, link, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseAccountBindingPin, verifyPinIntegrity } from '../accounts/account-binding.js';
import { verifyFundsEvidence, type VerifiedFundsEvidence } from './funds-evidence.js';
import { verifyAccountFeeEvidence, type VerifiedAccountFeeEvidence } from './account-fee-evidence.js';
import { assessAccountFundsAdmission, assessVerifiedAccountFundsAdmission } from './account-funds-admission.js';
import { canonicalLiveOrderJson as canonical, parseLiveOrderEvent, type LiveOrderIntent } from './order-lifecycle.js';
import { validateLiveLimitsDraft } from './launch-readiness.js';

export const ACCOUNT_FUNDS_JOURNAL_LIMITS = Object.freeze({ records: 256, imports: 8, fileBytes: 2 * 1024 * 1024,
  directoryBytes: 18 * 1024 * 1024, pendingFiles: 4 });
const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const time = z.number().int().positive().safe().max(8_640_000_000_000_000);
const receipt = z.object({ schema: z.literal(1), kind: z.literal('account-funds-observation-receipt'),
  archiveId: uuid, archiveHash: hash }).strict();
const encoded = (bytes: number) => z.string().max(4 * Math.ceil(bytes / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const envelopeSchema = z.object({ archiveBytes: encoded(1024 * 1024), pinBytes: encoded(64 * 1024), receipt }).strict();
const manifestBase = {
  journalId: uuid, rootPath: z.string().min(1), rootDevice: z.number().int().nonnegative().safe(), rootInode: z.number().int().positive().safe(),
  scopeHash: hash, createdAt: time, limits: z.unknown(), executable: z.literal(false), accountGlobalOwnershipVerified: z.literal(false), hash };
const manifestSchema = z.discriminatedUnion('schema', [
  z.object({ ...manifestBase, schema: z.literal(1), kind: z.literal('account-funds-preparation-journal') }).strict(),
  z.object({ ...manifestBase, schema: z.literal(2), kind: z.literal('fee-bound-account-funds-preparation-journal'), collectorSourceHash: hash }).strict(),
]);
const feeReceipt = z.object({ schema: z.literal(1), kind: z.literal('account-fees-observation-receipt'), archiveId: uuid, archiveHash: hash }).strict();
const feeEnvelopeSchema = z.object({ archiveBytes: encoded(128 * 1024), receipt: feeReceipt }).strict();
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fee-bound-evidence-imported'), checkedAt: time, envelope: envelopeSchema, feeEnvelope: feeEnvelopeSchema }).strict(),
  z.object({ type: z.literal('fee-bound-intent-staged'), checkedAt: time, intent: z.unknown() }).strict(),
  z.object({ type: z.literal('evidence-imported'), checkedAt: time, envelope: envelopeSchema }).strict(),
  z.object({ type: z.literal('intent-staged'), checkedAt: time, intent: z.unknown(), feeEvidence: z.unknown() }).strict(),
  z.object({ type: z.literal('intent-released'), checkedAt: time, intentId: uuid, reason: z.literal('operator-released') }).strict(),
]);
const recordSchema = z.object({ schema: z.union([z.literal(1), z.literal(2)]), kind: z.literal('account-funds-preparation-event'), journalId: uuid,
  sequence: z.number().int().min(1).max(ACCOUNT_FUNDS_JOURNAL_LIMITS.records), previousHash: hash, event: eventSchema, hash }).strict();
const checkpointSchema = z.object({ schema: z.union([z.literal(1), z.literal(2)]), kind: z.literal('account-funds-preparation-checkpoint'), journalId: uuid,
  revision: z.number().int().min(0).max(ACCOUNT_FUNDS_JOURNAL_LIMITS.records), headHash: hash }).strict();
export type AccountFundsJournalCheckpoint = z.infer<typeof checkpointSchema>;
export interface AccountFundsJournalSnapshot {
  schema: 1 | 2; kind: 'account-funds-preparation-journal' | 'fee-bound-account-funds-preparation-journal'; executable: false; liveAllowed: false;
  accountGlobalOwnershipVerified: false; feeProvenanceVerified: boolean;
  latestFeeEvidenceReceipt?: z.infer<typeof feeReceipt> | null;
  checkpoint: AccountFundsJournalCheckpoint; preparedIntents: readonly LiveOrderIntent[];
  latestEvidenceReceipt: z.infer<typeof receipt> | null; lastCheckedAt: number; limits: unknown | null;
}
type Envelope = z.infer<typeof envelopeSchema>;
type FeeEnvelope = z.infer<typeof feeEnvelopeSchema>;
type Event = z.infer<typeof eventSchema>;
type Manifest = z.infer<typeof manifestSchema>;
interface Loaded {
  manifest: Manifest; checkpoint: AccountFundsJournalCheckpoint; heads: string[]; prepared: LiveOrderIntent[];
  usedIntentIds: Set<string>; usedArchives: Set<string>; envelope: Envelope | null; lastCheckedAt: number;
  feeEnvelope: FeeEnvelope | null; usedFeeArchives: Set<string>; lastFeeCaptureStartedAt: number;
  lastCaptureStartedAt: number; bytes: number; pendingFiles: number;
}
export type AccountFundsJournalErrorCode = 'journal-invalid' | 'journal-limit' | 'journal-head-conflict' |
  'journal-evidence-invalid' | 'journal-event-invalid' | 'journal-policy-blocked' | 'journal-write-failed' | 'journal-publish-uncertain';
export class AccountFundsJournalError extends Error {
  constructor(readonly code: AccountFundsJournalErrorCode) { super(code); this.name = 'AccountFundsJournalError'; }
}
const fail = (code: AccountFundsJournalErrorCode): never => { throw new AccountFundsJournalError(code); };
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const filename = (sequence: number) => String(sequence).padStart(6, '0') + '.json';
const pendingPattern = /^\.pending-0[0-3]$/;
const committedBudget = ACCOUNT_FUNDS_JOURNAL_LIMITS.directoryBytes - ACCOUNT_FUNDS_JOURNAL_LIMITS.fileBytes * ACCOUNT_FUNDS_JOURNAL_LIMITS.pendingFiles;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function clone(value: unknown): unknown { return JSON.parse(canonical(value)) as unknown; }
function keyCopy(key: unknown): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) return fail('journal-evidence-invalid');
  return Buffer.from(key);
}
function rawCopy(raw: unknown, max: number): Buffer {
  if (!(raw instanceof Uint8Array) || !raw.byteLength || raw.byteLength > max) return fail('journal-evidence-invalid');
  return Buffer.from(raw);
}
function canonicalPin(raw: Buffer, key: Buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw), parsed: unknown = JSON.parse(text);
    if (JSON.stringify(parsed) + '\n' !== text) return fail('journal-evidence-invalid');
    const pin = parseAccountBindingPin(parsed);
    if (!verifyPinIntegrity(pin, key)) return fail('journal-evidence-invalid');
    return pin;
  } catch { return fail('journal-evidence-invalid'); }
}
function scope(raw: Buffer, key: Buffer): string {
  const pin = canonicalPin(raw, key);
  // Stable through credential rotation and new observations. This hash is private metadata, not a public identity.
  return digest({ context: pin.context, mexc: { uid: pin.identities.mexc.uid },
    okx: { uid: pin.identities.okx.uid, mainUid: pin.identities.okx.mainUid, accountType: pin.identities.okx.accountType } });
}
function intent(value: unknown, checkedAt: number): LiveOrderIntent {
  try {
    const event = parseLiveOrderEvent({ eventId: '00000000-0000-4000-8000-000000000000',
      type: 'intent-created', at: new Date(checkedAt).toISOString(), intent: value });
    if (event.type !== 'intent-created') return fail('journal-event-invalid');
    return event.intent;
  } catch { return fail('journal-event-invalid'); }
}
function parsedLimits(value: unknown): unknown | null {
  if (value === null) return null;
  if (validateLiveLimitsDraft(value).status !== 'valid-draft') return fail('journal-event-invalid');
  return clone(value);
}
function decode(value: string, max: number): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) return fail('journal-evidence-invalid');
  return bytes;
}
function evidence(envelope: Envelope, key: Buffer, checkedAt: number, previousCheckedAt: number, scopeHash: string): VerifiedFundsEvidence {
  try {
    const archiveBytes = decode(envelope.archiveBytes, 1024 * 1024), pinBytes = decode(envelope.pinBytes, 64 * 1024);
    if (scope(pinBytes, key) !== scopeHash) return fail('journal-evidence-invalid');
    return verifyFundsEvidence({ archiveBytes, receipt: envelope.receipt, pinBytes, bindingKey: key, now: checkedAt, previousCheckedAt });
  } catch { return fail('journal-evidence-invalid'); }
}
function feeEvidence(envelope: Envelope, fees: FeeEnvelope, key: Buffer, checkedAt: number, previousCheckedAt: number, collectorSourceHash: string): VerifiedAccountFeeEvidence {
  try {
    return verifyAccountFeeEvidence({ archiveBytes: decode(fees.archiveBytes, 128 * 1024), receipt: fees.receipt,
      pinBytes: decode(envelope.pinBytes, 64 * 1024), bindingKey: key, now: checkedAt, previousCheckedAt, expectedCollectorSourceHash: collectorSourceHash });
  } catch { return fail('journal-evidence-invalid'); }
}
function owned(stat: Stats) { return typeof process.getuid === 'function' && stat.uid === process.getuid(); }
function privateFile(stat: Stats) {
  if (!stat.isFile() || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink < 1 || stat.nlink > 2 ||
    stat.size > ACCOUNT_FUNDS_JOURNAL_LIMITS.fileBytes) return fail('journal-invalid');
}
async function directoryHandle(directory: string): Promise<FileHandle> {
  if (resolve(directory) !== await realpath(directory)) return fail('journal-invalid');
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o777) !== 0o700) return fail('journal-invalid');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readPrivate(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); privateFile(stat);
    const data = Buffer.alloc(ACCOUNT_FUNDS_JOURNAL_LIMITS.fileBytes + 1); let length = 0;
    while (length < data.length) {
      const part = await handle.read(data, length, data.length - length, null); if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > ACCOUNT_FUNDS_JOURNAL_LIMITS.fileBytes) return fail('journal-limit');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)), value: unknown = JSON.parse(text);
    if (canonical(value) + '\n' !== text) return fail('journal-invalid');
    return { value, bytes: length, stat };
  } finally { await handle.close(); }
}
function checkpoint(journalId: string, revision: number, headHash: string, schema: 1 | 2 = 1): AccountFundsJournalCheckpoint {
  return { schema, kind: 'account-funds-preparation-checkpoint', journalId, revision, headHash };
}
function snapshot(state: Loaded): AccountFundsJournalSnapshot {
  return freeze({ schema: state.manifest.schema, kind: state.manifest.kind, executable: false, liveAllowed: false,
    accountGlobalOwnershipVerified: false, feeProvenanceVerified: state.manifest.schema === 2 && state.feeEnvelope !== null,
    ...(state.manifest.schema === 2 ? { latestFeeEvidenceReceipt: state.feeEnvelope ? { ...state.feeEnvelope.receipt } : null } : {}), checkpoint: { ...state.checkpoint },
    preparedIntents: [...state.prepared], latestEvidenceReceipt: state.envelope ? { ...state.envelope.receipt } : null,
    lastCheckedAt: state.lastCheckedAt, limits: clone(state.manifest.limits) });
}
function apply(state: Loaded, event: Event, key: Buffer) {
  if (event.checkedAt < state.lastCheckedAt) return fail('journal-event-invalid');
  const bound = state.manifest.schema === 2;
  if ((event.type === 'evidence-imported' || event.type === 'intent-staged') && bound ||
      (event.type === 'fee-bound-evidence-imported' || event.type === 'fee-bound-intent-staged') && !bound) return fail('journal-event-invalid');
  if (event.type === 'evidence-imported' || event.type === 'fee-bound-evidence-imported') {
    if (state.usedArchives.size >= ACCOUNT_FUNDS_JOURNAL_LIMITS.imports) return fail('journal-limit');
    const checked = evidence(event.envelope, key, event.checkedAt, state.lastCheckedAt, state.manifest.scopeHash);
    if (checked.startedAt < state.lastCaptureStartedAt || state.usedArchives.has(checked.receipt.archiveId)) return fail('journal-evidence-invalid');
    if (event.type === 'fee-bound-evidence-imported') {
      if (state.manifest.schema !== 2) return fail('journal-event-invalid');
      const fees = feeEvidence(event.envelope, event.feeEnvelope, key, event.checkedAt, state.lastCheckedAt, state.manifest.collectorSourceHash);
      if (fees.pinHash !== checked.pinHash || fees.bundleVersion !== checked.bundleVersion ||
          fees.startedAt < state.lastFeeCaptureStartedAt || state.usedFeeArchives.has(fees.receipt.archiveId)) return fail('journal-evidence-invalid');
      state.feeEnvelope = event.feeEnvelope; state.lastFeeCaptureStartedAt = fees.startedAt; state.usedFeeArchives.add(fees.receipt.archiveId);
    }
    state.envelope = event.envelope; state.lastCaptureStartedAt = checked.startedAt; state.usedArchives.add(checked.receipt.archiveId);
  } else if (event.type === 'intent-staged' || event.type === 'fee-bound-intent-staged') {
    if (!state.envelope) return fail('journal-policy-blocked');
    const proposed = intent(event.intent, event.checkedAt);
    if (state.usedIntentIds.has(proposed.orderIntentId)) return fail('journal-event-invalid');
    const checked = evidence(state.envelope, key, event.checkedAt, state.lastCheckedAt, state.manifest.scopeHash);
    const common = { intent: proposed, preparedIntents: state.prepared, evidence: checked,
      limits: state.manifest.limits, now: event.checkedAt, previousCheckedAt: state.lastCheckedAt };
    let allowed: boolean;
    if (event.type === 'fee-bound-intent-staged') {
      if (state.manifest.schema !== 2 || !state.feeEnvelope) return fail('journal-policy-blocked');
      const fees = feeEvidence(state.envelope, state.feeEnvelope, key, event.checkedAt, state.lastCheckedAt, state.manifest.collectorSourceHash);
      allowed = assessVerifiedAccountFundsAdmission({ ...common, feeEvidence: fees }).allowedForPreparation;
    } else allowed = assessAccountFundsAdmission({ ...common, feeEvidence: event.feeEvidence }).allowedForPreparation;
    if (!allowed) return fail('journal-policy-blocked');
    state.prepared.push(proposed); state.usedIntentIds.add(proposed.orderIntentId);
  } else {
    const index = state.prepared.findIndex(item => item.orderIntentId === event.intentId);
    if (index < 0) return fail('journal-event-invalid');
    state.prepared.splice(index, 1);
  }
  state.lastCheckedAt = event.checkedAt;
}
async function load(directory: string, key: Buffer): Promise<Loaded> {
  const handle = await directoryHandle(directory);
  try {
    const stat = await handle.stat(), names = await readdir(directory);
    if (names.length > ACCOUNT_FUNDS_JOURNAL_LIMITS.records + ACCOUNT_FUNDS_JOURNAL_LIMITS.pendingFiles + 1) return fail('journal-limit');
    const records = names.filter(name => /^\d{6}\.json$/.test(name)).sort(), pending = names.filter(name => pendingPattern.test(name));
    if (!names.includes('manifest.json') || names.length !== records.length + pending.length + 1 ||
        records.some((name, index) => name !== filename(index + 1))) return fail('journal-invalid');
    const pendingStats: Stats[] = [];
    for (const name of pending) {
      try { const p = await lstat(join(directory, name)); privateFile(p); pendingStats.push(p); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    let bytes = 0;
    const checkedRead = async (name: string) => {
      const row = await readPrivate(join(directory, name)); bytes += row.bytes;
      if (bytes > committedBudget) return fail('journal-limit');
      if (row.stat.nlink === 2 && !pendingStats.some(item => item.ino === row.stat.ino && item.dev === row.stat.dev)) {
        const fresh = await lstat(join(directory, name));
        if (fresh.nlink !== 1 || fresh.ino !== row.stat.ino || fresh.dev !== row.stat.dev) return fail('journal-invalid');
      }
      return row.value;
    };
    const manifest = manifestSchema.parse(await checkedRead('manifest.json')), { hash: initialHash, ...body } = manifest;
    if (digest(body) !== initialHash || manifest.rootPath !== resolve(directory) || manifest.rootDevice !== stat.dev || manifest.rootInode !== stat.ino) return fail('journal-invalid');
    parsedLimits(manifest.limits);
    const state: Loaded = { manifest, checkpoint: checkpoint(manifest.journalId, 0, initialHash, manifest.schema), heads: [initialHash], prepared: [],
      usedIntentIds: new Set(), usedArchives: new Set(), envelope: null, lastCheckedAt: manifest.createdAt,
      lastCaptureStartedAt: 0, feeEnvelope: null, usedFeeArchives: new Set(), lastFeeCaptureStartedAt: 0, bytes, pendingFiles: pendingStats.length };
    for (let index = 0; index < records.length; index++) {
      const record = recordSchema.parse(await checkedRead(records[index])), { hash: nextHash, ...recordBody } = record;
      if (record.schema !== manifest.schema || record.journalId !== manifest.journalId || record.sequence !== index + 1 || record.previousHash !== state.checkpoint.headHash ||
        digest(recordBody) !== nextHash) return fail('journal-invalid');
      apply(state, record.event, key);
      state.checkpoint = checkpoint(manifest.journalId, index + 1, nextHash, manifest.schema); state.heads.push(nextHash);
    }
    state.bytes = bytes; await handle.sync(); return state;
  } finally { await handle.close(); }
}
function assertCheckpoint(state: Loaded, input: unknown, exact: boolean) {
  const expected = checkpointSchema.parse(input);
  if (expected.schema !== state.manifest.schema || expected.journalId !== state.manifest.journalId || expected.revision > state.checkpoint.revision ||
      state.heads[expected.revision] !== expected.headHash || (exact && expected.headHash !== state.checkpoint.headHash)) return fail('journal-head-conflict');
}
/** One sequence file is the cross-process CAS; failed/uncertain publication never grants a reservation twice. */
async function publish(directory: string, name: string, value: unknown) {
  const bytes = canonical(value) + '\n';
  if (Buffer.byteLength(bytes) > ACCOUNT_FUNDS_JOURNAL_LIMITS.fileBytes) return fail('journal-limit');
  const handle = await directoryHandle(directory); let pending: string | undefined, published = false;
  try {
    let file: FileHandle | undefined;
    for (let index = 0; index < ACCOUNT_FUNDS_JOURNAL_LIMITS.pendingFiles; index++) {
      const candidate = join(directory, '.pending-' + String(index).padStart(2, '0'));
      try { file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); pending = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!file || !pending) return fail('journal-limit');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(pending, join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('journal-head-conflict'); published = true; return fail('journal-publish-uncertain'); }
    published = true; await handle.sync(); await unlink(pending); pending = undefined; await handle.sync();
  } catch (error) {
    if (published) return fail('journal-publish-uncertain');
    if (error instanceof AccountFundsJournalError) throw error;
    return fail('journal-write-failed');
  } finally {
    if (pending && !published) { try { await unlink(pending); await handle.sync(); } catch { /* Retain uncertain staging evidence. */ } }
    await handle.close();
  }
}
async function append(directory: string, event: Event, expected: unknown, key: Buffer, mode: 1 | 2 = 1) {
  const current = await load(directory, key); if (current.manifest.schema !== mode) return fail('journal-invalid'); assertCheckpoint(current, expected, true);
  if (current.checkpoint.revision >= ACCOUNT_FUNDS_JOURNAL_LIMITS.records || current.pendingFiles >= ACCOUNT_FUNDS_JOURNAL_LIMITS.pendingFiles) return fail('journal-limit');
  apply(current, event, key);
  const body = { schema: current.manifest.schema, kind: 'account-funds-preparation-event', journalId: current.manifest.journalId,
    sequence: current.checkpoint.revision + 1, previousHash: current.checkpoint.headHash, event };
  const record = { ...body, hash: digest(body) };
  if (current.bytes + Buffer.byteLength(canonical(record) + '\n') > committedBudget) return fail('journal-limit');
  await publish(directory, filename(body.sequence), record);
  current.checkpoint = checkpoint(body.journalId, body.sequence, record.hash, current.manifest.schema); return snapshot(current);
}
async function protectedCall<T>(bindingKey: unknown, operation: (key: Buffer) => Promise<T>): Promise<T> {
  const key = keyCopy(bindingKey);
  try { return await operation(key); }
  catch (error) { if (error instanceof AccountFundsJournalError) throw error; return fail('journal-invalid'); }
  finally { key.fill(0); }
}
/** Caller chooses one private preparation root. Creating another root conveys no shared account authority. */
async function createJournal(directory: string, input: { pinBytes: Uint8Array; bindingKey: Uint8Array; limits: unknown | null },
  now: number, collectorSourceHash?: string): Promise<AccountFundsJournalSnapshot> {
  return protectedCall(input.bindingKey, async key => {
    const pinBytes = rawCopy(input.pinBytes, 64 * 1024), scopeHash = scope(pinBytes, key), limits = parsedLimits(input.limits), createdAt = time.parse(now);
    const selected = resolve(directory), parent = dirname(selected);
    if (parent !== await realpath(parent)) return fail('journal-invalid');
    await mkdir(selected, { mode: 0o700 });
    const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    const handle = await directoryHandle(selected); const stat = await handle.stat(); await handle.close();
    const body = { schema: collectorSourceHash === undefined ? 1 : 2,
      kind: collectorSourceHash === undefined ? 'account-funds-preparation-journal' : 'fee-bound-account-funds-preparation-journal',
      ...(collectorSourceHash === undefined ? {} : { collectorSourceHash }), journalId: randomUUID(), rootPath: selected,
      rootDevice: stat.dev, rootInode: stat.ino, scopeHash, createdAt, limits, executable: false, accountGlobalOwnershipVerified: false };
    await publish(selected, 'manifest.json', { ...body, hash: digest(body) }); return snapshot(await load(selected, key));
  });
}
export async function createAccountFundsJournal(directory: string,
  input: { pinBytes: Uint8Array; bindingKey: Uint8Array; limits: unknown | null }, now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  return createJournal(directory, input, now);
}
export async function importAccountFundsJournalEvidence(directory: string,
  input: { archiveBytes: Uint8Array; receipt: unknown; pinBytes: Uint8Array; bindingKey: Uint8Array },
  expected: AccountFundsJournalCheckpoint, now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  return protectedCall(input.bindingKey, async key => {
    const event = eventSchema.parse({ type: 'evidence-imported', checkedAt: now, envelope: {
      archiveBytes: rawCopy(input.archiveBytes, 1024 * 1024).toString('base64'), pinBytes: rawCopy(input.pinBytes, 64 * 1024).toString('base64'), receipt: clone(input.receipt) } });
    const head = checkpointSchema.parse(expected); return append(resolve(directory), event, head, key);
  });
}
export async function stageAccountFundsJournalIntent(directory: string,
  input: { intent: unknown; feeEvidence: unknown; bindingKey: Uint8Array }, expected: AccountFundsJournalCheckpoint,
  now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  return protectedCall(input.bindingKey, async key => {
    const checkedAt = time.parse(now), event = eventSchema.parse({ type: 'intent-staged', checkedAt,
      intent: intent(input.intent, checkedAt), feeEvidence: clone(input.feeEvidence) });
    const head = checkpointSchema.parse(expected); return append(resolve(directory), event, head, key);
  });
}
export async function releaseAccountFundsJournalIntent(directory: string,
  input: { intentId: string; reason: 'operator-released'; bindingKey: Uint8Array }, expected: AccountFundsJournalCheckpoint,
  now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  return protectedCall(input.bindingKey, async key => {
    const event = eventSchema.parse({ type: 'intent-released', checkedAt: now, intentId: input.intentId, reason: input.reason });
    const head = checkpointSchema.parse(expected); return append(resolve(directory), event, head, key);
  });
}
export async function readAccountFundsJournal(directory: string, bindingKey: Uint8Array,
  minimumCheckpoint?: AccountFundsJournalCheckpoint): Promise<AccountFundsJournalSnapshot> {
  return protectedCall(bindingKey, async key => {
    const expected = minimumCheckpoint === undefined ? undefined : checkpointSchema.parse(minimumCheckpoint);
    const current = await load(resolve(directory), key); if (current.manifest.schema !== 1) return fail('journal-invalid'); if (expected) assertCheckpoint(current, expected, false); return snapshot(current);
  });
}

function exactKeys(input: unknown, allowed: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== allowed.length ||
      Object.keys(input).some(name => !allowed.includes(name))) return fail('journal-event-invalid');
}
/** A separate immutable variant. It never falls back to caller-declared rates. */
export async function createFeeBoundAccountFundsJournal(directory: string,
  input: { pinBytes: Uint8Array; bindingKey: Uint8Array; limits: unknown | null; collectorSourceHash: string },
  now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  exactKeys(input, ['pinBytes', 'bindingKey', 'limits', 'collectorSourceHash']);
  if (!hash.safeParse(input.collectorSourceHash).success) return fail('journal-evidence-invalid');
  return createJournal(directory, input, now, input.collectorSourceHash);
}
export async function importFeeBoundAccountFundsJournalEvidence(directory: string,
  input: { funds: { archiveBytes: Uint8Array; receipt: unknown }; fees: { archiveBytes: Uint8Array; receipt: unknown };
    pinBytes: Uint8Array; bindingKey: Uint8Array }, expected: AccountFundsJournalCheckpoint,
  now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  exactKeys(input, ['funds', 'fees', 'pinBytes', 'bindingKey']);
  exactKeys(input.funds, ['archiveBytes', 'receipt']); exactKeys(input.fees, ['archiveBytes', 'receipt']);
  return protectedCall(input.bindingKey, async key => {
    const event = eventSchema.parse({ type: 'fee-bound-evidence-imported', checkedAt: now,
      envelope: { archiveBytes: rawCopy(input.funds.archiveBytes, 1024 * 1024).toString('base64'),
        receipt: clone(input.funds.receipt), pinBytes: rawCopy(input.pinBytes, 64 * 1024).toString('base64') },
      feeEnvelope: { archiveBytes: rawCopy(input.fees.archiveBytes, 128 * 1024).toString('base64'), receipt: clone(input.fees.receipt) } });
    return append(resolve(directory), event, checkpointSchema.parse(expected), key, 2);
  });
}
export async function stageFeeBoundAccountFundsJournalIntent(directory: string,
  input: { intent: unknown; bindingKey: Uint8Array }, expected: AccountFundsJournalCheckpoint,
  now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  exactKeys(input, ['intent', 'bindingKey']);
  return protectedCall(input.bindingKey, async key => {
    const checkedAt = time.parse(now), event = eventSchema.parse({ type: 'fee-bound-intent-staged', checkedAt,
      intent: intent(input.intent, checkedAt) });
    return append(resolve(directory), event, checkpointSchema.parse(expected), key, 2);
  });
}
export async function releaseFeeBoundAccountFundsJournalIntent(directory: string,
  input: { intentId: string; reason: 'operator-released'; bindingKey: Uint8Array }, expected: AccountFundsJournalCheckpoint,
  now = Date.now()): Promise<AccountFundsJournalSnapshot> {
  exactKeys(input, ['intentId', 'reason', 'bindingKey']);
  return protectedCall(input.bindingKey, async key => {
    const event = eventSchema.parse({ type: 'intent-released', checkedAt: now, intentId: input.intentId, reason: input.reason });
    return append(resolve(directory), event, checkpointSchema.parse(expected), key, 2);
  });
}
export async function readFeeBoundAccountFundsJournal(directory: string, bindingKey: Uint8Array,
  minimumCheckpoint?: AccountFundsJournalCheckpoint): Promise<AccountFundsJournalSnapshot> {
  return protectedCall(bindingKey, async key => {
    const expected = minimumCheckpoint === undefined ? undefined : checkpointSchema.parse(minimumCheckpoint);
    const current = await load(resolve(directory), key); if (current.manifest.schema !== 2) return fail('journal-invalid');
    if (expected) assertCheckpoint(current, expected, false); return snapshot(current);
  });
}
