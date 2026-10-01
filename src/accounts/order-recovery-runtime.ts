/** One-venue protected composition. Credentials come only from caller-supplied stdin bytes, never environment or a vault. */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { AccountCredentialBundle } from './credentials.js';
import type { AccountCredentials } from './types.js';
import type { Cooldowns } from './pair-runtime.js';
import { canonicalLiveOrderJson as canonical } from '../live/order-lifecycle.js';
import { captureLiveOrderRecoverySession, createOrderRecoverySessionContext,
  type LiveOrderRecoverySessionInput, type LiveOrderRecoverySessionResult } from '../live/order-recovery-session.js';
import { preflightProtectedOrderRecovery, PROTECTED_ORDER_RECOVERY_LIMITS, PROTECTED_ORDER_RECOVERY_PATHS,
  readProtectedRecoveryCooldowns, readProtectedRecoveryFile, requireProtectedRecoveryDirectory, type ProtectedOrderRecoveryPaths } from '../live/order-recovery-request.js';

export const PROTECTED_RECOVERY_FAILURE = Object.freeze({ schema: 1, error: 'recovery-failed' });
export interface OrderRecoveryCredentialInput {
  readonly venue: 'mexc' | 'okx';
  capture(input: Omit<LiveOrderRecoverySessionInput, 'credentials'>): Promise<LiveOrderRecoverySessionResult>;
  assertNoSecrets(text: string): void;
}
const invalid = (): never => { throw new Error('recovery-runtime-failed'); };
/** The generic credential bundle is used only for its existing strict validation.
 * No key-bearing object or generic account reader escapes this one-purpose closure. */
export function parseOrderRecoveryInput(raw: Buffer): OrderRecoveryCredentialInput {
  try {
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > PROTECTED_ORDER_RECOVERY_LIMITS.stdinBytes) return invalid();
    const input = JSON.parse(raw.toString('utf8'));
    if (!input || typeof input !== 'object' || !['mexc', 'okx'].includes(input.venue) || input.schema !== 1 ||
        Object.keys(input).sort().join(',') !== [input.venue, 'schema', 'venue'].sort().join(',')) return invalid();
    const selected = input[input.venue], bundle = AccountCredentialBundle.parse(JSON.stringify(selected));
    if (bundle.venue !== input.venue) return invalid();
    const credentials: AccountCredentials = { apiKey: selected.apiKey, apiSecret: selected.apiSecret,
      ...(input.venue === 'okx' ? { passphrase: selected.passphrase } : {}) };
    const secrets = [credentials.apiKey, credentials.apiSecret, credentials.passphrase].filter((value): value is string => value !== undefined);
    const selectedVenue = input.venue as 'mexc' | 'okx';
    return Object.freeze({ venue: selectedVenue,
      capture: (options: Omit<LiveOrderRecoverySessionInput, 'credentials'>) => {
        const performFetch = options.fetch ?? globalThis.fetch;
        const restrictedFetch: typeof fetch = (target, init) => {
          const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
          if (url.origin !== (selectedVenue === 'mexc' ? 'https://api.mexc.com' : 'https://www.okx.com') || init?.method !== 'GET') return invalid();
          return performFetch(target, init);
        };
        return captureLiveOrderRecoverySession({ ...options, credentials, fetch: restrictedFetch });
      },
      assertNoSecrets(text: string) {
        if (typeof text !== 'string' || secrets.some(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))) return invalid();
      } });
  } catch { return invalid(); }
}
/** One bounded frame. No line protocol, credential prompting, retries or partial JSON acceptance. */
export function readOrderRecoveryStdin(stream: Readable, limits: { bytes: number; timeoutMs: number } = { bytes: PROTECTED_ORDER_RECOVERY_LIMITS.stdinBytes, timeoutMs: PROTECTED_ORDER_RECOVERY_LIMITS.stdinTimeoutMs }): Promise<Buffer> {
  if (!Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > PROTECTED_ORDER_RECOVERY_LIMITS.stdinBytes ||
      !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > PROTECTED_ORDER_RECOVERY_LIMITS.stdinTimeoutMs) return Promise.reject(new Error('recovery-runtime-failed'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false;
    const cleanup = () => { clearTimeout(timer); stream.off('data', data); stream.off('end', end); stream.off('error', error); stream.off('close', closed); };
    const error = () => { if (done) return; done = true; cleanup(); stream.pause(); chunks.forEach(chunk => chunk.fill(0)); reject(new Error('recovery-runtime-failed')); };
    const data = (value: Buffer | string) => {
      if (done) return; const chunk = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value); bytes += chunk.length;
      if (bytes > limits.bytes) { chunk.fill(0); error(); return; } chunks.push(chunk);
    };
    const end = () => { if (done) return; if (bytes === 0) return error(); done = true; cleanup(); const raw = Buffer.concat(chunks, bytes); chunks.forEach(chunk => chunk.fill(0)); resolve(raw); };
    const closed = () => { if (!done) error(); };
    const timer = setTimeout(error, limits.timeoutMs);
    stream.on('data', data); stream.once('end', end); stream.once('error', error); stream.once('close', closed);
  });
}
/** Caller must hold the same cross-process observer lock used by the protected runner.
 * This writer additionally rejects a regressing state, preserves private modes and fsyncs file+directory. */
export async function persistProtectedRecoveryCooldowns(directory: string, input: Readonly<Cooldowns>): Promise<void> {
  let temporary: string | undefined;
  try {
    if (!input || Object.keys(input).sort().join(',') !== 'mexc,okx,schema') return invalid();
    const next = Object.freeze({ schema: input.schema, mexc: input.mexc, okx: input.okx });
    if (next.schema !== 1 || [next.mexc, next.okx].some(n => !Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000)) return invalid();
    await requireProtectedRecoveryDirectory(directory);
    const currentBytes = await readProtectedRecoveryFile(join(directory, 'cooldowns.json'), PROTECTED_ORDER_RECOVERY_LIMITS.cooldownBytes);
    const current = await readProtectedRecoveryCooldowns(directory);
    if (next.mexc < current.mexc || next.okx < current.okx) return invalid();
    const expectedHash = createHash('sha256').update(currentBytes).digest('hex');
    const directoryFd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      temporary = join(directory, '.recovery-cooldowns-' + randomUUID());
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(canonical(next) + '\n'); await file.sync(); } finally { await file.close(); }
      const beforeRename = await readProtectedRecoveryFile(join(directory, 'cooldowns.json'), PROTECTED_ORDER_RECOVERY_LIMITS.cooldownBytes);
      if (createHash('sha256').update(beforeRename).digest('hex') !== expectedHash) return invalid();
      await rename(temporary, join(directory, 'cooldowns.json')); temporary = undefined; await directoryFd.sync();
    } finally { await directoryFd.close(); }
  } catch { return invalid(); }
  finally { if (temporary) await unlink(temporary).catch(() => {}); }
}
export interface ProtectedOrderRecoveryExecutionOptions { paths?: ProtectedOrderRecoveryPaths; clock?: () => number; fetch?: typeof fetch; wait?: (milliseconds: number) => Promise<void> }
export interface ProtectedOrderRecoveryExecutionResult { readonly success: boolean; readonly output: string | null }
/** Always rechecks the request after credentials have been consumed, before the first signed GET.
 * The original archive is written privately; its events are never imported here. */
export async function executeProtectedOrderRecovery(requestSha256: string, raw: Buffer,
  options: ProtectedOrderRecoveryExecutionOptions = {}): Promise<ProtectedOrderRecoveryExecutionResult> {
  let credentials: OrderRecoveryCredentialInput | undefined;
  try {
    if (Object.keys(options).some(key => !['paths', 'clock', 'fetch', 'wait'].includes(key))) return invalid();
    credentials = parseOrderRecoveryInput(raw);
    const paths = options.paths ?? PROTECTED_ORDER_RECOVERY_PATHS, clock = options.clock ?? Date.now;
    const preflight = await preflightProtectedOrderRecovery(requestSha256, { paths, now: clock() });
    if (credentials.venue !== preflight.request.venue) return invalid();
    const performFetch = options.fetch ?? globalThis.fetch;
    const authorizedFetch: typeof fetch = (target, init) => {
      const value = clock();
      if (!Number.isSafeInteger(value) || value < preflight.request.createdAt || value >= preflight.request.expiresAt) return invalid();
      return performFetch(target, init);
    }; // The response clock must remain usable to preserve Retry-After even after expiry.
    const context = createOrderRecoverySessionContext(preflight.cooldowns, { persist: next => persistProtectedRecoveryCooldowns(paths.observerState, next) });
    const result = await credentials.capture({ journalDirectory: paths.journal, expectedCheckpoint: preflight.request.baseCheckpoint,
      orderIntentId: preflight.request.orderIntentId, archiveDirectory: preflight.archiveDirectory, context,
      clock, fetch: authorizedFetch, wait: options.wait });
    const summary = { schema: 1, mode: 'order-recovery-readonly', requestSha256, venue: preflight.request.venue,
      reportWritten: true, executable: false, captureProvenanceVerified: false, accountIdentityVerified: false, requestCount: result.requestCount, receipt: result.receipt };
    const output = JSON.stringify(summary); credentials.assertNoSecrets(output); return Object.freeze({ success: true, output });
  } catch {
    const output = JSON.stringify(PROTECTED_RECOVERY_FAILURE);
    try { credentials?.assertNoSecrets(output); return Object.freeze({ success: false, output }); }
    catch { return Object.freeze({ success: false, output: null }); }
  }
}
