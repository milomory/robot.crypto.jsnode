import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  appendRiskSettlementJournal, appendSettlementJournal, createRiskSettlementJournal,
  createSettlementJournal, readRiskSettlementJournal, readSettlementJournal
} from '../src/paper-pair/settlement-journal.js';
import type { RiskSettlementJournalCheckpoint } from '../src/paper-pair/settlement-journal.js';
import { replayPaperRiskJournal, viewPaperRiskState } from '../src/paper-pair/risk.js';
import type { PaperRiskPolicy } from '../src/paper-pair/risk.js';
import { replaySettlementJournal, viewSettlementState } from '../src/paper-pair/settlement.js';
import type { SettlementBalances, SettlementEvent } from '../src/paper-pair/settlement.js';
import { canonical } from '../src/paper-v2/ledger.js';

const fixture = JSON.parse(await readFile('fixtures/pair-settlement/btc-fee-reconciliation.json', 'utf8')) as {
  initialBalances: SettlementBalances; events: SettlementEvent[];
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function policy(): PaperRiskPolicy {
  return {
    schema: 1, kind: 'synthetic-pair-risk-policy', policyId: 'journal-test-policy',
    maxBuyDebitUsdt: '9', maxSingleLegBtc: '0.00010011', maxSessionCashLossUsdt: '9.01',
    maxSessionFees: { BTC: '0.000001', USDT: '1', MX: '0' },
    minFreeAfterReserve: {
      mexc: { BTC: '0', USDT: '0', MX: '0' }, okx: { BTC: '0', USDT: '0', MX: '0' }
    }
  };
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'risk-journal-test-')); roots.push(root);
  return { root, directory: join(root, 'journal') };
}
async function fresh(count = 0) {
  const paths = await directory();
  let snapshot = await createRiskSettlementJournal(paths.directory, fixture.initialBalances, policy());
  for (const event of fixture.events.slice(0, count)) {
    snapshot = await appendRiskSettlementJournal(paths.directory, event, snapshot.checkpoint);
  }
  return { ...paths, snapshot };
}
function nextPrepare() {
  const event = structuredClone(fixture.events[0]);
  if (event.type !== 'prepare') throw new Error('prepare-fixture-required');
  event.id = 'prepare-2'; event.pairId = 'pair-2'; event.at = 20_002;
  event.buy.orderId = 'buy-2'; event.sell.orderId = 'sell-2';
  return event;
}
type StoredRecord = {
  schema: 2; journalId: string; sequence: number; previousHash: string;
  event: SettlementEvent; policyHash: string; hash: string;
};
async function replaceHash(path: string, value: Record<string, unknown>) {
  const { hash: _hash, ...body } = value;
  await writeFile(path, canonical({ ...body, hash: digest(body) }) + '\n');
  return digest(body);
}
async function rehashRecords(path: string, change: (record: StoredRecord, index: number) => void) {
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as { hash: string };
  let previousHash = manifest.hash;
  const records = (await readdir(path)).filter(name => /^\d{6}\.json$/.test(name)).sort();
  for (let i = 0; i < records.length; i++) {
    const file = join(path, records[i]);
    const record = JSON.parse(await readFile(file, 'utf8')) as StoredRecord;
    change(record, i); record.previousHash = previousHash;
    previousHash = await replaceHash(file, record);
  }
}

const childSource = [
  "import fs from 'node:fs/promises';",
  "import {syncBuiltinESMExports} from 'node:module';",
  "const [mode,directory,eventFile,checkpointFile]=process.argv.slice(1);",
  "const originalLink=fs.link;",
  "const pause=async()=>{setInterval(()=>{},1000);process.send({boundary:mode});await new Promise(()=>{});};",
  "fs.link=async(...args)=>{if(mode==='before-link')await pause();if(mode==='race'){process.send({boundary:mode});await new Promise(resolve=>process.once('message',resolve));}await originalLink(...args);if(mode==='after-link')await pause();};",
  "syncBuiltinESMExports();",
  "const api=await import('./src/paper-pair/settlement-journal.ts');",
  "const {viewPaperRiskState}=await import('./src/paper-pair/risk.ts');",
  "try{const checkpoint=JSON.parse(await fs.readFile(checkpointFile,'utf8'));const s=mode==='read'?await api.readRiskSettlementJournal(directory,checkpoint):await api.appendRiskSettlementJournal(directory,JSON.parse(await fs.readFile(eventFile,'utf8')),checkpoint);console.log(JSON.stringify({revision:s.revision,headHash:s.headHash,pendingFiles:s.pendingFiles,appended:s.appended,policyHash:s.policyHash,checkpoint:s.checkpoint,view:viewPaperRiskState({policy:s.policy,settlement:s.state})}));}catch(e){console.log(JSON.stringify({error:e.reason??'fixed-failure'}));}"
].join('\n');
async function child(mode: string, path: string, eventFile: string, checkpointFile: string) {
  const processChild = spawn(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', childSource, mode, path, eventFile, checkpointFile],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', error = '', killedAtBoundary = false;
  processChild.stdout!.on('data', data => { output += data; });
  processChild.stderr!.on('data', data => { error += data; });
  processChild.on('message', message => {
    if ((message as { boundary?: string }).boundary === mode) {
      killedAtBoundary = true; processChild.kill('SIGKILL');
    }
  });
  return await new Promise<{ output: string; error: string; killedAtBoundary: boolean; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => { processChild.kill('SIGKILL'); reject(new Error('child-timeout')); }, 10_000);
    processChild.once('error', cause => { clearTimeout(timer); reject(cause); });
    processChild.once('close', (_code, signal) => {
      clearTimeout(timer); resolve({ output, error, killedAtBoundary, signal });
    });
  });
}


async function competingChildren(path: string, eventFiles: string[], checkpointFile: string) {
  const workers = eventFiles.map(eventFile => {
    const processChild = spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', childSource, 'race', path, eventFile, checkpointFile],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', error = '';
    processChild.stdout!.on('data', data => { output += data; });
    processChild.stderr!.on('data', data => { error += data; });
    const ready = new Promise<boolean>(resolve => {
      processChild.on('message', message => {
        if ((message as { boundary?: string }).boundary === 'race') resolve(true);
      });
      processChild.once('close', () => { resolve(false); });
      processChild.once('error', () => { resolve(false); });
    });
    const finished = new Promise<{ output: string; error: string; code: number | null; signal: string | null }>(resolve => {
      processChild.once('error', () => { error += 'child-spawn-failed'; });
      processChild.once('close', (code, signal) => { resolve({ output, error, code, signal }); });
    });
    return { processChild, ready, finished };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error('race-barrier-timeout')); }, 10_000);
  });
  try {
    const ready = await Promise.race([Promise.all(workers.map(worker => worker.ready)), timeout]);
    if (ready.some(value => !value)) throw new Error('writer-exited-before-publication-barrier');
    // Both processes have validated the same prefix and fsynced their staging record.
    // Release only now, forcing a collision at the exclusive next-sequence link.
    for (const worker of workers) worker.processChild.send({ go: true });
    return await Promise.race([Promise.all(workers.map(worker => worker.finished)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const worker of workers) {
      if (worker.processChild.exitCode === null && worker.processChild.signalCode === null) worker.processChild.kill('SIGKILL');
    }
    await Promise.all(workers.map(worker => worker.finished));
  }
}

describe('risk-bound durable paper settlement', () => {
  it('pins a cloned frozen policy in the private manifest and every published record', async () => {
    const { directory: path } = await directory(), input = policy(), original = structuredClone(input);
    const creating = createRiskSettlementJournal(path, fixture.initialBalances, input);
    input.maxBuyDebitUsdt = '100'; input.maxSessionFees.MX = '100';
    let snapshot = await creating;
    expect(snapshot.schema).toBe(2); expect(snapshot.policy).toEqual(original);
    expect(snapshot.policyHash).toBe(digest(original));
    for (const value of [snapshot.policy, snapshot.policy.maxSessionFees, snapshot.policy.minFreeAfterReserve,
      snapshot.policy.minFreeAfterReserve.okx, snapshot.policy.minFreeAfterReserve.mexc]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    const manifestBefore = await readFile(join(path, 'manifest.json'), 'utf8');
    expect(JSON.parse(manifestBefore)).toMatchObject({ schema: 2, kind: 'risk-bound-paper-settlement-journal',
      policy: original, policyHash: snapshot.policyHash, hash: snapshot.headHash });
    for (const event of fixture.events) snapshot = await appendRiskSettlementJournal(path, event, snapshot.checkpoint);
    expect(await readFile(join(path, 'manifest.json'), 'utf8')).toBe(manifestBefore);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(path)) {
      expect((await stat(join(path, name))).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(await readFile(join(path, name), 'utf8'));
      expect(stored.schema).toBe(2); expect(stored.policyHash).toBe(snapshot.policyHash);
    }
    expect(snapshot.checkpoint).toEqual({ schema: 2, journalId: snapshot.journalId,
      revision: fixture.events.length, headHash: snapshot.headHash, policyHash: snapshot.policyHash });
    await expect(createRiskSettlementJournal(path, fixture.initialBalances, policy())).rejects.toThrow();
    expect(await readFile(join(path, 'manifest.json'), 'utf8')).toBe(manifestBefore);
  });

  it.each([undefined, null, {}, { ...policy(), allowLive: true }, {
    ...policy(), maxSessionFees: { ...policy().maxSessionFees, other: '1' }
  }])('rejects absent or non-strict policy without creating a legacy fallback: %j', async input => {
    const { root, directory: path } = await directory();
    await expect(createRiskSettlementJournal(path, fixture.initialBalances, input as PaperRiskPolicy))
      .rejects.toThrow('journal-risk-rejected');
    expect(await readdir(root)).toEqual([]);
  });

  it('separates schema 1 and schema 2 APIs without upgrading or bypassing risk', async () => {
    const { directory: path, snapshot } = await fresh(), legacy = await directory();
    const old = await createSettlementJournal(legacy.directory, fixture.initialBalances);
    await expect(readSettlementJournal(path)).rejects.toThrow('journal-kind-mismatch');
    await expect(appendSettlementJournal(path, fixture.events[0], snapshot.headHash)).rejects.toThrow('journal-kind-mismatch');
    await expect(readRiskSettlementJournal(legacy.directory)).rejects.toThrow('journal-kind-mismatch');
    await expect(appendRiskSettlementJournal(legacy.directory, fixture.events[0], {
      ...snapshot.checkpoint, journalId: old.journalId, headHash: old.headHash
    })).rejects.toThrow('journal-kind-mismatch');
    expect((await readRiskSettlementJournal(path)).revision).toBe(0);
    expect((await readSettlementJournal(legacy.directory)).revision).toBe(0);
  });

  it('reconstructs every observed event and accumulated risk usage in a fresh process', async () => {
    const { root, directory: path, snapshot } = await fresh(fixture.events.length);
    const checkpoint = join(root, 'checkpoint.json'); await writeFile(checkpoint, JSON.stringify(snapshot.checkpoint));
    const recovered = await child('read', path, '-', checkpoint);
    expect(recovered.error).toBe('');
    const result = JSON.parse(recovered.output);
    expect(result.view).toEqual(viewPaperRiskState(replayPaperRiskJournal(fixture.initialBalances, policy(), fixture.events)));
    expect(result.view.sessionUsage.closedCashLossUsdt).toBe('0.01344');
    expect(result.policyHash).toBe(snapshot.policyHash); expect(result.checkpoint).toEqual(snapshot.checkpoint);
    await expect(appendRiskSettlementJournal(path, nextPrepare(), snapshot.checkpoint)).rejects.toThrow('journal-risk-rejected');
    expect((await readRiskSettlementJournal(path)).checkpoint).toEqual(snapshot.checkpoint);
    const smaller = nextPrepare();
    smaller.buy.sizing = { kind: 'base', baseQuantity: '0.00010011', maxQuoteAmount: '8.99' };
    expect((await appendRiskSettlementJournal(path, smaller, snapshot.checkpoint)).appended).toBe(true);
  }, 15_000);

  it('replays historical risk checks even when tampered records have a valid complete hash chain', async () => {
    const { directory: path } = await fresh(fixture.events.length);
    const altered = structuredClone(fixture.events);
    if (altered[0].type !== 'prepare') throw new Error('prepare-fixture-required');
    altered[0].buy.sizing = { kind: 'base', baseQuantity: '0.00010011', maxQuoteAmount: '10' };
    // The accounting alone accepts these fills and final balances; policy admission must reject the earlier preparation.
    expect(() => replaySettlementJournal(fixture.initialBalances, altered)).not.toThrow();
    await rehashRecords(path, (record, index) => { record.event = altered[index]; });
    await expect(readRiskSettlementJournal(path)).rejects.toThrow('journal-invalid');
  });

  it.each(['manifest-policy', 'record-policy', 'record-schema', 'extra-field'])('rejects valid-hash binding corruption at %s', async kind => {
    const { directory: path } = await fresh(1);
    if (kind === 'manifest-policy') {
      const file = join(path, 'manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.policy.maxBuyDebitUsdt = '10'; // Deliberately retain the old policy hash.
      await replaceHash(file, manifest);
    }
    await rehashRecords(path, record => {
      if (kind === 'record-policy') record.policyHash = 'f'.repeat(64);
      if (kind === 'record-schema') Object.assign(record, { schema: 1 });
      if (kind === 'extra-field') Object.assign(record, { skipRisk: true });
    });
    await expect(readRiskSettlementJournal(path)).rejects.toThrow('journal-invalid');
  });

  it.each(['identity', 'policy', 'revision', 'head', 'schema', 'extra-field'])('rejects checkpoint %s mismatches for reads and appends', async kind => {
    const { directory: path, snapshot } = await fresh(1);
    const checkpoint = { ...snapshot.checkpoint };
    if (kind === 'identity') checkpoint.journalId = '00000000-0000-4000-8000-000000000000';
    if (kind === 'policy') checkpoint.policyHash = 'f'.repeat(64);
    if (kind === 'revision') checkpoint.revision = 0;
    if (kind === 'head') checkpoint.headHash = 'f'.repeat(64);
    if (kind === 'schema') Object.assign(checkpoint, { schema: 1 });
    if (kind === 'extra-field') Object.assign(checkpoint, { ignorePolicy: true });
    await expect(readRiskSettlementJournal(path, checkpoint)).rejects.toThrow('journal-head-conflict');
    await expect(appendRiskSettlementJournal(path, fixture.events[1], checkpoint)).rejects.toThrow('journal-head-conflict');
    expect((await readRiskSettlementJournal(path)).checkpoint).toEqual(snapshot.checkpoint);
    expect((await readdir(path)).sort()).toEqual(['000001.json', 'manifest.json']);
  });

  it('requires a checkpoint for append, clones it before I/O, and never accepts extra event options', async () => {
    const { directory: path, snapshot } = await fresh();
    for (const invalid of [undefined, null, snapshot.headHash, { ...snapshot.checkpoint, skipRisk: true }]) {
      await expect(appendRiskSettlementJournal(path, fixture.events[0], invalid as RiskSettlementJournalCheckpoint))
        .rejects.toThrow('journal-head-conflict');
    }
    const checkpoint = { ...snapshot.checkpoint };
    const appending = appendRiskSettlementJournal(path, fixture.events[0], checkpoint);
    checkpoint.policyHash = 'f'.repeat(64); checkpoint.revision = 99;
    const appended = await appending;
    expect(appended.revision).toBe(1);
    const extra = { ...fixture.events[1], allowWithoutRisk: true } as unknown as SettlementEvent;
    await expect(appendRiskSettlementJournal(path, extra, appended.checkpoint)).rejects.toThrow('journal-event-invalid');
    expect((await readRiskSettlementJournal(path)).checkpoint).toEqual(appended.checkpoint);
  });

  it('accepts an anchored older prefix for read and exact duplicate but rejects a stale new decision', async () => {
    const { directory: path, snapshot } = await fresh(1);
    const after = await appendRiskSettlementJournal(path, fixture.events[1], snapshot.checkpoint);
    expect((await readRiskSettlementJournal(path, snapshot.checkpoint)).revision).toBe(2);
    const duplicate = await appendRiskSettlementJournal(path, fixture.events[1], snapshot.checkpoint);
    expect(duplicate.appended).toBe(false); expect(duplicate.checkpoint).toEqual(after.checkpoint);
    expect(viewSettlementState(duplicate.state)).toEqual(viewSettlementState(after.state));
    await expect(appendRiskSettlementJournal(path, fixture.events[2], snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
    const conflicting = structuredClone(fixture.events[1]); conflicting.at++;
    await expect(appendRiskSettlementJournal(path, conflicting, snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
    await expect(appendRiskSettlementJournal(path, conflicting, after.checkpoint)).rejects.toThrow('journal-event-invalid');
    expect((await readRiskSettlementJournal(path)).checkpoint).toEqual(after.checkpoint);
  });

  it('detects suffix deletion against an external risk checkpoint without inventing freshness without one', async () => {
    const { directory: path, snapshot } = await fresh(2);
    await rm(join(path, '000002.json'));
    await expect(readRiskSettlementJournal(path, snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
    expect((await readRiskSettlementJournal(path)).revision).toBe(1);
  });

  it('detects a consistent policy rewrite against the independently retained policy checkpoint', async () => {
    const { directory: path, snapshot } = await fresh(1);
    const file = join(path, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.policy.maxBuyDebitUsdt = '10'; manifest.policyHash = digest(manifest.policy);
    await replaceHash(file, manifest);
    await rehashRecords(path, record => { record.policyHash = manifest.policyHash; });
    // Hashes are consistency checks, not a signature: only the external anchor proves the original identity/policy/history.
    expect((await readRiskSettlementJournal(path)).policyHash).not.toBe(snapshot.policyHash);
    await expect(readRiskSettlementJournal(path, snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
  });

  it('forces two independent processes to compete at publication for the same risk-bound checkpoint', async () => {
    const { root, directory: path, snapshot } = await fresh();
    const eventFiles = [join(root, 'first.json'), join(root, 'second.json')], checkpointFile = join(root, 'checkpoint.json');
    await writeFile(eventFiles[0], JSON.stringify(fixture.events[0]), { mode: 0o600 });
    await writeFile(eventFiles[1], JSON.stringify(nextPrepare()), { mode: 0o600 });
    await writeFile(checkpointFile, JSON.stringify(snapshot.checkpoint), { mode: 0o600 });
    const results = await competingChildren(path, eventFiles, checkpointFile);
    for (const result of results) {
      expect(result.error).toBe(''); expect(result.code).toBe(0); expect(result.signal).toBeNull();
    }
    const responses = results.map(result => JSON.parse(result.output));
    const success = responses.filter(result => result.appended === true);
    expect(success).toHaveLength(1);
    expect(responses.filter(result => result.error)).toEqual([{ error: 'journal-head-conflict' }]);
    const recovered = await readRiskSettlementJournal(path, snapshot.checkpoint);
    expect(recovered.revision).toBe(1); expect(recovered.state.positions).toHaveLength(1);
    expect(viewSettlementState(recovered.state).reserved.okx.USDT).toBe('9');
    expect(recovered.policyHash).toBe(snapshot.policyHash); expect(recovered.checkpoint).toEqual(success[0].checkpoint);
    expect(recovered.pendingFiles).toBe(0);
  }, 15_000);

  it('deduplicates concurrent submissions of the same preparation without another reserve', async () => {
    const { directory: path, snapshot } = await fresh();
    const results = await Promise.all([
      appendRiskSettlementJournal(path, fixture.events[0], snapshot.checkpoint),
      appendRiskSettlementJournal(path, fixture.events[0], snapshot.checkpoint)
    ]);
    expect(results.map(result => result.appended).sort()).toEqual([false, true]);
    expect(results[0].checkpoint).toEqual(results[1].checkpoint);
    const recovered = await readRiskSettlementJournal(path);
    expect(recovered.revision).toBe(1); expect(viewSettlementState(recovered.state).reserved.okx.USDT).toBe('9');
  });

  it.each(['before-link', 'after-link'])('recovers pinned policy and partial-fill reserves after actual SIGKILL %s', async mode => {
    const { root, directory: path, snapshot } = await fresh(2);
    const eventFile = join(root, 'event.json'), checkpointFile = join(root, 'checkpoint.json');
    await writeFile(eventFile, JSON.stringify(fixture.events[2]), { mode: 0o600 });
    await writeFile(checkpointFile, JSON.stringify(snapshot.checkpoint), { mode: 0o600 });
    const stopped = await child(mode, path, eventFile, checkpointFile);
    expect(stopped.error).toBe(''); expect(stopped.killedAtBoundary).toBe(true); expect(stopped.signal).toBe('SIGKILL');
    const pending = (await readdir(path)).filter(name => name.startsWith('.pending-'));
    expect(pending).toHaveLength(1);
    const stagedBytes = await readFile(join(path, pending[0]));
    const recovered = await readRiskSettlementJournal(path, snapshot.checkpoint);
    expect(recovered.revision).toBe(mode === 'before-link' ? 2 : 3); expect(recovered.pendingFiles).toBe(1);
    expect(recovered.policyHash).toBe(snapshot.policyHash); expect(recovered.policy).toEqual(snapshot.policy);
    const view = viewSettlementState(recovered.state);
    expect(view.reserved.okx.USDT).toBe('3.96');
    expect(view.positions[0].legs.buy.status).toBe(mode === 'before-link' ? 'partial' : 'unknown');
    expect(viewPaperRiskState({ policy: recovered.policy, settlement: recovered.state })).toEqual(
      viewPaperRiskState(replayPaperRiskJournal(fixture.initialBalances, policy(), fixture.events.slice(0, recovered.revision)))
    );
    expect(await readFile(join(path, pending[0]))).toEqual(stagedBytes);
    const resumed = await appendRiskSettlementJournal(path, fixture.events[2], snapshot.checkpoint);
    expect(resumed.appended).toBe(mode === 'before-link'); expect(resumed.revision).toBe(3);
    expect(viewSettlementState(resumed.state).reserved.okx.USDT).toBe('3.96');
    expect(viewSettlementState(resumed.state).positions[0].legs.buy.status).toBe('unknown');
    expect(await readFile(join(path, pending[0]))).toEqual(stagedBytes);
  }, 15_000);

  it('reports and preserves unvalidated staging bytes without promoting them or relaxing policy', async () => {
    const { directory: path, snapshot } = await fresh(2);
    const staged = join(path, '.pending-00'), bytes = '{"schema":2,"policy":{"allowAnything":true},"event":';
    await writeFile(staged, bytes, { mode: 0o600 });
    const recovered = await readRiskSettlementJournal(path, snapshot.checkpoint);
    expect(recovered.checkpoint).toEqual(snapshot.checkpoint); expect(recovered.pendingFiles).toBe(1);
    expect(recovered.policy).toEqual(snapshot.policy);
    expect(viewSettlementState(recovered.state)).toEqual(viewSettlementState(snapshot.state));
    expect(await readFile(staged, 'utf8')).toBe(bytes);
    const next = await appendRiskSettlementJournal(path, fixture.events[2], recovered.checkpoint);
    expect(next.revision).toBe(3); expect(next.policyHash).toBe(snapshot.policyHash);
    expect(await readFile(staged, 'utf8')).toBe(bytes);
  });
});
