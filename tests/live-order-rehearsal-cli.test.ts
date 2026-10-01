import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LiveOrderJournalCheckpoint } from '../src/live/order-journal.js';

const fixture = JSON.parse(await readFile('fixtures/live-order-rehearsal/partial-cancel.json', 'utf8'));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function cli(args: string[]) {
  return await new Promise<{ code: number; output: string; error: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'src/scripts/live-order-rehearsal.ts', ...args],
      { cwd: process.cwd(), timeout: 15_000, maxBuffer: 128 * 1024,
        env: { ...process.env, TRADING_MODE: 'live', LIVE_TRADING_LOCKED: 'false' } },
      (error, output, stderr) => resolve({ code: error ? 1 : 0, output, error: stderr }));
  });
}
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
function metadata(response: Awaited<ReturnType<typeof cli>>) {
  expect(response.code).toBe(0); expect(response.error).toBe('');
  const result = JSON.parse(response.output) as { revision: number; appended?: boolean; checkpoint: LiveOrderJournalCheckpoint };
  expect(result).toMatchObject({ executable: false, captureProvenanceVerified: false, kind: 'offline-order-rehearsal-result' });
  expect(Object.keys(result).every(key => ['schema', 'kind', 'executable', 'captureProvenanceVerified', 'checkpoint',
    'revision', 'pendingFiles', 'appended', 'reportWritten'].includes(key))).toBe(true);
  expect(response.output).not.toMatch(/synthetic-order|synthetic-fill|orderIntentId|baseQuantity|cashDelta|PRIVATE-CANARY/);
  return result;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'live-rehearsal-cli-')); roots.push(root);
  return { root, journal: join(root, 'journal'), event: join(root, 'event.json'), checkpoint: join(root, 'checkpoint.json') };
}
async function inspect(journal: string, report: string, checkpoint?: string) {
  metadata(await cli(['inspect', journal, report, ...(checkpoint ? [checkpoint] : [])]));
  expect((await stat(report)).mode & 0o777).toBe(0o700);
  for (const name of ['report.json', 'checkpoint.json']) expect((await stat(join(report, name))).mode & 0o777).toBe(0o600);
  return JSON.parse(await readFile(join(report, 'report.json'), 'utf8'));
}

describe('offline order rehearsal CLI across fresh processes', () => {
  it('recovers unknown submission, preserves cancel reservation, accounts partial fill once and stays non-executable', async () => {
    const files = await setup();
    let latest = metadata(await cli(['init', files.journal]));
    for (let index = 0; index < fixture.events.length; index++) {
      await json(files.event, fixture.events[index]); await json(files.checkpoint, latest.checkpoint);
      latest = metadata(await cli(['append', files.event, files.journal, files.checkpoint]));
      if (index === 3 || index === 6) {
        const report = await inspect(files.journal, join(files.root, `report-${index}`));
        expect(report.orders[0]).toMatchObject({ phase: 'unknown', reserved: { USDT: '100.1' } });
        expect(report.preparation.recovery.actions[0]).toMatchObject({ automaticResubmitAllowed: false, reservationRetained: true });
        // Exact redelivery with the checkpoint predating its append remains no-op.
        expect(metadata(await cli(['append', files.event, files.journal, files.checkpoint]))).toMatchObject({ appended: false, revision: index + 1 });
      }
    }
    await json(files.checkpoint, latest.checkpoint);
    const report = await inspect(files.journal, join(files.root, 'final-report'), files.checkpoint);
    expect(report.orders[0]).toMatchObject({ phase: 'reconciled', reserved: { BTC: '0', USDT: '0', MX: '0' },
      cashDelta: { BTC: '0.0004', USDT: '-40.04', MX: '0' } });
    expect(report.orders[0].fills).toHaveLength(1);
    expect(report.preparation).toMatchObject({ readyToStart: false, executable: false, limitsEnforced: false,
      limits: { status: 'missing' }, liveAccountingVerified: false });
    expect(report.preparation.blockers).toContain('local-rehearsal-is-not-live-execution-evidence');
    const names = await readdir(files.journal);
    // An attempted dispatch after recovery must not append or replace anything.
    await json(files.event, { ...fixture.events[1], eventId: '20000000-0000-4000-8000-000000000001', at: '2026-09-28T12:01:00.000Z' });
    expect((await cli(['append', files.event, files.journal, files.checkpoint])).code).toBe(1);
    expect(await readdir(files.journal)).toEqual(names);
  }, 60_000);

  it('retains an over-cap fill after restart and does not release quarantine on a terminal observation', async () => {
    const files = await setup();
    let latest = metadata(await cli(['init', files.journal]));
    const anomaly = { ...fixture.events[4], type: 'fill-quarantined',
      fill: { ...fixture.events[4].fill, fees: { BTC: '0', USDT: '1', MX: '0' } } };
    for (const event of [fixture.events[0], fixture.events[1], anomaly, fixture.events[7]]) {
      await json(files.event, event); await json(files.checkpoint, latest.checkpoint);
      latest = metadata(await cli(['append', files.event, files.journal, files.checkpoint]));
    }
    const report = await inspect(files.journal, join(files.root, 'quarantine-report'));
    expect(report.orders[0]).toMatchObject({ phase: 'quarantined', cashDelta: { USDT: '-41' },
      reserved: { USDT: '100.1' }, accountingAnomalies: ['fee-cap-exceeded'] });
    expect(report.preparation.recovery.actions[0]).toMatchObject({ action: 'inspect-accounting-anomaly',
      automaticResubmitAllowed: false, reservationRetained: true });
    const before = await readdir(files.journal);
    await json(files.event, fixture.events[8]); await json(files.checkpoint, latest.checkpoint);
    expect((await cli(['append', files.event, files.journal, files.checkpoint])).code).toBe(1);
    expect(await readdir(files.journal)).toEqual(before);
  }, 30_000);

  it('preserves existing outputs, rejects extra fields and hides private values from failures', async () => {
    const files = await setup();
    const initial = metadata(await cli(['init', files.journal]));
    await json(files.checkpoint, initial.checkpoint);
    await json(files.event, { ...fixture.events[0], password: 'PRIVATE-CANARY' });
    const rejected = await cli(['append', files.event, files.journal, files.checkpoint]);
    expect(rejected.code).toBe(1); expect(rejected.output).toBe('');
    expect(rejected.error).toContain('Offline order rehearsal failed.');
    expect(rejected.error).not.toContain('PRIVATE-CANARY');
    expect((await readdir(files.journal)).sort()).toEqual(['manifest.json']);
    const destination = join(files.root, 'report');
    await inspect(files.journal, destination);
    const before = await readFile(join(destination, 'report.json'));
    expect((await cli(['inspect', files.journal, destination])).code).toBe(1);
    expect(await readFile(join(destination, 'report.json'))).toEqual(before);
    expect((await cli(['init', files.journal])).code).toBe(1);
    expect((await cli(['start', files.journal])).code).toBe(1);
  }, 30_000);
});
