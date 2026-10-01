import { describe, expect, it } from 'vitest';
import { createLiveOrderState } from '../src/live/order-lifecycle.js';
import { assessLiveLaunchPreparation, validateLiveLimitsDraft } from '../src/live/launch-readiness.js';

const limits = {
  schema: 1, kind: 'live-limits-draft', account: 'main', symbol: 'BTC/USDT',
  totalCapitalUsdt: '20', capitalByVenueUsdt: { mexc: '10', okx: '10' },
  maxOrderDebitUsdt: '5', maxCumulativeLossUsdt: '1', maxUnhedgedBtc: '0.0001',
  includeEarn: false, transfersEnabled: false, withdrawalsEnabled: false,
};

describe('live launch preparation stays blocked', () => {
  it('does not invent missing capital or loss choices', () => {
    expect(validateLiveLimitsDraft(undefined)).toEqual({ status: 'missing', reasons: ['capital-and-loss-limits-not-selected'] });
    expect(validateLiveLimitsDraft(null).status).toBe('missing');
  });
  it.each([
    { totalCapitalUsdt: 20 }, { maxCumulativeLossUsdt: '0' }, { maxOrderDebitUsdt: '-1' },
    { maxUnhedgedBtc: '1e-4' }, { maxUnhedgedBtc: '0.0000000000000000001' },
    { includeEarn: true }, { transfersEnabled: true }, { withdrawalsEnabled: true },
    { account: 'subaccount' }, { symbol: 'ETH/USDT' }, { enabled: true },
    { maxCumulativeLossUsdt: undefined }, { secret: 'PRIVATE-CANARY' },
  ])('rejects incomplete, ambiguous and out-of-scope drafts without echoing values: %o', patch => {
    const result = validateLiveLimitsDraft({ ...limits, ...patch });
    expect(result).toEqual({ status: 'invalid', reasons: ['invalid-limits-draft'] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-CANARY');
  });
  it('compares allocation exactly beyond float precision', () => {
    const exact = { ...limits, totalCapitalUsdt: '20.000000000000000001',
      capitalByVenueUsdt: { mexc: '10.000000000000000001', okx: '10' } };
    expect(validateLiveLimitsDraft(exact).status).toBe('valid-draft');
    expect(validateLiveLimitsDraft({ ...exact, totalCapitalUsdt: '20' })).toEqual({
      status: 'invalid', reasons: ['venue-capital-sum-mismatch'],
    });
  });
  it('keeps loss and per-order caps within the explicitly allocated budget', () => {
    expect(validateLiveLimitsDraft({ ...limits, maxCumulativeLossUsdt: '21', maxOrderDebitUsdt: '11' })).toEqual({
      status: 'invalid', reasons: ['order-debit-exceeds-venue-capital', 'loss-limit-exceeds-capital'],
    });
  });
  it('a fully valid draft and empty clean rehearsal cannot become launch authorization', () => {
    const report = assessLiveLaunchPreparation(createLiveOrderState(), limits);
    expect(report).toMatchObject({ executable: false, readyToStart: false, limitsEnforced: false,
      limits: { status: 'valid-draft' }, liveAccountingVerified: false, earnFundsIncluded: false, rehearsalOrderCount: 0 });
    expect(report.blockers).toContain('live-policy-not-bound-to-durable-admission');
    expect(report.blockers).toContain('strategy-after-costs-not-qualified');
    expect(report.blockers).toContain('exchange-order-transport-not-connected');
  });
  it('invalid history cannot be silently treated as an empty safe journal', () => {
    const state = createLiveOrderState();
    const report = assessLiveLaunchPreparation({ ...state, events: [{ secret: 'PRIVATE-CANARY' }] } as unknown as typeof state);
    expect(report).toMatchObject({ executable: false, readyToStart: false, recovery: null, rehearsalOrderCount: null });
    expect(report.blockers).toContain('invalid-rehearsal-history');
    expect(JSON.stringify(report)).not.toContain('PRIVATE-CANARY');
  });
  it('rejects forged executable/provenance labels', () => {
    const state = createLiveOrderState();
    for (const patch of [{ captureProvenanceVerified: true }, { nonExecutable: false }, { kind: 'live-order-state' }]) {
      expect(assessLiveLaunchPreparation({ ...state, ...patch } as typeof state).blockers).toContain('invalid-rehearsal-history');
    }
  });
});
