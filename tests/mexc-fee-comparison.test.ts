import { describe, expect, it, vi } from 'vitest';
import { compareMexcFeePayment, type MexcFeeComparisonInput } from '../src/accounts/mexc-fee-comparison.js';

function scenario(): MexcFeeComparisonInput {
  return { schema: 1, venue: 'mexc', account: 'main', symbol: 'BTC/USDT', liquidityRole: 'taker',
    rates: { kind: 'undiscounted-with-hypothetical-discount', undiscountedRate: '0.0005', discountFraction: '0.2' },
    applicability: 'unverified', turnoverBasis: 'declared-scenario-executed-mexc-notional',
    overheadAllocation: 'entire-declared-scenario', turnoverUsdt: '100', mxPriceUsdt: '2', availableMx: '0', acquisitionOverheadUsdt: '0' };
}

describe('MEXC fee comparison: advisory declared-input model', () => {
  it('shows the 20% example without turning a mobile screenshot into verified API evidence', () => {
    const result = compareMexcFeePayment(scenario());
    expect(result).toMatchObject({ withoutMxRate: '0.0005', withMxRate: '0.0004', withoutMxFeeUsdt: '0.05',
      withMxFeeEquivalentUsdt: '0.04', requiredMx: '0.02', missingMx: '0.02', mxAcquisitionPrincipalUsdt: '0.04',
      grossSavingUsdt: '0.01', netSavingUsdt: '0.01', positiveNetSavingInModel: true, coveredByDeclaredMx: false,
      hypothetical: true, advisoryOnly: true, executable: false, readyToEnable: false,
      activationReady: false, liveAllowed: false,
      applicabilityEvidenceVerified: false, applicabilityDeclared: 'unverified' });
    expect(result.reasons).toContain('api-discount-applicability-unverified');
  });
  it('uses two effective observations as supplied and never multiplies their discount twice', () => {
    const input = scenario();
    input.rates = { kind: 'observed-effective-rates', withoutMxRate: '0.0005', withMxRate: '0.0004' };
    input.applicability = 'verified';
    const result = compareMexcFeePayment(input);
    expect(result).toMatchObject({ withMxRate: '0.0004', withMxFeeEquivalentUsdt: '0.04', netSavingUsdt: '0.01',
      applicabilityDeclared: 'verified', applicabilityEvidenceVerified: false, readyToEnable: false });
    expect(result.reasons).not.toContain('discount-rate-assumed');
    expect(() => compareMexcFeePayment({ ...input, rates: { ...input.rates, discountFraction: '0.2' } }))
      .toThrow('invalid-mexc-fee-comparison');
  });
  it('does not treat MX purchase principal as a second fee expense', () => {
    const result = compareMexcFeePayment({ ...scenario(), availableMx: '0.01', acquisitionOverheadUsdt: '0.003' });
    expect(result).toMatchObject({ consumedMxValueUsdt: '0.04', missingMx: '0.01',
      mxAcquisitionPrincipalUsdt: '0.02', upfrontAcquisitionUsdt: '0.023', netSavingUsdt: '0.007' });
  });
  it('values existing MX as consumed money rather than free fees', () => {
    const result = compareMexcFeePayment({ ...scenario(), availableMx: '3' });
    expect(result).toMatchObject({ requiredMx: '0.02', missingMx: '0', mxAcquisitionPrincipalUsdt: '0',
      consumedMxValueUsdt: '0.04', netSavingUsdt: '0.01', coveredByDeclaredMx: true });
  });
  it.each(['0.01', '0.02'])('finds acquisition expenses %s can wipe out the saving', cost => {
    const result = compareMexcFeePayment({ ...scenario(), acquisitionOverheadUsdt: cost });
    expect(result.positiveNetSavingInModel).toBe(false);
    expect(result.reasons).toContain('no-positive-net-saving-in-model');
    expect(result.netSavingUsdt).toBe(cost === '0.01' ? '0' : '-0.01');
  });
  it('allows an observed rate increase and reports a loss instead of clamping it to zero', () => {
    const result = compareMexcFeePayment({ ...scenario(), rates: { kind: 'observed-effective-rates',
      withoutMxRate: '0.0005', withMxRate: '0.0006' } });
    expect(result).toMatchObject({ grossSavingUsdt: '-0.01', netSavingUsdt: '-0.01', positiveNetSavingInModel: false });
  });
  it('keeps zero maker fees at zero; zero fees do not prove a successful maker execution', () => {
    const result = compareMexcFeePayment({ ...scenario(), liquidityRole: 'maker',
      rates: { kind: 'undiscounted-with-hypothetical-discount', undiscountedRate: '0', discountFraction: '0.2' } });
    expect(result).toMatchObject({ withoutMxFeeUsdt: '0', withMxFeeEquivalentUsdt: '0', requiredMx: '0',
      netSavingUsdt: '0', positiveNetSavingInModel: false, executable: false });
    expect(result.limitations).toContain('maker-execution-and-second-venue-costs-not-modeled');
  });
  it('does not invent savings for a zero discount', () => {
    const result = compareMexcFeePayment({ ...scenario(),
      rates: { kind: 'undiscounted-with-hypothetical-discount', undiscountedRate: '0.0005', discountFraction: '0' } });
    expect(result).toMatchObject({ withoutMxFeeUsdt: '0.05', withMxFeeEquivalentUsdt: '0.05',
      netSavingUsdt: '0', positiveNetSavingInModel: false, savingStatus: 'conditional-model-estimate' });
  });
  it('handles zero turnover explicitly, retaining any declared setup expense', () => {
    expect(compareMexcFeePayment({ ...scenario(), turnoverUsdt: '0', acquisitionOverheadUsdt: '1' }))
      .toMatchObject({ requiredMx: '0', netSavingUsdt: '-1', positiveNetSavingInModel: false });
  });
  it('retains tiny amounts and a 36-decimal rate product without Number rounding', () => {
    const result = compareMexcFeePayment({ ...scenario(), turnoverUsdt: '1', mxPriceUsdt: '1',
      rates: { kind: 'undiscounted-with-hypothetical-discount',
        undiscountedRate: '0.000000000000000001', discountFraction: '0.000000000000000001' } });
    expect(result.withMxRate).toBe('0.000000000000000000999999999999999999');
    expect(result.withoutMxFeeUsdt).toBe('0.000000000000000001');
    expect(result.withMxFeeEquivalentUsdt).toBe('0.000000000000000001');
    expect(result.netSavingUsdt).toBe('0');
  });
  it('rounds MX need and its value upwards without overstating sub-atom savings', () => {
    const result = compareMexcFeePayment({ ...scenario(), mxPriceUsdt: '3' });
    expect(result.requiredMx).toBe('0.013333333333333334');
    expect(result.consumedMxValueUsdt).toBe('0.040000000000000002');
    expect(result.netSavingUsdt).toBe('0.009999999999999998');
  });
  it('retains amounts above Number safe-integer range', () => {
    const result = compareMexcFeePayment({ ...scenario(), turnoverUsdt: '9007199254740993', mxPriceUsdt: '1' });
    expect(result).toMatchObject({ withoutMxFeeUsdt: '4503599627370.4965',
      withMxFeeEquivalentUsdt: '3602879701896.3972', netSavingUsdt: '900719925474.0993' });
  });
  it.each(['maker', 'taker'] as const)('never authorizes settings or live operation for %s', liquidityRole => {
    const result = compareMexcFeePayment({ ...scenario(), applicability: 'verified', availableMx: '1', liquidityRole });
    expect(result).toMatchObject({ hypothetical: true, readyToEnable: false, executable: false,
      activationReady: false, liveAllowed: false,
      applicabilityEvidenceVerified: false });
  });
  it.each(['undiscountedRate', 'discountFraction', 'withoutMxRate', 'withMxRate', 'mxPriceUsdt'] as const)
  ('never echoes a malformed %s through decimal conversion errors', field => {
    const input = scenario(), invalid = 'PRIVATE_MISTAKEN_INPUT';
    if (field === 'mxPriceUsdt') input.mxPriceUsdt = invalid;
    else if (field === 'withoutMxRate' || field === 'withMxRate') {
      input.rates = { kind: 'observed-effective-rates', withoutMxRate: '0.0005', withMxRate: '0.0004', [field]: invalid };
    } else input.rates = { kind: 'undiscounted-with-hypothetical-discount',
      undiscountedRate: '0.0005', discountFraction: '0.2', [field]: invalid };
    expect(() => compareMexcFeePayment(input)).toThrow(/^invalid-mexc-fee-comparison$/);
  });
  it('rejects authority flags instead of accepting caller-supplied activation evidence', () => {
    expect(() => compareMexcFeePayment({ ...scenario(), activationReady: true, liveAllowed: true }))
      .toThrow(/^invalid-mexc-fee-comparison$/);
  });
  it('has no network side effects and returns immutable output independent of caller mutation', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const input = scenario(), result = compareMexcFeePayment(input);
      input.turnoverUsdt = '9999';
      expect(result.turnoverUsdt).toBe('100');
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.reasons)).toBe(true);
      expect(Object.isFrozen(result.limitations)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it.each([
    null, [], {}, { ...scenario(), secret: 'PRIVATE_ECHO' }, { ...scenario(), venue: 'okx' },
    { ...scenario(), account: 'sub' }, { ...scenario(), symbol: 'BTC/USDC' },
    { ...scenario(), liquidityRole: 'market' }, { ...scenario(), applicability: true },
    { ...scenario(), rates: { kind: 'observed-effective-rates', withMxRate: '0.0004' } },
    { ...scenario(), rates: { kind: 'undiscounted-with-hypothetical-discount',
      undiscountedRate: '0.0005', discountFraction: '1.01' } },
    { ...scenario(), rates: { kind: 'observed-effective-rates', withoutMxRate: '1.1', withMxRate: '0' } },
    { ...scenario(), rates: { kind: 'already-discounted', rate: '0.0004', discountFraction: '0.2' } },
    { ...scenario(), mxPriceUsdt: '0' }, { ...scenario(), turnoverUsdt: 100 },
    { ...scenario(), turnoverUsdt: '01' }, { ...scenario(), availableMx: '-1' },
    { ...scenario(), acquisitionOverheadUsdt: 'PRIVATE_ECHO' },
    { ...scenario(), turnoverUsdt: '1e3' }, { ...scenario(), availableMx: ' 1' },
    { ...scenario(), mxPriceUsdt: '0.0000000000000000001' },
    { ...scenario(), turnoverUsdt: '100000000000000000000' },
    { ...scenario(), acquisitionOverheadUsdt: undefined },
    { ...scenario(), turnoverBasis: 'all-venue-turnover' },
    { ...scenario(), overheadAllocation: 'monthly-cost-for-one-trade' }
  ])('rejects ambiguous input with a fixed non-echoing error', input => {
    expect(() => compareMexcFeePayment(input)).toThrow(/^invalid-mexc-fee-comparison$/);
  });
});
