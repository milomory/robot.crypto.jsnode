import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveOrderJournal } from '../src/live/order-journal.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const source = `
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const args = JSON.parse(process.env.LIVE_REHEARSAL_TEST_ARGS);
const forbidden = () => { fs.writeSync(2, 'OUTBOUND_ATTEMPT'); throw Error('OUTBOUND_ATTEMPT'); };
globalThis.fetch = forbidden;
net.connect = forbidden; net.createConnection = forbidden;
tls.connect = forbidden; http.request = forbidden; http.get = forbidden;
https.request = forbidden; https.get = forbidden;
syncBuiltinESMExports();
process.argv = [process.execPath, 'src/scripts/live-order-rehearsal.ts', ...args];
await import('./src/scripts/live-order-rehearsal.ts');
`;
async function cli(args: string[]) {
  return await new Promise<{ failed: boolean; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source],
      { cwd: process.cwd(), timeout: 10_000, maxBuffer: 128 * 1024,
        env: { ...process.env, LIVE_REHEARSAL_TEST_ARGS: JSON.stringify(args), TRADING_MODE: 'live', LIVE_TRADING_LOCKED: 'false' } },
      (error, stdout, stderr) => resolve({ failed: error !== null, stdout, stderr }));
  });
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'live-boundary-')); roots.push(root);
  const journal = join(root, 'journal');
  const state = await createLiveOrderJournal(journal);
  const checkpoint = join(root, 'checkpoint.json');
  await writeFile(checkpoint, JSON.stringify(state.checkpoint), { mode: 0o600 });
  return { root, journal, checkpoint };
}

describe('independent offline command input boundaries', () => {
  it.each(['symlink', 'directory', 'oversize'])('rejects %s event input without modifying the journal or accessing a network', async kind => {
    const paths = await setup(), event = join(paths.root, 'PRIVATE_INPUT');
    if (kind === 'symlink') {
      const secret = join(paths.root, 'secret.json');
      await writeFile(secret, JSON.stringify({ private: 'PRIVATE_BOUNDARY_CANARY' }));
      await symlink(secret, event);
    } else if (kind === 'directory') await mkdir(event);
    else await writeFile(event, ' '.repeat(128 * 1024 + 1) + 'PRIVATE_BOUNDARY_CANARY');
    const before = await readFile(join(paths.journal, 'manifest.json'));
    const result = await cli(['append', event, paths.journal, paths.checkpoint]);
    expect(result.failed).toBe(true); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Offline order rehearsal failed.');
    expect(result.stderr).not.toMatch(/PRIVATE_INPUT|PRIVATE_BOUNDARY_CANARY|OUTBOUND_ATTEMPT/);
    expect(await readdir(paths.journal)).toEqual(['manifest.json']);
    expect(await readFile(join(paths.journal, 'manifest.json'))).toEqual(before);
  }, 15_000);

  it('inspects an empty journal while all outbound entrypoints are trapped, even with live-looking environment flags', async () => {
    const paths = await setup(), report = join(paths.root, 'report');
    const result = await cli(['inspect', paths.journal, report, paths.checkpoint]);
    expect(result.failed).toBe(false); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ executable: false, captureProvenanceVerified: false, reportWritten: true });
    const data = JSON.parse(await readFile(join(report, 'report.json'), 'utf8'));
    expect(data.preparation).toMatchObject({ readyToStart: false, executable: false, limitsEnforced: false });
    expect(data.preparation.blockers).toContain('exchange-order-transport-not-connected');
  }, 15_000);
});
