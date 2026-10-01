import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLiveOrderJournal, createLiveOrderJournal, LIVE_ORDER_JOURNAL_LIMITS,
  readLiveOrderJournal } from '../src/live/order-journal.js';
import { deriveLiveClientOrderId, planLiveOrderRecovery } from '../src/live/order-lifecycle.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const at = (value: number) => new Date(Date.UTC(2026, 8, 28, 12, 0, value)).toISOString();
const intent = (value = 1) => ({ eventId: id(value), at: at(value), type: 'intent-created',
  intent: { orderIntentId: id(value + 100), venue: 'mexc', account: 'main', symbol: 'BTC/USDT', side: 'buy',
    orderType: 'limit', baseQuantity: '0.0001', limitPrice: '100000', maxQuoteAmount: '10',
    feeCaps: { BTC: '0', USDT: '0.1', MX: '0' } } });
const dispatch = () => ({ eventId: id(2), at: at(2), type: 'dispatch-marked', orderIntentId: id(101),
  clientOrderId: deriveLiveClientOrderId('mexc', id(101)) });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fresh(count = 0) {
  const root = await mkdtemp(join(tmpdir(), 'live-order-journal-test-')); roots.push(root);
  const directory = join(root, 'journal');
  let snapshot = await createLiveOrderJournal(directory);
  for (const event of [intent(), dispatch()].slice(0, count)) snapshot = await appendLiveOrderJournal(directory, event, snapshot.checkpoint);
  return { root, directory, snapshot };
}
const childSource = [
  "import fs from 'node:fs/promises';",
  "import {syncBuiltinESMExports} from 'node:module';",
  "const [mode,directory,eventFile,checkpointFile]=process.argv.slice(1);",
  "globalThis.fetch=()=>{throw Error('network-forbidden');};",
  "let linked=false,paused=0,limited=0;const originalLink=fs.link,originalOpen=fs.open;",
  "const checkLimit=()=>{if(paused===8&&limited===2)process.send({boundary:mode});};",
  "const pause=async()=>{setInterval(()=>{},1000);process.send({boundary:mode});await new Promise(()=>{});};",
  "fs.link=async(...args)=>{if(mode==='concurrency-limit'){paused++;checkLimit();await new Promise(()=>{});}if(mode==='before-link')await pause();await originalLink(...args);linked=true;if(mode==='after-link')await pause();};",
  "fs.open=async(...args)=>{const file=await originalOpen(...args),sync=file.sync.bind(file),write=file.writeFile.bind(file);file.writeFile=async(value,...rest)=>{if(mode==='during-write'&&String(args[0]).includes('.pending-')){await write(String(value).slice(0,20));await pause();}return write(value,...rest);};file.sync=async()=>{if((mode==='file-sync-error'&&String(args[0]).includes('.pending-'))||(mode==='directory-sync-error'&&linked))throw Error('PRIVATE_IO_DETAIL');return sync();};return file;};",
  "syncBuiltinESMExports();",
  "const api=await import('./src/live/order-journal.ts');",
  "const lifecycle=await import('./src/live/order-lifecycle.ts');",
  "if(mode==='concurrency-limit'){setInterval(()=>{},1000);const event=JSON.parse(await fs.readFile(eventFile,'utf8')),head=JSON.parse(await fs.readFile(checkpointFile,'utf8'));await Promise.all(Array.from({length:10},()=>api.appendLiveOrderJournal(directory,event,head).catch(e=>{if(e.reason!=='journal-limit')throw e;limited++;checkLimit();})));}",
  "try{const value=mode==='read'?await api.readLiveOrderJournal(directory):await api.appendLiveOrderJournal(directory,JSON.parse(await fs.readFile(eventFile,'utf8')),JSON.parse(await fs.readFile(checkpointFile,'utf8')));console.log(JSON.stringify({revision:value.revision,headHash:value.headHash,pendingFiles:value.pendingFiles,appended:value.appended,state:value.state,recovery:lifecycle.planLiveOrderRecovery(value.state)}));}catch(e){console.log(JSON.stringify({error:e.reason??'fixed-failure'}));}",
].join('\n');
async function child(mode: string, directory: string, eventFile = '-', checkpointFile = '-') {
  const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource,
    mode, directory, eventFile, checkpointFile], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
async function inputFiles(root: string, event: unknown, checkpoint: unknown) {
  const eventFile = join(root, 'event.json'), checkpointFile = join(root, 'checkpoint.json');
  await writeFile(eventFile, JSON.stringify(event), { mode: 0o600 });
  await writeFile(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600 });
  return { eventFile, checkpointFile };
}

describe('isolated durable live-order lifecycle rehearsal', () => {
  it('creates private immutable files with a distinct non-executable schema and never overwrites a journal', async () => {
    const { directory, snapshot } = await fresh(1);
    expect(snapshot).toMatchObject({ schema: 1, kind: 'live-order-rehearsal-journal', nonExecutable: true,
      captureProvenanceVerified: false, revision: 1 });
    expect(snapshot.checkpoint).toMatchObject({ schema: 1, kind: 'live-order-rehearsal-checkpoint',
      journalId: snapshot.journalId, revision: 1, headHash: snapshot.headHash });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files.sort()).toEqual(['000001.json', 'manifest.json']);
    for (const file of files) expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    const manifest = await readFile(join(directory, 'manifest.json'));
    await expect(createLiveOrderJournal(directory)).rejects.toThrow('journal-write-failed');
    expect((await readFile(join(directory, 'manifest.json'))).equals(manifest)).toBe(true);
  });

  it('persists dispatch uncertainty across a new process and exposes only a recovery plan', async () => {
    const { root, directory, snapshot } = await fresh(1);
    const paths = await inputFiles(root, dispatch(), snapshot.checkpoint);
    const appended = await child('append', directory, paths.eventFile, paths.checkpointFile);
    expect(appended.error).toBe(''); expect(JSON.parse(appended.output).appended).toBe(true);
    const restarted = await child('read', directory);
    expect(restarted.error).toBe('');
    const result = JSON.parse(restarted.output);
    expect(result.revision).toBe(2); expect(result.state.nonExecutable).toBe(true);
    expect(result.recovery).toEqual(planLiveOrderRecovery((await readLiveOrderJournal(directory)).state));
    expect(JSON.stringify(result.recovery)).not.toMatch(/"(?:submit|resubmit|retry|send)"/);
    const repeated = await child('append', directory, paths.eventFile, paths.checkpointFile);
    expect(JSON.parse(repeated.output)).toMatchObject({ revision: 2, appended: false, headHash: result.headHash });
  }, 15_000);

  it('replays partial fills and terminal reconciliation without repeating cash or recycling a terminal intent', async () => {
    const { root, directory, snapshot } = await fresh(2);
    const identity = { venue: 'mexc', account: 'main', symbol: 'BTC/USDT', side: 'buy',
      clientOrderId: deriveLiveClientOrderId('mexc', id(101)), exchangeOrderId: 'synthetic-order-1' };
    const fill = { eventId: id(3), at: at(3), type: 'fill-recorded', orderIntentId: id(101), identity,
      source: 'synthetic', fill: { fillId: 'synthetic-fill-1', executedAt: at(2), baseQuantity: '0.00005',
        quoteQuantity: '5', quoteAmountSource: 'reported', fees: { BTC: '0', USDT: '0.005', MX: '0' } } };
    let current = await appendLiveOrderJournal(directory, fill, snapshot.checkpoint);
    current = await appendLiveOrderJournal(directory, { ...fill, eventId: id(4), at: at(4) }, current.checkpoint);
    expect(current.state.orders[0].cashDelta).toEqual({ BTC: '0.00005', USDT: '-5.005', MX: '0' });
    expect(current.state.orders[0].fills).toHaveLength(1);
    current = await appendLiveOrderJournal(directory, { eventId: id(5), at: at(5), type: 'order-observed',
      orderIntentId: id(101), observation: { identity, source: 'synthetic', status: 'canceled',
        cumulativeBaseQuantity: '0.00005', cumulativeQuoteQuantity: '5', quoteAmountSource: 'reported' } }, current.checkpoint);
    const terminalRead = JSON.parse((await child('read', directory)).output);
    expect(terminalRead.state.orders[0].phase).toBe('terminal-unreconciled');
    expect(terminalRead.state.orders[0].reserved.USDT).toBe('10.1');
    expect(terminalRead.recovery.actions[0].action).toBe('reconcile-terminal-fills');
    const final = { eventId: id(6), at: at(6), type: 'terminal-reconciled', orderIntentId: id(101), observationEventId: id(5) };
    const paths = await inputFiles(root, final, current.checkpoint);
    const resumed = await child('append', directory, paths.eventFile, paths.checkpointFile);
    expect(resumed.error).toBe('');
    const result = JSON.parse(resumed.output);
    expect(result.state.orders[0]).toMatchObject({ phase: 'reconciled', reserved: { BTC: '0', USDT: '0', MX: '0' },
      cashDelta: { BTC: '0.00005', USDT: '-5.005', MX: '0' } });
    const recovered = await readLiveOrderJournal(directory);
    await expect(appendLiveOrderJournal(directory, { ...intent(), eventId: id(7), at: at(7) }, recovered.checkpoint))
      .rejects.toThrow('journal-event-invalid');
    expect((await appendLiveOrderJournal(directory, fill, snapshot.checkpoint)).appended).toBe(false);
    expect((await readLiveOrderJournal(directory)).state.orders[0].fills).toHaveLength(1);
  }, 15_000);

  it('keeps a persisted not-found result uncertain with its reservation across restart', async () => {
    const { directory, snapshot } = await fresh(2);
    await appendLiveOrderJournal(directory, { eventId: id(3), at: at(3), type: 'lookup-not-found',
      orderIntentId: id(101), venue: 'mexc', account: 'main',
      clientOrderId: deriveLiveClientOrderId('mexc', id(101)), source: 'synthetic' }, snapshot.checkpoint);
    const result = JSON.parse((await child('read', directory)).output);
    expect(result.state.orders[0]).toMatchObject({ phase: 'unknown', reserved: { BTC: '0', USDT: '10.1', MX: '0' } });
    expect(result.recovery.actions[0]).toMatchObject({ action: 'lookup-by-client-id', automaticResubmitAllowed: false,
      reservationRetained: true });
  }, 15_000);

  it('deduplicates an exact stale-checkpoint event and rejects a changed event ID payload', async () => {
    const { directory, snapshot } = await fresh(1);
    const committed = await appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint);
    const duplicate = await appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint);
    expect(duplicate.appended).toBe(false); expect(duplicate.headHash).toBe(committed.headHash);
    await expect(appendLiveOrderJournal(directory, { ...dispatch(), at: at(3) }, committed.checkpoint))
      .rejects.toThrow('journal-event-conflict');
    expect((await readLiveOrderJournal(directory)).revision).toBe(2);
    const other = await fresh(1);
    await expect(appendLiveOrderJournal(directory, dispatch(), other.snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
  });

  it('rejects stale heads and invalid transitions without committing or leaking caller details', async () => {
    const { directory, snapshot } = await fresh();
    const first = await appendLiveOrderJournal(directory, intent(), snapshot.checkpoint);
    await expect(appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
    await expect(appendLiveOrderJournal(directory, { ...dispatch(), privateToken: 'PRIVATE_VALUE' }, first.checkpoint))
      .rejects.toThrow('journal-event-invalid');
    await expect(appendLiveOrderJournal(directory, { ...dispatch(), orderIntentId: id(999) }, first.checkpoint))
      .rejects.toThrow('journal-event-invalid');
    expect((await readdir(directory)).sort()).toEqual(['000001.json', 'manifest.json']);
    expect((await readLiveOrderJournal(directory)).headHash).toBe(first.headHash);
  });

  it('clones input and expectation before its first asynchronous filesystem read', async () => {
    const { directory, snapshot } = await fresh();
    const input = intent(), expected = { ...snapshot.checkpoint };
    const pending = appendLiveOrderJournal(directory, input, expected);
    input.intent.limitPrice = '1'; expected.headHash = '0'.repeat(64);
    expect((await pending).state.events[0]).toEqual(intent());
  });

  it('serializes distinct competing writers at the immutable next sequence', async () => {
    const { directory, snapshot } = await fresh(1);
    const results = await Promise.allSettled([
      appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint),
      appendLiveOrderJournal(directory, intent(3), snapshot.checkpoint),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message)
      .toBe('journal-head-conflict');
    expect((await readLiveOrderJournal(directory)).revision).toBe(2);
  });

  it('returns one append and one no-op for concurrent identical deliveries', async () => {
    const { directory, snapshot } = await fresh(1);
    const results = await Promise.all([
      appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint),
      appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint),
    ]);
    expect(results.map(result => result.appended).sort()).toEqual([false, true]);
    expect((await readLiveOrderJournal(directory)).revision).toBe(2);
  });

  it.each(['during-write', 'before-link', 'after-link'])('recovers an actual SIGKILL at %s without assuming an exchange outcome', async mode => {
    const { root, directory, snapshot } = await fresh(1);
    const paths = await inputFiles(root, dispatch(), snapshot.checkpoint);
    const killed = await child(mode, directory, paths.eventFile, paths.checkpointFile);
    expect(killed.error).toBe(''); expect(killed.killedAtBoundary).toBe(true); expect(killed.signal).toBe('SIGKILL');
    const recovered = await readLiveOrderJournal(directory, snapshot.checkpoint);
    expect(recovered.revision).toBe(mode === 'after-link' ? 2 : 1); expect(recovered.pendingFiles).toBe(1);
    const repeated = await appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint);
    expect(repeated.appended).toBe(mode !== 'after-link'); expect(repeated.revision).toBe(2);
    expect(repeated.state.nonExecutable).toBe(true);
    expect(planLiveOrderRecovery(repeated.state).nonExecutable).toBe(true);
    expect((await readdir(directory)).filter(name => name.startsWith('.pending-'))).toHaveLength(1);
  }, 15_000);

  it.each(['file-sync-error', 'directory-sync-error'])('fails safely at %s and redacts I/O errors', async mode => {
    const { root, directory, snapshot } = await fresh(1);
    const paths = await inputFiles(root, dispatch(), snapshot.checkpoint);
    const result = await child(mode, directory, paths.eventFile, paths.checkpointFile);
    expect(result.error).toBe(''); expect(result.output).not.toContain('PRIVATE_IO_DETAIL');
    expect(JSON.parse(result.output).error).toBe(mode === 'file-sync-error' ? 'journal-write-failed' : 'journal-publish-uncertain');
    const recovered = await readLiveOrderJournal(directory);
    expect(recovered.revision).toBe(mode === 'file-sync-error' ? 1 : 2);
    expect(recovered.pendingFiles).toBe(mode === 'file-sync-error' ? 0 : 1);
  }, 15_000);

  it('rejects a corrupted committed record, gaps, unexpected files and a different journal namespace', async () => {
    const { directory } = await fresh(2), eventPath = join(directory, '000001.json');
    const original = await readFile(eventPath, 'utf8');
    for (const bad of ['{"schema":', original.replace('intent-created', 'tampered')]) {
      await writeFile(eventPath, bad); await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
    }
    await rm(eventPath); await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
    await writeFile(eventPath, original, { mode: 0o600 });
    await writeFile(join(directory, 'unexpected.json'), '{}', { mode: 0o600 });
    await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
    await rm(join(directory, 'unexpected.json'));
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replace('live-order-rehearsal-journal', 'paired-paper-settlement-journal'));
    await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
  });

  it('uses an independent checkpoint to detect missing suffixes and foreign journals', async () => {
    const { directory, snapshot } = await fresh(2);
    expect((await readLiveOrderJournal(directory, snapshot.checkpoint)).revision).toBe(2);
    await appendLiveOrderJournal(directory, intent(3), snapshot.checkpoint);
    expect((await readLiveOrderJournal(directory, snapshot.checkpoint)).revision).toBe(3);
    await rm(join(directory, '000003.json')); await rm(join(directory, '000002.json'));
    await expect(readLiveOrderJournal(directory, snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
    expect((await readLiveOrderJournal(directory)).revision).toBe(1);
    const other = await fresh();
    await expect(readLiveOrderJournal(other.directory, snapshot.checkpoint)).rejects.toThrow('journal-head-conflict');
  });

  it('rejects unsafe permissions, symlinks and external hardlinks', async () => {
    const { root, directory } = await fresh(1), file = join(directory, '000001.json');
    await chmod(directory, 0o755); await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid'); await chmod(directory, 0o700);
    await chmod(file, 0o644); await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid'); await chmod(file, 0o600);
    await link(file, join(root, 'external-link')); await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid'); await rm(join(root, 'external-link'));
    await symlink(directory, join(root, 'alias')); await expect(readLiveOrderJournal(join(root, 'alias'))).rejects.toThrow('journal-invalid');
    await rm(file); await symlink(join(directory, 'manifest.json'), file); await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
  });

  it('retains unpublished partial staging files and fails closed when all eight slots are occupied', async () => {
    const { directory, snapshot } = await fresh(1);
    for (let i = 0; i < LIVE_ORDER_JOURNAL_LIMITS.pendingFiles; i++) {
      await writeFile(join(directory, '.pending-' + String(i).padStart(2, '0')), '{incomplete', { mode: 0o600 });
    }
    expect((await readLiveOrderJournal(directory)).pendingFiles).toBe(8);
    await expect(appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint)).rejects.toThrow('journal-limit');
    await writeFile(join(directory, '.pending-08'), '', { mode: 0o600 });
    await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
  });

  it('bounds ten concurrent interrupted writers to eight private staging slots', async () => {
    const { root, directory, snapshot } = await fresh(1);
    const paths = await inputFiles(root, dispatch(), snapshot.checkpoint);
    const killed = await child('concurrency-limit', directory, paths.eventFile, paths.checkpointFile);
    expect(killed.error).toBe(''); expect(killed.killedAtBoundary).toBe(true); expect(killed.signal).toBe('SIGKILL');
    const recovered = await readLiveOrderJournal(directory);
    expect(recovered.revision).toBe(1); expect(recovered.pendingFiles).toBe(8);
    await expect(appendLiveOrderJournal(directory, dispatch(), snapshot.checkpoint)).rejects.toThrow('journal-limit');
  }, 15_000);

  it('rejects oversized staged and committed files before parsing', async () => {
    const { directory } = await fresh(1), pending = join(directory, '.pending-00');
    await writeFile(pending, Buffer.alloc(LIVE_ORDER_JOURNAL_LIMITS.fileBytes + 1), { mode: 0o600 });
    await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
    await rm(pending);
    await writeFile(join(directory, '000001.json'), Buffer.alloc(LIVE_ORDER_JOURNAL_LIMITS.fileBytes + 1));
    await expect(readLiveOrderJournal(directory)).rejects.toThrow('journal-invalid');
  });
});
