/** MEXC public D0 only: linear USDT specifications and an unsettled funding estimate. */
import { decimal, multiply, numberText, record, timestamp, units } from './exact-json.js';
import { assertReceipt, freeze, market, reject, type FundingEstimate, type InstrumentSpec, type PublicReceipt, type ResearchBase } from './model.js';

function envelope(raw: unknown): Record<string, unknown> {
  const root = record(raw);
  if (root.success !== true || numberText(root.code) !== '0') return reject('invalid-public-response');
  return record(root.data);
}
function integer(value: unknown): string {
  const text = numberText(value);
  if (!/^(?:0|[1-9]\d{0,2})$/.test(text)) return reject('invalid-public-number');
  return text;
}
function optionalMaximum(value: unknown, minimum: string): string | null {
  if (value === undefined) return null;
  const maximum = decimal(value, false, true);
  if (units(maximum) < units(minimum)) return reject('invalid-public-contract');
  return maximum;
}

export function parseMexcInstrument(raw: unknown, base: ResearchBase, receipt: PublicReceipt): InstrumentSpec {
  assertReceipt(receipt, 'mexc', base, 'instrument');
  const m = market('mexc', base), row = envelope(raw);
  if (row.symbol !== m.instrumentId || row.baseCoin !== base || row.quoteCoin !== 'USDT' || row.settleCoin !== 'USDT' ||
      integer(row.futureType) !== '1' || integer(row.type) !== '1') return reject('unsupported-public-contract');
  const state = integer(row.state), delivery = integer(row.automaticDelivery);
  if (!['0', '1', '2', '3', '4'].includes(state) || !['0', '1'].includes(delivery) ||
      typeof row.apiAllowed !== 'boolean' || typeof row.preMarket !== 'boolean') return reject('invalid-public-contract');
  const basePerContract = decimal(row.contractSize, false, true);
  const quantityStepContracts = decimal(row.volUnit, false, true);
  const minimumContracts = decimal(row.minVol, false, true);
  const priceTick = decimal(row.priceUnit, false, true);
  if (units(minimumContracts) % units(quantityStepContracts) !== 0n) return reject('invalid-public-contract');
  const upcomingChange = delivery !== '0' || row.preMarket;
  return freeze({
    schema: 1, kind: 'public-linear-contract', market: m, receipt: { ...receipt }, sourceUpdatedAt: null,
    quantityUnit: 'contracts', basePerContract, contractMultiplier: '1', quantityStepContracts, minimumContracts, priceTick,
    baseQuantityStep: multiply(basePerContract, quantityStepContracts), baseMinimumQuantity: multiply(basePerContract, minimumContracts),
    maximumContractsReported: optionalMaximum(row.maxVol, minimumContracts),
    limitMaximumContractsReported: optionalMaximum(row.limitMaxVol, minimumContracts),
    publicState: state, exchangeApiAllowed: row.apiAllowed,
    publicListingUsable: state === '0' && row.apiAllowed && !upcomingChange,
    upcomingChange, feeGroupId: null, accountEligibilityVerified: false, personalFeesVerified: false, executable: false,
  });
}

export function parseMexcFunding(raw: unknown, base: ResearchBase, receipt: PublicReceipt): FundingEstimate {
  assertReceipt(receipt, 'mexc', base, 'funding');
  const m = market('mexc', base), row = envelope(raw);
  if (row.symbol !== m.instrumentId) return reject('unsupported-public-contract');
  const rate = decimal(row.fundingRate, true);
  const cycle = Number(integer(row.collectCycle));
  // D0 accepts a bounded 1..24-hour reported cycle, never a default or a fixed eight hours.
  if (cycle < 1 || cycle > 24) return reject('unsupported-funding-cycle');
  const intervalMs = cycle * 3_600_000;
  const upcomingSettlementAt = timestamp(row.nextSettleTime);
  const sourceUpdatedAt = row.timestamp === undefined ? null : timestamp(row.timestamp);
  if (upcomingSettlementAt <= receipt.receivedAt || upcomingSettlementAt - receipt.receivedAt > intervalMs + 5000 ||
      sourceUpdatedAt !== null && (sourceUpdatedAt > receipt.receivedAt + 5000 || receipt.receivedAt - sourceUpdatedAt > 60_000 ||
        upcomingSettlementAt <= sourceUpdatedAt)) {
    return reject('invalid-public-timing');
  }
  // Source bounds constrain a reported estimate; they are neither fees nor realized funding.
  if (row.minFundingRate !== undefined || row.maxFundingRate !== undefined) {
    const lower = units(decimal(row.minFundingRate, true)), upper = units(decimal(row.maxFundingRate, true));
    if (lower > upper || units(rate) < lower || units(rate) > upper) return reject('invalid-public-funding');
  }
  return freeze({
    schema: 1, kind: 'public-funding-estimate', market: m, receipt: { ...receipt }, sourceUpdatedAt, rate,
    rateMeaning: 'estimate-not-settled', upcomingSettlementAt, followingSettlementAt: null, intervalMs,
    intervalBasis: 'reported-cycle', realizedAccountIncome: null, executable: false,
  });
}
