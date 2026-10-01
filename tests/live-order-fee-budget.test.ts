import { describe, expect, it, vi } from 'vitest';
import { assessOrderFeeBudget, ORDER_FEE_EVIDENCE_MAX_AGE_MS, type OrderFeeBudgetInput } from '../src/live/order-fee-budget.js';

const observedAt = Date.UTC(2026, 8, 30, 12);
function sample(): OrderFeeBudgetInput {
  const binding = { bundleVersion: '00000000-0000-4000-8000-000000000001', pinHash: 'a'.repeat(64) };
  return { intent: { orderIntentId: '00000000-0000-4000-8000-000000000002', venue: 'mexc', account: 'main',
    symbol: 'BTC/USDT', side: 'buy', orderType: 'limit', baseQuantity: '0.001', limitPrice: '100000',
    maxQuoteAmount: '100', feeCaps: { BTC: '0', USDT: '0.05', MX: '0' } },
  binding, checkedAt: observedAt + 10_000, feeEvidence: { schema: 1, kind: 'declared-order-fee-evidence',
    source: 'declared-synthetic', venue: 'mexc', account: 'main', symbol: 'BTC/USDT', ...binding,
    observedAt, expiresAt: observedAt + 60_000, makerRate: '0', takerRate: '0.0005', feeAsset: 'USDT', provenanceVerified: false } };
}

describe('declared native fee budget for an ordinary limit order', () => {
  it('covers the taker fee despite zero maker and reserves the complete declared caps', () => {
    const input = sample(); input.intent.feeCaps.USDT = '1';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true, feeCapsSufficient: true,
      feeProvenanceVerified: false, feeCurrencyVerified: false, evidenceDeclared: true, liveAllowed: false, executable: false,
      reasons: [], diagnostics: { rateBasis: 'maximum-declared-maker-taker', worstRate: '0.0005',
        requiredFees: { BTC: '0', USDT: '0.05', MX: '0' }, feeCapShortfall: { BTC: '0', USDT: '0', MX: '0' },
        requiredNativeReserve: { BTC: '0', USDT: '101', MX: '0' } } });
  });
  it('uses maker instead if the supplied maker cost is higher than taker', () => {
    const input = sample(); input.feeEvidence.makerRate = '0.001';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: false, reasons: ['fee-cap-insufficient'],
      diagnostics: { worstRate: '0.001', requiredFees: { USDT: '0.1' }, feeCapShortfall: { USDT: '0.05' } } });
  });
  it('uses the entire buy cap rather than a smaller quantity times limit price', () => {
    const input = sample(); input.intent.maxQuoteAmount = '110'; input.intent.feeCaps.USDT = '0.055';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true,
      diagnostics: { requiredFees: { USDT: '0.055' }, requiredNativeReserve: { USDT: '110.055' } } });
  });
  it('closes a fee cap short by exactly one unit at 18 decimal places', () => {
    const input = sample(); input.intent.feeCaps.USDT = '0.049999999999999999';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: false, feeCapsSufficient: false,
      reasons: ['fee-cap-insufficient'], diagnostics: { feeCapShortfall: { USDT: '0.000000000000000001' } } });
  });
  it('rounds a fractional 18-decimal unit upward instead of granting a zero fee', () => {
    const input = sample(); input.intent.baseQuantity = '0.000000000000000001'; input.intent.limitPrice = '1';
    input.intent.maxQuoteAmount = '0.000000000000000001'; input.intent.feeCaps.USDT = '0.000000000000000001';
    input.feeEvidence.takerRate = '0.000000000000000001';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true,
      diagnostics: { requiredFees: { USDT: '0.000000000000000001' }, requiredNativeReserve: { USDT: '0.000000000000000002' } } });
    input.intent.feeCaps.USDT = '0';
    expect(assessOrderFeeBudget(input).reasons).toEqual(['fee-cap-insufficient']);
  });
  it('preserves integers beyond Number safe range', () => {
    const input = sample(); input.intent.baseQuantity = '1'; input.intent.limitPrice = '9007199254740993';
    input.intent.maxQuoteAmount = '9007199254740993'; input.intent.feeCaps.USDT = '4503599627370.4965';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true,
      diagnostics: { requiredFees: { USDT: '4503599627370.4965' }, requiredNativeReserve: { USDT: '9011702854368363.4965' } } });
  });
  it.each(['buy', 'sell'] as const)('reserves BTC fee explicitly for %s without using received coins', side => {
    const input = sample(); input.intent.side = side; input.feeEvidence.feeAsset = 'BTC';
    input.intent.feeCaps = { BTC: '0.0000005', USDT: '0', MX: '0' };
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true,
      diagnostics: { requiredFees: { BTC: '0.0000005', USDT: '0', MX: '0' },
        requiredNativeReserve: { BTC: side === 'buy' ? '0.0000005' : '0.0010005', USDT: side === 'buy' ? '100' : '0', MX: '0' } } });
  });
  it('does not cover BTC commission by a larger fee cap in another currency', () => {
    const input = sample(); input.feeEvidence.feeAsset = 'BTC'; input.intent.feeCaps.USDT = '100';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: false, reasons: ['fee-cap-insufficient'],
      diagnostics: { feeCapShortfall: { BTC: '0.0000005', USDT: '0', MX: '0' } } });
  });
  it.each(['buy', 'sell'] as const)('retains zero only when both supplied rates are zero for %s', side => {
    const input = sample(); input.intent.side = side; input.feeEvidence.makerRate = '0'; input.feeEvidence.takerRate = '0';
    input.intent.feeCaps.USDT = '0';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true,
      diagnostics: { requiredFees: { BTC: '0', USDT: '0', MX: '0' }, worstRate: '0' } });
  });
  it('refuses a sell quote fee ceiling inferred from a minimum price or unenforced maxQuoteAmount', () => {
    const input = sample(); input.intent.side = 'sell'; input.intent.feeCaps.USDT = '999';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: false, reasons: ['sell-quote-fee-bound-unproven'],
      diagnostics: { requiredFees: null, feeCapShortfall: null, requiredNativeReserve: { BTC: '0.001', USDT: '999', MX: '0' } } });
  });
  it.each(['0', '0.0005'])('blocks MX as a declared fee currency at rate %s without inventing conversion', rate => {
    const input = sample(); input.feeEvidence.feeAsset = 'MX'; input.feeEvidence.takerRate = rate; input.intent.feeCaps.MX = '10';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: false, reasons: ['mx-fee-valuation-unproven'],
      diagnostics: { requiredFees: null, feeCapShortfall: null, requiredNativeReserve: { MX: '10' } } });
  });
  it('blocks an MX reserve even if this quote declares another fee currency', () => {
    const input = sample(); input.intent.feeCaps.MX = '0.000000000000000001';
    expect(assessOrderFeeBudget(input).reasons).toContain('mx-fee-valuation-unproven');
  });
  it('supports identical native arithmetic for explicitly matching OKX declarations', () => {
    const input = sample(); input.intent.venue = 'okx'; input.feeEvidence.venue = 'okx';
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true, liveAllowed: false });
  });
  it('normalizes insignificant zeros without rounding the underlying amount', () => {
    const input = sample(); input.feeEvidence.makerRate = '0.0000'; input.feeEvidence.takerRate = '0.0005000';
    input.intent.feeCaps.USDT = '0.05000';
    expect(assessOrderFeeBudget(input).diagnostics).toMatchObject({ worstRate: '0.0005', requiredFees: { USDT: '0.05' },
      requiredNativeReserve: { USDT: '100.05' } });
  });
});

describe('freshness, binding and declared provenance boundaries', () => {
  it.each([0, 60_000])('accepts the inclusive timestamp boundary %s only for local arithmetic', elapsed => {
    const input = sample(); input.checkedAt = observedAt + elapsed;
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true, feeProvenanceVerified: false, liveAllowed: false });
  });
  it('rejects exactly one millisecond beyond expiry', () => {
    const input = sample(); input.checkedAt = observedAt + ORDER_FEE_EVIDENCE_MAX_AGE_MS + 1;
    expect(assessOrderFeeBudget(input).reasons).toEqual(['fee-evidence-stale']);
  });
  it.each([0, -1, 60_001])('rejects invalid evidence lifetime %s', duration => {
    const input = sample(); input.feeEvidence.expiresAt = observedAt + duration;
    expect(assessOrderFeeBudget(input).reasons).toContain('fee-evidence-window-invalid');
  });
  it('rejects a shorter expired quote even when still younger than 60 seconds', () => {
    const input = sample(); input.feeEvidence.expiresAt = observedAt + 1;
    expect(assessOrderFeeBudget(input).reasons).toEqual(['fee-evidence-stale']);
  });
  it('rejects future observations and supplied prior-clock regression', () => {
    const input = sample(); input.checkedAt = observedAt - 1;
    expect(assessOrderFeeBudget(input).reasons).toEqual(['fee-clock-regression']);
    input.checkedAt = observedAt + 10_000; input.previousCheckedAt = input.checkedAt + 1;
    expect(assessOrderFeeBudget(input).reasons).toEqual(['fee-clock-regression']);
  });
  it.each(['bundleVersion', 'pinHash'] as const)('does not accept a fee quote for another %s', key => {
    const input = sample(); input.feeEvidence[key] = key === 'pinHash' ? 'b'.repeat(64) : '00000000-0000-4000-8000-000000000003';
    expect(assessOrderFeeBudget(input).reasons).toEqual(['fee-binding-mismatch']);
  });
  it('does not use another venue fee schedule', () => {
    const input = sample(); input.feeEvidence.venue = 'okx';
    expect(assessOrderFeeBudget(input).reasons).toEqual(['fee-scope-mismatch']);
  });
  it.each(['declared-synthetic', 'account-observation'] as const)('does not authenticate caller supplied source %s', source => {
    const input = sample(); input.feeEvidence.source = source;
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: true, evidenceDeclared: true,
      feeProvenanceVerified: false, feeCurrencyVerified: false, liveAllowed: false, executable: false });
  });
  it('has no external requests and returns independent deeply immutable diagnostics', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const input = sample(), output = assessOrderFeeBudget(input);
      input.intent.feeCaps.USDT = '900'; input.feeEvidence.takerRate = '1'; input.binding.pinHash = 'c'.repeat(64);
      expect(output.diagnostics?.requiredNativeReserve.USDT).toBe('100.05'); expect(fetch).not.toHaveBeenCalled();
      expect(Object.isFrozen(output)).toBe(true); expect(Object.isFrozen(output.reasons)).toBe(true);
      expect(Object.isFrozen(output.diagnostics)).toBe(true); expect(Object.isFrozen(output.diagnostics?.requiredFees)).toBe(true);
      expect(Object.isFrozen(output.diagnostics?.feeCapShortfall)).toBe(true); expect(Object.isFrozen(output.diagnostics?.requiredNativeReserve)).toBe(true);
    } finally { fetch.mockRestore(); }
  });
});

describe('strict input and secret-safe errors', () => {
  it.each([
    ['extra authority', (v: any) => { v.liveAllowed = true; }],
    ['undefined extra authority', (v: any) => { v.liveAllowed = undefined; }],
    ['undefined extra fee field', (v: any) => { v.feeEvidence.private = undefined; }],
    ['serialization override', (v: any) => { v.toJSON = () => sample(); }],
    ['fee provenance escalation', (v: any) => { v.feeEvidence.provenanceVerified = true; }],
    ['fee arbitrary private field', (v: any) => { v.feeEvidence.credentials = 'PRIVATE_NOT_FOR_OUTPUT'; }],
    ['fee role override', (v: any) => { v.feeEvidence.liquidityRole = 'maker'; }],
    ['extra discount', (v: any) => { v.feeEvidence.discountFraction = '0.2'; }],
    ['wrong symbol', (v: any) => { v.feeEvidence.symbol = 'ETH/USDT'; }],
    ['wrong account', (v: any) => { v.feeEvidence.account = 'sub'; }],
    ['missing currency', (v: any) => { delete v.feeEvidence.feeAsset; }],
    ['unknown currency', (v: any) => { v.feeEvidence.feeAsset = 'BNB'; }],
    ['missing maker', (v: any) => { delete v.feeEvidence.makerRate; }],
    ['missing taker', (v: any) => { delete v.feeEvidence.takerRate; }],
    ['missing binding', (v: any) => { delete v.binding; }],
    ['missing time', (v: any) => { delete v.checkedAt; }],
    ['numeric fee', (v: any) => { v.feeEvidence.takerRate = 0.0005; }],
    ['negative rebate', (v: any) => { v.feeEvidence.makerRate = '-0.0001'; }],
    ['oversized rate', (v: any) => { v.feeEvidence.takerRate = '1.000000000000000001'; }],
    ['scientific notation', (v: any) => { v.feeEvidence.takerRate = '5e-4'; }],
    ['nineteen decimal rate', (v: any) => { v.feeEvidence.takerRate = '0.0000000000000000001'; }],
    ['leading whitespace', (v: any) => { v.feeEvidence.takerRate = ' 0.0005'; }],
    ['leading zero', (v: any) => { v.feeEvidence.takerRate = '00.0005'; }],
    ['private malformed rate', (v: any) => { v.feeEvidence.takerRate = 'PRIVATE_NOT_FOR_OUTPUT'; }],
    ['timestamp text', (v: any) => { v.checkedAt = String(observedAt); }],
    ['timestamp fraction', (v: any) => { v.checkedAt = observedAt + 0.5; }],
    ['unsafe timestamp', (v: any) => { v.checkedAt = Number.MAX_SAFE_INTEGER + 1; }],
    ['private binding', (v: any) => { v.binding.pinHash = 'PRIVATE_NOT_FOR_OUTPUT'; }],
    ['bigint', (v: any) => { v.checkedAt = 1n; }],
    ['circular', (v: any) => { v.loop = v; }],
    ['huge input', (v: any) => { v.private = 'PRIVATE_NOT_FOR_OUTPUT'.repeat(2000); }],
  ])('rejects %s with a fixed non-echoing response', (_label, mutate) => {
    const input = sample(); mutate(input);
    const result = assessOrderFeeBudget(input);
    expect(result).toMatchObject({ calculationPassed: false, reasons: ['invalid-fee-budget-input'], diagnostics: null,
      feeProvenanceVerified: false, liveAllowed: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NOT_FOR_OUTPUT');
  });
  it.each([null, [], {}, undefined, 1, 'PRIVATE_NOT_FOR_OUTPUT'])('rejects invalid root %s', input => {
    expect(assessOrderFeeBudget(input)).toMatchObject({ calculationPassed: false, reasons: ['invalid-fee-budget-input'], diagnostics: null });
  });
  it.each([
    ['zero quantity', (v: any) => { v.intent.baseQuantity = '0'; }],
    ['zero limit', (v: any) => { v.intent.limitPrice = '0'; }],
    ['buy cap below limit notional', (v: any) => { v.intent.maxQuoteAmount = '99.999999999999999999'; }],
    ['numeric cap', (v: any) => { v.intent.feeCaps.USDT = 1; }],
    ['negative cap', (v: any) => { v.intent.feeCaps.USDT = '-1'; }],
    ['missing native cap', (v: any) => { delete v.intent.feeCaps.BTC; }],
    ['excess precision', (v: any) => { v.intent.feeCaps.USDT = '0.0000000000000000001'; }],
    ['market order', (v: any) => { v.intent.orderType = 'market'; }],
    ['post-only promise', (v: any) => { v.intent.postOnly = true; }],
    ['OKX MX cap', (v: any) => { v.intent.venue = 'okx'; v.intent.feeCaps.MX = '1'; }],
    ['private malformed quantity', (v: any) => { v.intent.baseQuantity = 'PRIVATE_NOT_FOR_OUTPUT'; }],
  ])('reuses lifecycle restriction for %s', (_label, mutate) => {
    const input = sample(); mutate(input); const result = assessOrderFeeBudget(input);
    expect(result).toMatchObject({ calculationPassed: false, reasons: ['invalid-fee-intent'], diagnostics: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NOT_FOR_OUTPUT');
  });
});
