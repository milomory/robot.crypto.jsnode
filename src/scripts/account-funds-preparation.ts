/** Offline private files only. This command cannot obtain exchange credentials or send an order. */
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AccountFundsJournalError, createAccountFundsJournal, importAccountFundsJournalEvidence,
  stageAccountFundsJournalIntent, releaseAccountFundsJournalIntent, readAccountFundsJournal,
  createFeeBoundAccountFundsJournal, importFeeBoundAccountFundsJournalEvidence, stageFeeBoundAccountFundsJournalIntent,
  releaseFeeBoundAccountFundsJournalIntent, readFeeBoundAccountFundsJournal,
  type AccountFundsJournalCheckpoint, type AccountFundsJournalSnapshot } from '../live/account-funds-journal.js';

const lengths = { init: [4], import: [6], stage: [5], release: [4], inspect: [2, 3],
  'init-bound': [5], 'import-bound': [8], 'stage-bound': [4], 'release-bound': [4], 'inspect-bound': [2, 3] } as const;
type Command = keyof typeof lengths;
const buffers: Buffer[] = [];
const collectorSchema = z.object({ collectorSourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const releaseSchema = z.object({ intentId: z.string().uuid(), reason: z.literal('operator-released') }).strict();
const errorCodes = new Set(['journal-invalid', 'journal-limit', 'journal-head-conflict', 'journal-evidence-invalid',
  'journal-event-invalid', 'journal-policy-blocked', 'journal-write-failed', 'journal-publish-uncertain']);
const invalid = (): never => { throw new Error('invalid-input'); };
function localPath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || value.includes('\0') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith('-')) return invalid();
  return resolve(value);
}
async function privateBytes(path: string, maximum: number): Promise<Buffer> {
  const selected = localPath(path);
  if (selected !== await realpath(selected)) return invalid();
  const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let buffer: Buffer | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || typeof process.getuid !== 'function' || stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size === 0 || stat.size > maximum) return invalid();
    buffer = Buffer.alloc(maximum + 1); let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(selected);
    if (size !== stat.size || size > maximum || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs || after.mode !== stat.mode || after.nlink !== 1 ||
        current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 ||
        current.mode !== stat.mode || selected !== await realpath(selected)) return invalid();
    const copied = Buffer.from(buffer.subarray(0, size)); buffers.push(copied); return copied;
  } finally { buffer?.fill(0); await handle.close(); }
}
async function privateJson(path: string, maximum: number): Promise<unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await privateBytes(path, maximum));
  const value: unknown = JSON.parse(text), compact = JSON.stringify(value);
  if (text !== compact && text !== compact + '\n') return invalid();
  return value;
}
try {
  const [rawCommand, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(lengths, rawCommand)) invalid();
  const command = rawCommand as Command;
  if (!(lengths[command] as readonly number[]).includes(args.length)) invalid();
  args.forEach(localPath);
  const [directory, keyPath] = args;
  const bindingKey = await privateBytes(keyPath, 32);
  if (bindingKey.length !== 32) invalid();
  let state: AccountFundsJournalSnapshot;
  if (command === 'init-bound') {
    const pinBytes = await privateBytes(args[2], 64 * 1024), limits = await privateJson(args[3], 4096),
      collector = collectorSchema.parse(await privateJson(args[4], 4096));
    state = await createFeeBoundAccountFundsJournal(localPath(directory), { pinBytes, bindingKey, limits, ...collector });
  } else if (command === 'import-bound') {
    const funds = { archiveBytes: await privateBytes(args[2], 1024 * 1024), receipt: await privateJson(args[3], 4096) },
      fees = { archiveBytes: await privateBytes(args[4], 128 * 1024), receipt: await privateJson(args[5], 4096) },
      pinBytes = await privateBytes(args[6], 64 * 1024), expected = await privateJson(args[7], 4096) as AccountFundsJournalCheckpoint;
    state = await importFeeBoundAccountFundsJournalEvidence(localPath(directory), { funds, fees, pinBytes, bindingKey }, expected);
  } else if (command === 'stage-bound') {
    const intent = await privateJson(args[2], 16 * 1024), expected = await privateJson(args[3], 4096) as AccountFundsJournalCheckpoint;
    state = await stageFeeBoundAccountFundsJournalIntent(localPath(directory), { intent, bindingKey }, expected);
  } else if (command === 'release-bound') {
    const release = releaseSchema.parse(await privateJson(args[2], 4096)), expected = await privateJson(args[3], 4096) as AccountFundsJournalCheckpoint;
    state = await releaseFeeBoundAccountFundsJournalIntent(localPath(directory), { ...release, bindingKey }, expected);
  } else if (command === 'inspect-bound') {
    const expected = args[2] === undefined ? undefined : await privateJson(args[2], 4096) as AccountFundsJournalCheckpoint;
    state = await readFeeBoundAccountFundsJournal(localPath(directory), bindingKey, expected);
  } else if (command === 'init') {
    const pinBytes = await privateBytes(args[2], 64 * 1024), limits = await privateJson(args[3], 4096);
    state = await createAccountFundsJournal(localPath(directory), { pinBytes, bindingKey, limits });
  } else if (command === 'import') {
    const archiveBytes = await privateBytes(args[2], 1024 * 1024), receipt = await privateJson(args[3], 4096),
      pinBytes = await privateBytes(args[4], 64 * 1024), expected = await privateJson(args[5], 4096) as AccountFundsJournalCheckpoint;
    state = await importAccountFundsJournalEvidence(localPath(directory), { archiveBytes, receipt, pinBytes, bindingKey }, expected);
  } else if (command === 'stage') {
    const intent = await privateJson(args[2], 16 * 1024), feeEvidence = await privateJson(args[3], 16 * 1024),
      expected = await privateJson(args[4], 4096) as AccountFundsJournalCheckpoint;
    state = await stageAccountFundsJournalIntent(localPath(directory), { intent, feeEvidence, bindingKey }, expected);
  } else if (command === 'release') {
    const release = releaseSchema.parse(await privateJson(args[2], 4096)),
      expected = await privateJson(args[3], 4096) as AccountFundsJournalCheckpoint;
    state = await releaseAccountFundsJournalIntent(localPath(directory), { ...release, bindingKey }, expected);
  } else {
    const expected = args[2] === undefined ? undefined : await privateJson(args[2], 4096) as AccountFundsJournalCheckpoint;
    state = await readAccountFundsJournal(localPath(directory), bindingKey, expected);
  }
  console.log(JSON.stringify({ schema: 1, kind: 'offline-account-funds-preparation-result', status: 'succeeded', command,
    checkpoint: state.checkpoint, preparedCount: state.preparedIntents.length, hasEvidence: state.latestEvidenceReceipt !== null,
    limitsDraftPresent: state.limits !== null, executable: false, liveAllowed: false,
    feeProvenanceVerified: state.feeProvenanceVerified, accountGlobalOwnershipVerified: false }));
} catch (error) {
  const reason = error instanceof AccountFundsJournalError && errorCodes.has(error.code) ? error.code : 'invalid-input';
  console.error(JSON.stringify({ schema: 1, kind: 'offline-account-funds-preparation-result', status: 'failed', reason,
    executable: false, liveAllowed: false }));
  process.exitCode = 1;
} finally { for (const buffer of buffers) buffer.fill(0); }
