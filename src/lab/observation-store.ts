import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, link, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LabError } from './order-book.js';

export const POLICY = { schema: 1, kind: 'crypto-public-observations', retentionDays: 7,
  maxRuns: 20, maxBytes: 100_000_000 } as const;
const pointerSchema = z.object({ schema: z.literal(1), runId: z.string().uuid() }).strict();
export const collectionSchema = z.object({ schema: z.literal(1), runId: z.string().uuid(),
  state: z.enum(['running', 'completed', 'stopped', 'failed']), deadlineAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(), endedAt: z.number().int().positive().optional() }).strict();
export type Collection = z.infer<typeof collectionSchema>;

export async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 100_000) throw new LabError('invalid-observation-file');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}

// Readers see either a complete old version or a complete new version.
export async function atomicJson(path: string, value: unknown, replace = false) {
  const data = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(data) > 100_000) throw new LabError('observation-file-too-large');
  const temporary = path + '.tmp-' + randomUUID();
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); }
  finally { await file.close(); }
  try {
    if (replace) await rename(temporary, path);
    else await link(temporary, path); // exclusive final name, unlike rename
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function initStore(root: string) {
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'runs'), { mode: 0o700 });
  await atomicJson(join(root, 'store.json'), POLICY);
}

async function realDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LabError('invalid-store-directory');
}
export async function checkStore(root: string) {
  await realDirectory(root); await realDirectory(join(root, 'runs'));
  const policy = await readJson(join(root, 'store.json'));
  if (JSON.stringify(policy) !== JSON.stringify(POLICY)) throw new LabError('unknown-store-policy');
}
export async function lockStore(root: string) {
  await checkStore(root);
  const lock = await open(join(root, 'writer.lock'), 'wx', 0o600);
  await lock.writeFile(randomUUID()); await lock.sync(); await lock.close();
  return async () => { await unlink(join(root, 'writer.lock')); };
}
export async function currentRun(root: string): Promise<string | undefined> {
  try { return pointerSchema.parse(await readJson(join(root, 'current.json'))).runId; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function publishRun(root: string, runId: string) {
  const pointer = pointerSchema.parse({ schema: 1, runId });
  await atomicJson(join(root, 'current.json'), pointer, true);
}
export async function resolveRun(directory: string) {
  const current = await currentRun(directory);
  if (!current) return directory; // historical single-run format
  await checkStore(directory);
  const selected = join(directory, 'runs', current);
  await realDirectory(selected);
  return selected;
}

// Call only with the single-writer lock. Unknown files or symlinks fail closed.
export async function enforceRetention(root: string, now = Date.now(), reserveBytes = 6_200_000) {
  await checkStore(root);
  let rootBytes = 0;
  for (const name of await readdir(root)) {
    if (name === 'runs') continue;
    if (!['store.json', 'current.json', 'writer.lock'].includes(name)) throw new LabError('unknown-store-file');
    const stat = await lstat(join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new LabError('invalid-store-file');
    rootBytes += stat.size;
  }
  const current = await currentRun(root);
  const names = await readdir(join(root, 'runs'));
  const rows: Array<{ id: string; bytes: number; expired: boolean }> = [];
  for (const id of names) {
    z.string().uuid().parse(id);
    const directory = join(root, 'runs', id); await realDirectory(directory);
    const manifest = z.object({ schema: z.literal(1), model: z.literal('depth-v2'), runId: z.literal(id), startedAt: z.number().int().positive() })
      .passthrough().parse(await readJson(join(directory, 'run.json')));
    const state = collectionSchema.parse(await readJson(join(directory, 'collection.json')));
    if (state.runId !== id) throw new LabError('mismatched-collection');
    if (state.endedAt !== undefined && state.endedAt < manifest.startedAt) throw new LabError('invalid-collection-time');
    let bytes = 0;
    for (const name of await readdir(directory)) {
      if (!/^(run|collection|\d{3})\.json$/.test(name)) throw new LabError('unknown-observation-file');
      const stat = await lstat(join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new LabError('invalid-observation-file');
      bytes += stat.size;
    }
    rows.push({ id, bytes, expired: id !== current && state.state !== 'running' &&
      state.endedAt !== undefined && state.endedAt < now - POLICY.retentionDays * 86_400_000 });
  }
  // Finish validation before deleting any managed evidence.
  const removed: string[] = [];
  for (const row of rows.filter(row => row.expired)) {
    await rm(join(root, 'runs', row.id), { recursive: true }); removed.push(row.id);
  }
  const kept = rows.filter(row => !row.expired);
  const bytes = kept.reduce((sum, row) => sum + row.bytes, rootBytes);
  if (kept.length >= POLICY.maxRuns || bytes + reserveBytes > POLICY.maxBytes) throw new LabError('observation-storage-full');
  return { removed, kept: kept.length, bytes, reservedBytes: reserveBytes };
}
