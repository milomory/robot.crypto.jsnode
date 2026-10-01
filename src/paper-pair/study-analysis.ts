import { quoteBook } from './engine.js';
import type { PairBook, PairCosts, PairVenue } from './engine.js';
import { validatePairUsdIndex } from './public.js';
import type { PairInstrument, PairUsdIndex } from './public.js';

const SCALE = 10n ** 18n, BPS = 10_000n * SCALE, BASE_QUANTUM = 10n ** 10n;
function amount(value: string): bigint {
  if (!/^(0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(value)) throw new Error('invalid-study-amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}
function text(value: bigint, places = 18): string {
  const scale = 10n ** BigInt(places), n = value < 0n ? -value : value;
  const fraction = (n % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${n / scale}${fraction ? '.' + fraction : ''}`;
}
function ceil(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }
export interface PaymentModes { observedAt: number; mexcMxDeduct: boolean | null; okxFeeType: '0' | '1' | null }
export function selectedFeeScenario(modes?: PaymentModes): 'quote' | 'okx-received-base' | null {
  if (!modes || modes.mexcMxDeduct !== false || modes.okxFeeType === null) return null;
  return modes.okxFeeType === '0' ? 'okx-received-base' : modes.okxFeeType === '1' ? 'quote' : null;
}
/** Separate USD valuation, never an assertion of OKX's undocumented internal admission formula. */
export function assessUsdLimit(index: PairUsdIndex | null, rule: PairInstrument | null, quantityBtc: string, now: number) {
  const base = { basis: 'okx-btc-usd-index-proxy-1pct-buffer', exchangeAdmissionProven: false,
    quantityBtc, bufferBps: '100' } as const;
  if (!rule || rule.venue !== 'okx' || rule.evidence.venue !== 'okx') return { ...base, status: 'unavailable' as const, reason: 'missing-instrument' };
  if (rule.evidence.maxMktAmt === '') return { ...base, status: 'not-published' as const };
  try {
    if (!index || !Number.isSafeInteger(now) || now < rule.receivedAt || now - rule.receivedAt > 3_600_000) throw new Error();
    const checked = validatePairUsdIndex(index);
    if (checked.receivedAt > now || now - checked.requestedAt > 5_000 || now - checked.sourceAt > 5_000) throw new Error();
    const quantity = amount(quantityBtc), cap = amount(rule.evidence.maxMktAmt);
    if (quantity === 0n || cap === 0n) throw new Error();
    // Exact BTC × USD/BTC; neither USD=USDT nor BTC quote cap is inferred.
    const numerator = quantity * amount(checked.usdPerBtc) * 10_100n;
    const denominator = SCALE * 10_000n;
    const within = numerator <= cap * denominator;
    return { ...base, status: within ? 'within-model-cap' as const : 'above-model-cap' as const,
      maximumUsd: rule.evidence.maxMktAmt, bufferedNotionalUsd: text(ceil(numerator, denominator)),
      indexSourceAt: checked.sourceAt };
  } catch { return { ...base, status: 'unavailable' as const, reason: 'missing-stale-or-invalid-index' }; }
}
/** Price sensitivity only. The 8-decimal BTC fee quantum is declared, not inferred as a legal order step. */
export function feeScenarios(input: { buy: PairBook; sell: PairBook; quantity: string;
  costs: Record<PairVenue, PairCosts>; now: number }) {
  const buyCost = input.costs[input.buy.venue], sellCost = input.costs[input.sell.venue];
  const buy = quoteBook(input.buy, 'buy', input.quantity, buyCost, input.now);
  const sell = quoteBook(input.sell, 'sell', input.quantity, sellCost, input.now);
  const quote = { netUsdt: text(amount(sell.cashUsdt) - amount(buy.cashUsdt)),
    requiredBuyQuantityBtc: input.quantity, receivedBtc: input.quantity, residualBtc: '0' };
  if (input.buy.venue !== 'okx') return { quote, okxReceivedBase: { ...quote, buyFeeBtc: '0',
    equalGrossResidualBtc: '0', equalGrossCashDeltaUsdt: quote.netUsdt }, baseFeeDecimals: 8 as const };
  const target = amount(input.quantity), feeRate = amount(buyCost.feeBps);
  if (target <= 0n || target % BASE_QUANTUM !== 0n || feeRate >= BPS) throw new Error('unsupported-study-fee');
  const buyNoQuoteFee: PairCosts = { ...buyCost, feeBps: '0' };
  const sameGross = quoteBook(input.buy, 'buy', input.quantity, buyNoQuoteFee, input.now);
  const sameGrossFee = ceil(target * feeRate, BPS * BASE_QUANTUM) * BASE_QUANTUM;
  // Gross up in the declared model quantum; the result still needs actual instrument admission.
  const gross = ceil((target / BASE_QUANTUM) * BPS, BPS - feeRate) * BASE_QUANTUM;
  const baseFee = ceil(gross * feeRate, BPS * BASE_QUANTUM) * BASE_QUANTUM;
  const received = gross - baseFee;
  if (received < target) throw new Error('fee-gross-up-invariant');
  const coveredBuy = quoteBook(input.buy, 'buy', text(gross), buyNoQuoteFee, input.now);
  return { quote, okxReceivedBase: {
    netUsdt: text(amount(sell.cashUsdt) - amount(coveredBuy.cashUsdt)),
    requiredBuyQuantityBtc: text(gross), receivedBtc: text(received), residualBtc: text(received - target),
    buyFeeBtc: text(baseFee), equalGrossResidualBtc: text(-sameGrossFee),
    equalGrossCashDeltaUsdt: text(amount(sell.cashUsdt) - amount(sameGross.cashUsdt)) }, baseFeeDecimals: 8 as const };
}
export interface SampledDirection { sequence: number; at: number; buyVenue: PairVenue; sellVenue: PairVenue; netUsdt: string }
/** Consecutive sampled signs, not a claim that an opportunity persisted between observations. */
export function sampledPersistence(rows: SampledDirection[], scheduledSamples: number) {
  if (!Number.isSafeInteger(scheduledSamples) || scheduledSamples <= 0) throw new Error('invalid-persistence-sequence');
  for (const row of rows) {
    if (!Number.isSafeInteger(row.sequence) || !Number.isSafeInteger(row.at) || row.at <= 0 ||
        !['mexc','okx'].includes(row.buyVenue) || row.sellVenue !== (row.buyVenue === 'mexc' ? 'okx' : 'mexc')) throw new Error('invalid-persistence-sequence');
    amount(row.netUsdt.startsWith('-') ? row.netUsdt.slice(1) : row.netUsdt);
  }
  return (['mexc', 'okx'] as const).map(buyVenue => {
    const selected = rows.filter(row => row.buyVenue === buyVenue).sort((a, b) => a.sequence - b.sequence);
    let positive = 0, longest = 0, current = 0, previous = -2, firstAt = 0, longestSpanMs = 0, previousAt = 0;
    for (const row of selected) {
      if (row.sequence < 0 || row.sequence >= scheduledSamples || row.sequence <= previous || row.at < previousAt) throw new Error('invalid-persistence-sequence');
      const isPositive = !row.netUsdt.startsWith('-') && amount(row.netUsdt) > 0n;
      if (isPositive) {
        positive++;
        if (row.sequence !== previous + 1 || current === 0) { current = 1; firstAt = row.at; } else current++;
        longest = Math.max(longest, current); longestSpanMs = Math.max(longestSpanMs, row.at - firstAt);
      } else current = 0;
      previous = row.sequence; previousAt = row.at;
    }
    return { buyVenue, sellVenue: buyVenue === 'mexc' ? 'okx' : 'mexc', evaluatedSamples: selected.length,
      scheduledSamples, positiveSamples: positive, longestConsecutivePositiveSamples: longest,
      longestSampledSpanMs: longestSpanMs, continuousWindowProven: false };
  });
}
