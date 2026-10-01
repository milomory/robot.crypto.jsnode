/** Explicit private binding and fresh account/funds capture; no trading admission. */
import { constants } from 'node:fs';
import { open, lstat, readdir, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPrivateAccountDirectory, readPrivateAccountFile, persistAccountCooldowns,
  parsePairCredentials, preflightAccountIdentity, identityDiagnostic } from './account-identity-runtime.js';
import { createAccountBindingPin, parseAccountBindingPin, parseAccountSelection, verifyPinIntegrity,
  compareAccountCredentials, compareAccountIdentity, assessCaptureFreshness,
  ACCOUNT_BINDING_REFERENCES, ACCOUNT_BINDING_CONTEXT, ACCOUNT_BINDING_POLICY_HASH } from './account-binding.js';
import { AccountFundsReader } from './account-funds-reader.js';
import { AccountError } from './types.js';
import { persistentFetch } from './pair-runtime.js';

export const FUNDS_FAILURE = Object.freeze({ schema: 1, error: 'funds-failed' });
export const FUNDS_PATHS = Object.freeze({ archive: '/state', observer: '/observer-state', binding: '/binding', manifest: '/code/manifest.json' });
type Paths = Readonly<{ archive: string; observer: string; binding: string; manifest: string }>;
type Options = { paths?: Paths; clock?: () => number; fetch?: typeof fetch };
const fail = (): never => { throw new Error('funds-failed'); };
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const validClock = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 8_640_000_000_000_000;
function pathsSnapshot(selected: Paths = FUNDS_PATHS): Paths {
  if (!selected || Object.keys(selected).sort().join(',') !== 'archive,binding,manifest,observer') fail();
  const paths = Object.freeze({ archive: selected.archive, observer: selected.observer, binding: selected.binding, manifest: selected.manifest });
  if (new Set([paths.archive, paths.observer, paths.binding]).size !== 3) fail();
  return paths;
}
function canonical(raw: Buffer): unknown {
  const value: unknown = JSON.parse(raw.toString('utf8'));
  if (JSON.stringify(value) + '\n' !== raw.toString('utf8')) fail();
  return value;
}
async function absent(path: string) {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  fail();
}
async function prerequisites(paths: Paths, now: number) {
  if (!validClock(now)) fail();
  const state = await preflightAccountIdentity({ archive: paths.archive, observer: paths.observer }, now);
  await assertPrivateAccountDirectory(paths.binding);
  if ((await readdir(paths.archive)).filter(n => n.startsWith('funds-')).length >= 20) fail();
  const selectionRaw = await readPrivateAccountFile(join(paths.binding, 'selection.json'), 16 * 1024);
  const selection = parseAccountSelection(canonical(selectionRaw));
  const manifestRaw = await readPrivateAccountFile(paths.manifest, 512 * 1024);
  if (hash(manifestRaw) !== selection.sourceHash || selection.selection.selectedAt > now) fail();
  const key = await readPrivateAccountFile(join(paths.binding, 'binding-key'), 32);
  if (key.length !== 32) { key.fill(0); fail(); }
  return { state, selection, selectionRaw, manifestRaw, key };
}
export async function preflightAccountFundsEnrollment(selected: Paths = FUNDS_PATHS, now = Date.now()) {
  const paths = pathsSnapshot(selected), context = await prerequisites(paths, now);
  try { await absent(join(paths.binding, 'pin.json')); return Object.freeze({ schema: 1, preflightPassed: true, requestCount: 0 }); }
  finally { context.key.fill(0); }
}
async function boundContext(paths: Paths, now: number) {
  const context = await prerequisites(paths, now);
  try {
    const pinRaw = await readPrivateAccountFile(join(paths.binding, 'pin.json'), 64 * 1024);
    const pin = parseAccountBindingPin(canonical(pinRaw));
    if (!verifyPinIntegrity(pin, context.key) || pin.sourceHash !== context.selection.sourceHash ||
        pin.bundleVersion !== context.selection.bundleVersion || pin.policyHash !== ACCOUNT_BINDING_POLICY_HASH ||
        JSON.stringify(pin.selection) !== JSON.stringify(context.selection.selection) ||
        JSON.stringify(pin.identities) !== JSON.stringify(context.selection.identities)) fail();
    // Selection/release equality is also validated with credentials before any GET.
    return { ...context, pin, pinRaw };
  } catch (error) { context.key.fill(0); throw error; }
}
export async function preflightAccountFunds(selected: Paths = FUNDS_PATHS, now = Date.now()) {
  const context = await boundContext(pathsSnapshot(selected), now);
  try { return Object.freeze({ schema: 1, preflightPassed: true, requestCount: 0 }); }
  finally { context.key.fill(0); }
}
async function unchanged(paths: Paths, context: Awaited<ReturnType<typeof prerequisites>>, pinRaw?: Buffer) {
  if (!(await readPrivateAccountFile(join(paths.binding, 'selection.json'), 16 * 1024)).equals(context.selectionRaw) ||
      !(await readPrivateAccountFile(paths.manifest, 512 * 1024)).equals(context.manifestRaw)) fail();
  const currentKey = await readPrivateAccountFile(join(paths.binding, 'binding-key'), 32);
  try { if (!currentKey.equals(context.key)) fail(); } finally { currentKey.fill(0); }
  if (pinRaw && !(await readPrivateAccountFile(join(paths.binding, 'pin.json'), 64 * 1024)).equals(pinRaw)) fail();
}
async function publish(directory: string, name: string, value: unknown, maximum: number, assertSafe: (s: string) => void) {
  await assertPrivateAccountDirectory(directory);
  const raw = JSON.stringify(value) + '\n'; assertSafe(raw);
  if (Buffer.byteLength(raw) > maximum) fail();
  const temporary = join(directory, '.funds-' + randomUUID()), target = join(directory, name);
  const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); }
    await link(temporary, target);
  } finally { await unlink(temporary); }
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  return hash(raw);
}
function input(raw: Buffer) {
  const secrets = parsePairCredentials(raw);
  // Take a private copy synchronously before any injected asynchronous callback.
  const frame: unknown = JSON.parse(raw.toString('utf8'));
  return { secrets, frame };
}
function runtime(options: Options) {
  if (Object.keys(options).some(k => !['paths', 'clock', 'fetch'].includes(k))) fail();
  const paths = pathsSnapshot(options.paths), sourceClock = options.clock ?? Date.now, performFetch = options.fetch ?? globalThis.fetch;
  let previous = 0;
  const clock = () => { const now = sourceClock(); if (!validClock(now) || now < previous) fail(); previous = now; return now; };
  return { paths, clock, performFetch };
}
function bindingInput(context: Awaited<ReturnType<typeof prerequisites>>, frame: unknown) {
  return { credentials: frame, references: ACCOUNT_BINDING_REFERENCES, context: ACCOUNT_BINDING_CONTEXT,
    sourceHash: context.selection.sourceHash, policyHash: ACCOUNT_BINDING_POLICY_HASH, bundleVersion: context.selection.bundleVersion };
}
type Stage = 'credentials' | 'preflight' | 'mexc-read' | 'okx-read' | 'archive';
function failure(error: unknown, stage: Stage, guard?: (s: string) => void) {
  const diagnostic = identityDiagnostic(stage, error), output = JSON.stringify(FUNDS_FAILURE);
  try { guard?.(output); guard?.(JSON.stringify(diagnostic)); return { success: false, output, diagnostic } as const; }
  catch { return { success: false, output: null, diagnostic: null } as const; }
}
/** Separate explicit enrollment: no fetch is called; capture never creates/replaces a pin. */
export async function executeAccountFundsEnrollment(raw: Buffer, options: Options = {}) {
  let stage: Stage = 'credentials', key: Buffer | undefined, guard: ((s: string) => void) | undefined;
  try {
    const { secrets, frame } = input(raw); guard = secrets.assertSafe;
    const { paths, clock } = runtime(options); stage = 'preflight';
    const context = await prerequisites(paths, clock()); key = context.key;
    await absent(join(paths.binding, 'pin.json'));
    const pin = createAccountBindingPin({ ...bindingInput(context, frame), selection: context.selection.selection,
      identities: context.selection.identities }, key);
    await unchanged(paths, context); stage = 'archive';
    await publish(paths.binding, 'pin.json', pin, 64 * 1024, guard);
    const output = JSON.stringify({ schema: 1, mode: 'account-binding-enrollment', pinWritten: true, selectionBound: true,
      identityEnrolled: false, executable: false, requestCount: 0 });
    guard(output); return { success: true, output } as const;
  } catch (error) { return failure(error, stage, guard); }
  finally { key?.fill(0); }
}
/** Four bounded GETs; private binding is required and read-only in the production container. */
export async function executeAccountFunds(raw: Buffer, options: Options = {}) {
  let stage: Stage = 'credentials', key: Buffer | undefined, guard: ((s: string) => void) | undefined;
  try {
    const { secrets, frame } = input(raw); guard = secrets.assertSafe;
    const { paths, clock, performFetch } = runtime(options), startedAt = clock(); stage = 'preflight';
    const context = await boundContext(paths, startedAt); key = context.key;
    const comparison = compareAccountCredentials(context.pin, bindingInput(context, frame), key);
    if (!comparison.matched) throw new AccountError(
      ['credential-rotation', 'context-mismatch', 'pin-integrity-invalid'].includes(comparison.code) ?
        'account-' + comparison.code : 'account-binding-mismatch');
    // The selected old archive must remain exactly the baseline of the existing pin.
    for (const venue of ['mexc', 'okx'] as const) {
      if (!compareAccountIdentity(context.pin, venue, context.selection.identities[venue], key).matched) fail();
    }
    let requestCount = 0, failed = false;
    const save = async () => { try { await persistAccountCooldowns(paths.observer, context.state); } catch { failed = true; fail(); } };
    const request = persistentFetch(context.state, save, async (target, init) => {
      if (failed || clock() - startedAt >= 30_000 || requestCount >= 4) fail();
      requestCount++; return performFetch(target, init);
    }, clock);
    const read = async (venue: 'mexc' | 'okx') => {
      try {
        return await new AccountFundsReader(venue, { credentials: secrets[venue], fetch: request, clock }).getSnapshot({
          acceptIdentity: identity => compareAccountIdentity(context.pin, venue, identity, key!).matched,
        });
      } catch (error) {
        if (!failed && error instanceof AccountError && error.code === 'account-rate-limited') {
          context.state[venue] = Math.min(8_640_000_000_000_000, Math.max(context.state[venue], clock() + 60_000)); await save();
        }
        throw error;
      }
    };
    stage = 'mexc-read'; const mexc = await read('mexc');
    stage = 'okx-read'; const okx = await read('okx');
    const endedAt = clock();
    const freshness = assessCaptureFreshness({ startedAt, endedAt, checkedAt: endedAt, requests: [
      { venue: 'mexc', stage: 'identity', requestedAt: mexc.identity.requestedAt, receivedAt: mexc.identity.receivedAt },
      { venue: 'mexc', stage: 'funds', requestedAt: mexc.funds.requestedAt, receivedAt: mexc.funds.receivedAt },
      { venue: 'okx', stage: 'identity', requestedAt: okx.identity.requestedAt, receivedAt: okx.identity.receivedAt },
      { venue: 'okx', stage: 'funds', requestedAt: okx.funds.requestedAt, receivedAt: okx.funds.receivedAt },
    ] });
    if (failed || requestCount !== 4 || endedAt - startedAt >= 30_000 || !freshness.fresh) fail();
    stage = 'archive'; await unchanged(paths, context, context.pinRaw);
    if (clock() - startedAt >= 30_000) fail();
    const archiveId = randomUUID();
    const report = { schema: 1, kind: 'account-funds-observation', archiveId, startedAt, endedAt, environment: 'mainnet',
      selectionReceipt: context.selection.selection.receipt, bundleVersion: context.selection.bundleVersion, pinHash: hash(context.pinRaw),
      identityEnrolled: true, fundsBound: true, fundsAdmission: false, executable: false, requestCount, mexc, okx };
    const archiveHash = await publish(paths.archive, 'funds-' + archiveId + '.json', report, 1024 * 1024, guard);
    const output = JSON.stringify({ schema: 1, mode: 'account-funds-readonly', reportWritten: true, executable: false,
      identityEnrolled: true, fundsBound: true, fundsAdmission: false, requestCount,
      mexc: { observed: true, identityMatched: true, mainAccountConfirmed: false },
      okx: { observed: true, identityMatched: true, mainAccountConfirmed: true },
      receipt: { schema: 1, kind: 'account-funds-observation-receipt', archiveId, archiveHash } });
    guard(output); return { success: true, output } as const;
  } catch (error) { return failure(error, stage, guard); }
  finally { key?.fill(0); }
}
