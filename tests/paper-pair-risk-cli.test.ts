import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPaperRiskScenario } from '../src/paper-pair/risk-scenario.js';
import { canonical } from '../src/paper-v2/ledger.js';
import type { PaperRiskPolicy } from '../src/paper-pair/risk.js';
import type { SettlementEvent } from '../src/paper-pair/settlement.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const zero = { BTC: '0', USDT: '0', MX: '0' };
function prepare(id: string, quote = '10'): Extract<SettlementEvent, { type: 'prepare' }> {
  return { type: 'prepare', id, pairId: id + '-pair', at: 1000,
    buy: { venue: 'mexc', orderId: id + '-buy', sizing: { kind: 'base', baseQuantity: '0.1', maxQuoteAmount: quote }, feeCaps: { ...zero } },
    sell: { venue: 'okx', orderId: id + '-sell', baseQuantity: '0.1', feeCaps: { ...zero } } };
}
function fixture() {
  const opening = prepare('history');
  const buyTotals = { baseQuantity: '0.1', quoteQuantity: '10', fees: { ...zero } };
  const sellTotals = { baseQuantity: '0.1', quoteQuantity: '9', fees: { ...zero } };
  const events: SettlementEvent[] = [opening,
    { type: 'fill', id: 'history-buy-fill', pairId: opening.pairId, at: 1010, side: 'buy',
      fill: { fillId: 'buy-fill', executedAt: 1005, ...buyTotals } },
    { type: 'fill', id: 'history-sell-fill', pairId: opening.pairId, at: 1020, side: 'sell',
      fill: { fillId: 'sell-fill', executedAt: 1007, ...sellTotals } },
    { type: 'settle', id: 'history-buy-terminal', pairId: opening.pairId, at: 1030, side: 'buy', outcome: 'filled', totals: buyTotals },
    { type: 'settle', id: 'history-sell-terminal', pairId: opening.pairId, at: 1040, side: 'sell', outcome: 'filled', totals: sellTotals }];
  const policy: PaperRiskPolicy = { schema: 1, kind: 'synthetic-pair-risk-policy', policyId: 'fixture-policy',
    maxBuyDebitUsdt: '20', maxSingleLegBtc: '0.2', maxSessionCashLossUsdt: '11',
    maxSessionFees: { BTC: '1', USDT: '1', MX: '1' }, minFreeAfterReserve: { mexc: { ...zero }, okx: { ...zero } } };
  const probes = [prepare('candidate-a'), prepare('candidate-b'), prepare('candidate-c', '10.0001')]
    .map(probe => ({ ...probe, at: 1050 }));
  return { schema: 1, kind: 'synthetic-pair-risk-scenario', scenarioId: 'synthetic-session-loss',
    initialBalances: { mexc: { BTC: '0', USDT: '100', MX: '0' }, okx: { BTC: '1', USDT: '0', MX: '0' } },
    policy, events, probes };
}
async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'pair-risk-cli-')); roots.push(root);
  return { root, input: join(root, 'scenario.json'), output: join(root, 'report') };
}
function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolveResult => {
    execFile(process.execPath, ['--import', 'tsx', resolve('src/scripts/pair-risk.ts'), ...args],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        resolveResult({ code: error ? Number(error.code) : 0, stdout, stderr });
      });
  });
}

describe('bounded offline paired paper risk CLI', () => {
  it('replays the whole session and independently probes one unchanged state with deterministic private output', async () => {
    const { root, input, output } = await paths(), scenario = fixture();
    const inputBytes = JSON.stringify(scenario, null, 2);
    await writeFile(input, inputBytes);
    const summary = await runPaperRiskScenario(input, output);
    const bytes = await readFile(join(output, 'report.json'), 'utf8'), report = JSON.parse(bytes);
    expect(summary).toEqual({ schema: 1, kind: 'synthetic-pair-risk-summary', executable: false, funding: 'synthetic',
      eventCount: 5, probeCount: 3, allowedCount: 2, blockedCount: 1,
      reportHash: createHash('sha256').update(bytes).digest('hex') });
    expect(report).toMatchObject({ schema: 1, kind: 'synthetic-pair-risk-report', executable: false, funding: 'synthetic',
      scenarioId: scenario.scenarioId, inputHashSha256: createHash('sha256').update(canonical(scenario)).digest('hex'),
      risk: { sessionUsage: { closedCashLossUsdt: '1' }, settlement: {
        balances: { mexc: { BTC: '0.1', USDT: '90', MX: '0' }, okx: { BTC: '0.9', USDT: '9', MX: '0' } },
        reserved: { mexc: zero, okx: zero } } } });
    expect(report.risk.settlement.positions).toHaveLength(1);
    expect(report.probes.map((probe: { decision: { paperAllowed: boolean } }) => probe.decision.paperAllowed)).toEqual([true, true, false]);
    expect(report.probes[0].decision.projectedAvailable).toEqual(report.probes[1].decision.projectedAvailable);
    expect(report.probes[2].decision.reasons).toContain('session-cash-loss-limit');
    expect(await readFile(input, 'utf8')).toBe(inputBytes);
    expect(await readdir(output)).toEqual(['report.json']);
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect((await stat(join(output, 'report.json'))).mode & 0o777).toBe(0o600);
    const compactInput = join(root, 'compact.json'), repeated = join(root, 'repeated');
    await writeFile(compactInput, JSON.stringify(scenario));
    expect(await runPaperRiskScenario(compactInput, repeated)).toEqual(summary);
    expect(await readFile(join(repeated, 'report.json'), 'utf8')).toBe(bytes);
  });

  it('rejects historical preparations disallowed by policy even when all legs have already settled', async () => {
    const { input, output } = await paths(), scenario = fixture();
    scenario.policy.maxBuyDebitUsdt = '9';
    await writeFile(input, JSON.stringify(scenario));
    await expect(runPaperRiskScenario(input, output)).rejects.toThrow('buy-debit-limit');
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an existing output and preserves input and user files', async () => {
    const { input, output } = await paths(), bytes = JSON.stringify(fixture());
    await writeFile(input, bytes); await mkdir(output);
    await writeFile(join(output, 'report.json'), 'existing-report');
    await writeFile(join(output, 'user.txt'), 'preserve-me');
    await expect(runPaperRiskScenario(input, output)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(input, 'utf8')).toBe(bytes);
    expect(await readFile(join(output, 'report.json'), 'utf8')).toBe('existing-report');
    expect(await readFile(join(output, 'user.txt'), 'utf8')).toBe('preserve-me');
  });

  it.each([
    ['non-prepare probe', (s: ReturnType<typeof fixture>) => ({ ...s, probes: [s.events[1]] })],
    ['malformed nested probe', (s: ReturnType<typeof fixture>) => ({ ...s, probes: [{ ...s.probes[0], buy: { PRIVATE: 'do-not-echo' } }] })],
    ['unknown top-level field', (s: ReturnType<typeof fixture>) => ({ ...s, unexpected: 'PRIVATE' })],
    ['unknown policy field', (s: ReturnType<typeof fixture>) => ({ ...s, policy: { ...s.policy, live: true } })],
    ['missing opening balance', (s: ReturnType<typeof fixture>) => ({ ...s, initialBalances: { mexc: zero } })],
    ['traversal identifier', (s: ReturnType<typeof fixture>) => ({ ...s, scenarioId: '../PRIVATE' })],
    ['too many events', (s: ReturnType<typeof fixture>) => ({ ...s, events: Array(2001).fill(null) })],
    ['too many probes', (s: ReturnType<typeof fixture>) => ({ ...s, probes: Array(21).fill(s.probes[0]) })]
  ])('rejects %s before creating output', async (_name, change) => {
    const { input, output } = await paths();
    await writeFile(input, JSON.stringify(change(fixture())));
    await expect(runPaperRiskScenario(input, output)).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces the 128 KiB input limit and never creates output for an oversized input', async () => {
    const { input, output } = await paths();
    await writeFile(input, ' '.repeat(128 * 1024) + JSON.stringify(fixture()));
    await expect(runPaperRiskScenario(input, output)).rejects.toThrow('invalid-archive-file');
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects input and ancestor symlinks, output symlink parents and traversal paths', async () => {
    const { root, input, output } = await paths(), actual = join(root, 'actual'), alias = join(root, 'alias');
    await mkdir(actual); await symlink(actual, alias);
    const target = join(actual, 'input.json'), bytes = JSON.stringify(fixture());
    await writeFile(target, bytes); await symlink(target, input);
    for (const path of [input, join(alias, 'input.json'), actual + '/../actual/input.json']) {
      await expect(runPaperRiskScenario(path, output)).rejects.toThrow('invalid-scenario-path');
    }
    await expect(runPaperRiskScenario(target, join(alias, 'new-report'))).rejects.toThrow('invalid-scenario-path');
    expect(await readFile(target, 'utf8')).toBe(bytes);
    expect(await readdir(actual)).toEqual(['input.json']);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints only summary metadata and fixed errors, with no scenario identifiers, paths or values', async () => {
    const { input, output } = await paths(), scenario = fixture();
    scenario.scenarioId = 'PRIVATE_SCENARIO_IDENTIFIER';
    await writeFile(input, JSON.stringify(scenario));
    const ok = await cli([input, output]);
    expect(ok.code).toBe(0); expect(ok.stderr).toBe('');
    expect(Object.keys(JSON.parse(ok.stdout)).sort()).toEqual([
      'schema', 'kind', 'executable', 'funding', 'eventCount', 'probeCount', 'allowedCount', 'blockedCount', 'reportHash'
    ].sort());
    expect(ok.stdout).not.toContain(scenario.scenarioId);
    expect(ok.stdout).not.toContain(input);
    expect(ok.stdout).not.toContain('sessionCashLoss');
    await writeFile(input, '{"PRIVATE_SECRET":invalid-json');
    for (const args of [[input, output], [input, output, 'PRIVATE_ARGUMENT'], []]) {
      const failed = await cli(args);
      expect(failed.code).toBe(1); expect(failed.stdout).toBe('');
      expect(failed.stderr).toBe('Offline paper risk scenario failed. Use SCENARIO_JSON NEW_OUTPUT_DIRECTORY. Existing files are preserved.\n');
    }
  });
});
