/** Three fixed read-only requests against the existing private account binding; no reenrollment. */
import { constants } from 'node:fs';
import { open, readdir, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPrivateAccountDirectory, readPrivateAccountFile, persistAccountCooldowns,
  parsePairCredentials, preflightAccountIdentity, identityDiagnostic } from './account-identity-runtime.js';
import { parseAccountBindingPin, parseAccountSelection, verifyPinIntegrity, compareAccountCredentials,
  compareAccountIdentity, ACCOUNT_BINDING_REFERENCES, ACCOUNT_BINDING_CONTEXT, ACCOUNT_BINDING_POLICY_HASH } from './account-binding.js';
import { OkxCapacityReader, getCapacityFailureDiagnostic, CAPACITY_READ_STEPS, CAPACITY_REJECTION_REASONS, type CapacityFailureDiagnostic } from './okx-capacity-reader.js';
import { parseOkxCapacityArchive, checkOkxCapacityTiming } from './okx-capacity-contract.js';
import { AccountError } from './types.js';
import { persistentFetch } from './pair-runtime.js';

export const CAPACITY_FAILURE = Object.freeze({ schema: 1, error: 'capacity-failed' });
export const CAPACITY_PATHS = Object.freeze({ archive: '/state', observer: '/observer-state', binding: '/binding',
  bindingSource: '/binding-source/manifest.json', manifest: '/code/manifest.json' });
type Paths = Readonly<Record<keyof typeof CAPACITY_PATHS, string>>;
type Options = { paths?: Paths; clock?: () => number; fetch?: typeof fetch };
const fail = (): never => { throw new Error('capacity-failed'); };
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const validClock = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 8_640_000_000_000_000;
function pathsSnapshot(selected: Paths = CAPACITY_PATHS): Paths {
  if (!selected || Object.keys(selected).sort().join(',') !== 'archive,binding,bindingSource,manifest,observer') fail();
  const paths = Object.freeze({ archive: selected.archive, observer: selected.observer, binding: selected.binding,
    bindingSource: selected.bindingSource, manifest: selected.manifest });
  if (new Set(Object.values(paths)).size !== 5) fail();
  return paths;
}
function canonical(raw: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw), value: unknown = JSON.parse(text);
  if (JSON.stringify(value) + '\n' !== text) fail();
  return value;
}
async function context(paths: Paths, now: number) {
  if (!validClock(now)) fail();
  const state = await preflightAccountIdentity({ archive: paths.archive, observer: paths.observer }, now);
  await assertPrivateAccountDirectory(paths.binding);
  if ((await readdir(paths.archive)).filter(n => n.startsWith('capacity-')).length >= 20) fail();
  const selectionRaw = await readPrivateAccountFile(join(paths.binding, 'selection.json'), 16 * 1024);
  const selection = parseAccountSelection(canonical(selectionRaw));
  const bindingSourceRaw = await readPrivateAccountFile(paths.bindingSource, 512 * 1024);
  const manifestRaw = await readPrivateAccountFile(paths.manifest, 512 * 1024);
  if (hash(bindingSourceRaw) !== selection.sourceHash || selection.selection.selectedAt > now ||
      manifestRaw.length === 0 || hash(manifestRaw) === selection.sourceHash) fail();
  const key = await readPrivateAccountFile(join(paths.binding, 'binding-key'), 32);
  try {
    if (key.length !== 32) fail();
    const pinRaw = await readPrivateAccountFile(join(paths.binding, 'pin.json'), 64 * 1024);
    const pin = parseAccountBindingPin(canonical(pinRaw));
    if (!verifyPinIntegrity(pin, key) || pin.sourceHash !== selection.sourceHash || pin.bundleVersion !== selection.bundleVersion ||
      pin.policyHash !== ACCOUNT_BINDING_POLICY_HASH || JSON.stringify(pin.selection) !== JSON.stringify(selection.selection) ||
      JSON.stringify(pin.identities) !== JSON.stringify(selection.identities)) fail();
    return { state, selection, selectionRaw, bindingSourceRaw, manifestRaw, key, pin, pinRaw };
  } catch (error) { key.fill(0); throw error; }
}
export async function preflightOkxCapacity(selected: Paths = CAPACITY_PATHS, now = Date.now()) {
  const checked = await context(pathsSnapshot(selected), now);
  try { return Object.freeze({ schema: 1, preflightPassed: true, requestCount: 0 }); }
  finally { checked.key.fill(0); }
}
async function unchanged(paths: Paths, checked: Awaited<ReturnType<typeof context>>) {
  for (const [path, initial, max] of [
    [join(paths.binding, 'selection.json'), checked.selectionRaw, 16 * 1024],
    [join(paths.binding, 'pin.json'), checked.pinRaw, 64 * 1024],
    [paths.bindingSource, checked.bindingSourceRaw, 512 * 1024], [paths.manifest, checked.manifestRaw, 512 * 1024],
  ] as const) if (!(await readPrivateAccountFile(path, max)).equals(initial)) fail();
  const current = await readPrivateAccountFile(join(paths.binding, 'binding-key'), 32);
  try { if (!current.equals(checked.key)) fail(); } finally { current.fill(0); }
}
async function publish(directory: string, name: string, value: unknown, assertSafe: (s: string) => void) {
  await assertPrivateAccountDirectory(directory);
  const raw = JSON.stringify(value) + '\n'; assertSafe(raw);
  if (Buffer.byteLength(raw) > 128 * 1024) fail();
  const temporary = join(directory, '.capacity-' + randomUUID()), target = join(directory, name);
  const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); }
    await link(temporary, target);
  } finally { await unlink(temporary); }
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  return hash(raw);
}
/** Closed diagnostic vocabulary only; no response text, identifiers, values or timing metadata. */
export async function writeCapacityFailureDiagnostic(details: CapacityFailureDiagnostic, directory = CAPACITY_PATHS.archive) {
  if (!details || Object.keys(details).sort().join(',') !== 'reason,step' ||
      !CAPACITY_READ_STEPS.includes(details.step) || !CAPACITY_REJECTION_REASONS.includes(details.reason)) fail();
  const selected = Object.freeze({ step: details.step, reason: details.reason });
  await assertPrivateAccountDirectory(directory);
  if ((await readdir(directory)).filter(name => name.startsWith('capacity-failure-')).length >= 20) fail();
  await publish(directory, 'capacity-failure-' + randomUUID() + '.json', selected, () => {});
}
/** No caller endpoint, symbol, fee rate, account selection, enrollment or trading action is accepted. */
export async function executeOkxCapacity(raw: Buffer, options: Options = {}) {
  let stage: 'credentials' | 'preflight' | 'okx-read' | 'archive' = 'credentials';
  let key: Buffer | undefined, guard: ((s: string) => void) | undefined;
  try {
    const secrets = parsePairCredentials(raw); guard = secrets.assertSafe;
    const frame: unknown = JSON.parse(raw.toString('utf8'));
    if (Object.keys(options).some(name => !['paths', 'clock', 'fetch'].includes(name))) fail();
    const paths = pathsSnapshot(options.paths), sourceClock = options.clock ?? Date.now, performFetch = options.fetch ?? globalThis.fetch;
    let previous = 0;
    const clock = () => { const n = sourceClock(); if (!validClock(n) || n < previous) fail(); previous = n; return n; };
    const startedAt = clock(); stage = 'preflight';
    const checked = await context(paths, startedAt); key = checked.key;
    const comparison = compareAccountCredentials(checked.pin, { credentials: frame, references: ACCOUNT_BINDING_REFERENCES,
      context: ACCOUNT_BINDING_CONTEXT, sourceHash: checked.selection.sourceHash, policyHash: ACCOUNT_BINDING_POLICY_HASH,
      bundleVersion: checked.selection.bundleVersion }, key);
    if (!comparison.matched) throw new AccountError(['credential-rotation', 'context-mismatch', 'pin-integrity-invalid'].includes(comparison.code)
      ? 'account-' + comparison.code : 'account-binding-mismatch');
    let requestCount = 0, failed = false;
    const save = async () => { try { await persistAccountCooldowns(paths.observer, checked.state); } catch { failed = true; fail(); } };
    const request = persistentFetch(checked.state, save, async (target, init) => {
      if (failed || clock() - startedAt >= 30_000 || requestCount >= 3) fail();
      requestCount++; return performFetch(target, init);
    }, clock);
    const venue = 'okx' as const;
    const read = async () => {
      try {
        return await new OkxCapacityReader({ credentials: secrets[venue], fetch: request, clock }).getSnapshot({
          acceptIdentity: identity => compareAccountIdentity(checked.pin, venue, identity, key!).matched,
        });
      } catch (error) {
        if (!failed && error instanceof AccountError && error.code === 'account-rate-limited') {
          checked.state[venue] = Math.min(8_640_000_000_000_000, Math.max(checked.state[venue], clock() + 60_000)); await save();
        }
        throw error;
      }
    };
    stage = 'okx-read'; const okx = await read();
    const endedAt = clock();
    if (failed || requestCount !== 3 || endedAt - startedAt >= 30_000) fail();
    stage = 'archive'; await unchanged(paths, checked);
    const archiveId = randomUUID();
    const report = parseOkxCapacityArchive({ schema: 1, kind: 'okx-capacity-observation', archiveId,
      startedAt, endedAt, environment: 'mainnet', selectionReceipt: checked.selection.selection.receipt,
      bundleVersion: checked.selection.bundleVersion, pinHash: hash(checked.pinRaw), bindingSourceHash: checked.pin.sourceHash,
      collectorSourceHash: hash(checked.manifestRaw), identityEnrolled: true, credentialBundleMatched: true, capacityBound: true, capacityAdmission: false,
      executable: false, requestCount, okx });
    if (!checkOkxCapacityTiming(report, clock()) || clock() - startedAt >= 30_000) fail();
    const archiveHash = await publish(paths.archive, 'capacity-' + archiveId + '.json', report, guard);
    const output = JSON.stringify({ schema: 1, mode: 'okx-capacity-readonly', reportWritten: true, executable: false,
      identityEnrolled: true, credentialBundleMatched: true, capacityBound: true, capacityAdmission: false, requestCount,
      okx: { observed: true, identityMatched: true, mainAccountConfirmed: true, configurationStable: true },
      receipt: { schema: 1, kind: 'okx-capacity-observation-receipt', archiveId, archiveHash } });
    guard(output); return { success: true, output } as const;
  } catch (error) {
    const output = JSON.stringify(CAPACITY_FAILURE), diagnostic = identityDiagnostic(stage, error), capacityDiagnostic = getCapacityFailureDiagnostic(error);
    try { guard?.(output); guard?.(JSON.stringify(diagnostic)); return { success: false, output, diagnostic, capacityDiagnostic } as const; }
    catch { return { success: false, output: null, diagnostic: null, capacityDiagnostic: null } as const; }
  } finally { key?.fill(0); }
}
