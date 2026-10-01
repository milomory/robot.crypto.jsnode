import { AccountError } from './types.js';
import type { OkxAccountReader, OkxAssetValuation } from './okx.js';
import type { MexcFuturesAccountReader } from './mexc-futures.js';
import { accountDashboardSchema, type AccountDashboard, type DashboardCoverage, type DashboardExchange } from './dashboard-contract.js';
import type { ValuationClient } from './portfolio-observation.js';
import { sumHistoryAmounts as add } from './balance-history-contract.js';

type Futures = Awaited<ReturnType<MexcFuturesAccountReader['getBalances']>>;
type Observation<T> = { status: 'available'; requestedAt: number; receivedAt: number; value: T }
  | { status: 'unavailable'; reason: 'read-failed' | 'rate-limited' };
export type AccountCoverageReads = { mexc: Observation<Futures>; okx: Observation<OkxAssetValuation> };
const MAX_AGE = 120_000;
const decimal = /^-?(?:0|[1-9]\d{0,89})(?:\.\d{1,60})?$/;
function time(clock: () => number) {
  const at = clock();
  if (!Number.isSafeInteger(at) || at <= 0 || at > 8_640_000_000_000_000) throw new Error('coverage-invalid-clock');
  return at;
}
async function bounded<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('coverage-timeout')), 6_000);
  })]); } finally { clearTimeout(timer); }
}
/** Additional fixed GET reads; the caller completes these before operation
 * history to avoid concurrent use of the same signed OKX transport. */
export async function observeAccountCoverage(mexc: Pick<MexcFuturesAccountReader, 'getBalances'>,
  okx: Pick<OkxAccountReader, 'getAssetValuation'>, options: {
    clock?: () => number; deadline: number; onRateLimit?: (venue: 'mexc' | 'okx') => Promise<void>
  }): Promise<AccountCoverageReads> {
  const clock = options.clock ?? Date.now;
  async function read<T>(venue: 'mexc' | 'okx', action: () => Promise<T>): Promise<Observation<T>> {
    try {
      const requestedAt = time(clock);
      if (requestedAt + 6_000 > options.deadline) throw new Error();
      const value = await bounded(action), receivedAt = time(clock);
      if (receivedAt < requestedAt) throw new Error();
      return { status: 'available', requestedAt, receivedAt, value };
    } catch (error) {
      const rate = error instanceof AccountError && error.code === 'account-rate-limited';
      if (rate) await options.onRateLimit?.(venue).catch(() => {});
      return { status: 'unavailable', reason: rate ? 'rate-limited' : 'read-failed' };
    }
  }
  const [mexcResult, okxResult] = await Promise.all([
    read('mexc', () => mexc.getBalances()), read('okx', () => okx.getAssetValuation())
  ]);
  return { mexc: mexcResult, okx: okxResult };
}
function fresh<T>(read: Observation<T>, now: number): read is Extract<Observation<T>, { status: 'available' }> {
  return read.status === 'available' && Number.isSafeInteger(read.requestedAt) && Number.isSafeInteger(read.receivedAt)
    && read.requestedAt > 0 && read.receivedAt >= read.requestedAt && read.receivedAt <= now && now - read.requestedAt <= MAX_AGE;
}
function zero(value: string | null): boolean { return value !== null && /^-?0(?:\.0+)?$/.test(value); }
function multiply(left: string, right: string) {
  if (!decimal.test(left) || !decimal.test(right)) throw new Error('coverage-invalid-decimal');
  const parts = (v: string) => { const [whole, fraction = ''] = v.replace(/^-/, '').split('.');
    return { atoms: BigInt(whole + fraction) * (v.startsWith('-') ? -1n : 1n), scale: fraction.length }; };
  const a = parts(left), b = parts(right), atoms = a.atoms * b.atoms, scale = a.scale + b.scale;
  if (atoms === 0n) return '0';
  const digits = (atoms < 0n ? -atoms : atoms).toString().padStart(scale + 1, '0');
  const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
  return `${atoms < 0n ? '-' : ''}${value}`;
}
function legacyCoverage(exchange: DashboardExchange): DashboardCoverage {
  const included = exchange.status === 'connected' ? 'included' : 'unavailable';
  return exchange.venue === 'mexc' ? { basis: 'mexc-spot', status: 'partial', scope: 'current-account', assetBreakdown: 'spot',
    wallets: [{ id: 'spot', status: included, valueUsdt: exchange.portfolioUsdt },
      { id: 'futures', status: 'unavailable', valueUsdt: null, reason: 'read-failed' }, { id: 'earn', status: 'unsupported', valueUsdt: null, reason: 'unsupported' }] }
    : { basis: 'okx-trading-funding', status: 'partial', scope: 'current-account', assetBreakdown: 'trading-funding',
      wallets: [{ id: 'trading', status: included, valueUsdt: null }, { id: 'funding', status: included, valueUsdt: null },
        { id: 'earn', status: 'unavailable', valueUsdt: null }, { id: 'classic', status: 'unavailable', valueUsdt: null }] };
}
/** Extend the existing private projection. OKX's official total REPLACES the
 * previous priced subtotal, never adds to it. MEXC futures equity is independent
 * of Spot, but unknown bonus/debt semantics are not guessed or silently netted.
 * Available USDT and asset rows keep their explicit original wallet scope. */
export async function extendAccountCoverage(base: AccountDashboard, reads: AccountCoverageReads,
  prices: ValuationClient, clock = Date.now): Promise<AccountDashboard> {
  const started = time(clock);
  const exchanges = base.exchanges.map(row => ({ ...row, coverage: legacyCoverage(row) }));
  const mexc = exchanges.find(row => row.venue === 'mexc')!, okx = exchanges.find(row => row.venue === 'okx')!;
  if (fresh(reads.okx, started) && okx.status === 'connected' &&
      Number(reads.okx.value.updatedAt) <= started && started - Number(reads.okx.value.updatedAt) <= MAX_AGE) {
    const value = reads.okx.value;
    okx.portfolioUsdt = value.totalUsdt; okx.pricedUsdt = value.totalUsdt;
    okx.valuationComplete = true; okx.unpricedAssets = [];
    okx.observedAt = Math.min(okx.observedAt!, reads.okx.requestedAt, Number(value.updatedAt));
    okx.coverage = { basis: 'okx-account-total', status: 'complete', scope: 'current-account',
      assetBreakdown: 'trading-funding', breakdownMatchesTotal: value.breakdownMatchesTotal,
      wallets: (['trading', 'funding', 'earn', 'classic'] as const).map(id => ({ id, status: 'included', valueUsdt: value.wallets[id] })) };
  } else {
    // A failed new total read must produce a gap, not a fall back to the old
    // smaller amount presented as a complete account value.
    okx.portfolioUsdt = null; okx.valuationComplete = false;
  }
  if (fresh(reads.mexc, started) && mexc.status === 'connected') {
    const balances = reads.mexc.value.balances;
    mexc.coverage.wallets[1].reason = 'ambiguous-equity';
    if (balances.length <= 200 && balances.every(row => zero(row.bonus) && zero(row.debtAmount))) {
      const nonzero = balances.filter(row => !zero(row.equity));
      const currencies = nonzero.map(row => row.currency);
      let quotes: Record<string, string> = {};
      try {
        if (currencies.some(value => value !== 'USDT')) {
          const quote = await bounded(() => prices.getPrices('mexc', currencies));
          const at = time(clock);
          if (quote.venue === 'mexc' && Number.isSafeInteger(quote.requestedAt) && Number.isSafeInteger(quote.receivedAt)
              && quote.requestedAt > 0 && quote.receivedAt >= quote.requestedAt && quote.receivedAt <= at && at - quote.requestedAt <= MAX_AGE) quotes = quote.prices;
        }
      } catch { /* missing price remains unknown */ }
      const missing: string[] = [], amounts: string[] = [];
      for (const row of nonzero) {
        const price = row.currency === 'USDT' ? '1' : quotes[row.currency];
        if (typeof price !== 'string' || !decimal.test(price) || /^-/.test(price) || zero(price)) missing.push(row.currency);
        else amounts.push(multiply(row.equity, price));
      }
      const subtotal = amounts.reduce(add, '0');
      mexc.pricedUsdt = mexc.pricedUsdt === null ? null : add(mexc.pricedUsdt, subtotal);
      mexc.unpricedAssets = [...new Set([...mexc.unpricedAssets, ...missing])];
      mexc.valuationComplete = mexc.valuationComplete && missing.length === 0;
      mexc.portfolioUsdt = mexc.valuationComplete ? mexc.pricedUsdt : null;
      mexc.observedAt = Math.min(mexc.observedAt!, reads.mexc.requestedAt);
      mexc.coverage.basis = 'mexc-spot-futures';
      mexc.coverage.wallets[1] = { id: 'futures', status: 'included', valueUsdt: missing.length ? null : subtotal,
        ...(missing.length ? { reason: 'unpriced' as const } : {}) };
    }
  }
  const observedAt = time(clock);
  if (observedAt < started) throw new Error('coverage-invalid-clock');
  const connected = exchanges.every(row => row.status === 'connected');
  const valuationComplete = connected && exchanges.every(row => row.valuationComplete);
  const combined = (field: 'pricedUsdt' | 'usdtBalance' | 'availableUsdt') => connected && exchanges.every(row => row[field] !== null)
    ? exchanges.map(row => row[field]!).reduce(add, '0') : null;
  const pricedUsdt = combined('pricedUsdt');
  return accountDashboardSchema.parse({ ...base, observedAt, exchanges,
    status: connected ? 'partial' : base.status,
    totals: { portfolioUsdt: valuationComplete ? pricedUsdt : null, pricedUsdt, valuationComplete,
      usdtBalance: combined('usdtBalance'), availableUsdt: combined('availableUsdt') } });
}
