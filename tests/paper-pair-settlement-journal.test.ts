import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createSettlementJournal, readSettlementJournal, appendSettlementJournal } from '../src/paper-pair/settlement-journal.js';
import { replaySettlementJournal, viewSettlementState } from '../src/paper-pair/settlement.js';
import type { SettlementBalances, SettlementEvent } from '../src/paper-pair/settlement.js';

const fixture = JSON.parse(await readFile('fixtures/pair-settlement/btc-fee-reconciliation.json', 'utf8')) as {
  initialBalances: SettlementBalances; events: SettlementEvent[];
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fresh(count = 0) {
  const root = await mkdtemp(join(tmpdir(), 'settlement-journal-test-')); roots.push(root);
  const directory = join(root, 'journal');
  let snapshot = await createSettlementJournal(directory, fixture.initialBalances);
  for (const event of fixture.events.slice(0, count)) snapshot = await appendSettlementJournal(directory, event, snapshot.headHash);
  return { root, directory, snapshot };
}
const childSource = [
  "import fs from 'node:fs/promises';",
  "import {syncBuiltinESMExports} from 'node:module';",
  "const [mode,directory,eventFile,head]=process.argv.slice(1);",
  "let linked=false,paused=0,limited=0; const originalLink=fs.link, originalOpen=fs.open;const checkLimit=()=>{if(paused===16&&limited===4)process.send({boundary:'concurrency-limit'});};",
  "const pause=async()=>{setInterval(()=>{},1000);process.send({boundary:mode});await new Promise(()=>{});};",
  "fs.link=async(...args)=>{if(mode==='concurrency-limit'){paused++;checkLimit();await new Promise(()=>{});}if(mode==='before-link')await pause();await originalLink(...args);linked=true;if(mode==='after-link')await pause();};",
  "fs.open=async(...args)=>{const file=await originalOpen(...args),sync=file.sync.bind(file);file.sync=async()=>{if((mode==='file-sync-error'&&String(args[0]).includes('.pending-'))||(mode==='directory-sync-error'&&linked))throw new Error('PRIVATE_IO_FAILURE');return sync();};return file;};",
  "syncBuiltinESMExports();",
  "const api=await import('./src/paper-pair/settlement-journal.ts');",
  "const {viewSettlementState}=await import('./src/paper-pair/settlement.ts');",
  "if(mode==='concurrency-limit'){setInterval(()=>{},1000);const event=JSON.parse(await fs.readFile(eventFile,'utf8'));await Promise.all(Array.from({length:20},()=>api.appendSettlementJournal(directory,event,head).catch(e=>{if(e.reason!=='journal-limit')throw e;limited++;checkLimit();})));}",
  "try{const s=mode==='read'?await api.readSettlementJournal(directory):await api.appendSettlementJournal(directory,JSON.parse(await fs.readFile(eventFile,'utf8')),head);console.log(JSON.stringify({revision:s.revision,headHash:s.headHash,pendingFiles:s.pendingFiles,appended:s.appended,view:viewSettlementState(s.state)}));}catch(e){console.log(JSON.stringify({error:e.reason??'fixed-failure'}));}",
].join('\n');
async function child(mode: string, directory: string, eventFile = '-', head = '-') {
  const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource, mode, directory, eventFile, head],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', error = '', killedAtBoundary = false;
  processChild.stdout!.on('data', data => { output += data; });
  processChild.stderr!.on('data', data => { error += data; });
  processChild.on('message', message => {
    if ((message as { boundary?: string }).boundary === mode) { killedAtBoundary = true; processChild.kill('SIGKILL'); }
  });
  return await new Promise<{ output: string; error: string; killedAtBoundary: boolean; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => { processChild.kill('SIGKILL'); reject(new Error('child-timeout')); }, 10_000);
    processChild.once('error', cause => { clearTimeout(timer); reject(cause); });
    processChild.once('close', (_code, signal) => { clearTimeout(timer); resolve({ output, error, killedAtBoundary, signal }); });
  });
}

async function cli(args: string[]) {
  return await new Promise<{ code: number; output: string; error: string }>(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'src/scripts/settlement-journal.ts', ...args],
      { cwd: process.cwd(), timeout: 10_000, maxBuffer: 256 * 1024 }, (error, output, stderr) => {
        resolve({ code: error ? 1 : 0, output, error: stderr });
      });
  });
}

describe('durable offline paired settlement', () => {
  it('replays partial fills, unknown reserves and final settlement across independent processes', async () => {
    const { root, directory, snapshot } = await fresh();
    let head = snapshot.headHash;
    for (let i = 0; i < fixture.events.length; i++) {
      const eventFile = join(root, 'event.json'); await writeFile(eventFile, JSON.stringify(fixture.events[i]), { mode: 0o600 });
      const result = await child('append', directory, eventFile, head);
      expect(result.error).toBe('');
      const actual = JSON.parse(result.output);
      expect(actual.error).toBeUndefined(); expect(actual.appended).toBe(true); expect(actual.revision).toBe(i + 1);
      const expected = viewSettlementState(replaySettlementJournal(fixture.initialBalances, fixture.events.slice(0, i + 1)));
      expect(actual.view).toEqual(expected); head = actual.headHash;
      if (i === 2) {
        expect(actual.view.reserved.okx.USDT).toBe('3.96');
        expect(actual.view.positions[0].legs.buy.status).toBe('unknown');
      }
    }
    const recovered = JSON.parse((await child('read', directory)).output);
    expect(recovered.headHash).toBe(head); expect(recovered.view.positions[0].settlement).toBe('balanced');
    expect(recovered.view.positions[0].cashDeltaUsdt).toBe('-0.01344');
  }, 30_000);

  it('stores private immutable files and never overwrites an existing journal', async () => {
    const { directory } = await fresh(1);
    const files = await readdir(directory);
    expect(files.sort()).toEqual(['000001.json', 'manifest.json']);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const original = await readFile(join(directory, 'manifest.json'));
    for (const name of files) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    await expect(createSettlementJournal(directory, fixture.initialBalances)).rejects.toThrow();
    expect((await readFile(join(directory, 'manifest.json'))).equals(original)).toBe(true);
  });

  it('deduplicates identical event IDs after lost acknowledgement without posting twice', async () => {
    const { directory, snapshot } = await fresh(1);
    const first = await appendSettlementJournal(directory, fixture.events[1], snapshot.headHash);
    const duplicate = await appendSettlementJournal(directory, fixture.events[1], snapshot.headHash);
    expect(duplicate.appended).toBe(false); expect(duplicate.headHash).toBe(first.headHash);
    expect(duplicate.revision).toBe(2); expect(viewSettlementState(duplicate.state)).toEqual(viewSettlementState(first.state));
    const conflicting = structuredClone(fixture.events[1]); conflicting.at++;
    await expect(appendSettlementJournal(directory, conflicting, first.headHash)).rejects.toThrow('journal-event-invalid');
    expect((await readSettlementJournal(directory)).headHash).toBe(first.headHash);
  });

  it('keeps economic duplicate deliveries as audit records without repeating the cash movement', async () => {
    const { directory, snapshot } = await fresh(6);
    const after = await appendSettlementJournal(directory, fixture.events[6], snapshot.headHash);
    expect(after.revision).toBe(7);
    expect(viewSettlementState(after.state).balances).toEqual(viewSettlementState(snapshot.state).balances);
  });

  it('rejects stale heads and invalid new events without changing any record', async () => {
    const { directory, snapshot } = await fresh(1);
    await expect(appendSettlementJournal(directory, fixture.events[1], '0'.repeat(64))).rejects.toThrow('journal-head-conflict');
    await expect(appendSettlementJournal(directory, { ...fixture.events[1], private: 'DO_NOT_OUTPUT' } as unknown as SettlementEvent, snapshot.headHash)).rejects.toThrow('journal-event-invalid');
    expect((await readSettlementJournal(directory)).headHash).toBe(snapshot.headHash);
    expect((await readdir(directory)).sort()).toEqual(['000001.json', 'manifest.json']);
  });

  it('serializes competing writers using the immutable next sequence', async () => {
    const { directory, snapshot } = await fresh(1);
    const first: SettlementEvent = { type: 'unknown', id: 'unknown-buy', at: 1100, pairId: 'pair-1', side: 'buy' };
    const second: SettlementEvent = { ...first, id: 'unknown-sell', side: 'sell' };
    const results = await Promise.allSettled([appendSettlementJournal(directory, first, snapshot.headHash), appendSettlementJournal(directory, second, snapshot.headHash)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('journal-head-conflict');
    expect((await readSettlementJournal(directory)).revision).toBe(2);
  });

  it('deduplicates competing submissions of the same event', async () => {
    const { directory, snapshot } = await fresh(1);
    const results = await Promise.all([appendSettlementJournal(directory, fixture.events[1], snapshot.headHash), appendSettlementJournal(directory, fixture.events[1], snapshot.headHash)]);
    expect(results.map(result => result.appended).sort()).toEqual([false, true]);
    expect((await readSettlementJournal(directory)).revision).toBe(2);
  });

  it.each(['before-link', 'after-link'])('recovers after actual SIGKILL at %s without inventing or losing a published fill', async mode => {
    const { root, directory, snapshot } = await fresh(1);
    const eventFile = join(root, 'event.json'); await writeFile(eventFile, JSON.stringify(fixture.events[1]));
    const stopped = await child(mode, directory, eventFile, snapshot.headHash);
    expect(stopped.error).toBe(''); expect(stopped.killedAtBoundary).toBe(true); expect(stopped.signal).toBe('SIGKILL');
    const recovered = await readSettlementJournal(directory);
    expect(recovered.revision).toBe(mode === 'before-link' ? 1 : 2);
    expect(recovered.pendingFiles).toBe(1);
    const expected = viewSettlementState(replaySettlementJournal(fixture.initialBalances, fixture.events.slice(0, recovered.revision)));
    expect(viewSettlementState(recovered.state)).toEqual(expected);
    const resumed = await appendSettlementJournal(directory, fixture.events[1], snapshot.headHash);
    expect(resumed.appended).toBe(mode === 'before-link'); expect(resumed.revision).toBe(2);
    expect(viewSettlementState(resumed.state)).toEqual(viewSettlementState(replaySettlementJournal(fixture.initialBalances, fixture.events.slice(0, 2))));
  }, 15_000);

  it.each(['file-sync-error', 'directory-sync-error'])('preserves the correct recovery boundary for %s', async mode => {
    const { root, directory, snapshot } = await fresh(1);
    const eventFile = join(root, 'event.json'); await writeFile(eventFile, JSON.stringify(fixture.events[1]));
    const result = await child(mode, directory, eventFile, snapshot.headHash);
    expect(result.error).toBe(''); expect(result.output).not.toContain('PRIVATE_IO_FAILURE');
    expect(JSON.parse(result.output).error).toBe(mode === 'file-sync-error' ? 'journal-write-failed' : 'journal-publish-uncertain');
    const recovered = await readSettlementJournal(directory);
    expect(recovered.revision).toBe(mode === 'file-sync-error' ? 1 : 2);
    expect(recovered.pendingFiles).toBe(mode === 'file-sync-error' ? 0 : 1);
  }, 15_000);

  it('fails closed on truncated records, modified content, missing middle records and unknown files', async () => {
    const { directory } = await fresh(2), file = join(directory, '000001.json');
    const original = await readFile(file, 'utf8');
    for (const broken of ['{"schema":', original.replace('prepare', 'tampered')]) {
      await writeFile(file, broken);
      await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid');
    }
    await rm(file);
    await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid');
    await writeFile(file, original, { mode: 0o600 });
    await writeFile(join(directory, 'unexpected.json'), '{}', { mode: 0o600 });
    await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid');
  });

  it('rejects unsafe permissions, symlinks and foreign hardlinks', async () => {
    const { root, directory } = await fresh(1), file = join(directory, '000001.json');
    await chmod(directory, 0o755); await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid'); await chmod(directory, 0o700);
    await chmod(file, 0o644); await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid'); await chmod(file, 0o600);
    await link(file, join(root, 'external-link')); await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid'); await rm(join(root, 'external-link'));
    await symlink(directory, join(root, 'alias')); await expect(readSettlementJournal(join(root, 'alias'))).rejects.toThrow('journal-invalid');
    await rm(file); await symlink(join(directory, 'manifest.json'), file); await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid');
  });

  it('bounds retained interrupted writes and prevents more writes at the pending limit', async () => {
    const { directory, snapshot } = await fresh(1);
    for (let i = 0; i < 16; i++) await writeFile(join(directory, '.pending-' + String(i).padStart(2, '0')), 'incomplete', { mode: 0o600 });
    expect((await readSettlementJournal(directory)).pendingFiles).toBe(16);
    await expect(appendSettlementJournal(directory, fixture.events[1], snapshot.headHash)).rejects.toThrow('journal-limit');
    await writeFile(join(directory, '.pending-16'), '', { mode: 0o600 });
    await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid');
  });

  it('bounds twenty concurrent interrupted writers to sixteen exclusive staging slots', async () => {
    const { root, directory, snapshot } = await fresh(1);
    const eventFile = join(root, 'event.json'); await writeFile(eventFile, JSON.stringify(fixture.events[1]));
    const stopped = await child('concurrency-limit', directory, eventFile, snapshot.headHash);
    expect(stopped.error).toBe(''); expect(stopped.killedAtBoundary).toBe(true); expect(stopped.signal).toBe('SIGKILL');
    const recovered = await readSettlementJournal(directory);
    expect(recovered.revision).toBe(1); expect(recovered.pendingFiles).toBe(16);
    expect((await readdir(directory)).filter(name => name.startsWith('.pending-'))).toHaveLength(16);
    expect(viewSettlementState(recovered.state)).toEqual(viewSettlementState(snapshot.state));
    await expect(appendSettlementJournal(directory, fixture.events[1], snapshot.headHash)).rejects.toThrow('journal-limit');
  }, 15_000);

  it('uses an external checkpoint to reject missing committed suffixes or another journal', async () => {
    const { directory, snapshot } = await fresh(2);
    const checkpoint = { journalId: snapshot.journalId, revision: snapshot.revision, headHash: snapshot.headHash };
    expect((await readSettlementJournal(directory, checkpoint)).revision).toBe(2);
    await appendSettlementJournal(directory, fixture.events[2], snapshot.headHash);
    expect((await readSettlementJournal(directory, checkpoint)).revision).toBe(3);
    await rm(join(directory, '000003.json')); await rm(join(directory, '000002.json'));
    await expect(readSettlementJournal(directory, checkpoint)).rejects.toThrow('journal-head-conflict');
    // Without an independently retained anchor only internal prefix consistency is knowable.
    expect((await readSettlementJournal(directory)).revision).toBe(1);
    const other = await fresh();
    await expect(readSettlementJournal(other.directory, checkpoint)).rejects.toThrow('journal-head-conflict');
  });

  it('rejects oversized committed or staged files without parsing their content', async () => {
    const { directory } = await fresh(1);
    const pending = join(directory, '.pending-00');
    await writeFile(pending, Buffer.alloc(128 * 1024 + 1), { mode: 0o600 });
    await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid');
    await rm(pending); await writeFile(join(directory, '000001.json'), Buffer.alloc(128 * 1024 + 1));
    await expect(readSettlementJournal(directory)).rejects.toThrow('journal-invalid');
  });
  it('provides a local CLI with private report and independent checkpoint, metadata-only stdout', async () => {
    const { root } = await fresh();
    const journal = join(root, 'cli-journal'), opening = join(root, 'opening.json'), eventFile = join(root, 'event.json');
    await writeFile(opening, JSON.stringify(fixture.initialBalances), { mode: 0o600 });
    await writeFile(eventFile, JSON.stringify(fixture.events[0]), { mode: 0o600 });
    const init = await cli(['init', opening, journal]); expect(init.code).toBe(0);
    const first = JSON.parse(init.output);
    const append = await cli(['append', eventFile, journal, first.headHash]); expect(append.code).toBe(0);
    expect(JSON.parse(append.output)).toMatchObject({ revision: 1, appended: true, funding: 'synthetic', executable: false });
    const output = join(root, 'report');
    const inspect = await cli(['inspect', journal, output]); expect(inspect.code).toBe(0);
    for (const response of [init, append, inspect]) {
      expect(response.error).toBe('');
      expect(response.output).not.toMatch(/initialBalances|orderId|cashDeltaUsdt|buy-1|pair-1/);
    }
    const checkpointFile = join(output, 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
    expect(Object.keys(checkpoint).sort()).toEqual(['headHash', 'journalId', 'revision']);
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    for (const name of ['report.json', 'checkpoint.json']) expect((await stat(join(output, name))).mode & 0o777).toBe(0o600);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report.result).toEqual(viewSettlementState(replaySettlementJournal(fixture.initialBalances, [fixture.events[0]])));
    expect((await cli(['inspect', journal, join(root, 'recovered'), checkpointFile])).code).toBe(0);
    await rm(join(journal, '000001.json'));
    expect((await cli(['inspect', journal, join(root, 'rollback-detected'), checkpointFile])).code).toBe(1);
  }, 20_000);

  it('keeps CLI errors fixed and refuses invalid commands or untrusted input without network access', async () => {
    const { root } = await fresh();
    const secretFile = join(root, 'PRIVATE_INPUT_NAME.json');
    await writeFile(secretFile, '{"privateToken":"PRIVATE_INPUT_VALUE"}', { mode: 0o600 });
    for (const args of [['init', secretFile, join(root, 'invalid')], ['unknown', secretFile, root], ['append', secretFile, root, 'PRIVATE_HEAD']]) {
      const result = await cli(args); expect(result.code).toBe(1); expect(result.output).toBe('');
      expect(result.error).toContain('Local paper journal command failed.');
      expect(result.error).not.toMatch(/PRIVATE_INPUT_NAME|PRIVATE_INPUT_VALUE|PRIVATE_HEAD|ZodError|stack/);
    }
  }, 15_000);

});
