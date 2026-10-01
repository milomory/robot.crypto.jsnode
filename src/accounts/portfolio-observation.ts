import type { PairObservation, PairVenue } from './pair-observation.js';
import { accountDashboardSchema, type AccountDashboard, type DashboardAsset,
  type DashboardExchange } from './dashboard-contract.js';

const DECIMAL = /^-?(?:0|[1-9]\d{0,89})(?:\.\d{1,60})?$/;
const INPUT_DECIMAL = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/;
const CURRENCY = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MAX_BYTES = 4 * 1024 * 1024, MAX_ASSETS = 200, FRESH_MS = 120_000;
const URLS = { mexc: 'https://api.mexc.com/api/v3/ticker/price',
  okx: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT' } as const;
export class PortfolioError extends Error {
  constructor(readonly reason: 'portfolio-invalid-data' | 'portfolio-invalid-clock' | 'portfolio-public-unavailable'
    | 'portfolio-public-timeout' | 'portfolio-public-too-large' | 'portfolio-public-busy') {
    super(reason); this.name = 'PortfolioError';
  }
}
function invalid(): never { throw new PortfolioError('portfolio-invalid-data'); }
function now(clock: () => number): number {
  let value: number;
  try { value = clock(); } catch { throw new PortfolioError('portfolio-invalid-clock'); }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) {
    throw new PortfolioError('portfolio-invalid-clock');
  }
  return value;
}
// Arbitrary fixed decimals, not binary floating point. Source precision is at
// most 30 places; a product retains all 60 places, and sums never round.
type Exact = { atoms: bigint; scale: number };
function parse(value: string): Exact {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return invalid();
  const negative = value.startsWith('-'), unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  return { atoms: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
}
function format(value: Exact): string {
  if (value.atoms === 0n) return '0';
  const negative = value.atoms < 0n, absolute = negative ? -value.atoms : value.atoms;
  const digits = absolute.toString().padStart(value.scale + 1, '0');
  const output = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, '');
  const result = `${negative ? '-' : ''}${output}`;
  if (!DECIMAL.test(result)) return invalid();
  return result;
}
function add(left: string, right: string): string {
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  return format({ atoms: a.atoms * 10n ** BigInt(scale - a.scale) + b.atoms * 10n ** BigInt(scale - b.scale), scale });
}
function multiply(left: string, right: string): string {
  const a = parse(left), b = parse(right);
  return format({ atoms: a.atoms * b.atoms, scale: a.scale + b.scale });
}
function minimum(left: string, right: string): string {
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  return a.atoms * 10n ** BigInt(scale - a.scale) <= b.atoms * 10n ** BigInt(scale - b.scale) ? left : right;
}
function nonnegative(value: string): string { return parse(value).atoms < 0n ? '0' : value; }
function sum(values: string[]): string { return values.reduce(add, '0'); }
function input(value: string): string {
  if (typeof value !== 'string' || !INPUT_DECIMAL.test(value)) return invalid();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export type ValuationPrices = { venue: PairVenue; requestedAt: number; receivedAt: number; prices: Record<string, string> };
export type ValuationClient = { getPrices(venue: PairVenue, currencies: readonly string[]): Promise<ValuationPrices> };

/** Public last-price estimates only. Official endpoints:
 * https://mexcdevelop.github.io/apidocs/spot_v3_en/#symbol-price-ticker
 * https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-tickers
 * No URLs, auth headers, proxies or per-asset destinations come from callers.
 * The injected fetch must retain the runtime's direct-network policy.
 */
export class AccountValuationClient implements ValuationClient {
  readonly #busy = new Set<PairVenue>();
  constructor(private readonly request: typeof fetch = fetch, private readonly clock = Date.now) {}
  async getPrices(venue: PairVenue, currencies: readonly string[]): Promise<ValuationPrices> {
    if (!Object.hasOwn(URLS, venue) || currencies.length > MAX_ASSETS
      || currencies.some(currency => !CURRENCY.test(currency)) || new Set(currencies).size !== currencies.length) return invalid();
    if (this.#busy.has(venue)) throw new PortfolioError('portfolio-public-busy');
    this.#busy.add(venue);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const requestedAt = now(this.clock);
      return await Promise.race([new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PortfolioError('portfolio-public-timeout')); }, 5_000);
      }), (async () => {
        const response = await this.request(URLS[venue], { method: 'GET', credentials: 'omit', redirect: 'error',
          cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new PortfolioError('portfolio-public-timeout');
        }
        if (!response.ok || response.redirected) {
          void response.body?.cancel().catch(() => {});
          throw new PortfolioError('portfolio-public-unavailable');
        }
        const size = response.headers.get('content-length');
        if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) {
          void response.body?.cancel().catch(() => {});
          throw new PortfolioError('portfolio-public-too-large');
        }
        if (!response.body) return invalid();
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let count = 0;
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new PortfolioError('portfolio-public-timeout');
          if (chunk.done) break;
          count += chunk.value.byteLength;
          if (count > MAX_BYTES) throw new PortfolioError('portfolio-public-too-large');
          chunks.push(chunk.value);
        }
        const payload: unknown = JSON.parse(Buffer.concat(chunks, count).toString('utf8'));
        const receivedAt = now(this.clock);
        if (receivedAt < requestedAt) throw new PortfolioError('portfolio-invalid-clock');
        const prices = this.#project(venue, currencies, payload, receivedAt);
        return { venue, requestedAt, receivedAt, prices };
      })()]);
    } catch (error) {
      if (error instanceof PortfolioError) throw error;
      throw new PortfolioError('portfolio-public-unavailable');
    } finally {
      clearTimeout(timer); controller.abort(); cancel();
      controller.signal.removeEventListener('abort', cancel); this.#busy.delete(venue);
    }
  }
  #project(venue: PairVenue, currencies: readonly string[], payload: unknown, receivedAt: number): Record<string, string> {
    let rows: unknown;
    if (venue === 'okx') {
      const envelope = object(payload);
      if (envelope.code !== '0') return invalid();
      rows = envelope.data;
    } else rows = payload;
    if (!Array.isArray(rows) || rows.length > 30_000) return invalid();
    const wanted = new Map(currencies.filter(currency => currency !== 'USDT')
      .map(currency => [venue === 'mexc' ? `${currency}USDT` : `${currency}-USDT`, currency]));
    const prices: Record<string, string> = Object.create(null), seen = new Set<string>();
    for (const raw of rows) {
      const row = object(raw), symbol = venue === 'mexc' ? row.symbol : row.instId;
      if (typeof symbol !== 'string') return invalid();
      const currency = wanted.get(symbol);
      if (currency === undefined) continue;
      if (seen.has(currency)) { delete prices[currency]; continue; }
      seen.add(currency);
      const value = venue === 'mexc' ? row.price : row.last;
      if (typeof value !== 'string' || !INPUT_DECIMAL.test(value) || parse(value).atoms <= 0n) continue;
      if (venue === 'okx') {
        if (row.instType !== 'SPOT' || typeof row.ts !== 'string' || !/^[1-9]\d{0,15}$/.test(row.ts)) continue;
        const sourceAt = Number(row.ts);
        if (!Number.isSafeInteger(sourceAt) || sourceAt > receivedAt + 1_000 || receivedAt - sourceAt > FRESH_MS) continue;
      }
      prices[currency] = value;
    }
    return prices;
  }
}

type Holding = Omit<DashboardAsset, 'valueUsdt'>;
function holdings(report: PairObservation, venue: PairVenue): Holding[] {
  if (venue === 'mexc') {
    const account = report.accounts.mexc;
    if (account.status !== 'available') return [];
    if (!Array.isArray(account.holdings) || account.holdings.length > MAX_ASSETS) return invalid();
    return account.holdings.map(row => ({ currency: row.currency, total: add(input(row.free), input(row.locked)),
      available: row.available === null ? input(row.free) : minimum(input(row.free), input(row.available)), locked: input(row.locked) }));
  }
  const account = report.accounts.okx;
  if (account.status !== 'available') return [];
  if (!Array.isArray(account.holdings) || !Array.isArray(account.fundingHoldings)) return invalid();
  const trading = new Map(account.holdings.map(row => [row.currency, row]));
  const funding = new Map(account.fundingHoldings.map(row => [row.currency, row]));
  if (trading.size !== account.holdings.length || funding.size !== account.fundingHoldings.length) return invalid();
  const currencies = new Set([...trading.keys(), ...funding.keys()]);
  if (currencies.size > MAX_ASSETS) return invalid();
  return [...currencies].map(currency => {
    const a = trading.get(currency), b = funding.get(currency);
    // Equity already includes the account's cash position; adding cash again
    // would duplicate assets. Signed equity retains liabilities and losses.
    const total = add(a ? input(a.equity) : '0', b ? input(b.balance) : '0');
    const tradingAvailable = !a ? '0' : account.permissions.accountMode !== '1' || a.availableBalance === null ? null
      : minimum(nonnegative(input(a.cashBalance)), nonnegative(input(a.availableBalance)));
    const available = tradingAvailable === null ? null : add(tradingAvailable, b ? input(b.availableBalance) : '0');
    const locked = a?.frozenBalance === null ? null : add(a ? input(a.frozenBalance!) : '0', b ? input(b.frozenBalance) : '0');
    return { currency, total, available, locked };
  });
}
function emptyExchange(venue: PairVenue, status: 'error' | 'stale', observedAt: number | null): DashboardExchange {
  return { venue, status, observedAt, portfolioUsdt: null, pricedUsdt: null, usdtBalance: null,
    availableUsdt: null, valuationComplete: false, unpricedAssets: [], assets: [] };
}
async function safePrices(client: ValuationClient, venue: PairVenue, currencies: string[]): Promise<ValuationPrices | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => client.getPrices(venue, currencies)),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 6_000); })]);
  } catch { return null; } finally { clearTimeout(timer); }
}
function selectedPrices(snapshot: ValuationPrices | null, venue: PairVenue, at: number): Record<string, string> {
  if (!snapshot || snapshot.venue !== venue || !Number.isSafeInteger(snapshot.requestedAt)
    || snapshot.requestedAt <= 0 || !Number.isSafeInteger(snapshot.receivedAt)
    || snapshot.receivedAt < snapshot.requestedAt || snapshot.receivedAt > at || at - snapshot.requestedAt > FRESH_MS) return {};
  return snapshot.prices;
}

/** A private UI projection of the existing authenticated account snapshots.
 * USDT is the denomination (1 USDT), never a USD peg. All other currencies
 * require that venue's exact asset/USDT last price; no cross-venue fallback.
 * This valuation excludes Earn, derivatives outside returned equity and costs
 * of liquidation/rebalancing. Available includes funding, not execution power.
 */
export async function buildAccountDashboard(report: PairObservation, valuationClient: ValuationClient,
  clock = Date.now): Promise<AccountDashboard> {
  const startedAt = now(clock);
  const venues = ['mexc', 'okx'] as const;
  const rows = venues.map(venue => {
    try {
      const result = holdings(report, venue);
      if (new Set(result.map(row => row.currency)).size !== result.length
        || result.some(row => !CURRENCY.test(row.currency))) return null;
      return result.sort((a, b) => a.currency.localeCompare(b.currency));
    } catch { return null; }
  });
  const prices = await Promise.all(venues.map((venue, i) => safePrices(valuationClient, venue, rows[i]?.map(row => row.currency) ?? [])));
  const observedAt = now(clock);
  if (observedAt < startedAt) throw new PortfolioError('portfolio-invalid-clock');
  const exchanges: DashboardExchange[] = venues.map((venue, i) => {
    const account = report.accounts[venue], balances = rows[i];
    if (account.status !== 'available' || balances === null) return emptyExchange(venue, 'error', null);
    if (!Number.isSafeInteger(account.requestedAt) || !Number.isSafeInteger(account.receivedAt)
      || account.requestedAt <= 0 || account.receivedAt < account.requestedAt || account.receivedAt > observedAt) {
      return emptyExchange(venue, 'error', null);
    }
    if (observedAt - account.requestedAt > FRESH_MS) return emptyExchange(venue, 'stale', account.requestedAt);
    const quotes = selectedPrices(prices[i], venue, observedAt);
    const assets = balances.map(row => {
      const price = row.currency === 'USDT' ? '1' : quotes[row.currency];
      let valueUsdt: string | null = null;
      // Even offsetting nonzero wallet holdings retain explicit price coverage.
      if (typeof price === 'string' && INPUT_DECIMAL.test(price) && parse(price).atoms > 0n) valueUsdt = multiply(row.total, price);
      return { ...row, valueUsdt };
    });
    const unpricedAssets = assets.filter(row => row.valueUsdt === null).map(row => row.currency);
    const pricedUsdt = sum(assets.flatMap(row => row.valueUsdt === null ? [] : [row.valueUsdt]));
    const usdt = assets.find(row => row.currency === 'USDT');
    return { venue, status: 'connected' as const, observedAt: account.requestedAt,
      portfolioUsdt: unpricedAssets.length === 0 ? pricedUsdt : null, pricedUsdt,
      usdtBalance: usdt?.total ?? '0', availableUsdt: usdt ? usdt.available : '0',
      valuationComplete: unpricedAssets.length === 0, unpricedAssets, assets };
  });
  const connected = exchanges.every(exchange => exchange.status === 'connected');
  const valuationComplete = connected && exchanges.every(exchange => exchange.valuationComplete);
  const combined = (field: 'pricedUsdt' | 'usdtBalance' | 'availableUsdt') => connected
    && exchanges.every(exchange => exchange[field] !== null) ? sum(exchanges.map(exchange => exchange[field]!)) : null;
  const pricedUsdt = combined('pricedUsdt');
  return accountDashboardSchema.parse({ schema: 1, observedAt,
    status: connected ? valuationComplete ? 'ready' : 'partial'
      : exchanges.some(exchange => exchange.status === 'connected') ? 'partial'
        : exchanges.some(exchange => exchange.status === 'stale') ? 'stale' : 'unavailable',
    totals: { portfolioUsdt: valuationComplete ? pricedUsdt : null, pricedUsdt,
      usdtBalance: combined('usdtBalance'), availableUsdt: combined('availableUsdt'), valuationComplete },
    exchanges, operations: { status: 'not-connected', items: [], coverageLabel: 'История бирж ещё не подключена' },
    liveExecutionEnabled: false });
}
