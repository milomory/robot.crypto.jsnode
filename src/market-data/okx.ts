/** OKX public linear contracts and funding forecasts. No account or execution access. */
import { decimal, multiply, record, timestamp, units } from './exact-json.js';
import { assertReceipt, freeze, market, reject } from './model.js';
import type { FundingEstimate, InstrumentSpec, PublicReceipt, ResearchBase } from './model.js';

function item(raw: unknown, base: ResearchBase): Record<string, unknown> {
  const expected = market('okx', base), envelope = record(raw);
  if (envelope.code !== '0' || !Array.isArray(envelope.data) || envelope.data.length !== 1) return reject('invalid-okx-envelope');
  const row = record(envelope.data[0]);
  if (row.instId !== expected.instrumentId || row.instType !== 'SWAP') return reject('unexpected-okx-instrument');
  return row;
}
function optionalMaximum(value: unknown, minimum: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const amount = decimal(value, false, true);
  if (units(amount) < units(minimum)) return reject('invalid-okx-limits');
  return amount;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) return reject('invalid-okx-label');
  return value;
}

export function parseOkxInstrument(raw: unknown, base: ResearchBase, receipt: PublicReceipt): InstrumentSpec {
  assertReceipt(receipt, 'okx', base, 'instrument');
  const row = item(raw, base), family = `${base}-USDT`;
  if (row.instFamily !== family || row.uly !== family || row.ctType !== 'linear' || row.ctValCcy !== base ||
      row.settleCcy !== 'USDT' || row.baseCcy !== '' || row.quoteCcy !== '' || decimal(row.ctMult, false, true) !== '1') {
    return reject('unsupported-okx-contract');
  }
  // ctMult is deliberately restricted to one: do not generalize conflicting notional examples.
  const basePerContract = decimal(row.ctVal, false, true), quantityStepContracts = decimal(row.lotSz, false, true),
    minimumContracts = decimal(row.minSz, false, true), priceTick = decimal(row.tickSz, false, true);
  if (units(minimumContracts) % units(quantityStepContracts) !== 0n) return reject('invalid-okx-limits');
  const maximumContractsReported = optionalMaximum(row.maxMktSz, minimumContracts),
    limitMaximumContractsReported = optionalMaximum(row.maxLmtSz, minimumContracts);
  const publicState = label(row.state), listedAt = timestamp(row.listTime);
  if (typeof row.expTime !== 'string') return reject('invalid-okx-listing');
  const expiresAt = row.expTime === '' ? null : timestamp(row.expTime);
  if (!Array.isArray(row.upcChg) || row.upcChg.length > 20) return reject('invalid-okx-listing');
  for (const entry of row.upcChg) {
    const change = record(entry); label(change.param); timestamp(change.effTime);
    if (typeof change.newValue !== 'string' || change.newValue.length === 0 || change.newValue.length > 128) return reject('invalid-okx-listing');
  }
  if (!Array.isArray(row.tradeQuoteCcyList) || row.tradeQuoteCcyList.length !== 0) return reject('unsupported-okx-contract');
  const upcomingChange = expiresAt !== null || row.upcChg.length !== 0;
  return freeze({ schema: 1, kind: 'public-linear-contract', market: market('okx', base), receipt: { ...receipt },
    sourceUpdatedAt: null, quantityUnit: 'contracts', basePerContract, contractMultiplier: '1',
    quantityStepContracts, minimumContracts, priceTick,
    baseQuantityStep: multiply(basePerContract, quantityStepContracts), baseMinimumQuantity: multiply(basePerContract, minimumContracts),
    maximumContractsReported, limitMaximumContractsReported, publicState, exchangeApiAllowed: null,
    publicListingUsable: publicState === 'live' && listedAt <= receipt.requestedAt && !upcomingChange && row.ruleType === 'normal',
    upcomingChange, feeGroupId: row.groupId === undefined || row.groupId === '' ? null : label(row.groupId),
    accountEligibilityVerified: false, personalFeesVerified: false, executable: false });
}

export function parseOkxFunding(raw: unknown, base: ResearchBase, receipt: PublicReceipt): FundingEstimate {
  assertReceipt(receipt, 'okx', base, 'funding');
  const row = item(raw, base);
  if (row.method !== 'current_period') return reject('unsupported-okx-funding-method');
  const sourceUpdatedAt = timestamp(row.ts), upcomingSettlementAt = timestamp(row.fundingTime),
    followingSettlementAt = timestamp(row.nextFundingTime), intervalMs = followingSettlementAt - upcomingSettlementAt;
  // This is a bounded research freshness policy, not a server-clock calibration or a fixed funding cadence.
  // The following interval can already have a new cadence. It is NOT the current rate's
  // duration, so bound the upcoming horizon separately rather than by intervalMs.
  if (sourceUpdatedAt > receipt.receivedAt + 5000 || receipt.receivedAt - sourceUpdatedAt > 60000 ||
      upcomingSettlementAt <= receipt.receivedAt || upcomingSettlementAt <= sourceUpdatedAt ||
      intervalMs <= 0 || intervalMs > 86400000 || upcomingSettlementAt - receipt.receivedAt > 86400000) {
    return reject('invalid-okx-funding-time');
  }
  const rate = decimal(row.fundingRate, true);
  if (units(rate) < -units('1') || units(rate) > units('1')) return reject('invalid-okx-funding-rate');
  // nextFundingRate and settFundingRate concern other cycles; neither is realized account income.
  return freeze({ schema: 1, kind: 'public-funding-estimate', market: market('okx', base), receipt: { ...receipt },
    sourceUpdatedAt, rate, rateMeaning: 'estimate-not-settled', upcomingSettlementAt, followingSettlementAt,
    intervalMs, intervalBasis: 'next-times-difference', realizedAccountIncome: null, executable: false });
}
