import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replayPaperRiskJournal, viewPaperRiskState, type PaperRiskPolicy } from '../src/paper-pair/risk.js';
import type { SettlementBalances, SettlementEvent } from '../src/paper-pair/settlement.js';

const fixture = JSON.parse(await readFile('fixtures/pair-risk/session-cash-stop.json', 'utf8')) as {
  initialBalances: SettlementBalances; policy: PaperRiskPolicy; events: SettlementEvent[]; probes: SettlementEvent[];
};
interface Checkpoint { schema: 2; journalId: string; revision: number; headHash: string; policyHash: string }
interface Metadata extends Checkpoint {
  checkpoint: Checkpoint; pendingFiles: number; executable: false; funding: 'synthetic'; appended?: boolean; reportWritten?: boolean;
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fixedError = 'Local paper risk journal command failed. Use init INITIALIZATION_JSON NEW_JOURNAL, append EVENT_JSON JOURNAL CHECKPOINT_JSON, or inspect JOURNAL NEW_REPORT [MINIMUM_CHECKPOINT_JSON]. Preserve files and re-read after uncertain writes.\n';
async function cli(args: string[]) {
  return await new Promise<{ code: number; output: string; error: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'src/scripts/risk-journal.ts', ...args],
      { cwd: process.cwd(), timeout: 10_000, maxBuffer: 256 * 1024 }, (error, output, stderr) => {
        resolve({ code: error ? 1 : 0, output, error: stderr });
      });
  });
}
async function json(path: string, data: unknown) { await writeFile(path, JSON.stringify(data), { mode: 0o600 }); }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'risk-journal-cli-test-')); roots.push(root);
  const journal = join(root, 'journal'), input = join(root, 'initialization.json');
  const event = join(root, 'event.json'), checkpoint = join(root, 'checkpoint.json');
  await json(input, { schema: 1, kind: 'synthetic-risk-journal-input', initialBalances: fixture.initialBalances, policy: fixture.policy });
  return { root, journal, input, event, checkpoint };
}
function metadata(response: Awaited<ReturnType<typeof cli>>) {
  expect(response.error).toBe(''); expect(response.code).toBe(0);
  const result = JSON.parse(response.output) as Metadata;
  const allowed = ['schema', 'journalId', 'revision', 'headHash', 'policyHash', 'checkpoint', 'pendingFiles', 'executable', 'funding', 'appended', 'reportWritten'];
  expect(Object.keys(result).every(key => allowed.includes(key))).toBe(true);
  expect(Object.keys(result.checkpoint).sort()).toEqual(['headHash', 'journalId', 'policyHash', 'revision', 'schema']);
  expect(result).toMatchObject({ schema: 2, funding: 'synthetic', executable: false, checkpoint: {
    schema: 2, journalId: result.journalId, revision: result.revision, headHash: result.headHash, policyHash: result.policyHash
  } });
  expect(response.output).not.toMatch(/initialBalances|orderId|cashDeltaUsdt|pair-1|okx-buy|synthetic-demo|maxBuyDebit|sessionUsage/);
  return result;
}
function failure(response: Awaited<ReturnType<typeof cli>>) {
  expect(response).toEqual({ code: 1, output: '', error: fixedError });
  expect(response.output + response.error).not.toContain('PRIVATE');
}

describe('durable synthetic risk journal CLI', () => {
  it('restores reservations and cumulative loss across fresh CLI processes, with private reports and metadata-only stdout', async () => {
    const files = await setup();
    let latest = metadata(await cli(['init', files.input, files.journal]));
    const openingCheckpoint = structuredClone(latest.checkpoint);
    expect(latest.revision).toBe(0);
    for (let index = 0; index < fixture.events.length; index++) {
      await json(files.event, fixture.events[index]); await json(files.checkpoint, latest.checkpoint);
      latest = metadata(await cli(['append', files.event, files.journal, files.checkpoint]));
      expect(latest).toMatchObject({ revision: index + 1, appended: true });
      if (index === 2) {
        const directory = join(files.root, 'unknown-report');
        metadata(await cli(['inspect', files.journal, directory, files.checkpoint]));
        const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
        expect(report.result.settlement.reserved.okx.USDT).toBe('3.96');
        expect(report.result.settlement.positions[0].legs.buy.status).toBe('unknown');
      }
    }
    const output = join(files.root, 'report');
    await json(files.checkpoint, openingCheckpoint);
    const inspected = metadata(await cli(['inspect', files.journal, output, files.checkpoint]));
    expect(inspected).toMatchObject({ revision: 7, reportWritten: true });
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    for (const name of ['report.json', 'checkpoint.json']) expect((await stat(join(output, name))).mode & 0o777).toBe(0o600);
    const checkpoint = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8'));
    expect(checkpoint).toEqual(latest.checkpoint);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ schema: 2, kind: 'durable-paper-risk-settlement-report', executable: false,
      funding: 'synthetic', checkpoint, initialBalances: fixture.initialBalances, journal: fixture.events });
    expect(report.result).toEqual(viewPaperRiskState(replayPaperRiskJournal(fixture.initialBalances, fixture.policy, fixture.events)));
    expect(report.result.sessionUsage.closedCashLossUsdt).toBe('0.01344');
    // Rejected admission cannot create a record or reset the persisted session loss.
    const before = await readdir(files.journal);
    await json(files.event, fixture.probes[0]); await json(files.checkpoint, latest.checkpoint);
    failure(await cli(['append', files.event, files.journal, files.checkpoint]));
    expect(await readdir(files.journal)).toEqual(before);
    // A smaller plan below the remaining cash-loss allowance remains admissible.
    await json(files.event, fixture.probes[1]);
    expect(metadata(await cli(['append', files.event, files.journal, files.checkpoint])).revision).toBe(8);
  }, 30_000);

  it('requires the full current checkpoint for a new event and detects a missing suffix on anchored recovery', async () => {
    const files = await setup();
    const opening = metadata(await cli(['init', files.input, files.journal]));
    await json(files.event, fixture.events[0]); await json(files.checkpoint, opening.checkpoint);
    const current = metadata(await cli(['append', files.event, files.journal, files.checkpoint]));
    await json(files.event, fixture.events[1]);
    failure(await cli(['append', files.event, files.journal, files.checkpoint]));
    for (const checkpoint of [{ ...current.checkpoint, policyHash: '0'.repeat(64) },
      { ...current.checkpoint, journalId: '00000000-0000-4000-8000-000000000000' },
      { ...current.checkpoint, headHash: '0'.repeat(64) },
      { schema: 1, journalId: current.journalId, revision: current.revision, headHash: current.headHash }]) {
      await json(files.checkpoint, checkpoint);
      failure(await cli(['append', files.event, files.journal, files.checkpoint]));
    }
    await json(files.checkpoint, current.checkpoint);
    await rm(join(files.journal, '000001.json'));
    failure(await cli(['inspect', files.journal, join(files.root, 'rejected-report'), files.checkpoint]));
    expect(await readdir(files.root)).not.toContain('rejected-report');
    expect(metadata(await cli(['inspect', files.journal, join(files.root, 'unanchored-report')])).revision).toBe(0);
  }, 25_000);

  it('rejects policy bypass fields and strict initialization errors before creating a journal', async () => {
    const files = await setup();
    const valid = JSON.parse(await readFile(files.input, 'utf8')) as Record<string, unknown>;
    for (const invalid of [{ ...valid, live: true }, { ...valid, schema: 2 },
      { ...valid, policy: { ...fixture.policy, maxBuyDebitUsdt: '0' } },
      { ...valid, policy: { ...fixture.policy, resetSession: true } },
      { ...valid, initialBalances: undefined }]) {
      await json(files.input, invalid);
      failure(await cli(['init', files.input, files.journal]));
      expect(await readdir(files.root)).not.toContain('journal');
    }
    await json(files.input, valid);
    const current = metadata(await cli(['init', files.input, files.journal]));
    await json(files.checkpoint, current.checkpoint);
    await json(files.event, { ...fixture.events[0], policy: { ...fixture.policy, maxSessionCashLossUsdt: '999' } });
    failure(await cli(['append', files.event, files.journal, files.checkpoint]));
    expect(await readdir(files.journal)).toEqual(['manifest.json']);
  }, 20_000);

  it('preserves existing destinations and rejects unknown commands, excess arguments and unbounded or malformed inputs with fixed errors', async () => {
    const files = await setup();
    const current = metadata(await cli(['init', files.input, files.journal]));
    await json(files.checkpoint, current.checkpoint); await json(files.event, fixture.events[0]);
    const manifest = await readFile(join(files.journal, 'manifest.json'));
    failure(await cli(['init', files.input, files.journal]));
    expect(await readFile(join(files.journal, 'manifest.json'))).toEqual(manifest);
    const output = join(files.root, 'report');
    metadata(await cli(['inspect', files.journal, output]));
    const originalReport = await readFile(join(output, 'report.json'));
    failure(await cli(['inspect', files.journal, output]));
    expect(await readFile(join(output, 'report.json'))).toEqual(originalReport);
    for (const args of [[], ['PRIVATE_COMMAND', files.input, files.journal], ['append', files.event, files.journal],
      ['init', files.input, join(files.root, 'unused'), files.checkpoint],
      ['inspect', files.journal, join(files.root, 'unused'), files.checkpoint, 'PRIVATE_ARGUMENT']]) failure(await cli(args));
    const privateInput = join(files.root, 'PRIVATE_FILENAME.json');
    for (const content of ['{"PRIVATE_SECRET":', '{"PRIVATE_SECRET":"PRIVATE_VALUE"}', ' '.repeat(128 * 1024 + 1)]) {
      await writeFile(privateInput, content, { mode: 0o600 });
      failure(await cli(['append', privateInput, files.journal, files.checkpoint]));
    }
  }, 30_000);
});
