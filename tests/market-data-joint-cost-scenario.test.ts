import { describe, expect, it } from 'vitest';
import { calculateJointCostScenario, JOINT_SCENARIO_LEGS,
  type JointCostScenarioInput, type JointScenarioLegInput, type JointScenarioLegName } from '../src/market-data/joint-cost-scenario.js';

const leg = (price: string, feeBps = '0', quantityBase = '1'): JointScenarioLegInput => ({ levels: [{ price, quantityBase }], feeBps });
const scenario = (): JointCostScenarioInput => ({ quantityBase: '1',
  longEntry: leg('100', '2'), shortEntry: leg('103', '3'), longExit: leg('101', '4'), shortExit: leg('102', '5'),
  fundingQuote: '0.5', borrowQuote: '0.1', rebalanceQuote: '0.2', safetyQuote: '0.3' });
const noExtras = () => ({ fundingQuote: '0', borrowQuote: '0', rebalanceQuote: '0', safetyQuote: '0' });
const equalPrices = (price = '100', quantityBase = '1', feeBps = '0'): JointCostScenarioInput => ({ quantityBase,
  longEntry: leg(price, feeBps, quantityBase), shortEntry: leg(price, feeBps, quantityBase),
  longExit: leg(price, feeBps, quantityBase), shortExit: leg(price, feeBps, quantityBase), ...noExtras() });
const unsafe = (value: unknown) => value as JointCostScenarioInput;
const smallest = '0.000000000000000000000000000001';

// Synthetic caller-declared cost scenarios; none are observed or executable profit.
describe('offline explicit four-leg hedge cost scenario', () => {
  it('accounts for four independently priced executions, four tariffs and all signed/additional costs', () => {
    const result = calculateJointCostScenario(scenario());
    expect(result).toMatchObject({ schema: 1, kind: 'offline-four-leg-cost-scenario', status: 'complete',
      quantityBase: '1', grossPricePnl: '2', totalFeesQuote: '0.1423', fundingQuote: '0.5',
      borrowQuote: '0.1', rebalanceQuote: '0.2', safetyQuote: '0.3', netQuote: '1.7577', netEdgeBps: '175.77',
      netEdgeDenominator: 'long-entry-quote', netEdgeDenominatorQuote: '100', reasons: [],
      scenarioOnly: true, accountFeesVerified: false, bookFreshnessVerified: false, marketIdentityVerified: false, executable: false });
    expect(result.legs.longEntry).toMatchObject({ side: 'BUY', quote: '100', feeBps: '2', feeQuote: '0.02' });
    expect(result.legs.shortEntry).toMatchObject({ side: 'SELL', quote: '103', feeBps: '3', feeQuote: '0.0309' });
    expect(result.legs.longExit).toMatchObject({ side: 'SELL', quote: '101', feeBps: '4', feeQuote: '0.0404' });
    expect(result.legs.shortExit).toMatchObject({ side: 'BUY', quote: '102', feeBps: '5', feeQuote: '0.051' });
  });
  it('does not turn a positive entry spread into profit when the basis does not converge', () => {
    const input: JointCostScenarioInput = { quantityBase: '1', longEntry: leg('100', '10'), shortEntry: leg('103', '10'),
      longExit: leg('100', '10'), shortExit: leg('103', '10'), ...noExtras() };
    expect(calculateJointCostScenario(input)).toMatchObject({ grossPricePnl: '0', totalFeesQuote: '0.406',
      netQuote: '-0.406', netEdgeBps: '-40.6', executable: false });
  });
  it('keeps missing exit books unknown rather than assuming basis convergence or zero closing costs', () => {
    const input = { ...scenario(), longExit: null, shortExit: { levels: null, feeBps: '5' } };
    const result = calculateJointCostScenario(input);
    expect(result).toMatchObject({ status: 'blocked', grossPricePnl: null, totalFeesQuote: null, netQuote: null, netEdgeBps: null });
    expect(result.reasons).toEqual(['longExit:fee-missing', 'longExit:book-missing', 'shortExit:book-missing']);
    expect(result.legs.longEntry.quote).toBe('100');
    expect(result.legs.shortExit.feeBps).toBe('5');
  });
  it('walks the same base quantity on every leg and does not double deduct slippage', () => {
    const rows = (pairs: [string, string][]): JointScenarioLegInput => ({ levels: pairs.map(([price, quantityBase]) => ({ price, quantityBase })), feeBps: '0' });
    const input: JointCostScenarioInput = { quantityBase: '2',
      longEntry: rows([['100', '1'], ['102', '2']]), shortEntry: rows([['110', '1'], ['108', '2']]),
      longExit: rows([['101', '1'], ['100', '2']]), shortExit: rows([['105', '1'], ['107', '2']]), ...noExtras() };
    const result = calculateJointCostScenario(input);
    expect(result).toMatchObject({ grossPricePnl: '5', totalFeesQuote: '0', netQuote: '5',
      netEdgeBps: '247.524752475247524752475247524752' });
    expect(JOINT_SCENARIO_LEGS.map(name => result.legs[name].quote)).toEqual(['202', '218', '201', '212']);
    expect(JOINT_SCENARIO_LEGS.map(name => result.legs[name].slippageQuote)).toEqual(['2', '2', '1', '2']);
    for (const name of JOINT_SCENARIO_LEGS) expect(result.legs[name]).toMatchObject({ quantityBase: '2', filledQuantityBase: '2',
      unfilledQuantityBase: '0', levelsUsed: 2, depthComplete: true, feeQuote: '0' });
  });
  it('subtracts negative funding and floors negative bps instead of truncating toward zero', () => {
    const input = { ...equalPrices('3'), fundingQuote: '-1' };
    expect(calculateJointCostScenario(input)).toMatchObject({ grossPricePnl: '0', netQuote: '-1',
      netEdgeBps: '-3333.333333333333333333333333333334' });
  });
  it('floors positive recurring bps at 30 decimal places', () => {
    expect(calculateJointCostScenario({ ...equalPrices('3'), fundingQuote: '1' })).toMatchObject({ netQuote: '1',
      netEdgeBps: '3333.333333333333333333333333333333' });
  });
  it.each(['fundingQuote', 'borrowQuote', 'rebalanceQuote', 'safetyQuote'] as const)('requires explicit %s, including zero', name => {
    const input = { ...equalPrices(), [name]: null }, result = calculateJointCostScenario(input);
    expect(result).toMatchObject({ status: 'blocked', grossPricePnl: '0', totalFeesQuote: '0', netQuote: null, netEdgeBps: null });
    expect(result.reasons).toEqual([`${name}:missing`]);
    expect(calculateJointCostScenario({ ...input, [name]: '0' }).status).toBe('complete');
  });
  it.each(JOINT_SCENARIO_LEGS)('requires an explicit %s tariff rather than using a default', name => {
    const input = scenario(); input[name] = { ...input[name]!, feeBps: null };
    const result = calculateJointCostScenario(input);
    expect(result).toMatchObject({ grossPricePnl: '2', totalFeesQuote: null, netQuote: null, netEdgeBps: null });
    expect(result.reasons).toEqual([`${name}:fee-missing`]);
    expect(result.legs[name].quote).not.toBeNull();
  });
  it.each(JOINT_SCENARIO_LEGS)('blocks when %s depth cannot fill the exact matched base quantity', name => {
    const input = scenario(); input[name] = leg('100', '2', '0.999999999999999999999999999999');
    const result = calculateJointCostScenario(input);
    expect(result).toMatchObject({ status: 'blocked', grossPricePnl: null, totalFeesQuote: null, netQuote: null, netEdgeBps: null });
    expect(result.reasons).toEqual([`${name}:insufficient-depth`]);
    expect(result.legs[name]).toMatchObject({ depthComplete: false, quote: null, feeQuote: null,
      filledQuantityBase: '0.999999999999999999999999999999', unfilledQuantityBase: smallest, levelsUsed: 1 });
  });
  it('reports every unavailable component without treating an empty book as a free fill', () => {
    const input: JointCostScenarioInput = { quantityBase: '1', longEntry: { levels: [], feeBps: null }, shortEntry: null,
      longExit: null, shortExit: null, fundingQuote: null, borrowQuote: null, rebalanceQuote: null, safetyQuote: null };
    const result = calculateJointCostScenario(input);
    expect(result.reasons).toHaveLength(12);
    expect(result.reasons).toContain('longEntry:insufficient-depth');
    expect(result.legs.longEntry).toMatchObject({ levelsUsed: 0, filledQuantityBase: '0', unfilledQuantityBase: '1' });
    expect(result.netEdgeDenominatorQuote).toBeNull();
    expect(result.netEdgeBps).toBeNull();
  });
  it('accepts exactly fifty rows without silently truncating fifty-one', () => {
    const input = equalPrices('100', '50');
    input.longEntry = { levels: Array.from({ length: 50 }, (_, i) => ({ price: String(100 + i), quantityBase: '1' })), feeBps: '0' };
    expect(calculateJointCostScenario(input).legs.longEntry).toMatchObject({ quote: '6225', filledQuantityBase: '50', levelsUsed: 50 });
    input.longEntry.levels = [...input.longEntry.levels!, { price: '150', quantityBase: '1' }];
    expect(() => calculateJointCostScenario(input)).toThrow('invalid-joint-scenario-book');
  });
  it('preserves native BigInt precision above the IEEE safe-integer range', () => {
    const quantity = '9007199254740993';
    const result = calculateJointCostScenario({ ...equalPrices('2', quantity), fundingQuote: '0.000000000000000000000000000001' });
    expect(result.legs.longEntry.quote).toBe('18014398509481986');
    expect(result.quantityBase).toBe(quantity);
    expect(result.netQuote).toBe(smallest);
    expect(result.netEdgeBps).toBe('0');
  });
  it('allows exact products wider than input whole-number bounds without Number overflow or rejection', () => {
    const max = '999999999999999999999999999999';
    const expectedQuote = (BigInt(max) * BigInt(max)).toString();
    const result = calculateJointCostScenario(equalPrices(max, max, '10000'));
    expect(result.legs.longEntry.quote).toBe(expectedQuote);
    expect(result.legs.longEntry.feeQuote).toBe(expectedQuote);
    expect(result.totalFeesQuote).toBe((4n * BigInt(expectedQuote)).toString());
    expect(result.netQuote).toBe((-4n * BigInt(expectedQuote)).toString());
    expect(result.netEdgeBps).toBe('-40000');
  });
  it('ceil-rounds tiny buy outflows and floor-rounds tiny sell inflows instead of losing precision silently', () => {
    const result = calculateJointCostScenario(equalPrices('0.1', smallest));
    expect(result.legs.longEntry.quote).toBe(smallest);
    expect(result.legs.shortEntry.quote).toBe('0');
    expect(result.legs.longExit.quote).toBe('0');
    expect(result.legs.shortExit.quote).toBe(smallest);
    expect(result.grossPricePnl).toBe('-0.000000000000000000000000000002');
    expect(result.netEdgeBps).toBe('-20000');
  });
  it('ceil-rounds sell fees from exact unrounded quote even when conservative sell cash rounds to zero', () => {
    const result = calculateJointCostScenario(equalPrices('0.1', smallest, '1'));
    expect(result.legs.shortEntry.quote).toBe('0');
    for (const name of JOINT_SCENARIO_LEGS) expect(result.legs[name].feeQuote).toBe(smallest);
    expect(result.totalFeesQuote).toBe('0.000000000000000000000000000004');
    expect(result.netQuote).toBe('-0.000000000000000000000000000006');
  });
  it('rounds each complete leg once after summing price/quantity products', () => {
    const input = equalPrices('1', '0.000000000000000000000000000002');
    input.longEntry = { levels: [{ price: '0.1', quantityBase: smallest }, { price: '0.2', quantityBase: smallest }], feeBps: '0' };
    expect(calculateJointCostScenario(input).legs.longEntry).toMatchObject({ quote: smallest, levelsUsed: 2 });
  });
  it('preserves exact exponent input and normalizes negative funding zero', () => {
    const input = { ...equalPrices('1e2', '1e-2', '1e1'), fundingQuote: '-0.000' };
    expect(calculateJointCostScenario(input)).toMatchObject({ quantityBase: '0.01', fundingQuote: '0', totalFeesQuote: '0.004',
      netQuote: '-0.004', netEdgeBps: '-40' });
  });
  it('leaves caller inputs unchanged and freezes the detached result', () => {
    const input = scenario(), before = structuredClone(input), result = calculateJointCostScenario(input);
    expect(input).toEqual(before); expect(Object.isFrozen(input)).toBe(false);
    input.longEntry!.levels![0].price = '99';
    expect(result.legs.longEntry.quote).toBe('100');
    for (const value of [result, result.legs, result.legs.longEntry, result.reasons]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { result.reasons.push('fundingQuote:missing'); }).toThrow();
  });
});

describe('closed malformed-input rejection for joint cost scenarios', () => {
  it.each([null, undefined, [], {}, { ...scenario(), extra: 'field' }, { ...scenario(), quantityBase: undefined }])('rejects malformed root %j', value => {
    expect(() => calculateJointCostScenario(unsafe(value))).toThrow(/invalid-joint/);
  });
  it.each(['', '0', '-1', 'NaN', 'Infinity', ' 1', '1 ', '+1', '01', '0.0000000000000000000000000000001', '1e31',
    '1'.repeat(1000), 1, NaN, Infinity, null])('rejects nonpositive, imprecise or native quantity %s', value => {
    expect(() => calculateJointCostScenario(unsafe({ ...scenario(), quantityBase: value }))).toThrow('invalid-joint-scenario-number');
  });
  it.each(JOINT_SCENARIO_LEGS)('refuses a rebate on %s instead of adding invented revenue', name => {
    const input = scenario(); input[name] = { ...input[name]!, feeBps: '-0.01' };
    expect(() => calculateJointCostScenario(input)).toThrow('invalid-joint-scenario-number');
  });
  it.each(['10000.000000000000000000000000000001', '10001'])('rejects an out-of-contract tariff %s bps', feeBps => {
    const input = scenario(); input.longEntry!.feeBps = feeBps;
    expect(() => calculateJointCostScenario(input)).toThrow('invalid-joint-scenario-fee');
  });
  it.each(['borrowQuote', 'rebalanceQuote', 'safetyQuote'] as const)('refuses negative %s rather than silently treating it as income', name => {
    expect(() => calculateJointCostScenario({ ...scenario(), [name]: '-0.01' })).toThrow('invalid-joint-scenario-number');
  });
  it.each(['fundingQuote', 'borrowQuote', 'rebalanceQuote', 'safetyQuote'] as const)('refuses omitted/native %s rather than assuming zero', name => {
    const omitted = { ...scenario() } as unknown as Record<string, unknown>; delete omitted[name];
    expect(() => calculateJointCostScenario(unsafe(omitted))).toThrow('invalid-joint-cost-scenario');
    expect(() => calculateJointCostScenario(unsafe({ ...scenario(), [name]: 0 }))).toThrow('invalid-joint-scenario-number');
    expect(() => calculateJointCostScenario(unsafe({ ...scenario(), [name]: undefined }))).toThrow('invalid-joint-scenario-number');
  });
  it.each([undefined, [], {}, { levels: [], feeBps: '0', side: 'SELL' }, { levels: [], feeBps: undefined }, { levels: undefined, feeBps: '0' }])('rejects malformed leg %j', value => {
    expect(() => calculateJointCostScenario(unsafe({ ...scenario(), longEntry: value }))).toThrow(/invalid-joint/);
  });
  it.each([
    [{ price: '100', quantityBase: '1' }, { price: '100', quantityBase: '1' }],
    [{ price: '100', quantityBase: '1' }, { price: '99', quantityBase: '1' }],
    [{ price: '0', quantityBase: '1' }], [{ price: '100', quantityBase: '0' }],
    [{ price: '100', quantityBase: '-1' }], [{ price: 100, quantityBase: '1' }],
    [{ price: '100', quantityBase: 1 }], [{ price: '100' }], [{ price: '100', quantityBase: '1', extra: true }],
    [null], ['100'], Array(1), 'not-levels', {},
  ])('rejects malformed/unsorted/duplicate BUY levels, including unused tail %j', levels => {
    expect(() => calculateJointCostScenario(unsafe({ ...scenario(), longEntry: { levels, feeBps: '0' } }))).toThrow(/invalid-joint/);
  });
  it.each(['shortEntry', 'longExit'] as JointScenarioLegName[])('requires strictly descending %s SELL bids', name => {
    const input = scenario();
    input[name] = { levels: [{ price: '100', quantityBase: '1' }, { price: '101', quantityBase: '1' }], feeBps: '0' };
    expect(() => calculateJointCostScenario(input)).toThrow('invalid-joint-scenario-book');
  });
  it('validates malformed hidden rows even when another component already blocks net', () => {
    const input = { ...scenario(), fundingQuote: null };
    input.longEntry!.levels = [{ price: '100', quantityBase: '1' }, { price: '99', quantityBase: '1' }];
    expect(() => calculateJointCostScenario(input)).toThrow('invalid-joint-scenario-book');
  });
});
