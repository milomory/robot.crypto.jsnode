import { describe, expect, it } from 'vitest';
import { assessVerifiedAccountFeeBudget } from '../src/live/account-fee-budget.js';
import { verifyAccountFeeEvidence } from '../src/live/account-fee-evidence.js';
import { verifyFundsEvidence } from '../src/live/funds-evidence.js';
import { accountFeesFixture } from './helpers/account-fees-fixture.js';
function intent() {
  return { orderIntentId: '00000000-0000-4000-8000-000000000002', venue: 'okx', account: 'main', symbol: 'BTC/USDT',
    side: 'buy', orderType: 'limit', baseQuantity: '0.001', limitPrice: '100000', maxQuoteAmount: '100', feeCaps: { BTC: '0', USDT: '0.1', MX: '0' } };
}
function input(f = accountFeesFixture()) {
  return { intent: intent(), feeEvidence: verifyAccountFeeEvidence(f.input()), fundsEvidence: verifyFundsEvidence(f.fundsInput()), now: f.now };
}

describe('fee budget from verified account rates', () => {
  it('uses authenticated personal rates with separate currency-policy and future-fill claims', () => {
    const result = assessVerifiedAccountFeeBudget(input());
    expect(result).toMatchObject({ calculationPassed: true, feeCapsSufficient: true, evidenceDeclared: false,
      feeProvenanceVerified: true, rateProvenanceVerified: true, feeCurrencyPolicyVerified: true,
      feeCurrencyVerified: false, fillRoundingVerified: false, liveAllowed: false, executable: false, reasons: [],
      diagnostics: { rateBasis: 'maximum-observed-maker-taker', worstRate: '0.001',
        requiredFees: { BTC: '0', USDT: '0.1', MX: '0' }, requiredNativeReserve: { BTC: '0', USDT: '100.1', MX: '0' } } });
    expect(Object.isFrozen(result.diagnostics?.requiredFees)).toBe(true);
  });
  it('uses the larger observed maker rate for a normal limit order', () => {
    const f = accountFeesFixture(); f.archive.okx.fees.makerRateRaw = '-0.002'; f.archive.okx.fees.makerCostRate = '0.002';
    const result = assessVerifiedAccountFeeBudget(input(f));
    expect(result).toMatchObject({ calculationPassed: false, diagnostics: { worstRate: '0.002', requiredFees: { USDT: '0.2' } } });
    expect(result.reasons).toContain('fee-cap-insufficient');
  });
  it('does not subtract a maker rebate from a possible taker expense', () => {
    const f = accountFeesFixture(); f.archive.okx.fees.makerRateRaw = '0.9'; f.archive.okx.fees.makerCostRate = '0';
    expect(assessVerifiedAccountFeeBudget(input(f))).toMatchObject({ calculationPassed: true,
      diagnostics: { worstRate: '0.001', requiredFees: { USDT: '0.1' } } });
  });
  it('uses zero budget for two observed rebates without promising their income', () => {
    const f = accountFeesFixture();
    f.archive.okx.fees.makerRateRaw = f.archive.okx.fees.takerRateRaw = '0.01';
    f.archive.okx.fees.makerCostRate = f.archive.okx.fees.takerCostRate = '0';
    const request = input(f); request.intent.feeCaps.USDT = '0';
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: true,
      diagnostics: { worstRate: '0', requiredFees: { BTC: '0', USDT: '0', MX: '0' }, requiredNativeReserve: { USDT: '100' } },
      feeCurrencyVerified: false, fillRoundingVerified: false, liveAllowed: false });
  });
  it('reserves fee in BTC for feeType0 buy, without crediting incoming BTC', () => {
    const request = input(accountFeesFixture({ feeType: '0' })); request.intent.feeCaps = { BTC: '0.000001', USDT: '0', MX: '0' };
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: true, feeCurrencyPolicyVerified: true,
      diagnostics: { requiredFees: { BTC: '0.000001', USDT: '0', MX: '0' }, requiredNativeReserve: { BTC: '0.000001', USDT: '100', MX: '0' } } });
  });
  it.each(['0', '1'] as const)('does not infer a quote-fee upper bound from sell limit price at feeType%s', feeType => {
    const request = input(accountFeesFixture({ feeType })); request.intent.side = 'sell'; request.intent.feeCaps.USDT = '100';
    expect(assessVerifiedAccountFeeBudget(request).reasons).toContain('sell-quote-fee-bound-unproven');
  });
  it('cannot pay a required BTC fee cap with a larger USDT cap', () => {
    const request = input(accountFeesFixture({ feeType: '0' })); request.intent.feeCaps.USDT = '999';
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: false,
      diagnostics: { feeCapShortfall: { BTC: '0.000001', USDT: '0', MX: '0' } } });
  });
  it('uses the full buy maxQuoteAmount for quote fees', () => {
    const request = input(); request.intent.maxQuoteAmount = '110'; request.intent.feeCaps.USDT = '0.11';
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: true,
      diagnostics: { requiredFees: { USDT: '0.11' }, requiredNativeReserve: { USDT: '110.11' } } });
  });
  it('rejects a cap one 18-decimal unit short', () => {
    const request = input(); request.intent.feeCaps.USDT = '0.099999999999999999';
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: false,
      diagnostics: { feeCapShortfall: { USDT: '0.000000000000000001' } } });
  });
  it('rounds model dust upward while disclosing that exchange fill rounding is unverified', () => {
    const f = accountFeesFixture();
    f.archive.okx.fees.makerRateRaw = '0'; f.archive.okx.fees.makerCostRate = '0';
    f.archive.okx.fees.takerRateRaw = '-0.000000000000000001'; f.archive.okx.fees.takerCostRate = '0.000000000000000001';
    const request = input(f); request.intent.baseQuantity = request.intent.maxQuoteAmount = '0.000000000000000001';
    request.intent.limitPrice = '1'; request.intent.feeCaps.USDT = '0.000000000000000001';
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: true, fillRoundingVerified: false,
      diagnostics: { requiredFees: { USDT: '0.000000000000000001' }, requiredNativeReserve: { USDT: '0.000000000000000002' } } });
  });
  it('retains significant observed precision as a blocker rather than rounding down', () => {
    const f = accountFeesFixture();
    f.archive.okx.fees.takerRateRaw = '-0.1234567890123456789'; f.archive.okx.fees.takerCostRate = '0.1234567890123456789';
    f.archive.okx.blockers = ['rate-precision-over-18'];
    const result = assessVerifiedAccountFeeBudget(input(f));
    expect(result.calculationPassed).toBe(false); expect(result.rateProvenanceVerified).toBe(true);
    expect(result.reasons).toContain('rate-precision-over-18');
  });
  it.each([false, true])('does not infer MEXC currency or discounted rate from MX enabled=%s', mxEnabled => {
    const request = input(accountFeesFixture({ mxEnabled })); request.intent.venue = 'mexc';
    const result = assessVerifiedAccountFeeBudget(request);
    expect(result).toMatchObject({ calculationPassed: false, rateProvenanceVerified: true, feeCurrencyPolicyVerified: false, diagnostics: null });
    expect(result.reasons).toContain('fee-currency-unconfirmed');
    expect(result.reasons.includes('mx-fee-conversion-unconfirmed')).toBe(mxEnabled);
  });
  it('does not invent missing OKX fee currency policy', () => {
    const result = assessVerifiedAccountFeeBudget(input(accountFeesFixture({ feeType: null })));
    expect(result).toMatchObject({ calculationPassed: false, rateProvenanceVerified: true, feeCurrencyPolicyVerified: false,
      reasons: ['fee-currency-unconfirmed'] });
  });
  it('rejects stale upstream data even when archive and HTTP observation are fresh', () => {
    const f = accountFeesFixture();
    f.archive.okx.fees.sourceUpdatedAt = String(f.archive.okx.fees.requestedAt - 60_001); f.archive.okx.blockers = ['source-time-stale'];
    const result = assessVerifiedAccountFeeBudget(input(f));
    expect(result.calculationPassed).toBe(false); expect(result.reasons).toContain('source-time-stale');
  });
});

describe('fee budget binding, freshness and nonforgeable evidence', () => {
  it.each(['feeEvidence', 'fundsEvidence'] as const)('rejects copied %s proof', field => {
    const request = input(); Object.assign(request, { [field]: { ...request[field] } });
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: false, feeProvenanceVerified: false,
      reasons: ['account-fee-evidence-not-verified'] });
  });
  it('rejects rates injected alongside an otherwise verified input', () => {
    expect(assessVerifiedAccountFeeBudget({ ...input(), makerRate: '0', takerRate: '0' } as never).reasons).toEqual(['invalid-verified-fee-input']);
  });
  it.each(['mexc', 'okx'] as const)('rejects fee/funds from different selected %s accounts', venue => {
    const request = input(), other = accountFeesFixture(venue === 'mexc' ? { mexcUid: 'OTHER_MEXC_ACCOUNT' } : { okxUid: '999999' });
    request.fundsEvidence = verifyFundsEvidence(other.fundsInput());
    expect(assessVerifiedAccountFeeBudget(request).reasons).toEqual(['fee-funds-binding-mismatch']);
  });
  it('checks freshness against the older funds capture as well as fees', () => {
    const f = accountFeesFixture(), request = input(f);
    request.now = request.fundsEvidence.startedAt + 60_000;
    expect(assessVerifiedAccountFeeBudget(request).calculationPassed).toBe(true);
    request.now++;
    expect(request.now - request.feeEvidence.startedAt).toBeLessThan(60_000);
    expect(assessVerifiedAccountFeeBudget(request).reasons).toEqual(['fee-or-funds-evidence-stale']);
  });
  it('rejects regression from verifier time or prior admission time', () => {
    const request = input(); request.now--;
    expect(assessVerifiedAccountFeeBudget(request).reasons).toEqual(['fee-clock-regression']);
    request.now++;
    expect(assessVerifiedAccountFeeBudget({ ...request, previousCheckedAt: request.now + 1 }).reasons).toEqual(['fee-clock-regression']);
  });
  it.each([NaN, Infinity, -1, 0, 1.5])('rejects invalid admission time %s', now => {
    expect(assessVerifiedAccountFeeBudget({ ...input(), now }).reasons).toEqual(['invalid-fee-check-time']);
  });
  it.each([{ venue: 'bybit' }, { account: 'subaccount' }, { symbol: 'ETH/USDT' }, { orderType: 'market' }, { extra: 'unrecognized' }])('rejects unsupported or enlarged intent %j', patch => {
    const request = input(); Object.assign(request.intent, patch);
    expect(assessVerifiedAccountFeeBudget(request)).toMatchObject({ calculationPassed: false, rateProvenanceVerified: true, reasons: ['invalid-fee-intent'] });
  });
  it('does not expose account identifiers through a public budget assessment', () => {
    const f = accountFeesFixture(), result = assessVerifiedAccountFeeBudget(input(f)), text = JSON.stringify(result);
    expect(text).not.toContain(f.archive.mexc.identity.uid); expect(text).not.toContain(f.archive.okx.identity.uid);
    expect(text).not.toContain(f.funds.pin.credentialFingerprint);
  });
});
