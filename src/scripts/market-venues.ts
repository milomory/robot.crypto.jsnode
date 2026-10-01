import { ExtendedPublicBookClient, PUBLIC_VENUES } from '../lab/extended-public-books.js';
import { comparePublicVenues } from '../lab/extended-comparison.js';
import { LabError, type FillAssumptions, type PublicVenue } from '../lab/order-book.js';
import { LAB_SYMBOLS } from '../lab/public-books.js';

// One-shot public reads only. No production config, accounts, secrets, DB or order modules.
const [symbol = 'BTC/USDT', rawQuantity = '0.0001', rawFee = '10', rawSlippage = '5', ...extra] = process.argv.slice(2);
const quantity = Number(rawQuantity), feeBps = Number(rawFee), slippageBps = Number(rawSlippage);
if (extra.length || !LAB_SYMBOLS.some(s => s === symbol) || !Number.isFinite(quantity) || quantity <= 0 ||
    [feeBps, slippageBps].some(v => !Number.isFinite(v) || v < 0 || v >= 10_000)) {
  console.error('Usage: npm run lab:venues -- BTC/USDT baseQuantity feeBps slippageBps');
  process.exitCode = 1;
} else {
  try {
    const costs = Object.fromEntries(PUBLIC_VENUES.map(venue => [venue, { feeBps, slippageBps }])) as Record<PublicVenue, FillAssumptions>;
    const report = await comparePublicVenues(new ExtendedPublicBookClient(), symbol, quantity, costs);
    console.log(JSON.stringify(report, null, 2));
    if (!report.comparisons.some(value => 'netQuote' in value)) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof LabError ? error.message : 'public-comparison-failed');
    process.exitCode = 1;
  }
}
