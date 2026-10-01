import { AccountError } from './types.js';
import type { MexcAccountReader } from './mexc.js';
import type { OkxAccountReader } from './okx.js';
import { compareVenues, LabError, validateBook, type OrderBook, type PublicVenue } from '../lab/order-book.js';

export type PairVenue = 'mexc' | 'okx';
type BookReader = { getBook(venue: PairVenue, symbol: string): Promise<OrderBook<PublicVenue>> };
type Stage = 'clock' | 'config' | 'balances' | 'funding' | 'fees';
const SYMBOL = 'BTC/USDT', QUANTITY = 0.0001, ADVERSE_BPS = 5, ACCOUNT_MAX_AGE_MS = 120_000;
const CURRENCIES = ['BTC', 'USDT'] as const;
const accountReasons = new Set(['account-invalid-clock', 'account-stale', 'account-invalid-fees',
  'account-invalid-response', 'account-timeout', 'account-unavailable', 'account-auth-failed',
  'account-api-rejected', 'account-access-denied', 'account-clock-skew', 'account-rate-limited',
  'account-busy', 'account-response-too-large']);
const bookReasons = new Set(['public-venue-busy', 'rate-limit-cooldown', 'invalid-public-clock',
  'public-request-timeout', 'public-response-too-large', 'invalid-public-response', 'public-request-failed',
  'public-book-identity-mismatch', 'stale-or-invalid-receipt-time', 'stale-or-invalid-source-time',
  'invalid-depth', 'invalid-level', 'unsorted-or-duplicate-level', 'crossed-or-locked-book',
  'incompatible-books', 'unsynchronised-books', 'invalid-order', 'invalid-cost', 'insufficient-depth',
  'invalid-fill-arithmetic']);
function accountReason(error: unknown): string {
  return error instanceof AccountError && accountReasons.has(error.code) ? error.code : 'account-unavailable';
}
function bookReason(error: unknown): string {
  return error instanceof LabError && bookReasons.has(error.message) ? error.message : 'public-request-failed';
}
function time(clock: () => number): number {
  let value: number;
  try { value = clock(); } catch { throw new AccountError('account-invalid-clock'); }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) {
    throw new AccountError('account-invalid-clock');
  }
  return value;
}
function fresh(requestedAt: number, receivedAt: number, checkedAt: number): void {
  if (receivedAt < requestedAt || checkedAt < receivedAt) throw new AccountError('account-invalid-clock');
  if (checkedAt - requestedAt > ACCOUNT_MAX_AGE_MS) throw new AccountError('account-stale');
}
// Readers already bound each network request to five seconds. This extra bound
// also makes substituted readers fail closed without retaining an older result.
async function bounded<T>(read: () => Promise<T>, publicRead = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(publicRead ? new LabError('public-request-timeout')
        : new AccountError('account-timeout')), 6_000);
    })]);
  } finally { clearTimeout(timer); }
}
function selected<T extends { currency: string }, U>(rows: T[], project: (row: T) => U) {
  return Object.fromEntries(CURRENCIES.map(currency => {
    const row = rows.find(item => item.currency === currency);
    return [currency, row ? project(row) : null];
  })) as Record<typeof CURRENCIES[number], U | null>;
}
function nonzero(...values: Array<string | null>): boolean {
  return values.some(value => value !== null && /[1-9]/.test(value));
}
function boundedHoldings<T extends { currency: string }>(rows: T[]): T[] {
  if (rows.length > 200) throw new AccountError('account-invalid-response');
  return rows;
}
function feeCost(rate: string, convention: 'positive-fee' | 'negative-fee-positive-rebate'): number {
  const parsed = Number(rate);
  if (!Number.isFinite(parsed) || Math.abs(parsed) >= 1 || (convention === 'positive-fee' && parsed < 0)) {
    throw new AccountError('account-invalid-fees');
  }
  return convention === 'positive-fee' ? parsed : Math.max(0, -parsed);
}
type FailedAccount = { status: 'unavailable'; feeReadVerified: false; stage: Stage; reason: string };
const failure = (stage: Stage, error: unknown): FailedAccount => ({
  status: 'unavailable', feeReadVerified: false, stage, reason: accountReason(error)
});
async function readMexc(client: MexcAccountReader, clock: () => number) {
  let stage: Stage = 'clock';
  try {
    const requestedAt = time(clock);
    stage = 'balances';
    const account = await bounded(() => client.getBalances());
    const holdings = boundedHoldings(account.balances.filter(row => nonzero(row.free, row.locked, row.available))
      .map(row => ({ currency: row.currency, free: row.free, locked: row.locked, available: row.available })));
    stage = 'fees';
    const fees = await bounded(() => client.getSpotFees(SYMBOL));
    const takerCostRate = feeCost(fees.takerRate, 'positive-fee');
    let mxDeductEnabled: boolean | null = null;
    let feePaymentReason: string | null = null;
    try { mxDeductEnabled = (await bounded(() => client.getMxDeductStatus())).enabled; }
    catch (error) { feePaymentReason = accountReason(error); }
    stage = 'clock';
    const receivedAt = time(clock);
    fresh(requestedAt, receivedAt, receivedAt);
    return { status: 'available' as const, feeReadVerified: true as const, requestedAt, receivedAt,
      account: 'spot' as const, holdings,
      feePayment: { mxDeductEnabled, readVerified: mxDeductEnabled !== null, reason: feePaymentReason },
      balances: selected(account.balances, row => ({ free: row.free, locked: row.locked, available: row.available })),
      accountCapabilities: { canTrade: account.accountCapabilities.canTrade,
        canWithdraw: account.accountCapabilities.canWithdraw, canDeposit: account.accountCapabilities.canDeposit },
      fees: { makerRate: fees.makerRate, takerRate: fees.takerRate, takerCostRate,
        ratePrecision: fees.ratePrecision, rateConvention: 'positive-fee' as const } };
  } catch (error) { return failure(stage, error); }
}
async function readOkx(client: OkxAccountReader, clock: () => number) {
  let stage: Stage = 'clock';
  try {
    const requestedAt = time(clock);
    stage = 'config';
    const permissions = await bounded(() => client.getKeyPermissions());
    stage = 'balances';
    const trading = await bounded(() => client.getBalances());
    stage = 'funding';
    const funding = await bounded(() => client.getFundingBalances());
    const holdings = boundedHoldings(trading.balances
      .filter(row => nonzero(row.cashBalance, row.equity, row.availableBalance, row.frozenBalance))
      .map(row => ({ currency: row.currency, cashBalance: row.cashBalance, equity: row.equity,
        availableBalance: row.availableBalance, frozenBalance: row.frozenBalance })));
    const fundingHoldings = boundedHoldings(funding.balances
      .filter(row => nonzero(row.balance, row.availableBalance, row.frozenBalance))
      .map(row => ({ currency: row.currency, balance: row.balance,
        availableBalance: row.availableBalance, frozenBalance: row.frozenBalance })));
    if (new Set([...holdings, ...fundingHoldings].map(row => row.currency)).size > 200) {
      throw new AccountError('account-invalid-response');
    }
    stage = 'fees';
    const fees = await bounded(() => client.getSpotFees(SYMBOL));
    const takerCostRate = feeCost(fees.takerRate, 'negative-fee-positive-rebate');
    stage = 'clock';
    const receivedAt = time(clock);
    fresh(requestedAt, receivedAt, receivedAt);
    return { status: 'available' as const, feeReadVerified: true as const, requestedAt, receivedAt,
      account: 'trading' as const, holdings, fundingHoldings,
      permissions: { read: permissions.read, trade: permissions.trade, withdraw: permissions.withdraw,
        unknownPermissionsPresent: permissions.unknownPermissionsPresent, accountMode: permissions.accountMode,
        feeType: permissions.feeType ?? null },
      balances: selected(trading.balances, row => ({ cashBalance: row.cashBalance,
        availableBalance: row.availableBalance, frozenBalance: row.frozenBalance })),
      funding: selected(funding.balances, row => ({ balance: row.balance,
        availableBalance: row.availableBalance, frozenBalance: row.frozenBalance })),
      fees: { makerRate: fees.makerRate, takerRate: fees.takerRate, takerCostRate,
        ratePrecision: 'decimal-string' as const, rateConvention: fees.rateConvention } };
  } catch (error) { return failure(stage, error); }
}
type MexcResult = Awaited<ReturnType<typeof readMexc>>;
type OkxResult = Awaited<ReturnType<typeof readOkx>>;
type Accounts = { mexc: MexcResult; okx: OkxResult };
type BookResult = { status: 'available'; book: OrderBook<PublicVenue> }
  | { status: 'unavailable'; reason: string };
async function readBook(client: BookReader, venue: PairVenue): Promise<BookResult> {
  try {
    const book = await bounded(() => client.getBook(venue, SYMBOL), true);
    if (book.venue !== venue || book.symbol !== SYMBOL) throw new LabError('public-book-identity-mismatch');
    return { status: 'available', book };
  } catch (error) { return { status: 'unavailable', reason: bookReason(error) }; }
}
function invalidateStale<T extends MexcResult | OkxResult>(account: T, now: number): T | FailedAccount {
  if (account.status === 'available') {
    try { fresh(account.requestedAt, account.receivedAt, now); }
    catch (error) { return failure('clock', error); }
  }
  return account;
}
function validateSnapshot(snapshot: BookResult, now: number): BookResult {
  if (snapshot.status === 'available') {
    try { validateBook(snapshot.book, now); }
    catch (error) { return { status: 'unavailable', reason: bookReason(error) }; }
  }
  return snapshot;
}
function bookMetadata(snapshot: BookResult) {
  return snapshot.status === 'unavailable' ? snapshot : { status: 'available' as const,
    requestedAt: snapshot.book.requestedAt, receivedAt: snapshot.book.receivedAt,
    sourceTimestampPresent: snapshot.book.sourceAt !== undefined };
}
// This is only a Number estimate, never inventory authorization. Available
// equity may include borrowing, and funding cannot fund a spot order directly.
function available(accounts: Accounts, venue: PairVenue, currency: 'BTC' | 'USDT'): number | null {
  if (venue === 'mexc') {
    const account = accounts.mexc;
    if (account.status !== 'available') return null;
    const row = account.balances[currency];
    if (!row) return 0;
    const value = Math.min(Number(row.free), row.available === null ? Infinity : Number(row.available));
    return Number.isFinite(value) ? Math.max(0, value) : null;
  }
  const account = accounts.okx;
  if (account.status !== 'available' || account.permissions.accountMode !== '1') return null;
  const row = account.balances[currency];
  if (!row) return 0;
  if (row.availableBalance === null) return null;
  const value = Math.min(Number(row.cashBalance), Number(row.availableBalance));
  return Number.isFinite(value) ? Math.max(0, value) : null;
}
type Estimate = ReturnType<typeof compareVenues<PairVenue>>;
type Inventory = { status: 'sufficient-estimate' | 'insufficient' | 'unknown';
  reason: 'inventory-estimate-only' | 'insufficient-selected-balance' | 'unsupported-okx-account-mode' | 'ambiguous-available-balance';
  buyQuoteAvailableEstimate: number | null; sellBaseAvailableEstimate: number | null;
  executableInventoryProven: false };
function inventory(accounts: Accounts, buy: PairVenue, sell: PairVenue, estimate: Estimate): Inventory {
  const quote = available(accounts, buy, 'USDT'), base = available(accounts, sell, 'BTC');
  const unsupported = accounts.okx.status === 'available' && accounts.okx.permissions.accountMode !== '1';
  return { status: quote === null || base === null ? 'unknown'
    : quote >= estimate.purchase.cashQuote && base >= QUANTITY ? 'sufficient-estimate' : 'insufficient',
    reason: unsupported ? 'unsupported-okx-account-mode'
      : quote === null || base === null ? 'ambiguous-available-balance'
      : quote >= estimate.purchase.cashQuote && base >= QUANTITY ? 'inventory-estimate-only' : 'insufficient-selected-balance',
    buyQuoteAvailableEstimate: quote, sellBaseAvailableEstimate: base, executableInventoryProven: false };
}
type Comparison = { buyVenue: PairVenue; sellVenue: PairVenue; status: 'blocked'; reason: string }
  | { buyVenue: PairVenue; sellVenue: PairVenue; status: 'observed'; estimate: Estimate; inventory: Inventory };
const limitations = [
  'Number-based indicative estimates; balance strings remain exact only in this private report',
  'Fee currency is unknown; quote-currency fees assumed, inventory is never proven executable',
  'OKX rebates receive no credit; only mode 1 cash and available balances support an inventory estimate',
  'Funding, available equity and borrowing are excluded from the inventory estimate',
  'MEXC numeric JSON fee precision is disclosed, not reconstructed',
  'OKX API fee rates can exclude zero-fee promotions; observed tariffs remain estimates',
  'REST snapshots are not atomic; MEXC source time is unavailable',
  'Account freshness uses request start, not exchange update time; maximum age is 120 seconds',
  'Lot sizes, minimum notionals, transfer networks and rebalancing costs are not validated',
  'No order, transfer, withdrawal, paper trade or production runtime is executed'
];

/** Private observation report: never publish account data in a shared journal.
 * Each call is independent. A failed/expired snapshot replaces, never reuses,
 * an earlier successful observation. No credentials are returned or persisted.
 */
export async function observeAccountPair(mexc: MexcAccountReader, okx: OkxAccountReader,
  books: BookReader, clock = Date.now) {
  let checkedAt: number | null = null;
  try { checkedAt = time(clock); } catch { /* Fixed failure report; no network on invalid initial clock. */ }
  const noClock = failure('clock', new AccountError('account-invalid-clock'));
  let accounts: Accounts = { mexc: noClock, okx: noClock };
  let snapshots: Record<PairVenue, BookResult> = {
    mexc: { status: 'unavailable', reason: 'invalid-public-clock' },
    okx: { status: 'unavailable', reason: 'invalid-public-clock' }
  };
  if (checkedAt !== null) {
    const [mexcAccount, okxAccount] = await Promise.all([readMexc(mexc, clock), readOkx(okx, clock)]);
    accounts = { mexc: mexcAccount, okx: okxAccount };
    const [mexcBook, okxBook] = await Promise.all([readBook(books, 'mexc'), readBook(books, 'okx')]);
    try {
      const finishedAt = time(clock);
      if (finishedAt < checkedAt) throw new AccountError('account-invalid-clock');
      checkedAt = finishedAt;
      accounts = { mexc: invalidateStale(accounts.mexc, checkedAt), okx: invalidateStale(accounts.okx, checkedAt) };
      snapshots = { mexc: validateSnapshot(mexcBook, checkedAt), okx: validateSnapshot(okxBook, checkedAt) };
    } catch {
      checkedAt = null;
      accounts = { mexc: noClock, okx: noClock };
    }
  }
  const comparisons: Comparison[] = [];
  for (const [buyVenue, sellVenue] of [['mexc', 'okx'], ['okx', 'mexc']] as const) {
    const buy = snapshots[buyVenue], sell = snapshots[sellVenue];
    if (checkedAt === null || accounts.mexc.status !== 'available' || accounts.okx.status !== 'available'
      || buy.status !== 'available' || sell.status !== 'available') {
      comparisons.push({ buyVenue, sellVenue, status: 'blocked', reason: 'required-snapshot-unavailable' });
      continue;
    }
    try {
      const estimate = compareVenues(buy.book as OrderBook<PairVenue>, sell.book as OrderBook<PairVenue>, QUANTITY,
        { mexc: { feeBps: accounts.mexc.fees.takerCostRate * 10_000, slippageBps: ADVERSE_BPS },
          okx: { feeBps: accounts.okx.fees.takerCostRate * 10_000, slippageBps: ADVERSE_BPS } }, checkedAt);
      if (![estimate.netQuote, estimate.netBps, ...Object.values(estimate.purchase).filter(v => typeof v === 'number'),
        ...Object.values(estimate.sale).filter(v => typeof v === 'number')].every(Number.isFinite)) {
        throw new LabError('invalid-fill-arithmetic');
      }
      comparisons.push({ buyVenue, sellVenue, status: 'observed', estimate,
        inventory: inventory(accounts, buyVenue, sellVenue, estimate) });
    } catch (error) { comparisons.push({ buyVenue, sellVenue, status: 'blocked', reason: bookReason(error) }); }
  }
  return { schema: 1 as const, mode: 'observation-only' as const, executable: false as const,
    symbol: SYMBOL, quantity: QUANTITY, adverseBps: ADVERSE_BPS, checkedAt,
    status: comparisons.every(item => item.status === 'observed') ? 'observed' as const : 'blocked' as const,
    accounts, books: { mexc: bookMetadata(snapshots.mexc), okx: bookMetadata(snapshots.okx) }, comparisons,
    limitations: [...limitations] };
}
export type PairObservation = Awaited<ReturnType<typeof observeAccountPair>>;
