/** Key-free, read-only request gate for the isolated protected recovery command. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalLiveOrderJson as canonical } from './order-lifecycle.js';
import { readLiveOrderJournal } from './order-journal.js';
import { ORDER_RECOVERY_POLICY } from './order-recovery-collection.js';
import type { Cooldowns } from '../accounts/pair-runtime.js';

export const PROTECTED_ORDER_RECOVERY_PATHS = Object.freeze({ request: '/request/request.json', journal: '/journal', archiveParent: '/state', observerState: '/observer-state' });
export type ProtectedOrderRecoveryPaths = Readonly<{ request: string; journal: string; archiveParent: string; observerState: string }>;
export const PROTECTED_ORDER_RECOVERY_LIMITS = Object.freeze({ requestBytes: 16 * 1024, ttlMs: 15 * 60_000, cooldownBytes: 4096, stdinBytes: 40 * 1024, stdinTimeoutMs: 5000 });
const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const millis = z.number().int().safe().positive().max(8_640_000_000_000_000);
const checkpoint = z.object({ schema: z.union([z.literal(1), z.literal(2)]), kind: z.literal('live-order-rehearsal-checkpoint'),
  journalId: uuid, revision: z.number().int().min(0).max(2000), headHash: hash }).strict();
const schema = z.object({ schema: z.literal(1), kind: z.literal('protected-order-recovery-request'), requestId: uuid,
  venue: z.enum(['mexc', 'okx']), account: z.literal('main'), createdAt: millis, expiresAt: millis,
  baseCheckpoint: checkpoint, orderIntentId: uuid }).strict();
const cooldownSchema = z.object({ schema: z.literal(1), mexc: z.number().int().safe().min(0).max(8_640_000_000_000_000),
  okx: z.number().int().safe().min(0).max(8_640_000_000_000_000) }).strict();
export type ProtectedOrderRecoveryRequest = z.infer<typeof schema>;
export class ProtectedOrderRecoveryRequestError extends Error {
  constructor() { super('recovery-preflight-failed'); this.name = 'ProtectedOrderRecoveryRequestError'; }
}
function fail(): never { throw new ProtectedOrderRecoveryRequestError(); }
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function absolute(path: string) { if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail(); }
export async function requireProtectedRecoveryDirectory(path: string): Promise<void> {
  absolute(path); if (path !== await realpath(path)) fail();
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const stat = await fd.stat(); if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) fail(); }
  finally { await fd.close(); }
}
export async function readProtectedRecoveryFile(path: string, maxBytes: number): Promise<Buffer> {
  absolute(path); await requireProtectedRecoveryDirectory(dirname(path));
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > maxBytes) fail();
    const bytes = Buffer.alloc(maxBytes + 1); let count = 0;
    while (count < bytes.length) { const part = await fd.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > maxBytes) fail(); return bytes.subarray(0, count);
  } finally { await fd.close(); }
}
export async function readProtectedRecoveryCooldowns(directory: string): Promise<Readonly<Cooldowns>> {
  try {
    const bytes = await readProtectedRecoveryFile(join(directory, 'cooldowns.json'), PROTECTED_ORDER_RECOVERY_LIMITS.cooldownBytes);
    // Missing state is not silently treated as a new account without rate restrictions.
    const text = bytes.toString('utf8');
    const entry = '"(?:schema|mexc|okx)"\\s*:\\s*(?:0|[1-9]\\d*)';
    if (!new RegExp('^\\s*\\{\\s*' + entry + '\\s*,\\s*' + entry + '\\s*,\\s*' + entry + '\\s*\\}\\s*$').test(text)) fail();
    const keys = [...text.matchAll(/"(schema|mexc|okx)"\s*:/g)].map(match => match[1]);
    if (new Set(keys).size !== 3) fail();
    const parsed = cooldownSchema.safeParse(JSON.parse(text)); if (!parsed.success) fail(); return freeze(parsed.data);
  } catch { return fail(); }
}
export function parseProtectedOrderRecoveryRequest(input: unknown, now: number): ProtectedOrderRecoveryRequest {
  const parsed = schema.safeParse(input);
  if (!parsed.success || !millis.safeParse(now).success) fail();
  const request = parsed.data;
  if (request.expiresAt <= request.createdAt || request.expiresAt - request.createdAt > PROTECTED_ORDER_RECOVERY_LIMITS.ttlMs ||
      now < request.createdAt || now >= request.expiresAt) fail();
  return freeze(request);
}
export interface ProtectedOrderRecoveryPreflight {
  readonly request: ProtectedOrderRecoveryRequest;
  readonly requestSha256: string;
  readonly archiveDirectory: string;
  readonly cooldowns: Readonly<Cooldowns>;
  readonly summary: { readonly schema: 1; readonly mode: 'order-recovery-preflight'; readonly requestSha256: string;
    readonly venue: 'mexc' | 'okx'; readonly ready: true; readonly executable: false;
    readonly captureProvenanceVerified: false; readonly accountIdentityVerified: false };
}
/** Test callers may supply isolated paths; the protected CLI always uses the fixed mount paths above. */
export async function preflightProtectedOrderRecovery(requestSha256: string,
  options: { paths?: ProtectedOrderRecoveryPaths; now?: number } = {}): Promise<ProtectedOrderRecoveryPreflight> {
  try {
    if (!hash.safeParse(requestSha256).success || Object.keys(options).some(k => !['paths', 'now'].includes(k))) fail();
    const paths = options.paths ?? PROTECTED_ORDER_RECOVERY_PATHS, now = options.now ?? Date.now();
    if (Object.keys(paths).sort().join(',') !== 'archiveParent,journal,observerState,request') fail();
    const bytes = await readProtectedRecoveryFile(paths.request, PROTECTED_ORDER_RECOVERY_LIMITS.requestBytes);
    if (createHash('sha256').update(bytes).digest('hex') !== requestSha256) fail();
    const request = parseProtectedOrderRecoveryRequest(JSON.parse(bytes.toString('utf8')), now);
    if (bytes.toString('utf8') !== canonical(request) + '\n') fail();
    await requireProtectedRecoveryDirectory(paths.journal);
    await requireProtectedRecoveryDirectory(paths.archiveParent);
    await requireProtectedRecoveryDirectory(paths.observerState);
    if (paths.archiveParent === paths.journal || paths.archiveParent.startsWith(paths.journal + '/')) fail();
    const snapshot = await readLiveOrderJournal(paths.journal, request.baseCheckpoint);
    if (canonical(snapshot.checkpoint) !== canonical(request.baseCheckpoint)) fail();
    const order = snapshot.state.orders.find(row => row.intent.orderIntentId === request.orderIntentId);
    if (!order || order.intent.venue !== request.venue || order.intent.account !== request.account || !order.dispatchAt ||
        order.phase === 'prepared' || order.phase === 'reconciled') fail();
    const dispatch = Date.parse(order.dispatchAt);
    if (request.createdAt < dispatch || now < dispatch || now - dispatch + ORDER_RECOVERY_POLICY.maxClockSkewMs >= 7 * 86_400_000) fail();
    const archiveDirectory = join(paths.archiveParent, request.requestId);
    try { await lstat(archiveDirectory); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const cooldowns = await readProtectedRecoveryCooldowns(paths.observerState);
    if (cooldowns[request.venue] > now) fail();
    return freeze({ request, requestSha256, archiveDirectory, cooldowns,
      summary: { schema: 1, mode: 'order-recovery-preflight', requestSha256, venue: request.venue, ready: true,
        executable: false, captureProvenanceVerified: false, accountIdentityVerified: false } });
  } catch { return fail(); }
}
