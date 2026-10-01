import { describe, expect, it } from 'vitest';
import { fundsEvidenceFixture } from './helpers/funds-evidence-fixture.js';
import { verifyFundsEvidence } from '../src/live/funds-evidence.js';
import { assessAccountFundsAdmission, type AccountFundsAdmissionInput } from '../src/live/account-funds-admission.js';
import type { LiveOrderIntent } from '../src/live/order-lifecycle.js';

function fixture(okxUSDT = '100') {
  const f = fundsEvidenceFixture({ okxUSDT });
  for (const row of f.archive.mexc.funds.balances) if (row.currency === 'BTC') row.free = row.available = '0';
  for (const row of f.archive.okx.funds.balances) if (row.currency === 'BTC') row.cashBal = row.availBal = '0';
  const intent: LiveOrderIntent = { orderIntentId: '00000000-0000-4000-8000-000000000002', venue: 'okx', account: 'main',
    symbol: 'BTC/USDT', side: 'buy', orderType: 'limit', baseQuantity: '0.1', limitPrice: '100', maxQuoteAmount: '10',
    feeCaps: { BTC: '0', USDT: '0.01', MX: '0' } };
  const limits = { schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT', totalCapitalUsdt: '200',
    capitalByVenueUsdt: { mexc: '100', okx: '100' }, maxOrderDebitUsdt: '30', maxCumulativeLossUsdt: '100', maxUnhedgedBtc: '1',
    includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false };
  const fee = { schema: 1, kind: 'declared-order-fee-evidence', source: 'declared-synthetic', venue: 'okx', account: 'main',
    symbol: 'BTC/USDT', bundleVersion: f.pin.bundleVersion, pinHash: f.archive.pinHash, observedAt: f.archive.startedAt,
    expiresAt: f.archive.startedAt + 60_000, makerRate: '0', takerRate: '0.001', feeAsset: 'USDT', provenanceVerified: false };
  const input = (): AccountFundsAdmissionInput => ({ intent, limits, preparedIntents: [],
    evidence: verifyFundsEvidence(f.input()), feeEvidence: fee, now: f.now });
  return { f, intent, limits, fee, input };
}
function prior(intent: LiveOrderIntent, amount = '10'): LiveOrderIntent {
  return { ...intent, orderIntentId: '00000000-0000-4000-8000-000000000003', maxQuoteAmount: amount };
}

describe('account funds preparation integration', () => {
  it('binds verified fresh capture to full fee reserve without authorizing live trading', () => {
    const { input } = fixture(), result = assessAccountFundsAdmission(input());
    expect(result.allowedForPreparation).toBe(true);
    expect(result.diagnostics?.reservedIncludingProposedByVenue.okx.USDT).toBe('10.01');
    expect(result.diagnostics?.remainingByVenue.okx.USDT).toBe('89.99');
    expect(result).toMatchObject({ executable: false, liveAllowed: false, accountGlobalOwnershipVerified: false,
      feeProvenanceVerified: false, userLimitsApproved: false });
    expect(result.liveBlockers).toContain('fee-capture-and-currency-unverified');
    expect(Object.isFrozen(result.diagnostics?.remainingByVenue.okx)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MEXC_UID');
    expect(JSON.stringify(result)).not.toContain('9876543212345678901');
  });
  it('does not subtract exchange frozen balance twice', () => {
    const { f, input } = fixture();
    const usdt = f.archive.okx.funds.balances.find(row => row.currency === 'USDT')!;
    usdt.cashBal = '200'; usdt.availBal = '100'; usdt.frozenBal = '100';
    const result = assessAccountFundsAdmission(input());
    expect(result.allowedForPreparation).toBe(true);
    expect(result.diagnostics?.remainingByVenue.okx.USDT).toBe('89.99');
    expect(result.diagnostics?.exchangeHoldsSubtractedAgain).toBe(false);
  });
  it('subtracts all existing local reservations exactly once', () => {
    const { input, intent } = fixture('35'), data = input(); data.preparedIntents = [prior(intent, '20')];
    const result = assessAccountFundsAdmission(data);
    expect(result.allowedForPreparation).toBe(true);
    expect(result.diagnostics?.reservedIncludingProposedByVenue.okx.USDT).toBe('30.02');
    expect(result.diagnostics?.remainingByVenue.okx.USDT).toBe('4.98');
  });
  it('reserves full cap even when estimated fee is lower', () => {
    const f = fixture('20'); f.intent.feeCaps.USDT = '3';
    const result = assessAccountFundsAdmission(f.input());
    expect(result.diagnostics?.feeBudget.diagnostics?.requiredFees?.USDT).toBe('0.01');
    expect(result.diagnostics?.remainingByVenue.okx.USDT).toBe('7');
  });
  it('rejects another proposal after the first consumes the budget', () => {
    const { input, intent } = fixture('15');
    expect(assessAccountFundsAdmission(input()).allowedForPreparation).toBe(true);
    const data = input(); data.preparedIntents = [prior(intent)];
    const result = assessAccountFundsAdmission(data);
    expect(result.allowedForPreparation).toBe(false);
    expect(result.reasons).toContain('insufficient-available-funds');
    expect(result.diagnostics?.remainingByVenue.okx.USDT).toBe('-5.02');
  });
  it('distinguishes one native decimal atom shortage', () => {
    const f = fixture('10.009999999999999999'), result = assessAccountFundsAdmission(f.input());
    expect(result.allowedForPreparation).toBe(false);
    expect(result.diagnostics?.remainingByVenue.okx.USDT).toBe('-0.000000000000000001');
  });
  it('rejects a copied projection with forged amounts despite its verified labels', () => {
    const f = fixture(), data = f.input(); data.evidence = structuredClone(data.evidence);
    expect(assessAccountFundsAdmission(data).reasons).toEqual(['funds-evidence-not-verified']);
  });
  it('rechecks age after the projection was verified', () => {
    const f = fixture(), data = f.input(); data.now = f.f.archive.startedAt + 60_001;
    expect(assessAccountFundsAdmission(data).reasons).toEqual(['funds-evidence-stale']);
  });
  it('accepts the exact age boundary for calculation only', () => {
    const f = fixture(), data = f.input(); data.now = f.f.archive.startedAt + 60_000;
    expect(assessAccountFundsAdmission(data).allowedForPreparation).toBe(true);
  });
  it.each(['verification', 'journal'] as const)('rejects regressive time against %s', kind => {
    const f = fixture(), data = f.input();
    if (kind === 'verification') data.now--; else data.previousCheckedAt = data.now + 1;
    expect(assessAccountFundsAdmission(data).reasons).toEqual(['funds-clock-regression']);
  });
  it.each([NaN, Infinity, -1, 1.25])('rejects an invalid clock', now => {
    const data = fixture().input(); data.now = now;
    expect(assessAccountFundsAdmission(data).allowedForPreparation).toBe(false);
  });
  it('does not fill in absent user limits', () => {
    const data = fixture().input(); data.limits = null;
    expect(assessAccountFundsAdmission(data).reasons).toEqual(['capital-and-loss-limits-not-selected']);
  });
  it('rejects additional policy fields including declared balances', () => {
    const f = fixture();
    expect(assessAccountFundsAdmission({ ...f.input(), limits: { ...f.limits, initialBalances: { USDT: '90000' } } }).reasons).toContain('invalid-limits-draft');
  });
  it('cannot turn cash movements into available money', () => {
    const data = { ...fixture('1').input(), cashDelta: { USDT: '100000' } };
    expect(assessAccountFundsAdmission(data).reasons).toEqual(['invalid-preparation-input']);
  });
  it('does not require an absent MX balance when every MX reserve is zero', () => {
    const result = assessAccountFundsAdmission(fixture().input());
    expect(result.allowedForPreparation).toBe(true);
    expect(result.diagnostics?.candidateByVenue.okx.MX).toBeNull();
    expect(result.diagnostics?.remainingByVenue.okx.MX).toBeNull();
  });
  it('does not turn a missing required USDT row into zero or assume another wallet covers it', () => {
    const f = fixture(); f.f.archive.okx.funds.balances = f.f.archive.okx.funds.balances.filter(row => row.currency !== 'USDT');
    const result = assessAccountFundsAdmission(f.input());
    expect(result.reasons).toContain('required-funds-unavailable');
    expect(result.diagnostics?.remainingByVenue.okx.USDT).toBeNull();
  });
  it('requires BTC information for the combined exposure even for a USDT-only buy reserve', () => {
    const f = fixture(); f.f.archive.mexc.funds.balances = f.f.archive.mexc.funds.balances.filter(row => row.currency !== 'BTC');
    expect(assessAccountFundsAdmission(f.input()).reasons).toContain('btc-exposure-unavailable');
  });
  it('does not waive unsupported MEXC spending semantics', () => {
    const f = fixture(); f.intent.venue = 'mexc'; f.fee.venue = 'mexc';
    const result = assessAccountFundsAdmission(f.input());
    expect(result.allowedForPreparation).toBe(false);
    expect(result.reasons).toContain('mexc-available-semantics-unconfirmed');
    expect(result.reasons).toContain('mexc-main-account-unconfirmed');
  });
  it('rechecks the venue of older reservations when a capture changes', () => {
    const f = fixture(), data = f.input(); data.preparedIntents = [{ ...prior(f.intent), venue: 'mexc' }];
    expect(assessAccountFundsAdmission(data).reasons).toContain('mexc-available-semantics-unconfirmed');
  });
  it('blocks borrowing/debt even if the displayed amount could cover the proposal', () => {
    const f = fixture(); f.f.archive.okx.funds.balances[1].liab = '1';
    expect(assessAccountFundsAdmission(f.input()).reasons).toContain('liability-reported');
  });
  it('does not confuse arithmetic success with an authenticated account fee', () => {
    const f = fixture(); f.fee.source = 'account-observation';
    const result = assessAccountFundsAdmission(f.input());
    expect(result.allowedForPreparation).toBe(true);
    expect(result.feeProvenanceVerified).toBe(false);
    expect(result.liveAllowed).toBe(false);
  });
  it('blocks stale, missing and insufficient fee declarations', () => {
    const f = fixture(); f.fee.expiresAt = f.fee.observedAt + 100;
    expect(assessAccountFundsAdmission(f.input()).reasons).toContain('fee-evidence-stale');
    expect(assessAccountFundsAdmission({ ...f.input(), feeEvidence: null }).reasons).toContain('invalid-fee-budget-input');
    f.fee.expiresAt = f.fee.observedAt + 60_000; f.intent.feeCaps.USDT = '0';
    expect(assessAccountFundsAdmission(f.input()).reasons).toContain('fee-cap-insufficient');
  });
  it('does not allow a fee from another binding version', () => {
    const f = fixture(); f.fee.pinHash = 'a'.repeat(64);
    expect(assessAccountFundsAdmission(f.input()).reasons).toContain('fee-binding-mismatch');
  });
  it('does not net two independent buy reservations for the exposure limit', () => {
    const f = fixture(), data = f.input(); f.limits.maxUnhedgedBtc = '0.15'; data.preparedIntents = [prior(f.intent)];
    const result = assessAccountFundsAdmission(data);
    expect(result.reasons).toContain('unhedged-btc-limit');
    expect(result.diagnostics?.unhedgedBtcInterval?.upper).toBe('0.2');
  });
  it('retains the explicit opening-inventory valuation blocker', () => {
    const f = fixture(); f.f.archive.okx.funds.balances[0].cashBal = f.f.archive.okx.funds.balances[0].availBal = '0.01';
    expect(assessAccountFundsAdmission(f.input()).reasons).toContain('opening-btc-cost-basis-unproven');
  });
  it('includes locked inventory in exposure rather than confusing available with owned BTC', () => {
    const f = fixture();
    f.f.archive.mexc.funds.balances[0].locked = '1';
    f.f.archive.okx.funds.balances[0].cashBal = '1';
    f.f.archive.okx.funds.balances[0].frozenBal = '1';
    f.limits.maxUnhedgedBtc = '0.2';
    const result = assessAccountFundsAdmission(f.input());
    expect(result.allowedForPreparation).toBe(false);
    expect(result.reasons).toContain('opening-btc-cost-basis-unproven');
    expect(result.reasons).toContain('unhedged-btc-limit');
    expect(result.diagnostics?.unhedgedBtcInterval).toEqual({ lower: '2', upper: '2.1', largestAbsolute: '2.1' });
    expect(result.diagnostics?.candidateByVenue.okx.BTC).toBe('0');
  });
  it.each([
    ['maxOrderDebitUsdt', '10', 'per-order-usdt-debit-limit'],
    ['maxCumulativeLossUsdt', '10', 'gross-usdt-outflow-limit'],
  ] as const)('enforces %s including fee reserve', (field, value, reason) => {
    const f = fixture(); f.limits[field] = value;
    expect(assessAccountFundsAdmission(f.input()).reasons).toContain(reason);
  });
  it('checks a venue allocation against all local reservations', () => {
    const f = fixture(); f.limits.totalCapitalUsdt = '40'; f.limits.capitalByVenueUsdt = { mexc: '20', okx: '20' };
    f.limits.maxOrderDebitUsdt = '15'; f.limits.maxCumulativeLossUsdt = '40';
    expect(assessAccountFundsAdmission({ ...f.input(), preparedIntents: [prior(f.intent)] }).reasons).toContain('venue-capital-limit');
  });
  it('rejects repeated intent identities and unsupported submitted-order input', () => {
    const f = fixture();
    expect(assessAccountFundsAdmission({ ...f.input(), preparedIntents: [f.intent] }).reasons).toContain('prepared-intent-id-reused');
    expect(assessAccountFundsAdmission({ ...f.input(), preparedIntents: [{ ...prior(f.intent), dispatchAt: '2026-09-30' }] }).allowedForPreparation).toBe(false);
  });
});
