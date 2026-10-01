/** Private identity observation only: no enrollment, funds binding or trading authorization. */
import { constants } from 'node:fs';
import { open, realpath, readdir, link, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AccountCredentialBundle } from './credentials.js';
import { AccountIdentityReader } from './account-identity-reader.js';
import { AccountError, type AccountCredentials } from './types.js';
import { persistentFetch, type Cooldowns } from './pair-runtime.js';

export const IDENTITY_FAILURE = Object.freeze({ schema: 1, error: 'identity-failed' });
export const IDENTITY_PATHS = Object.freeze({ archive: '/state', observer: '/observer-state' });
const IDENTITY_STAGES = ['credentials', 'preflight', 'mexc-read', 'okx-read', 'archive'] as const;
const ACCOUNT_REASONS = [
  'account-invalid-config', 'account-invalid-credential-bundle', 'account-unsupported-venue',
  'account-unsupported-endpoint', 'account-invalid-clock', 'account-invalid-cooldown',
  'account-public-credentials-forbidden', 'account-busy', 'account-rate-limited', 'account-timeout',
  'account-access-denied', 'account-auth-failed', 'account-api-rejected', 'account-response-too-large',
  'account-invalid-response', 'account-unavailable', 'account-binding-mismatch',
  'account-identity-mismatch', 'account-reader-used', 'account-credential-rotation',
  'account-context-mismatch', 'account-pin-integrity-invalid',
] as const;
const IDENTITY_RESPONSE_REASONS = ['mexc-uid-missing', 'mexc-uid-numeric', 'mexc-uid-invalid-string', 'mexc-uid-invalid-type',
  'okx-invalid-envelope', 'okx-invalid-row-count', 'okx-uid-invalid', 'okx-mainuid-invalid',
  'okx-account-type-unknown', 'okx-account-type-conflict'] as const;
const FILE_REASONS = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOSPC', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOTDIR', 'ELOOP'] as const;
export type IdentityDiagnosticStage = typeof IDENTITY_STAGES[number];
export type IdentityDiagnostic = Readonly<{ stage: IdentityDiagnosticStage; reason:
  typeof ACCOUNT_REASONS[number] | typeof IDENTITY_RESPONSE_REASONS[number] | typeof FILE_REASONS[number] | 'unavailable' }>;
/** Closed literals only; error messages, paths, API text and identifiers are never copied. */
export function identityDiagnostic(stage: IdentityDiagnosticStage, error: unknown): IdentityDiagnostic {
  if (!IDENTITY_STAGES.includes(stage)) throw new Error('identity-failed');
  let reason: IdentityDiagnostic['reason'] = 'unavailable';
  try {
    if (error instanceof Error) {
      const code: unknown = (error as NodeJS.ErrnoException).code;
      if (error instanceof AccountError && typeof code === 'string' && (ACCOUNT_REASONS as readonly string[]).includes(code)) {
        reason = code as typeof ACCOUNT_REASONS[number];
        const detail = (error as AccountError & { identityDiagnosticCode?: unknown }).identityDiagnosticCode;
        if (code === 'account-invalid-response' && typeof detail === 'string' &&
            ((stage === 'mexc-read' && detail.startsWith('mexc-')) || (stage === 'okx-read' && detail.startsWith('okx-'))) &&
            (IDENTITY_RESPONSE_REASONS as readonly string[]).includes(detail)) reason = detail as typeof IDENTITY_RESPONSE_REASONS[number];
      } else if (typeof code === 'string' && (FILE_REASONS as readonly string[]).includes(code)) {
        reason = code as typeof FILE_REASONS[number];
      }
    }
  } catch { reason = 'unavailable'; }
  return Object.freeze({ stage, reason });
}
type Paths = Readonly<typeof IDENTITY_PATHS> | Readonly<{ archive: string; observer: string }>;
const fail = (): never => { throw new Error('identity-failed'); };
const validClock = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 8_640_000_000_000_000;

async function directory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) fail();
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const info = await fd.stat(); if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) fail(); }
  finally { await fd.close(); }
}
async function privateFile(path: string, maximum: number) {
  await directory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > maximum) fail();
    const buffer = Buffer.alloc(maximum + 1); let size = 0;
    while (size < buffer.length) { const part = await file.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size > maximum) fail(); return buffer.subarray(0, size);
  } finally { await file.close(); }
}
function cooldowns(raw: Buffer): Cooldowns {
  const text = raw.toString('utf8'), entry = '"(?:schema|mexc|okx)"\\s*:\\s*(?:0|[1-9]\\d*)';
  if (!new RegExp('^\\s*\\{\\s*' + entry + '\\s*,\\s*' + entry + '\\s*,\\s*' + entry + '\\s*\\}\\s*$').test(text)) fail();
  if (new Set([...text.matchAll(/"(schema|mexc|okx)"\s*:/g)].map(m => m[1])).size !== 3) fail();
  const value = JSON.parse(text);
  if (value.schema !== 1 || [value.mexc, value.okx].some(n => !Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000)) fail();
  return { schema: 1, mexc: value.mexc, okx: value.okx };
}
export async function preflightAccountIdentity(paths: Paths = IDENTITY_PATHS, now = Date.now()) {
  if (Object.keys(paths).sort().join(',') !== 'archive,observer' || !validClock(now) || paths.archive === paths.observer) fail();
  paths = Object.freeze({ archive: paths.archive, observer: paths.observer });
  await directory(paths.archive); await directory(paths.observer);
  if ((await readdir(paths.archive)).filter(name => name.startsWith('identity-')).length >= 20) fail();
  const state = cooldowns(await privateFile(join(paths.observer, 'cooldowns.json'), 4096));
  if (state.mexc > now || state.okx > now) fail();
  return state;
}
/** Caller holds the shared observer flock. Existing state must never disappear or regress. */
async function persist(directoryPath: string, state: Cooldowns) {
  const next = cooldowns(Buffer.from(JSON.stringify({ schema: state.schema, mexc: state.mexc, okx: state.okx })));
  const target = join(directoryPath, 'cooldowns.json'), initial = await privateFile(target, 4096), current = cooldowns(initial);
  if (next.mexc < current.mexc || next.okx < current.okx) fail();
  const temporary = join(directoryPath, '.identity-cooldowns-' + randomUUID()); let created = false;
  const parent = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
    try { await fd.writeFile(JSON.stringify(next) + '\n'); await fd.sync(); } finally { await fd.close(); }
    if (!(await privateFile(target, 4096)).equals(initial)) fail();
    await rename(temporary, target); created = false; await parent.sync();
  } finally { await parent.close(); if (created) await unlink(temporary).catch(() => {}); }
}

function credentials(raw: Buffer) {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 40 * 1024) fail();
  const value = JSON.parse(raw.toString('utf8'));
  if (!value || value.schema !== 1 || Object.keys(value).sort().join(',') !== 'mexc,okx,schema') fail();
  for (const venue of ['mexc', 'okx'] as const) if (AccountCredentialBundle.parse(JSON.stringify(value[venue])).venue !== venue) fail();
  const mexc: AccountCredentials = Object.freeze({ apiKey: value.mexc.apiKey, apiSecret: value.mexc.apiSecret });
  const okx: AccountCredentials = Object.freeze({ apiKey: value.okx.apiKey, apiSecret: value.okx.apiSecret, passphrase: value.okx.passphrase });
  const secrets = [mexc.apiKey, mexc.apiSecret, okx.apiKey, okx.apiSecret, okx.passphrase!];
  return Object.freeze({ mexc, okx, assertSafe(text: string) {
    if (secrets.some(s => text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1)))) fail();
  } });
}
async function archive(directoryPath: string, id: string, report: unknown, assertSafe: (text: string) => void) {
  await directory(directoryPath);
  const raw = JSON.stringify(report) + '\n'; assertSafe(raw);
  if (Buffer.byteLength(raw) > 16 * 1024) fail();
  const target = join(directoryPath, 'identity-' + id + '.json'), temporary = join(directoryPath, '.identity-' + randomUUID());
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    await link(temporary, target);
  } finally { await unlink(temporary); }
  const parent = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  return { schema: 1, kind: 'account-identity-observation-receipt', archiveId: id,
    archiveHash: createHash('sha256').update(raw).digest('hex') } as const;
}

/** A bounded, private diagnostic file is separate from identity evidence and stdout. */
export async function writeIdentityDiagnostic(diagnostic: IdentityDiagnostic, directoryPath: string = IDENTITY_PATHS.archive) {
  if (!diagnostic || Object.keys(diagnostic).sort().join(',') !== 'reason,stage') fail();
  const selected = Object.freeze({ stage: diagnostic.stage, reason: diagnostic.reason });
  if (!IDENTITY_STAGES.includes(selected.stage) ||
      ![...ACCOUNT_REASONS, ...IDENTITY_RESPONSE_REASONS, ...FILE_REASONS, 'unavailable'].includes(selected.reason)) fail();
  await directory(directoryPath);
  if ((await readdir(directoryPath)).filter(name => name.startsWith('diagnostic-')).length >= 20) fail();
  const diagnosticId = randomUUID();
  const raw = JSON.stringify({ schema: 1, kind: 'account-identity-diagnostic', diagnosticId, ...selected }) + '\n';
  if (Buffer.byteLength(raw) > 1024) fail();
  const target = join(directoryPath, 'diagnostic-' + diagnosticId + '.json');
  const temporary = join(directoryPath, '.diagnostic-' + randomUUID());
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    await link(temporary, target);
  } finally { await unlink(temporary); }
  const parent = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  return Object.freeze({ schema: 1, kind: 'account-identity-diagnostic-receipt', diagnosticId,
    diagnosticHash: createHash('sha256').update(raw).digest('hex') } as const);
}

/** Test options cannot be supplied to the fixed production CLI. No raw identity is returned. */
export async function executeAccountIdentity(raw: Buffer, options: { paths?: Paths; clock?: () => number; fetch?: typeof fetch } = {}) {
  let bundle: ReturnType<typeof credentials> | undefined;
  let stage: IdentityDiagnosticStage = 'credentials';
  try {
    if (Object.keys(options).some(key => !['paths', 'clock', 'fetch'].includes(key))) fail();
    bundle = credentials(raw);
    stage = 'preflight';
    const selected = options.paths ?? IDENTITY_PATHS;
    if (Object.keys(selected).sort().join(',') !== 'archive,observer') fail();
    const paths = Object.freeze({ archive: selected.archive, observer: selected.observer });
    const sourceClock = options.clock ?? Date.now, performFetch = options.fetch ?? globalThis.fetch;
    let previous = 0;
    const clock = () => { const now = sourceClock(); if (!validClock(now) || now < previous) fail(); previous = now; return now; };
    const startedAt = clock();
    const state = await preflightAccountIdentity(paths, startedAt);
    let requestCount = 0, failed = false;
    const save = async () => { try { await persist(paths.observer, state); } catch { failed = true; fail(); } };
    const request = persistentFetch(state, save, async (target, init) => {
      const now = clock();
      if (failed || !validClock(now) || now < startedAt || now - startedAt >= 20_000 || requestCount >= 2) fail();
      requestCount++;
      return performFetch(target, init);
    }, clock);
    const read = async (venue: 'mexc' | 'okx') => {
      try { return await new AccountIdentityReader(venue, { credentials: bundle![venue], fetch: request, clock }).getIdentity(); }
      catch (error) {
        if (!failed && error instanceof AccountError && error.code === 'account-rate-limited') {
          const now = clock(); if (!validClock(now) || now < startedAt) fail();
          state[venue] = Math.min(8_640_000_000_000_000, Math.max(state[venue], now + 60_000)); await save();
        }
        throw error;
      }
    };
    stage = 'mexc-read';
    const mexc = await read('mexc');
    stage = 'okx-read';
    const okx = await read('okx'), endedAt = clock();
    if (failed || !validClock(endedAt) || endedAt < startedAt || endedAt - startedAt >= 20_000 || requestCount !== 2) fail();
    stage = 'archive';
    const archiveId = randomUUID();
    const report = { schema: 1, kind: 'account-identity-observation', archiveId, startedAt, endedAt,
      environment: 'mainnet', identityEnrolled: false, fundsBound: false, executable: false, requestCount, mexc, okx };
    const receipt = await archive(paths.archive, archiveId, report, bundle.assertSafe);
    const output = JSON.stringify({ schema: 1, mode: 'account-identity-readonly', reportWritten: true, executable: false,
      identityEnrolled: false, requestCount, mexc: { observed: true, mainAccountConfirmed: false },
      okx: { observed: true, mainAccountConfirmed: okx.mainAccountConfirmed }, receipt });
    bundle.assertSafe(output); return { success: true, output } as const;
  } catch (error) {
    const output = JSON.stringify(IDENTITY_FAILURE);
    let diagnostic: IdentityDiagnostic | null = identityDiagnostic(stage, error);
    try { bundle?.assertSafe(JSON.stringify(diagnostic)); } catch { diagnostic = null; }
    try { bundle?.assertSafe(output); return { success: false, output, diagnostic } as const; }
    catch { return { success: false, output: null, diagnostic } as const; }
  }
}

export function readIdentityStdin(stream: Readable, timeoutMs = 5000): Promise<Buffer> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return Promise.reject(new Error('identity-failed'));
  return new Promise((resolveInput, reject) => {
    let done = false, size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { clearTimeout(timer); stream.off('data', data); stream.off('end', end); stream.off('error', error); stream.off('close', error); };
    const error = () => { if (done) return; done = true; cleanup(); stream.pause(); chunks.forEach(c => c.fill(0)); reject(new Error('identity-failed')); };
    const data = (value: Buffer | string) => { const chunk = Buffer.from(value); size += chunk.length;
      if (size > 40 * 1024) { chunk.fill(0); error(); return; } chunks.push(chunk); };
    const end = () => { if (done) return; if (!size) return error(); done = true; cleanup();
      const result = Buffer.concat(chunks); chunks.forEach(c => c.fill(0)); resolveInput(result); };
    const timer = setTimeout(error, timeoutMs);
    stream.on('data', data); stream.once('end', end); stream.once('error', error); stream.once('close', error);
  });
}

// Shared private primitives; production entrypoints still expose fixed workflows only.
export { directory as assertPrivateAccountDirectory, privateFile as readPrivateAccountFile,
  persist as persistAccountCooldowns, credentials as parsePairCredentials };
