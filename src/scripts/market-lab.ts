import { compareVenues, LabError, type FillAssumptions, type Venue } from '../lab/order-book.js';
import { LAB_SYMBOLS, PublicBookClient, VENUES } from '../lab/public-books.js';

// No dotenv, production config, journal, authentication or order client imports.
const [symbol = 'BTC/USDT', rawQuantity = '0.0001', rawFee = '10', rawSlippage = '5', ...extra] = process.argv.slice(2);
const quantity = Number(rawQuantity), feeBps = Number(rawFee), slippageBps = Number(rawSlippage);
if (extra.length || !LAB_SYMBOLS.some(value => value === symbol) || !Number.isFinite(quantity) || quantity <= 0 ||
    [feeBps, slippageBps].some(value => !Number.isFinite(value) || value < 0 || value >= 10_000)) {
  console.error('Usage: npm run lab:markets -- BTC/USDT baseQuantity feeBps slippageBps');
  process.exitCode = 1;
} else {
  const client = new PublicBookClient();
  const results = await Promise.allSettled(VENUES.map(venue => client.getBook(venue, symbol)));
  const checkedAt = Date.now();
  const costs = Object.fromEntries(VENUES.map(venue => [venue, { feeBps, slippageBps }])) as Record<Venue, FillAssumptions>;
  const sources = results.map((result, i) => result.status === 'fulfilled'
    ? { venue: VENUES[i], available: true, sourceTimestampPresent: result.value.sourceAt !== undefined,
      requestMs: result.value.receivedAt - result.value.requestedAt }
    : { venue: VENUES[i], available: false, reason: result.reason instanceof LabError ? result.reason.message : 'unavailable' });
  const comparisons: unknown[] = [];
  for (const buy of results) for (const sell of results) {
    if (buy.status !== 'fulfilled' || sell.status !== 'fulfilled' || buy === sell) continue;
    try { comparisons.push(compareVenues(buy.value, sell.value, quantity, costs, checkedAt)); }
    catch (error) { comparisons.push({ buyVenue: buy.value.venue, sellVenue: sell.value.venue,
      rejected: error instanceof LabError ? error.message : 'comparison-failed' }); }
  }
  console.log(JSON.stringify({ model: 'depth-v2', mode: 'observation-only', checkedAt: new Date(checkedAt).toISOString(),
    symbol, quantity, assumptions: costs, sources, comparisons,
    limitations: ['Indicative REST snapshots, not executable arbitrage', 'Fees are assumptions, not account tariffs',
      'Pre-funded venues assumed; transfer/rebalancing costs excluded', 'Lot sizes/minimum notionals not checked',
      'Binance snapshot has no source timestamp; freshness there is receipt-only'] }, null, 2));
  if (!comparisons.some(value => typeof value === 'object' && value !== null && 'netQuote' in value)) process.exitCode = 2;
}
