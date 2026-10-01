import { compareVenues, LabError, type FillAssumptions, type OrderBook, type PublicVenue } from './order-book.js';
import { LAB_SYMBOLS } from './public-books.js';
import { PUBLIC_VENUES } from './extended-public-books.js';

const publicReasons = new Set([
  'unsupported-market', 'public-venue-busy', 'rate-limit-cooldown', 'invalid-public-clock',
  'public-request-timeout', 'public-response-too-large', 'invalid-public-response', 'public-request-failed',
  'invalid-public-book', 'invalid-hitbtc-symbol', 'public-book-identity-mismatch',
  'stale-or-invalid-receipt-time', 'stale-or-invalid-source-time', 'invalid-depth', 'invalid-level',
  'unsorted-or-duplicate-level', 'crossed-or-locked-book', 'incompatible-books', 'unsynchronised-books',
  'invalid-order', 'invalid-cost', 'insufficient-depth', 'invalid-fill-arithmetic'
]);
function safeReason(error: unknown, fallback: string): string {
  return error instanceof LabError && (publicReasons.has(error.message) || /^public-http-[1-5]\d{2}$/.test(error.message))
    ? error.message : fallback;
}

type BookReader = { getBook(venue: PublicVenue, symbol: string): Promise<OrderBook<PublicVenue>> };
export async function comparePublicVenues(client: BookReader, symbol: string, quantity: number,
  costs: Record<PublicVenue, FillAssumptions>, clock = Date.now) {
  if (!LAB_SYMBOLS.some(s => s === symbol) || !Number.isFinite(quantity) || quantity <= 0) {
    throw new LabError('unsupported-market-or-quantity');
  }
  for (const venue of PUBLIC_VENUES) {
    const cost = costs[venue];
    if (!cost || [cost.feeBps, cost.slippageBps].some(v => !Number.isFinite(v) || v < 0 || v >= 10_000)) {
      throw new LabError('invalid-cost');
    }
  }
  const results = await Promise.allSettled(PUBLIC_VENUES.map(async venue => {
    const book = await client.getBook(venue, symbol);
    if (book.venue !== venue || book.symbol !== symbol) throw new LabError('public-book-identity-mismatch');
    return book;
  }));
  const checkedAt = clock();
  if (!Number.isSafeInteger(checkedAt) || checkedAt <= 0 || !Number.isFinite(new Date(checkedAt).getTime())) {
    throw new LabError('invalid-public-clock');
  }
  const sources = results.map((result, i) => result.status === 'fulfilled'
    ? { venue: PUBLIC_VENUES[i], available: true, sourceTimestampPresent: result.value.sourceAt !== undefined,
      requestedAt: result.value.requestedAt, receivedAt: result.value.receivedAt,
      requestMs: result.value.receivedAt - result.value.requestedAt }
    : { venue: PUBLIC_VENUES[i], available: false,
      reason: safeReason(result.reason, 'public-request-failed') });
  const comparisons: Array<ReturnType<typeof compareVenues<PublicVenue>> |
    { buyVenue: PublicVenue; sellVenue: PublicVenue; rejected: string }> = [];
  for (const buy of results) for (const sell of results) {
    if (buy.status !== 'fulfilled' || sell.status !== 'fulfilled' || buy === sell) continue;
    try { comparisons.push(compareVenues(buy.value, sell.value, quantity, costs, checkedAt)); }
    catch (error) { comparisons.push({ buyVenue: buy.value.venue, sellVenue: sell.value.venue,
      rejected: safeReason(error, 'comparison-failed') }); }
  }
  return { model: 'depth-v2', mode: 'observation-only', checkedAt: new Date(checkedAt).toISOString(),
    symbol, quantity, assumptions: costs, sources, comparisons,
    limitations: ['Indicative REST snapshots, not executable arbitrage', 'Fees are assumptions, not verified account tariffs',
      'Pre-funded venues assumed; transfer/rebalancing costs excluded', 'Lot sizes/minimum notionals not checked',
      'Binance and MEXC snapshots have no source timestamp; freshness there is receipt-only',
      'Number-based estimates, not an exact monetary ledger', 'Separate from legacy three-venue archives and runtime'] };
}
