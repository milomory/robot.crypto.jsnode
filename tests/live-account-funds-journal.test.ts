import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm, chmod, symlink, link, cp, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createAccountFundsJournal, importAccountFundsJournalEvidence, stageAccountFundsJournalIntent,
  releaseAccountFundsJournalIntent, readAccountFundsJournal } from '../src/live/account-funds-journal.js';
import { appendLiveOrderJournal, readLiveOrderJournal } from '../src/live/order-journal.js';
import { canonicalLiveOrderJson } from '../src/live/order-lifecycle.js';
import { fundsEvidenceFixture, FUNDS_EVIDENCE_TEST_TIME as NOW } from './helpers/funds-evidence-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = (index: number) => `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const limits = () => ({ schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT', totalCapitalUsdt: '200',
  capitalByVenueUsdt: { mexc: '100', okx: '100' }, maxOrderDebitUsdt: '100', maxCumulativeLossUsdt: '200', maxUnhedgedBtc: '1',
  includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false });
const proposed = (index = 1) => ({ orderIntentId: id(index), venue: 'okx', account: 'main', symbol: 'BTC/USDT', side: 'buy', orderType: 'limit',
  baseQuantity: '0.0001', limitPrice: '100000', maxQuoteAmount: '10', feeCaps: { BTC: '0', USDT: '1', MX: '0' } });
function fixture(options: Parameters<typeof fundsEvidenceFixture>[0] = {}) {
  const f = fundsEvidenceFixture({ okxUSDT: '20', ...options });
  Object.assign(f.archive.mexc.funds.balances[0], { free: '0', available: '0' });
  Object.assign(f.archive.okx.funds.balances[0], { cashBal: '0', availBal: '0' });
  return f;
}
function fee(f: ReturnType<typeof fixture>, now = NOW + 900) {
  return { schema: 1, kind: 'declared-order-fee-evidence', source: 'declared-synthetic', venue: 'okx', account: 'main', symbol: 'BTC/USDT',
    bundleVersion: f.pin.bundleVersion, pinHash: f.archive.pinHash, observedAt: now, expiresAt: now + 60_000,
    makerRate: '0.001', takerRate: '0.002', feeAsset: 'USDT', provenanceVerified: false };
}
async function setup(selectedLimits: unknown = limits()) {
  const root = await mkdtemp(join(tmpdir(), 'funds-journal-test-')); roots.push(root);
  const directory = join(root, 'journal'), f = fixture();
  const initial = await createAccountFundsJournal(directory, { pinBytes: f.pinBytes, bindingKey: f.bindingKey, limits: selectedLimits }, NOW + 850);
  const imported = await importAccountFundsJournalEvidence(directory, f.input(), initial.checkpoint, NOW + 900);
  return { root, directory, f, initial, imported };
}
async function faultedStage(s: Awaited<ReturnType<typeof setup>>, fault: 'file-sync' | 'published-sync' | 'crash-before-link') {
  const path = join(s.root, 'synthetic-fault-input.json');
  await writeFile(path, JSON.stringify({ directory: s.directory, key: [...s.f.bindingKey], head: s.imported.checkpoint,
    intent: proposed(), fee: fee(s.f) }), { mode: 0o600 });
  const program = `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';
    const input=JSON.parse(await fs.readFile(process.argv[2],'utf8')),fault=process.argv[3];let published=false;
    const realOpen=fs.open,realLink=fs.link;
    fs.link=async(...args)=>{const result=await realLink(...args);published=true;return result};
    fs.open=async(...args)=>{const handle=await realOpen(...args),realSync=handle.sync.bind(handle),name=String(args[0]);
      handle.sync=async()=>{if(fault==='file-sync'&&name.includes('/.pending-'))throw new Error('PRIVATE_FAILURE_NEVER_OUTPUT');
        if(fault==='published-sync'&&published&&name===input.directory)throw new Error('PRIVATE_FAILURE_NEVER_OUTPUT');
        const value=await realSync();if(fault==='crash-before-link'&&name.includes('/.pending-'))process.kill(process.pid,'SIGKILL');return value};return handle};
    syncBuiltinESMExports();const api=await import(process.argv[1]);
    try{await api.stageAccountFundsJournalIntent(input.directory,{intent:input.intent,feeEvidence:input.fee,bindingKey:Uint8Array.from(input.key)},input.head,${NOW + 1000});console.log('accepted')}
    catch(e){console.log(e.code??'fixed-failure')}`;
  return new Promise<{ output: string; code: number | null; signal: string | null }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program,
      resolve('src/live/account-funds-journal.ts'), path, fault], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject); child.on('close', (code, signal) => stderr ? reject(new Error(stderr)) : resolveResult({ output: output.trim(), code, signal }));
  });
}
const stage = (s: Awaited<ReturnType<typeof setup>>, index = 1, head = s.imported.checkpoint, now = NOW + 1000) =>
  stageAccountFundsJournalIntent(s.directory, { intent: proposed(index), feeEvidence: fee(s.f), bindingKey: s.f.bindingKey }, head, now);
function hash(value: unknown) { return createHash('sha256').update(canonicalLiveOrderJson(value)).digest('hex'); }
async function mutateRecord(directory: string, filename: string, mutate: (value: Record<string, any>) => void) {
  const path = join(directory, filename), value = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
  mutate(value); const { hash: _hash, ...body } = value; value.hash = hash(body);
  await writeFile(path, canonicalLiveOrderJson(value) + '\n', { mode: 0o600 });
}

describe('private configured-root funds preparation journal', () => {
  it('imports accepted private evidence, stages a reserve, replays and releases only a local intent', async () => {
    const s = await setup(); const saved = await stage(s);
    expect(saved.preparedIntents).toHaveLength(1);
    expect(saved).toMatchObject({ executable: false, liveAllowed: false, accountGlobalOwnershipVerified: false, feeProvenanceVerified: false });
    const read = await readAccountFundsJournal(s.directory, s.f.bindingKey, saved.checkpoint);
    expect(read).toEqual(saved);
    const released = await releaseAccountFundsJournalIntent(s.directory, { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, saved.checkpoint, NOW + 1100);
    expect(released.preparedIntents).toEqual([]);
    expect((await stage(s, 2, released.checkpoint, NOW + 1200)).preparedIntents).toHaveLength(1);
  });
  it('does not output raw identifiers, credentials, capture bytes or private binding key in snapshot', async () => {
    const s = await setup(); const json = JSON.stringify(await stage(s));
    for (const secret of ['PRIVATE_MEXC_UID_ABC', '9876543212345678901', 'SYNTHETIC_MEXC_KEY', 'SYNTHETIC_MEXC_SECRET', s.f.bindingKey.toString('hex')]) expect(json).not.toContain(secret);
    expect(json).not.toContain('archiveBytes'); expect(json).not.toContain('pinBytes');
  });
  it('keeps original key bytes unchanged and rejects invalid binding keys', async () => {
    const s = await setup(), original = Buffer.from(s.f.bindingKey);
    await stage(s); expect(s.f.bindingKey).toEqual(original);
    await expect(readAccountFundsJournal(s.directory, Buffer.alloc(32, 2))).rejects.toThrow('journal-evidence-invalid');
    await expect(readAccountFundsJournal(s.directory, Buffer.alloc(31))).rejects.toThrow('journal-evidence-invalid');
  });
  it('requires explicit limits and never defaults capital', async () => {
    const s = await setup(null);
    await expect(stage(s)).rejects.toThrow('journal-policy-blocked');
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).checkpoint.revision).toBe(1);
  });
  it('subtracts an existing full local fee-inclusive reserve and blocks overcommit', async () => {
    const s = await setup(), first = await stage(s);
    await expect(stage(s, 2, first.checkpoint)).rejects.toThrow('journal-policy-blocked');
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).preparedIntents).toHaveLength(1);
  });
  it('release cannot double-release or reset a used intent identifier', async () => {
    const s = await setup(), first = await stage(s);
    const released = await releaseAccountFundsJournalIntent(s.directory, { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, first.checkpoint, NOW + 1100);
    await expect(releaseAccountFundsJournalIntent(s.directory, { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, released.checkpoint, NOW + 1200)).rejects.toThrow('journal-event-invalid');
    await expect(stage(s, 1, released.checkpoint)).rejects.toThrow('journal-event-invalid');
  });
  it('historical replay survives wall-clock expiry but a new stage must use fresh evidence', async () => {
    const s = await setup(); await stage(s);
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey)).resolves.toMatchObject({ preparedIntents: [proposed()] });
    const current = await readAccountFundsJournal(s.directory, s.f.bindingKey);
    await expect(stage(s, 2, current.checkpoint, NOW + 60_001)).rejects.toThrow('journal-evidence-invalid');
  });
  it('allows local release even after capture expiry', async () => {
    const s = await setup(), first = await stage(s);
    await expect(releaseAccountFundsJournalIntent(s.directory, { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, first.checkpoint, NOW + 60_100)).resolves.toMatchObject({ preparedIntents: [] });
  });
  it('rejects clock regression without changing committed state', async () => {
    const s = await setup(), first = await stage(s);
    await expect(releaseAccountFundsJournalIntent(s.directory, { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, first.checkpoint, NOW + 999)).rejects.toThrow('journal-event-invalid');
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).checkpoint).toEqual(first.checkpoint);
  });
  it('only one concurrent CAS at a shared checkpoint may reserve funds', async () => {
    const s = await setup(); const results = await Promise.allSettled([stage(s, 1), stage(s, 2)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = await readAccountFundsJournal(s.directory, s.f.bindingKey);
    const loser = current.preparedIntents[0].orderIntentId === id(1) ? 2 : 1;
    await expect(stage(s, loser, current.checkpoint)).rejects.toThrow('journal-policy-blocked');
  });
  it('a stale checkpoint cannot import, stage or release', async () => {
    const s = await setup(), first = await stage(s);
    await expect(stage(s, 2)).rejects.toThrow('journal-head-conflict');
    await expect(releaseAccountFundsJournalIntent(s.directory, { intentId: id(1), reason: 'operator-released', bindingKey: s.f.bindingKey }, s.imported.checkpoint, NOW + 1100)).rejects.toThrow('journal-head-conflict');
    await expect(importAccountFundsJournalEvidence(s.directory, s.f.input(), s.imported.checkpoint, NOW + 1200)).rejects.toThrow('journal-head-conflict');
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).checkpoint).toEqual(first.checkpoint);
  });
  it('fresh import preserves local reservations instead of refunding them', async () => {
    const s = await setup(), first = await stage(s);
    const next = fixture({ now: NOW + 2000 }); next.archive.archiveId = id(99);
    const updated = await importAccountFundsJournalEvidence(s.directory, next.input(), first.checkpoint, NOW + 2900);
    expect(updated.preparedIntents).toEqual(first.preparedIntents);
    await expect(stageAccountFundsJournalIntent(s.directory, { intent: proposed(2), feeEvidence: fee(next, NOW + 2900), bindingKey: next.bindingKey }, updated.checkpoint, NOW + 3000)).rejects.toThrow('journal-policy-blocked');
  });
  it('same account pin observation rotation cannot create a new root or drop reservations', async () => {
    const s = await setup(), first = await stage(s), next = fixture({ now: NOW + 2000 }); next.archive.archiveId = id(98);
    await expect(createAccountFundsJournal(s.directory, { pinBytes: next.pinBytes, bindingKey: next.bindingKey, limits: limits() }, NOW + 2850)).rejects.toThrow('journal-invalid');
    const updated = await importAccountFundsJournalEvidence(s.directory, next.input(), first.checkpoint, NOW + 2900);
    expect(updated.preparedIntents).toHaveLength(1);
  });
  it('another selected account cannot import into this root', async () => {
    const s = await setup(), foreign = fixture({ mexcUid: 'OTHER_PRIVATE_UID', now: NOW + 2000 }); foreign.archive.archiveId = id(97);
    await expect(importAccountFundsJournalEvidence(s.directory, foreign.input(), s.imported.checkpoint, NOW + 2900)).rejects.toThrow('journal-evidence-invalid');
  });
  it('prevents reimport and capture-time regression', async () => {
    const s = await setup();
    await expect(importAccountFundsJournalEvidence(s.directory, s.f.input(), s.imported.checkpoint, NOW + 901)).rejects.toThrow('journal-evidence-invalid');
    const older = fixture({ now: NOW - 1000 }); older.archive.archiveId = id(96);
    await expect(importAccountFundsJournalEvidence(s.directory, older.input(), s.imported.checkpoint, NOW + 901)).rejects.toThrow('journal-evidence-invalid');
  });
  it('imports a large valid private capture within the bounded record budget', async () => {
    const s = await setup(), next = fixture({ now: NOW + 2000 }); next.archive.archiveId = id(95);
    const sample = next.archive.okx.funds.balances[1];
    for (let index = 2; index < 2000; index++) next.archive.okx.funds.balances.push({ ...sample,
      currency: 'ASSET' + index, cashBal: '99999999999999999999.999999999999999999',
      availBal: '99999999999999999999.999999999999999999' });
    const input = next.input(); expect(input.archiveBytes.length).toBeGreaterThan(512 * 1024);
    const saved = await importAccountFundsJournalEvidence(s.directory, input, s.imported.checkpoint, NOW + 2900);
    expect(saved.latestEvidenceReceipt).toEqual(input.receipt);
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).checkpoint).toEqual(saved.checkpoint);
  });
  it('input objects and byte buffers are detached before asynchronous work', async () => {
    const s = await setup(), input = { intent: proposed(), feeEvidence: fee(s.f), bindingKey: Buffer.from(s.f.bindingKey) };
    const pending = stageAccountFundsJournalIntent(s.directory, input, s.imported.checkpoint, NOW + 1000);
    input.intent.maxQuoteAmount = '9999'; input.feeEvidence.takerRate = '1'; input.bindingKey.fill(0);
    expect((await pending).preparedIntents[0].maxQuoteAmount).toBe('10');
  });
  it('checks full private permissions and rejects extra files', async () => {
    const s = await setup(); await chmod(join(s.directory, 'manifest.json'), 0o644);
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow('journal-invalid');
    await chmod(join(s.directory, 'manifest.json'), 0o600); await writeFile(join(s.directory, 'unexpected'), 'private', { mode: 0o600 });
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow('journal-invalid');
  });
  it('rejects symlink roots and copied physical anchors', async () => {
    const s = await setup(); const alias = join(s.root, 'alias'); await symlink(s.directory, alias);
    await expect(readAccountFundsJournal(alias, s.f.bindingKey)).rejects.toThrow('journal-invalid');
    const copy = join(s.root, 'copy'); await cp(s.directory, copy, { recursive: true }); await chmod(copy, 0o700);
    await expect(readAccountFundsJournal(copy, s.f.bindingKey)).rejects.toThrow('journal-invalid');
  });
  it('rejects hardlinked and symlinked records', async () => {
    const s = await setup(), record = join(s.directory, '000001.json');
    await link(record, join(s.root, 'external-link'));
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow('journal-invalid');
    await unlink(join(s.root, 'external-link')); const original = await readFile(record); await unlink(record);
    const outside = join(s.root, 'outside'); await writeFile(outside, original, { mode: 0o600 }); await symlink(outside, record);
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow('journal-invalid');
  });
  it('replays admission instead of trusting an internally rehashed staged record', async () => {
    const s = await setup(); await stage(s);
    await mutateRecord(s.directory, '000002.json', record => { record.event.intent.maxQuoteAmount = '100'; });
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow('journal-policy-blocked');
  });
  it('does not accept a lifecycle dispatch even if locally rehashed', async () => {
    const s = await setup(); await stage(s);
    await mutateRecord(s.directory, '000002.json', record => { record.event = { type: 'dispatch-marked', checkedAt: NOW + 1000, orderIntentId: id(1) }; });
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey)).rejects.toThrow('journal-invalid');
  });
  it('legacy journal APIs cannot read or append this new kind', async () => {
    const s = await setup();
    await expect(readLiveOrderJournal(s.directory)).rejects.toThrow('journal-invalid');
    await expect(appendLiveOrderJournal(s.directory, { type: 'intent-created', eventId: id(70), at: new Date(NOW).toISOString(), intent: proposed() },
      s.imported.checkpoint as never)).rejects.toThrow();
  });
  it('independently retained checkpoint detects removed suffix', async () => {
    const s = await setup(), current = await stage(s); await unlink(join(s.directory, '000002.json'));
    await expect(readAccountFundsJournal(s.directory, s.f.bindingKey, current.checkpoint)).rejects.toThrow('journal-head-conflict');
  });
  it('malformed inputs fail with a fixed message without persisting their text', async () => {
    const s = await setup();
    await expect(stageAccountFundsJournalIntent(s.directory, { intent: { private: 'DO_NOT_ECHO' }, feeEvidence: {}, bindingKey: s.f.bindingKey }, s.imported.checkpoint)).rejects.toThrow('journal-event-invalid');
    const files = await readdir(s.directory); expect(files).toEqual(['000001.json', 'manifest.json']);
  });
  it('file fsync failure never publishes a reservation and returns only a fixed error', async () => {
    const s = await setup(), outcome = await faultedStage(s, 'file-sync');
    expect(outcome).toMatchObject({ output: 'journal-write-failed', code: 0, signal: null });
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).checkpoint).toEqual(s.imported.checkpoint);
    expect((await readdir(s.directory)).filter(name => name.startsWith('.pending'))).toEqual([]);
  }, 15_000);
  it('fsync failure after publication is uncertain and preserves committed reserve on replay', async () => {
    const s = await setup(), outcome = await faultedStage(s, 'published-sync');
    expect(outcome.output).toBe('journal-publish-uncertain');
    const recovered = await readAccountFundsJournal(s.directory, s.f.bindingKey);
    expect(recovered.preparedIntents).toHaveLength(1); expect(recovered.checkpoint.revision).toBe(2);
    expect((await readdir(s.directory)).filter(name => name.startsWith('.pending'))).toHaveLength(1);
    await expect(stage(s, 2, recovered.checkpoint)).rejects.toThrow('journal-policy-blocked');
  }, 15_000);
  it('SIGKILL before publication leaves an orphan but never invents a reserve or reclaims the orphan', async () => {
    const s = await setup(), outcome = await faultedStage(s, 'crash-before-link');
    expect(outcome.signal).toBe('SIGKILL'); expect(outcome.output).toBe('');
    const recovered = await readAccountFundsJournal(s.directory, s.f.bindingKey);
    expect(recovered.preparedIntents).toEqual([]); expect(recovered.checkpoint).toEqual(s.imported.checkpoint);
    const orphans = (await readdir(s.directory)).filter(name => name.startsWith('.pending')); expect(orphans).toHaveLength(1);
    await stage(s); expect((await readdir(s.directory)).filter(name => name.startsWith('.pending'))).toEqual(orphans);
  }, 15_000);
  it('bounded orphan slots cannot be reclaimed or bypassed automatically', async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) await writeFile(join(s.directory, '.pending-0' + i), 'uncertain private data', { mode: 0o600 });
    await expect(stage(s)).rejects.toThrow('journal-limit');
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).checkpoint).toEqual(s.imported.checkpoint);
  });
  it('inter-process CAS leaves one reserve and forces losing preparation to retry from the new head', async () => {
    const s = await setup(), modulePath = resolve('src/live/account-funds-journal.ts');
    const inputPath = join(s.root, 'synthetic-input.json');
    await writeFile(inputPath, JSON.stringify({ directory: s.directory, key: [...s.f.bindingKey], head: s.imported.checkpoint, fee: fee(s.f) }), { mode: 0o600 });
    const program = `import fs from 'node:fs/promises'; const api=await import(process.argv[1]); const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const index=Number(process.argv[3]);const intent=${JSON.stringify(proposed())};intent.orderIntentId='90000000-0000-4000-8000-'+String(index).padStart(12,'0');try{await api.stageAccountFundsJournalIntent(input.directory,{intent,feeEvidence:input.fee,bindingKey:Uint8Array.from(input.key)},input.head,${NOW + 1000});console.log('accepted')}catch(e){console.log(e.code??'fixed-failure')}`;
    const run = (index: number) => new Promise<string>((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, modulePath, inputPath, String(index)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject); child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(stderr)));
    });
    const outcomes = await Promise.all([run(1), run(2)]);
    expect(outcomes.sort()).toEqual(['accepted', 'journal-head-conflict']);
    expect((await readAccountFundsJournal(s.directory, s.f.bindingKey)).preparedIntents).toHaveLength(1);
  }, 15_000);
});
