import { describe, expect, it } from 'vitest';
import { verifyFundsEvidence, isVerifiedFundsEvidence } from '../src/live/funds-evidence.js';
import { fundsEvidenceFixture } from './helpers/funds-evidence-fixture.js';

type Fixture = ReturnType<typeof fundsEvidenceFixture>;
function unavailable(f: Fixture, field: string, marker: 'empty' | 'missing' | 'null' = 'empty', index = 0) {
  const row = f.archive.okx.funds.balances[index] as Record<string, unknown>;
  row[field] = null;
  row.unavailableFields = { ...(row.unavailableFields as object), [field]: marker };
}
function notApplicable(f: Fixture) {
  for (let index = 0; index < f.archive.okx.funds.balances.length; index++) unavailable(f, 'isoLiab', 'empty', index);
  return f;
}

describe('documented OKX Spot isoLiab applicability', () => {
  it('represents only a reported empty isoLiab in acctLv 1 as N/A, never as zero', () => {
    const f = notApplicable(fundsEvidenceFixture()), input = f.input(), before = Buffer.from(input.archiveBytes);
    const observed = verifyFundsEvidence(input);
    expect(isVerifiedFundsEvidence(observed)).toBe(true);
    expect(observed.venues.okx.blockers).toEqual([]);
    for (const asset of ['BTC', 'USDT'] as const) {
      expect(observed.venues.okx.assets[asset].notApplicableFields).toEqual(['isoLiab']);
      expect(observed.venues.okx.assets[asset].blockers).toEqual([]);
      expect(observed.venues.okx.assets[asset].candidateAmount).not.toBeNull();
    }
    expect(f.archive.okx.funds.balances[0].isoLiab).toBeNull();
    expect(input.archiveBytes).toEqual(before);
    expect(observed).toMatchObject({ fundsAdmission: false, executable: false });
    expect(observed.venues.mexc.blockers).toContain('mexc-available-semantics-unconfirmed');
  });
  it('keeps the previous result shape for an explicitly reported zero', () => {
    const observed = verifyFundsEvidence(fundsEvidenceFixture().input());
    expect(observed.venues.okx.assets.BTC).not.toHaveProperty('notApplicableFields');
    expect(observed.venues.okx.assets.BTC.blockers).toEqual([]);
  });
  it.each(['missing', 'null'] as const)('keeps %s isoLiab unknown in Spot mode', marker => {
    const f = fundsEvidenceFixture(); unavailable(f, 'isoLiab', marker);
    const observed = verifyFundsEvidence(f.input());
    expect(observed.venues.okx.assets.BTC).not.toHaveProperty('notApplicableFields');
    expect(observed.venues.okx.assets.BTC.candidateAmount).toBeNull();
    expect(observed.venues.okx.assets.BTC.blockers).toEqual(expect.arrayContaining(['amount-unavailable', 'liability-unavailable']));
    expect(observed.venues.okx.blockers).toContain('liability-unavailable');
  });
  it.each(['2', '3', '4', 'unknown'])('does not apply the exception to acctLv %s', accountMode => {
    const f = notApplicable(fundsEvidenceFixture({ okxAccountMode: accountMode }));
    const observed = verifyFundsEvidence(f.input());
    expect(observed.venues.okx.assets.BTC).not.toHaveProperty('notApplicableFields');
    expect(observed.venues.okx.assets.BTC.candidateAmount).toBeNull();
    expect(observed.venues.okx.blockers).toEqual(expect.arrayContaining(['okx-mode-not-supported', 'liability-unavailable']));
  });
  it.each(['0.01', '-0.01', '0.0000000000000000001'])('still blocks reported isoLiab %s', value => {
    const f = fundsEvidenceFixture(); f.archive.okx.funds.balances[0].isoLiab = value;
    const observed = verifyFundsEvidence(f.input());
    expect(observed.venues.okx.assets.BTC).not.toHaveProperty('notApplicableFields');
    expect(observed.venues.okx.assets.BTC.candidateAmount).toBeNull();
    expect(observed.venues.okx.assets.BTC.blockers).toContain('liability-reported');
    expect(observed.venues.okx.blockers).toContain('liability-reported');
    if (value.startsWith('-')) expect(observed.venues.okx.assets.BTC.blockers).toContain('negative-amount-reported');
    if (value.endsWith('0001')) expect(observed.venues.okx.assets.BTC.blockers).toContain('precision-over-18');
  });
  it.each(['liab', 'crossLiab', 'interest', 'borrowFroz'])('keeps empty %s blocked while only isoLiab is N/A', field => {
    const f = notApplicable(fundsEvidenceFixture()); unavailable(f, field);
    const observed = verifyFundsEvidence(f.input());
    expect(observed.venues.okx.assets.BTC.notApplicableFields).toEqual(['isoLiab']);
    expect(observed.venues.okx.assets.BTC.candidateAmount).toBeNull();
    expect(observed.venues.okx.assets.BTC.blockers).toEqual(expect.arrayContaining(['amount-unavailable', 'liability-unavailable']));
    expect(observed.venues.okx.blockers).toContain('liability-unavailable');
  });
  it.each(['liab', 'crossLiab', 'interest', 'borrowFroz'])('keeps reported nonzero %s blocked', field => {
    const f = notApplicable(fundsEvidenceFixture()); (f.archive.okx.funds.balances[0] as Record<string, unknown>)[field] = '1';
    const observed = verifyFundsEvidence(f.input());
    expect(observed.venues.okx.assets.BTC.blockers).toContain('liability-reported');
    expect(observed.venues.okx.blockers).toContain('liability-reported');
  });
  it('does not hide debt reported in a different currency', () => {
    const f = notApplicable(fundsEvidenceFixture()); f.archive.okx.funds.balances[1].liab = '1';
    const observed = verifyFundsEvidence(f.input());
    expect(observed.venues.okx.assets.BTC.notApplicableFields).toEqual(['isoLiab']);
    expect(observed.venues.okx.assets.BTC.blockers).toEqual([]);
    expect(observed.venues.okx.blockers).toContain('liability-reported');
  });
  it('does not turn an absent currency into a reported or spendable balance', () => {
    const observed = verifyFundsEvidence(notApplicable(fundsEvidenceFixture()).input());
    expect(observed.venues.okx.assets.MX).toEqual({ reported: false, candidateAmount: null, ownedAmount: null, blockers: ['asset-not-reported'] });
  });
  it('freezes the N/A marker with the evidence projection', () => {
    const observed = verifyFundsEvidence(notApplicable(fundsEvidenceFixture()).input());
    expect(Object.isFrozen(observed.venues.okx.assets.BTC.notApplicableFields)).toBe(true);
    expect(() => (observed.venues.okx.assets.BTC.notApplicableFields as string[]).push('liab')).toThrow();
  });
  it.each(['non-null-value', 'no-marker', 'extra-marker'])('rejects an inconsistent %s DTO', kind => {
    const f = fundsEvidenceFixture();
    const row = f.archive.okx.funds.balances[0] as Record<string, unknown>;
    if (kind === 'non-null-value') row.unavailableFields = { isoLiab: 'empty' };
    if (kind === 'no-marker') row.isoLiab = null;
    if (kind === 'extra-marker') { row.isoLiab = null; row.unavailableFields = { isoLiab: 'empty', liab: 'empty' }; }
    expect(() => verifyFundsEvidence(f.input())).toThrow('funds-evidence-invalid');
  });
  it('retains borrow enabled and unknown configuration blockers', () => {
    const f = notApplicable(fundsEvidenceFixture()); f.archive.okx.configuration.enableSpotBorrow = true;
    expect(verifyFundsEvidence(f.input()).venues.okx.blockers).toContain('okx-borrow-enabled-or-unknown');
  });
});
