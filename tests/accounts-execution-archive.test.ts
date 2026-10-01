import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeExecutionCapture } from '../src/accounts/execution-archive.js';
import { HISTORY_POLICY, type ExecutionHistoryCapture } from '../src/accounts/execution-history.js';

const roots: string[] = [];
const captureId = '01234567-89ab-4cde-8fab-0123456789ab';
function capture(): ExecutionHistoryCapture {
  const venue = () => ({ meta: { requests: 1, successfulRequests: 1, discoveredOrders: 0, capturedOrders: 0,
    fillRows: 0, billRows: 0, errors: 0, truncated: false }, reads: [], errors: [],
    discoveryDrained: true, billsDrained: null, orders: [] });
  return { schema: 1, kind: 'private-execution-history-capture', captureId, startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_000_100, policy: HISTORY_POLICY, window: { from: 1_799_481_600_000, to: 1_800_000_000_000 },
    account: 'main', symbol: 'BTC/USDT', executable: false, wholeAccountHistoryProven: false,
    orderDiscovery: 'recent-executions-only', assumptions: ['Synthetic archive test; no exchange access'],
    venues: { mexc: venue(), okx: venue() } };
}
async function privateDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'crypto-execution-archive-test-'));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
const filename = (id = captureId) => `capture-${id}.json`;
async function noTemporary(directory: string) {
  expect((await readdir(directory)).filter(name => name.startsWith('.capture-'))).toEqual([]);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('private immutable execution capture archive', () => {
  it('writes exact JSON plus newline to one exclusive UUID file with private permissions', async () => {
    const directory = await privateDirectory(), report = capture();
    const guard = vi.fn((text: string) => {
      expect(text).toBe(JSON.stringify(report) + '\n');
      expect(readdirSync(directory)).toEqual([]);
    });
    await writeExecutionCapture(directory, report, guard);
    const target = join(directory, filename());
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify(report) + '\n');
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect((await lstat(target)).isFile()).toBe(true);
    expect((await lstat(target)).nlink).toBe(1);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual([filename()]);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('rejects a credential canary before creating a temporary or permanent file', async () => {
    const directory = await privateDirectory(), report = capture();
    report.assumptions = ['SYNTHETIC_SECRET_CANARY'];
    const guard = vi.fn((text: string) => {
      expect(readdirSync(directory)).toEqual([]);
      if (text.includes('SYNTHETIC_SECRET_CANARY')) throw new Error('credential-material-forbidden');
    });
    await expect(writeExecutionCapture(directory, report, guard)).rejects.toThrow(/^credential-material-forbidden$/);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['', '../escape', '../../capture-escape.json', '/tmp/escape', captureId + '/suffix',
    captureId + '\n', captureId.toUpperCase(), captureId.slice(1), captureId.replace('a', 'g')])
    ('rejects a malformed or path-shaped UUID before touching the destination: %j', async id => {
      const directory = await privateDirectory(), guard = vi.fn();
      const report = { ...capture(), captureId: id };
      await expect(writeExecutionCapture(directory, report, guard)).rejects.toThrow(/^history-invalid-capture-id$/);
      expect(guard).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    });

  it.each([0o755, 0o750, 0o710, 0o707, 0o701])('rejects a directory with non-owner permissions %s', async mode => {
    const directory = await privateDirectory(), guard = vi.fn();
    await chmod(directory, mode);
    await expect(writeExecutionCapture(directory, capture(), guard)).rejects.toThrow(/^history-private-directory-required$/);
    expect(guard).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('requires an existing directory and does not create a destination implicitly', async () => {
    const root = await privateDirectory(), absent = join(root, 'missing'), guard = vi.fn();
    await expect(writeExecutionCapture(absent, capture(), guard)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
    expect(guard).not.toHaveBeenCalled();
  });

  it('rejects a regular file in place of the private archive directory', async () => {
    const root = await privateDirectory(), file = join(root, 'not-a-directory'), guard = vi.fn();
    await writeFile(file, 'ORIGINAL', { mode: 0o600 });
    await expect(writeExecutionCapture(file, capture(), guard)).rejects.toThrow(/^history-private-directory-required$/);
    expect(await readFile(file, 'utf8')).toBe('ORIGINAL');
    expect(guard).not.toHaveBeenCalled();
  });

  it('rejects a symlink as the archive directory even when its target is private', async () => {
    const root = await privateDirectory(), actual = join(root, 'actual'), alias = join(root, 'alias'), guard = vi.fn();
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias);
    await expect(writeExecutionCapture(alias, capture(), guard)).rejects.toThrow(/^history-private-directory-required$/);
    expect(await readdir(actual)).toEqual([]);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  });

  it('preserves an existing capture byte-for-byte and removes the failed temporary file', async () => {
    const directory = await privateDirectory(), report = capture();
    await writeExecutionCapture(directory, report, () => {});
    const target = join(directory, filename()), initial = await readFile(target), inode = (await lstat(target)).ino;
    report.assumptions = ['Changed data must not replace previous evidence'];
    await expect(writeExecutionCapture(directory, report, () => {})).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(target)).toEqual(initial);
    expect((await lstat(target)).ino).toBe(inode);
    expect(await readdir(directory)).toEqual([filename()]);
    await noTemporary(directory);
  });

  it('does not follow or replace an existing capture symlink', async () => {
    const directory = await privateDirectory(), protectedFile = join(directory, 'protected'), target = join(directory, filename());
    await writeFile(protectedFile, 'KEEP_THIS_CONTENT', { mode: 0o600 });
    await symlink(protectedFile, target);
    await expect(writeExecutionCapture(directory, capture(), () => {})).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(protectedFile, 'utf8')).toBe('KEEP_THIS_CONTENT');
    await noTemporary(directory);
  });

  it('accepts exactly 4 MiB of serialized UTF-8 including the final newline', async () => {
    const directory = await privateDirectory(), report = capture(), limit = 4 * 1024 * 1024;
    report.assumptions = [''];
    const overhead = Buffer.byteLength(JSON.stringify(report) + '\n');
    report.assumptions = ['x'.repeat(limit - overhead)];
    await writeExecutionCapture(directory, report, () => {});
    expect((await lstat(join(directory, filename()))).size).toBe(limit);
    await noTemporary(directory);
  });

  it('rejects one byte above the archive cap before writing any file', async () => {
    const directory = await privateDirectory(), report = capture(), limit = 4 * 1024 * 1024;
    report.assumptions = [''];
    const overhead = Buffer.byteLength(JSON.stringify(report) + '\n');
    report.assumptions = ['x'.repeat(limit - overhead + 1)];
    await expect(writeExecutionCapture(directory, report, () => {})).rejects.toThrow(/^history-archive-too-large$/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('bounds UTF-8 bytes rather than JavaScript string length', async () => {
    const directory = await privateDirectory(), report = capture(), limit = 4 * 1024 * 1024;
    report.assumptions = ['я'.repeat(limit / 2)];
    const text = JSON.stringify(report) + '\n';
    expect(text.length).toBeLessThan(limit);
    expect(Buffer.byteLength(text)).toBeGreaterThan(limit);
    await expect(writeExecutionCapture(directory, report, () => {})).rejects.toThrow(/^history-archive-too-large$/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('admits capture number 20, ignores unrelated files, then refuses number 21 without eviction', async () => {
    const directory = await privateDirectory();
    const earlier = Array.from({ length: 19 }, () => filename(randomUUID()));
    for (const name of earlier) await writeFile(join(directory, name), 'PREVIOUS_EVIDENCE', { mode: 0o600 });
    await writeFile(join(directory, 'archive-note.txt'), 'NOT_A_CAPTURE', { mode: 0o600 });
    await writeExecutionCapture(directory, capture(), () => {});
    const guard = vi.fn(), report = { ...capture(), captureId: randomUUID() };
    await expect(writeExecutionCapture(directory, report, guard)).rejects.toThrow(/^history-archive-capacity$/);
    expect(guard).not.toHaveBeenCalled();
    expect((await readdir(directory)).filter(name => name.startsWith('capture-'))).toHaveLength(20);
    for (const name of earlier) expect(await readFile(join(directory, name), 'utf8')).toBe('PREVIOUS_EVIDENCE');
    await noTemporary(directory);
  });

  it('leaves no temporary file after JSON serialization fails', async () => {
    const directory = await privateDirectory(), report = capture(), guard = vi.fn();
    Object.assign(report, { circular: report });
    await expect(writeExecutionCapture(directory, report, guard)).rejects.toThrow();
    expect(guard).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});
