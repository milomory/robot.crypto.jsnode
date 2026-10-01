import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import okxFixture from '../fixtures/cash-audit/okx-cash-illustrative.json' with { type: 'json' };
import mexcFixture from '../fixtures/cash-audit/mexc-reported-partial-cancel.json' with { type: 'json' };
import zeroFixture from '../fixtures/execution-audit/okx-zero-cancel.json' with { type: 'json' };
import { auditOrderCash, CashAuditError } from '../src/paper-pair/cash-audit.js';
import { auditRecordedOrder } from '../src/paper-pair/execution-audit.js';
import { writeCashAudit } from '../src/paper-pair/cash-audit-report.js';
import { canonical } from '../src/paper-v2/ledger.js';

const okx = () => structuredClone(okxFixture);
const mexc = () => structuredClone(mexcFixture);
type Okx = ReturnType<typeof okx>;
const funds = (BTC = '0', USDT = '0', MX = '0') => ({ BTC, USDT, MX });
function bothOkx(input: Okx, patch: Partial<Okx['order']['orderAfter']['data'][number]>) {
  Object.assign(input.order.orderBefore.data[0], patch);
  Object.assign(input.order.orderAfter.data[0], patch);
}
function cashError(input: unknown, reason: string) {
  let caught: unknown;
  try { auditOrderCash(input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CashAuditError);
  expect(caught).toMatchObject({ reason, message: reason });
}

describe('exact expected cash movement from executions', () => {
  it('uses reported MEXC quote and all fee currencies once for a partial cancellation', () => {
    const input = mexc();
    input.order.fills[0].price = '83000';
    input.order.fills[2].price = '83000';
    const result = auditOrderCash(input);
    expect(result).toMatchObject({ venue: 'mexc', source: 'synthetic', side: 'buy', executable: false,
      captureProvenanceVerified: false, wholeAccountHistoryProven: false, settlementReady: true,
      quoteSource: 'reported-fill-quote',
      cash: { expectedNet: funds('0.0001', '-8.40252', '-0.001'),
        expectedSource: 'reported-fill-amounts', reportedNet: null, difference: null,
        comparison: 'not-requested', billRows: 0, uniqueBills: 0, duplicateBills: 0,
        grossQuoteProven: true } });
    expect(result.orderAudit).toEqual(auditRecordedOrder(input.order));
    expect(result.orderAudit.outcome).toBe('cancelled');
    expect(result.orderAudit.uniqueFills).toBe(2);
  });

  it('reverses bought/sold assets on MEXC sell but still subtracts fees', () => {
    const input = mexc();
    input.order.expected.side = 'sell';
    for (const order of [input.order.orderBefore, input.order.orderAfter]) order.side = 'SELL';
    for (const fill of input.order.fills) fill.isBuyer = false;
    expect(auditOrderCash(input).cash.expectedNet).toEqual(funds('-0.0001', '8.39748', '-0.001'));
  });

  it('charges a BTC fee against acquired MEXC quantity rather than quote', () => {
    const input = mexc();
    for (const fill of input.order.fills) {
      fill.commissionAsset = 'BTC'; fill.commission = '0.000000000000000001';
    }
    expect(auditOrderCash(input).cash.expectedNet).toEqual(funds('0.000099999999999998', '-8.4'));
  });

  it('does not turn missing executions into cash amounts from order aggregates', () => {
    const input = mexc(); input.order.fills = [];
    const result = auditOrderCash(input);
    expect(result.cash.expectedNet).toBeNull();
    expect(result.cash.blockers).toContain('order-evidence-incomplete');
    expect(result.cash.grossQuoteProven).toBe(false);
    expect(result.settlementReady).toBe(false);
    expect(result.orderAudit.blockers).toContain('base-total-mismatch');
    expect(result.orderAudit.blockers).toContain('quote-total-mismatch');
  });

  it('does not assert expected cash while a MEXC partial fill order is still live', () => {
    const input = mexc();
    input.order.orderBefore.status = 'PARTIALLY_FILLED'; input.order.orderAfter.status = 'PARTIALLY_FILLED';
    expect(auditOrderCash(input)).toMatchObject({ settlementReady: false,
      cash: { expectedNet: null, grossQuoteProven: false, blockers: ['order-evidence-incomplete'] } });
  });

  it('retains exact negative 36-place derived quote on OKX', () => {
    const input = okx();
    bothOkx(input, { accFillSz: '0.000000000000000001', avgPx: '0.000000000000000001', fee: '0' });
    input.order.fills.data = [{ ...input.order.fills.data[0], fillSz: '0.000000000000000001',
      fillPx: '0.000000000000000001', fee: '0' }];
    const { bills: _bills, ...withoutBills } = input;
    expect(auditOrderCash(withoutBills).cash.expectedNet).toEqual(funds('0.000000000000000001',
      '-0.000000000000000000000000000000000001'));
  });

  it('keeps order blockers, readiness, and audit output unchanged', () => {
    const input = okx(); input.order.orderBefore.data[0].state = 'partially_filled';
    input.order.limit = 2;
    const direct = auditRecordedOrder(input.order), result = auditOrderCash(input);
    expect(result.orderAudit).toEqual(direct);
    expect(result.settlementReady).toBe(direct.settlementReady);
    expect(result.orderAudit.blockers).toEqual(expect.arrayContaining([
      'order-changed-during-observation', 'response-at-limit', 'quote-amount-not-reported'
    ]));
    expect(result.executable).toBe(false);
  });

  it('preserves the recorded label without claiming cryptographic capture provenance', () => {
    const input = okx(); input.order.source = 'recorded';
    expect(auditOrderCash(input)).toMatchObject({ source: 'recorded', captureProvenanceVerified: false,
      wholeAccountHistoryProven: false, executable: false });
  });

  it('keeps input immutable including duplicate rows and unknown private fields', () => {
    const input = okx(); input.bills.rows.push({ ...input.bills.rows[0] });
    Object.assign(input.bills.rows[0], { privateDiagnostic: 'must-remain-input-only' });
    const before = structuredClone(input); auditOrderCash(input);
    expect(input).toEqual(before);
  });
});

describe('OKX cash bills corroborate a model without proving settlement', () => {
  it('compares net currency deltas while retaining unproven cash and fee contracts', () => {
    const result = auditOrderCash(okx());
    expect(result).toMatchObject({ schema: 1, kind: 'order-cash-audit-result', venue: 'okx', side: 'buy',
      quoteSource: 'derived-price-times-size', settlementReady: false, executable: false,
      cash: { expectedNet: funds('0.0000999', '-8.4'), expectedSource: 'derived-price-times-size',
        reportedNet: funds('0.0000999', '-8.4'), difference: funds(), comparison: 'matches-model',
        billRows: 4, uniqueBills: 4, duplicateBills: 0, grossQuoteProven: false,
        checks: { uncappedResponse: true, windowCoversOrder: true, tradeCoverage: true, currencyCoverage: true } } });
    expect(result.orderAudit.blockers).toContain('quote-amount-not-reported');
    expect(result.cash.blockers).toEqual(expect.arrayContaining([
      'bill-fee-currency-unconfirmed', 'cash-bill-contract-unconfirmed'
    ]));
    expect(result.cash.checks).not.toHaveProperty('feesMatch');
  });

  it('subtracts USDT fees from quote deltas on a buy', () => {
    const input = okx(); bothOkx(input, { fee: '-0.0084', feeCcy: 'USDT' });
    Object.assign(input.order.fills.data[0], { fee: '-0.0050394', feeCcy: 'USDT' });
    Object.assign(input.order.fills.data[1], { fee: '-0.0033606', feeCcy: 'USDT' });
    Object.assign(input.bills.rows[0], { balChg: '0.00006', fee: '0' });
    Object.assign(input.bills.rows[1], { balChg: '-5.0444394', fee: '-0.0050394' });
    Object.assign(input.bills.rows[2], { balChg: '0.00004', fee: '0' });
    Object.assign(input.bills.rows[3], { balChg: '-3.3639606', fee: '-0.0033606' });
    expect(auditOrderCash(input).cash).toMatchObject({ expectedNet: funds('0.0001', '-8.4084'),
      comparison: 'matches-model', difference: funds() });
  });

  it('uses negative base and positive net quote on a sale', () => {
    const input = okx(); input.order.expected.side = 'sell';
    bothOkx(input, { side: 'sell', fee: '-0.0084', feeCcy: 'USDT' });
    for (const fill of input.order.fills.data) Object.assign(fill, { side: 'sell', subType: '2', feeCcy: 'USDT' });
    input.order.fills.data[0].fee = '-0.0050394'; input.order.fills.data[1].fee = '-0.0033606';
    for (const bill of input.bills.rows) bill.subType = '2';
    Object.assign(input.bills.rows[0], { balChg: '-0.00006', fee: '0' });
    Object.assign(input.bills.rows[1], { balChg: '5.0343606', fee: '-0.0050394' });
    Object.assign(input.bills.rows[2], { balChg: '-0.00004', fee: '0' });
    Object.assign(input.bills.rows[3], { balChg: '3.3572394', fee: '-0.0033606' });
    expect(auditOrderCash(input).cash).toMatchObject({ expectedNet: funds('-0.0001', '8.3916'),
      reportedNet: funds('-0.0001', '8.3916'), comparison: 'matches-model' });
  });

  it('never adds bill fees again or assumes their denomination from ccy', () => {
    const input = okx();
    for (const row of input.bills.rows) row.fee = '-123.456';
    const result = auditOrderCash(input);
    expect(result.cash).toMatchObject({ reportedNet: funds('0.0000999', '-8.4'), difference: funds(),
      comparison: 'matches-model', grossQuoteProven: false });
    expect(result.cash.blockers).toContain('bill-fee-currency-unconfirmed');
  });

  it('reports signed reported-minus-expected differences with no rounding', () => {
    const input = okx(); input.bills.rows[1].balChg = '-5.139400000000000001';
    expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'differs-from-model',
      reportedNet: funds('0.0000999', '-8.500000000000000001'),
      difference: funds('0', '-0.100000000000000001') });
  });

  it('does not infer gross from optional sz even when it conflicts with balChg', () => {
    const input = okx();
    for (const row of input.bills.rows) row.sz = '-999999';
    expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'matches-model',
      expectedNet: funds('0.0000999', '-8.4'), reportedNet: funds('0.0000999', '-8.4'), grossQuoteProven: false });
  });

  it('does not require a bill id to equal the fill bill id', () => {
    const input = okx();
    input.bills.rows.forEach((row, i) => { row.billId = `different-bill-${i}`; });
    expect(auditOrderCash(input).cash.comparison).toBe('matches-model');
  });

  it('accepts multiple distinct bill rows per currency when net deltas still match', () => {
    const input = okx(); input.bills.rows[1].balChg = '-2';
    input.bills.rows.push({ ...input.bills.rows[1], billId: 'split-quote-bill', balChg: '-3.0394' });
    expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'matches-model', uniqueBills: 5,
      reportedNet: funds('0.0000999', '-8.4') });
  });

  it('never leaks raw order, trade, bill ids or unrecognized private response fields', () => {
    const input = okx();
    Object.assign(input.order.orderAfter.data[0], { clientOrderId: 'private-client-marker' });
    Object.assign(input.order.fills.data[0], { privateField: 'private-fill-marker' });
    Object.assign(input.bills.rows[0], { balance: 'private-balance-marker', accountId: 'private-account-marker' });
    const json = JSON.stringify(auditOrderCash(input));
    for (const forbidden of ['synthetic-cash-order', 'synthetic-trade-', 'synthetic-base-bill-',
      'synthetic-quote-bill-', 'private-client-marker', 'private-fill-marker', 'private-balance-marker', 'private-account-marker']) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('cash comparison evidence must be complete and correctly bound', () => {
  it('retains expected amounts but cannot compare missing bills', () => {
    const { bills: _bills, ...input } = okx();
    expect(auditOrderCash(input).cash).toMatchObject({ expectedNet: funds('0.0000999', '-8.4'),
      comparison: 'incomplete', reportedNet: null, difference: null, billRows: 0 });
  });

  it('does not treat an empty response as corroboration', () => {
    const input = okx(); input.bills.rows = [];
    expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'incomplete', difference: null,
      checks: { tradeCoverage: false, currencyCoverage: false } });
  });

  it('does not affirm zero executions using an empty bills page', () => {
    const input = { schema: 1, kind: 'order-cash-audit', order: structuredClone(zeroFixture),
      bills: { window: { from: 1000, to: 2000 }, limit: 100, rows: [] } };
    const result = auditOrderCash(input);
    expect(result.settlementReady).toBe(auditRecordedOrder(input.order).settlementReady);
    expect(result.cash).toMatchObject({ expectedNet: funds(), comparison: 'incomplete', difference: null,
      grossQuoteProven: false });
  });

  it('requires both currencies separately for every trade rather than globally', () => {
    const input = okx(); input.bills.rows = [input.bills.rows[0], input.bills.rows[3]];
    expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'incomplete', difference: null,
      checks: { tradeCoverage: true, currencyCoverage: false } });
  });

  it('detects a missing trade even when another trade covers both currencies', () => {
    const input = okx(); input.bills.rows = input.bills.rows.slice(0, 2);
    expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'incomplete', difference: null,
      checks: { tradeCoverage: false } });
  });

  it('treats a response at its limit as incomplete before deduplication', () => {
    const input = okx(); input.bills.rows.push({ ...input.bills.rows[0] }); input.bills.limit = 5;
    expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'incomplete', difference: null,
      billRows: 5, uniqueBills: 4, duplicateBills: 1, checks: { uncappedResponse: false } });
  });

  it.each([{ from: 1001, to: 2000 }, { from: 1000, to: 1499 }])(
    'cannot compare a window that does not bracket the observed order: %j', window => {
      const input = okx(); input.bills.window = window;
      expect(auditOrderCash(input).cash).toMatchObject({ comparison: 'incomplete', difference: null,
        checks: { windowCoversOrder: false } });
    });

  it.each([
    ['wrong order', { ordId: 'unrelated-order' }],
    ['unknown trade', { tradeId: 'unrelated-trade' }],
    ['wrong side subtype', { subType: '2' }],
    ['fill bill reused for another trade', { billId: 'synthetic-base-bill-2' }]
  ])('rejects %s', (_name, patch) => {
    const input = okx(); Object.assign(input.bills.rows[0], patch);
    cashError(input, 'bill-binding-mismatch');
  });

  it.each(['999', '2001'])('rejects a bill outside the requested window or observation: %s', ts => {
    const input = okx(); input.bills.rows[0].ts = ts;
    cashError(input, 'invalid-bill-time');
  });

  it('rejects a bill posted before its claimed execution', () => {
    const input = okx(); input.bills.rows[0].ts = '1099'; cashError(input, 'invalid-bill-time');
  });

  it('rejects an optional fillTime that does not bind to the same execution', () => {
    const input = okx(); Object.assign(input.bills.rows[0], { fillTime: '1101' });
    cashError(input, 'invalid-bill-time');
  });

  it('accepts an optional matching fillTime without inferring economic amounts', () => {
    const input = okx(); Object.assign(input.bills.rows[0], { fillTime: '1100' });
    expect(auditOrderCash(input).cash.comparison).toBe('matches-model');
  });

  it('deduplicates numerically equivalent records and ignores unknown fields', () => {
    const input = okx();
    const repeat = { ...input.bills.rows[0], balChg: '0.0000599400', fee: '-0.000000060', sz: '0.000060' };
    Object.assign(repeat, { debug: 'ignored-private-duplicate-field' }); input.bills.rows.push(repeat);
    expect(auditOrderCash(input).cash).toMatchObject({ billRows: 5, uniqueBills: 4, duplicateBills: 1,
      comparison: 'matches-model', reportedNet: funds('0.0000999', '-8.4') });
  });

  it.each([
    { balChg: '0.00005995' }, { fee: '-0.00000007' }, { ccy: 'USDT' }, { ts: '1111' }, { sz: '0.000061' }
  ])('rejects contradictory delivery of an existing bill: %j', patch => {
    const input = okx(); input.bills.rows.push({ ...input.bills.rows[0], ...patch });
    cashError(input, 'bill-id-conflict');
  });
});

describe('cash audit strict validation', () => {
  it.each([
    { schema: 2 }, { kind: 'cash-live-execution' }, { authorization: 'private-header-marker' },
    { bills: null }
  ])('rejects unsupported envelope %j with a fixed error', patch => {
    cashError({ ...okx(), ...patch }, 'invalid-cash-record');
  });

  it('preserves execution validation failures without treating them as a valid cash record', () => {
    expect(() => auditOrderCash({ ...okx(), order: null })).toThrow('invalid-execution-record');
  });

  it('rejects an unsupported OKX fee denomination rather than guessing missing monetary coverage', () => {
    const input = okx(); bothOkx(input, { feeCcy: 'MX' });
    for (const fill of input.order.fills.data) fill.feeCcy = 'MX';
    expect(() => auditOrderCash(input)).toThrow('unsupported-okx-fee-currency');
  });

  it('forbids bills on MEXC instead of assuming matching accounting semantics', () => {
    cashError({ ...mexc(), bills: okx().bills }, 'unexpected-bill-source');
  });

  it.each([
    { instType: 'SWAP' }, { instId: 'ETH-USDT' }, { type: '1' }, { subType: '3' },
    { ccy: 'MX' }, { mgnMode: '' }, { mgnMode: 'cross' }, { execType: '' }, { execType: 'M' },
    { billId: 'unsafe/id' }, { ordId: 'unsafe/id' }, { tradeId: 'unsafe/id' },
    { balChg: '1e-8' }, { balChg: 1 }, { balChg: '0.0000000000000000001' },
    { fee: '-0.0000000000000000001' }, { fee: '' }, { sz: '1e-3' }, { ts: '-1' }
  ])('rejects unsupported or ambiguous bill facts %j', patch => {
    const input = okx(); Object.assign(input.bills.rows[0], patch);
    cashError(input, 'invalid-cash-record');
  });

  it.each(['instType', 'instId', 'billId', 'ordId', 'tradeId', 'type', 'subType', 'ccy', 'balChg', 'fee', 'ts', 'mgnMode', 'execType'])(
    'rejects missing bill field %s', field => {
      const input = okx(); const row: Record<string, unknown> = input.bills.rows[0]; delete row[field];
      cashError(input, 'invalid-cash-record');
    });

  it.each(['0.000000000000000001', '1'])('rejects a positive bill rebate %s', fee => {
    const input = okx(); input.bills.rows[0].fee = fee;
    cashError(input, 'unsupported-fee-rebate');
  });

  it('accepts signed zero without creating negative-zero monetary output', () => {
    const input = okx(); input.bills.rows[1].fee = '-0.000';
    const result = auditOrderCash(input);
    expect(result.cash.difference).toEqual(funds());
    expect(JSON.stringify(result.cash)).not.toContain('"-0"');
  });

  it.each([0, 101, 1.5])('rejects unsupported bill response limit %s', limit => {
    const input = okx(); input.bills.limit = limit; cashError(input, 'invalid-cash-record');
  });

  it('rejects rows exceeding the requested limit', () => {
    const input = okx(); input.bills.limit = 3; cashError(input, 'response-exceeds-limit');
  });

  it.each([{ from: 0, to: 2000 }, { from: 1000.5, to: 2000 }])(
    'rejects invalid bills window %j', window => {
      const input = okx(); input.bills.window = window; cashError(input, 'invalid-cash-record');
    });
});


describe('cash window causality', () => {
  it.each([{ from: 2000, to: 1000 }, { from: 1000, to: 2001 }])('rejects reversed or future window %j', window => {
    const input = okx(); input.bills.window = window; cashError(input, 'invalid-bill-time');
  });
});


describe('offline cash report filesystem and CLI boundary', () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  async function location(input: unknown = okx()) {
    const root = await mkdtemp(join(tmpdir(), 'cash-audit-test-')); temporary.push(root);
    const record = join(root, 'record.json'), output = join(root, 'report');
    await writeFile(record, JSON.stringify(input), { mode: 0o600 });
    return { root, record, output };
  }
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/cash-audit.ts', ...args],
    { cwd: resolve('.'), encoding: 'utf8', timeout: 10_000 });

  it('writes a private reproducible report and returns an amount-free summary', async () => {
    const { record, output } = await location();
    const summary = await writeCashAudit(record, output);
    expect((await lstat(output)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(output, 'report.json'))).mode & 0o777).toBe(0o600);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ schema: 1, kind: 'offline-cash-audit-report', networkUsed: false,
      exchangeOrders: 0, captureProvenanceVerified: false, audit: { executable: false, settlementReady: false } });
    expect(report.audit).toEqual(auditOrderCash(okx()));
    expect(report.normalizedSha256).toBe(createHash('sha256').update(canonical(report.audit)).digest('hex'));
    expect(summary.normalizedSha256).toBe(report.normalizedSha256);
    for (const key of ['expectedNet', 'reportedNet', 'difference', 'fills', 'orderKey']) expect(summary).not.toHaveProperty(key);
    expect(JSON.stringify(summary)).not.toContain('0.0000999');
    expect(await readdir(output)).toEqual(['report.json']);
  });

  it('preserves an existing report byte for byte', async () => {
    const { record, output } = await location(); await writeCashAudit(record, output);
    const before = await readFile(join(output, 'report.json'));
    await expect(writeCashAudit(record, output)).rejects.toThrow();
    expect(await readFile(join(output, 'report.json'))).toEqual(before);
    expect(await readdir(output)).toEqual(['report.json']);
  });

  it('rejects symlink input rather than following it', async () => {
    const { root, record, output } = await location(); const link = join(root, 'linked.json');
    await symlink(record, link);
    await expect(writeCashAudit(link, output)).rejects.toThrow();
    await expect(lstat(output)).rejects.toThrow();
  });

  it('rejects symlink output without modifying its target', async () => {
    const { root, record, output } = await location(); const target = join(root, 'existing.txt');
    await writeFile(target, 'keep-this', { mode: 0o600 }); await symlink(target, output);
    await expect(writeCashAudit(record, output)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('keep-this');
  });

  it('rejects an oversized input before creating an output directory', async () => {
    const { record, output } = await location(); await writeFile(record, ' '.repeat(128 * 1024 + 1));
    await expect(writeCashAudit(record, output)).rejects.toThrow();
    await expect(lstat(output)).rejects.toThrow();
  });

  it('prints metadata only on CLI success', async () => {
    const { record, output } = await location(); const result = run([record, output]);
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({ source: 'synthetic', venue: 'okx', comparison: 'matches-model',
      uniqueFills: 2, uniqueBills: 4, settlementReady: false });
    expect(result.stdout).not.toContain('synthetic-cash-order');
    expect(result.stdout).not.toContain('synthetic-trade');
    expect(result.stdout).not.toContain('0.0000999');
    expect(result.stdout).not.toContain('-8.4');
  });

  it('uses fixed CLI errors without echoing malformed private record contents', async () => {
    const { record, output } = await location({ schema: 1, secret: 'do-not-print-private-marker' });
    const result = run([record, output]);
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Offline cash audit failed. Use RECORD_JSON NEW_OUTPUT_DIRECTORY. Existing files are preserved.\n');
    expect(result.stderr).not.toContain('do-not-print-private-marker');
    await expect(lstat(output)).rejects.toThrow();
  });

  it('rejects extra CLI arguments and creates no report', async () => {
    const { record, output } = await location(); const result = run([record, output, 'extra']);
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    await expect(lstat(output)).rejects.toThrow();
  });
});
