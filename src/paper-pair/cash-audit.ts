/** Offline selected-order cash comparison. A matching model is not reported gross quote evidence. */
import { z } from 'zod';
import { canonical } from '../paper-v2/ledger.js';
import { auditRecordedOrder } from './execution-audit.js';

const id = z.union([z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), z.number().int().nonnegative().safe()]).transform(String);
const time = z.union([z.number(), z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)]).pipe(z.number().int().positive().safe());
const signed = z.string().regex(/^-?(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/);
const billSchema = z.object({ instType: z.literal('SPOT'), instId: z.literal('BTC-USDT'),
  type: z.literal('2'), subType: z.enum(['1', '2']), mgnMode: z.literal('cash'), execType: z.literal('T'),
  billId: id, ordId: id, tradeId: id, ccy: z.enum(['BTC', 'USDT']), balChg: signed, fee: signed,
  ts: time, sz: signed.optional(), bal: signed.optional(), fillTime: time.optional() });
const inputSchema = z.object({ schema: z.literal(1), kind: z.literal('order-cash-audit'), order: z.unknown(),
  bills: z.object({ window: z.object({ from: time, to: time }).strict(), limit: z.number().int().min(1).max(100),
    rows: z.array(billSchema).max(100) }).strict().optional() }).strict();
const okxSource = z.object({ expected: z.object({ orderId: id }), orderAfter: z.object({ data: z.array(z.object({ cTime: time, uTime: time })).length(1) }),
  fills: z.object({ data: z.array(z.object({ tradeId: id, billId: id, fillTime: time })) }) });
const ASSETS = ['BTC', 'USDT', 'MX'] as const;
type Funds = Record<typeof ASSETS[number], string>;
type Units = Record<typeof ASSETS[number], bigint>;
const SCALE = 10n ** 36n;
function units(value: string): bigint {
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(36, '0'))) * (negative ? -1n : 1n);
}
function decimal(value: bigint): string {
  const abs = value < 0n ? -value : value, fraction = (abs % SCALE).toString().padStart(36, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${abs / SCALE}${fraction ? '.' + fraction : ''}`;
}
function zero(): Units { return { BTC: 0n, USDT: 0n, MX: 0n }; }
function display(values: Units): Funds { return { BTC: decimal(values.BTC), USDT: decimal(values.USDT), MX: decimal(values.MX) }; }
export class CashAuditError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'CashAuditError'; }
}
function fail(reason: string): never { throw new CashAuditError(reason); }
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input); if (!result.success) fail('invalid-cash-record'); return result.data;
}

export function auditOrderCash(input: unknown) {
  const e = parse(inputSchema, input), orderAudit = auditRecordedOrder(e.order);
  if (orderAudit.venue === 'mexc' && e.bills !== undefined) fail('unexpected-bill-source');
  const expected = zero(), direction = orderAudit.side === 'buy' ? 1n : -1n;
  expected.BTC = direction * units(orderAudit.totals.baseQuantity);
  expected.USDT = -direction * units(orderAudit.totals.quoteQuantity);
  for (const asset of ASSETS) expected[asset] -= units(orderAudit.totals.fees[asset]);
  const checks: { uncappedResponse: boolean | null; windowCoversOrder: boolean | null;
    tradeCoverage: boolean | null; currencyCoverage: boolean | null } = {
    uncappedResponse: null, windowCoversOrder: null, tradeCoverage: null, currencyCoverage: null };
  const orderConsistent = orderAudit.blockers.every(reason => orderAudit.venue === 'okx' && reason === 'quote-amount-not-reported');
  const cash: { expectedNet: Funds | null; expectedSource: string; reportedNet: Funds | null; difference: Funds | null;
    comparison: 'not-requested' | 'incomplete' | 'matches-model' | 'differs-from-model'; billRows: number;
    uniqueBills: number; duplicateBills: number; checks: typeof checks; blockers: string[]; grossQuoteProven: boolean } = {
    expectedNet: orderConsistent ? display(expected) : null, expectedSource: orderAudit.venue === 'mexc' ? 'reported-fill-amounts' : 'derived-price-times-size',
    reportedNet: null, difference: null, comparison: orderAudit.venue === 'mexc' ? 'not-requested' : 'incomplete',
    billRows: 0, uniqueBills: 0, duplicateBills: 0, checks, blockers: [], grossQuoteProven: orderAudit.venue === 'mexc' && orderAudit.settlementReady };
  if (!orderConsistent) cash.blockers.push('order-evidence-incomplete');
  if (orderAudit.venue === 'okx') {
    cash.blockers.push('cash-bill-contract-unconfirmed', 'bill-fee-currency-unconfirmed');
    if (!e.bills) cash.blockers.push('bills-not-supplied');
    else {
      const source = parse(okxSource, e.order), order = source.orderAfter.data[0], page = e.bills;
      if (page.window.from > page.window.to || page.window.to > orderAudit.observedAt) fail('invalid-bill-time');
      if (page.rows.length > page.limit) fail('response-exceeds-limit');
      const trades = new Map(source.fills.data.map(fill => [fill.tradeId, fill]));
      const fillBills = new Map(source.fills.data.map(fill => [fill.billId, fill.tradeId]));
      const unique = new Map<string, string>(), coverage = new Map<string, Set<string>>();
      const reported = zero();
      cash.billRows = page.rows.length;
      for (const bill of page.rows) {
        const fill = trades.get(bill.tradeId);
        if (bill.ordId !== source.expected.orderId || !fill || bill.subType !== (orderAudit.side === 'buy' ? '1' : '2') ||
            (fillBills.has(bill.billId) && fillBills.get(bill.billId) !== bill.tradeId)) fail('bill-binding-mismatch');
        if (bill.ts < order.cTime || bill.ts < fill.fillTime || bill.ts < page.window.from || bill.ts > page.window.to ||
            (bill.fillTime !== undefined && (bill.fillTime !== fill.fillTime || bill.fillTime > bill.ts))) fail('invalid-bill-time');
        if (units(bill.fee) > 0n) fail('unsupported-fee-rebate');
        // fee has no separately documented feeCcy here. Retain it for conflicts,
        // but never group it by bill.ccy or add it again to balChg.
        const fingerprint = canonical({ ...bill, balChg: decimal(units(bill.balChg)), fee: decimal(units(bill.fee)),
          sz: bill.sz === undefined ? null : decimal(units(bill.sz)), bal: bill.bal === undefined ? null : decimal(units(bill.bal)) });
        const previous = unique.get(bill.billId);
        if (previous !== undefined) {
          if (previous !== fingerprint) fail('bill-id-conflict');
          cash.duplicateBills++; continue;
        }
        unique.set(bill.billId, fingerprint);
        reported[bill.ccy] += units(bill.balChg);
        const currencies = coverage.get(bill.tradeId) ?? new Set<string>(); currencies.add(bill.ccy); coverage.set(bill.tradeId, currencies);
      }
      cash.uniqueBills = unique.size;
      checks.uncappedResponse = page.rows.length < page.limit;
      checks.windowCoversOrder = page.window.from <= order.cTime && page.window.to >= order.uTime;
      checks.tradeCoverage = trades.size > 0 && [...trades.keys()].every(trade => coverage.has(trade));
      // Coverage is a prerequisite of this comparison, not an assertion about
      // the exchange's number of bills. Missing assets are not reported as zero.
      checks.currencyCoverage = trades.size > 0 && [...trades.keys()].every(trade =>
        ['BTC', 'USDT'].every(asset => coverage.get(trade)?.has(asset)));
      if (!checks.uncappedResponse) cash.blockers.push('bill-response-at-limit');
      if (!checks.windowCoversOrder) cash.blockers.push('bill-window-incomplete');
      if (!checks.tradeCoverage) cash.blockers.push('bill-trade-coverage-incomplete');
      if (!checks.currencyCoverage) cash.blockers.push('bill-currency-coverage-incomplete');
      if (!orderAudit.uniqueFills) cash.blockers.push('no-executions-to-compare');
      // Ignore only the existing gross-quote gate for MODEL comparison, never
      // for settlement. Other source inconsistencies invalidate comparison.
      if (orderConsistent && Object.values(checks).every(value => value === true)) {
        cash.reportedNet = display(reported);
        const difference = zero(); for (const asset of ASSETS) difference[asset] = reported[asset] - expected[asset];
        cash.difference = display(difference);
        cash.comparison = ASSETS.every(asset => difference[asset] === 0n) ? 'matches-model' : 'differs-from-model';
        if (cash.comparison === 'differs-from-model') cash.blockers.push('cash-movement-differs');
      }
    }
  }
  return { schema: 1, kind: 'order-cash-audit-result', venue: orderAudit.venue, source: orderAudit.source,
    side: orderAudit.side, orderKey: orderAudit.orderKey, executable: false, captureProvenanceVerified: false,
    wholeAccountHistoryProven: false, settlementReady: orderAudit.settlementReady,
    quoteSource: orderAudit.quoteSource, orderAudit, cash };
}
