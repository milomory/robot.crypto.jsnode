import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSettlementScenario } from '../src/paper-pair/settlement-scenario.js';
import { canonical } from '../src/paper-v2/ledger.js';
import { replaySettlementJournal, viewSettlementState, type SettlementEvent } from '../src/paper-pair/settlement.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const zero = { BTC: '0', USDT: '0', MX: '0' };
function fixture() {
  const buyFees = { BTC: '0', USDT: '0.099', MX: '0.123456789012345678' };
  const events: SettlementEvent[] = [
    { type: 'prepare', id: 'prepare', pairId: 'pair', at: 1000,
      buy: { venue: 'mexc', orderId: 'buy-order', sizing: { kind: 'quote-budget', quoteAmount: '10' },
        feeCaps: { BTC: '0', USDT: '0.2', MX: '0.2' } },
      sell: { venue: 'okx', orderId: 'sell-order', baseQuantity: '0.1', feeCaps: { ...zero } } },
    { type: 'fill', id: 'buy-delivery', pairId: 'pair', at: 1010, side: 'buy',
      fill: { fillId: 'buy-fill', executedAt: 1005, baseQuantity: '0.1', quoteQuantity: '9.9', fees: buyFees } },
    { type: 'fill', id: 'sell-delivery', pairId: 'pair', at: 1020, side: 'sell',
      fill: { fillId: 'sell-fill', executedAt: 1007, baseQuantity: '0.1', quoteQuantity: '11', fees: { ...zero } } },
    { type: 'settle', id: 'buy-terminal', pairId: 'pair', at: 1030, side: 'buy', outcome: 'filled',
      totals: { baseQuantity: '0.1', quoteQuantity: '9.9', fees: buyFees } },
    { type: 'settle', id: 'sell-terminal', pairId: 'pair', at: 1040, side: 'sell', outcome: 'filled',
      totals: { baseQuantity: '0.1', quoteQuantity: '11', fees: { ...zero } } }
  ];
  return { schema: 1, kind: 'synthetic-settlement-scenario', scenarioId: 'synthetic-budget-fees',
    initialBalances: { mexc: { BTC: '0', USDT: '20', MX: '1' }, okx: { BTC: '0.1', USDT: '0', MX: '0' } }, events };
}
async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'pair-settlement-scenario-')); roots.push(root);
  return { root, input: join(root, 'scenario.json'), output: join(root, 'report') };
}

describe('offline explicit-fee scenario runner', () => {
  it('writes a bounded synthetic report with reproducible replay and identical bytes across separate runs', async () => {
    const { root, input, output } = await paths(), scenario = fixture();
    await writeFile(input, JSON.stringify(scenario, null, 2));
    const summary = await runSettlementScenario(input, output);
    const reportBytes = await readFile(join(output, 'report.json'), 'utf8');
    const report = JSON.parse(reportBytes);
    const expectedHash = createHash('sha256').update(canonical(scenario)).digest('hex');
    expect(summary).toEqual({ scenarioId: scenario.scenarioId, sourceSha256: expectedHash, deterministicReplay: true,
      executable: false, funding: 'synthetic', output, positions: [{ pairId: 'pair', settlement: 'balanced',
        residualBtc: '0', cashDeltaUsdt: '1.001', feesByAsset: { BTC: '0', USDT: '0.099', MX: '0.123456789012345678' } }] });
    expect(report).toMatchObject({ schema: 1, kind: 'synthetic-settlement-report', scenarioId: scenario.scenarioId,
      sourceSha256: expectedHash, deterministicReplay: true, marketOpportunityEvidence: false, exchangeAdmissionProven: false,
      initialBalances: scenario.initialBalances, journal: scenario.events,
      result: { executable: false, funding: 'synthetic', feeAccounting: 'explicit-per-fill-asset-amounts',
        balances: { mexc: { BTC: '0.1', USDT: '10.001', MX: '0.876543210987654322' }, okx: { BTC: '0', USDT: '11', MX: '0' } },
        reserved: { mexc: zero, okx: zero } } });
    expect(report.result).toEqual(viewSettlementState(replaySettlementJournal(report.initialBalances, report.journal)));
    expect(await readdir(output)).toEqual(['report.json']);
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect((await stat(join(output, 'report.json'))).mode & 0o777).toBe(0o600);

    const otherInput = join(root, 'compact-input.json'), otherOutput = join(root, 'report-again');
    await writeFile(otherInput, JSON.stringify(scenario));
    const repeated = await runSettlementScenario(otherInput, otherOutput);
    expect(repeated.sourceSha256).toBe(summary.sourceSha256);
    expect(await readFile(join(otherOutput, 'report.json'), 'utf8')).toBe(reportBytes);
  });

  it('refuses an existing output directory and preserves every existing byte', async () => {
    const { input, output } = await paths();
    await writeFile(input, JSON.stringify(fixture()));
    await mkdir(output);
    await writeFile(join(output, 'report.json'), 'existing report must stay untouched\n');
    await writeFile(join(output, 'owner-file.txt'), 'user content');
    await expect(runSettlementScenario(input, output)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(output, 'report.json'), 'utf8')).toBe('existing report must stay untouched\n');
    expect(await readFile(join(output, 'owner-file.txt'), 'utf8')).toBe('user content');
    expect((await readdir(output)).sort()).toEqual(['owner-file.txt', 'report.json']);
  });

  it.each([
    ['omitted fee object', undefined],
    ['omitted fee asset', { BTC: '0', USDT: '0.099' }],
    ['unknown fee asset', { BTC: '0', USDT: '0.099', MX: '0', BNB: '1' }],
    ['negative fee', { BTC: '0', USDT: '-0.099', MX: '0' }],
    ['numeric fee', { BTC: '0', USDT: 0.099, MX: '0' }]
  ])('rejects %s before creating any output artifact', async (_name, fees) => {
    const { root, input, output } = await paths(), scenario = fixture();
    const event = scenario.events[1];
    if (event.type !== 'fill') throw new Error('fixture missing buy fill');
    const invalid = { ...scenario, events: scenario.events.map((e, i) => i === 1 ? { ...event, fill: { ...event.fill, fees } } : e) };
    await writeFile(input, JSON.stringify(invalid));
    await expect(runSettlementScenario(input, output)).rejects.toThrow('invalid-settlement-event');
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual(['scenario.json']);
  });

  it('rejects conflicting terminal fee totals before creating output', async () => {
    const { input, output } = await paths(), scenario = fixture();
    const event = scenario.events[3];
    if (event.type !== 'settle') throw new Error('fixture missing buy terminal');
    event.totals = { ...event.totals, fees: { ...zero } };
    await writeFile(input, JSON.stringify(scenario));
    await expect(runSettlementScenario(input, output)).rejects.toThrow('incomplete-or-conflicting-fill-totals');
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink input instead of following it and leaves target/output untouched', async () => {
    const { root, input, output } = await paths(), target = join(root, 'real-scenario.json');
    const bytes = JSON.stringify(fixture());
    await writeFile(target, bytes);
    await symlink(target, input);
    await expect(runSettlementScenario(input, output)).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await readFile(target, 'utf8')).toBe(bytes);
    expect((await lstat(input)).isSymbolicLink()).toBe(true);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
