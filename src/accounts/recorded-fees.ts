/** Offline arithmetic over reported fill fees. No tariff comparison, FX conversion or wallet-net inference. */
import { z } from 'zod';
import { projectExecutionRows, type ExecutionVenue } from './execution-records.js';

const MAX_ROWS = 3_000;
const SCALE = 10n ** 30n;
const inputSchema = z.object({ venue: z.enum(['mexc', 'okx']), rows: z.array(z.unknown()).max(MAX_ROWS) }).strict();
export const RECORDED_FEE_REASONS = ['invalid-input', 'too-many-rows', 'invalid-fill', 'unsupported-execution-category',
  'fill-identity-conflict', 'bill-identity-conflict', 'fee-missing', 'fee-currency-missing', 'fill-time-missing',
  'fill-time-invalid', 'fill-time-conflict', 'side-missing', 'side-subtype-conflict'] as const;
export type RecordedFeeReason = typeof RECORDED_FEE_REASONS[number];
export type RecordedFeeTotal = Readonly<{ currency: string; charges: string; rebates: string;
  nonzeroChargeFills: number; nonzeroRebateFills: number }>;
export type RecordedFeeSummary = Readonly<{ schema: 1; kind: 'recorded-fee-summary'; venue: ExecutionVenue | null;
  symbol: 'BTC/USDT'; scope: 'observed-fills-only'; status: 'observed' | 'no-observations' | 'incomplete' | 'invalid';
  inputRows: number; uniqueFills: number; duplicateRows: number; roles: Readonly<{ maker: number; taker: number; unknown: number }>;
  zeroFeeFills: number;
  /** Only currencies of nonzero reported fees appear here. All-zero observed fills produce an empty array. */
  totals: readonly RecordedFeeTotal[] | null; reasons: readonly RecordedFeeReason[];
  wholeAccountHistoryProven: false; captureProvenanceVerified: false; futureFeeCurrencyVerified: false;
  roundingVerified: false; executable: false }>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function units(value: string): bigint {
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(30, '0'))) * (negative ? -1n : 1n);
}
function decimal(value: bigint): string {
  const negative = value < 0n, absolute = negative ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(30, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + (absolute / SCALE).toString() + (fraction ? '.' + fraction : '');
}
const absent = (value: unknown) => value === undefined || value === null || value === '';
const moneyFields = new Set(['price', 'qty', 'quoteQty', 'commission', 'fillSz', 'fillPx', 'fee', 'feeRate']);
const timeFields = new Set(['time', 'fillTime', 'ts']);
function fingerprint(row: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    normalized[key] = absent(value) ? null : moneyFields.has(key) ? decimal(units(value as string)) :
      timeFields.has(key) ? String(value) : value;
  }
  return JSON.stringify(normalized);
}
function initial(venue: ExecutionVenue | null, inputRows: number): Omit<RecordedFeeSummary, 'status' | 'totals'> {
  return { schema: 1, kind: 'recorded-fee-summary', venue, symbol: 'BTC/USDT', scope: 'observed-fills-only',
    inputRows, uniqueFills: 0, duplicateRows: 0, roles: { maker: 0, taker: 0, unknown: 0 }, zeroFeeFills: 0,
    reasons: [], wholeAccountHistoryProven: false, captureProvenanceVerified: false, futureFeeCurrencyVerified: false,
    roundingVerified: false, executable: false };
}
function rejected(reason: RecordedFeeReason, venue: ExecutionVenue | null = null, inputRows = 0): RecordedFeeSummary {
  return freeze({ ...initial(venue, inputRows), status: 'invalid', totals: null, reasons: [reason] });
}

/** Invalid or incomplete observations never expose partial totals as a complete fee summary. */
export function summarizeRecordedFees(input: unknown): RecordedFeeSummary {
  try {
    if (input && typeof input === 'object' && 'rows' in input && Array.isArray(input.rows) && input.rows.length > MAX_ROWS) {
      const venue = 'venue' in input && (input.venue === 'mexc' || input.venue === 'okx') ? input.venue : null;
      return rejected('too-many-rows', venue, input.rows.length);
    }
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return rejected('invalid-input');
    const { venue, rows } = parsed.data;
    if (!rows.length) return freeze({ ...initial(venue, 0), status: 'no-observations', totals: null });
    const reasons = new Set<RecordedFeeReason>(), seen = new Map<string, string>(), bills = new Map<string, string>();
    const roles = { maker: 0, taker: 0, unknown: 0 };
    const totals = new Map<string, { charges: bigint; rebates: bigint; nonzeroChargeFills: number; nonzeroRebateFills: number }>();
    let invalid = false, duplicateRows = 0, zeroFeeFills = 0;
    for (const raw of rows) {
      let row: Record<string, unknown>;
      try { row = projectExecutionRows(venue, 'fills', [raw])[0] as Record<string, unknown>; }
      catch { invalid = true; reasons.add('invalid-fill'); continue; }
      if (venue === 'okx' && row.instType !== 'SPOT') { invalid = true; reasons.add('unsupported-execution-category'); }
      const id = String(venue === 'mexc' ? row.id : row.tradeId), signature = fingerprint(row);
      const prior = seen.get(id);
      if (prior !== undefined) {
        if (prior === signature) duplicateRows++;
        else { invalid = true; reasons.add('fill-identity-conflict'); }
        continue;
      }
      seen.set(id, signature);
      if (venue === 'okx') {
        const bill = String(row.billId), existing = bills.get(bill);
        if (existing !== undefined && existing !== id) { invalid = true; reasons.add('bill-identity-conflict'); }
        else bills.set(bill, id);
      }
      const role = venue === 'mexc' ? row.isMaker === true ? 'maker' : row.isMaker === false ? 'taker' : 'unknown' :
        row.execType === 'M' ? 'maker' : row.execType === 'T' ? 'taker' : 'unknown';
      roles[role]++;
      const fee = venue === 'mexc' ? row.commission : row.fee, currency = venue === 'mexc' ? row.commissionAsset : row.feeCcy;
      const at = venue === 'mexc' ? row.time : row.fillTime;
      const side = venue === 'mexc' ? row.isBuyer === true ? 'buy' : row.isBuyer === false ? 'sell' : null : row.side;
      if (absent(fee)) reasons.add('fee-missing');
      if (absent(currency)) reasons.add('fee-currency-missing');
      if (absent(at)) reasons.add('fill-time-missing');
      else if (Number(at) <= 0 || Number(at) > 8_640_000_000_000_000) { invalid = true; reasons.add('fill-time-invalid'); }
      if (absent(side)) reasons.add('side-missing');
      else if (side !== 'buy' && side !== 'sell') { invalid = true; reasons.add('unsupported-execution-category'); }
      if (venue === 'okx') {
        if (!absent(row.ts) && (Number(row.ts) <= 0 || Number(row.ts) > 8_640_000_000_000_000)) { invalid = true; reasons.add('fill-time-invalid'); }
        if (!absent(at) && !absent(row.ts) && Number(at) > Number(row.ts)) { invalid = true; reasons.add('fill-time-conflict'); }
        if ((row.subType === '1' && side === 'sell') || (row.subType === '2' && side === 'buy')) { invalid = true; reasons.add('side-subtype-conflict'); }
      }
      if (absent(fee) || absent(currency)) continue;
      const amount = units(fee as string);
      if (amount === 0n) { zeroFeeFills++; continue; }
      const expense = venue === 'mexc' || amount < 0n, absolute = amount < 0n ? -amount : amount;
      const total = totals.get(currency as string) ?? { charges: 0n, rebates: 0n, nonzeroChargeFills: 0, nonzeroRebateFills: 0 };
      if (expense) { total.charges += absolute; total.nonzeroChargeFills++; }
      else { total.rebates += absolute; total.nonzeroRebateFills++; }
      totals.set(currency as string, total);
    }
    return freeze({ ...initial(venue, rows.length), status: invalid ? 'invalid' : reasons.size ? 'incomplete' : 'observed',
      uniqueFills: seen.size, duplicateRows, roles, zeroFeeFills, reasons: [...reasons].sort(),
      totals: invalid || reasons.size ? null : [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({
        currency, charges: decimal(total.charges), rebates: decimal(total.rebates),
        nonzeroChargeFills: total.nonzeroChargeFills, nonzeroRebateFills: total.nonzeroRebateFills })) });
  } catch { return rejected('invalid-input'); }
}
