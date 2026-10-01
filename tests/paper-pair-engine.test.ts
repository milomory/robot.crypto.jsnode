import { describe, it, expect } from 'vitest';
import { quotePair, quoteBook, evaluatePair, createPairState, applyPairEvent, replayPairJournal, viewPairState } from '../src/paper-pair/engine.js';
import { T, market, opening, prepare, leg } from './helpers/pair-fixtures.js';

describe('independent two-leg exact paper accounting', () => {
  it('charges exact fee/slippage per venue with adverse quote rounding', () => {
    const q = quotePair(market());
    expect(q).toMatchObject({ buy: { cashUsdt: '10.015005', feeUsdt: '0.010005' },
      sell: { cashUsdt: '10.1847051', feeUsdt: '0.0101949' }, netUsdt: '0.1697001' });
    const input = market(); input.buy.costs.feeBps = '0.125'; expect(quotePair(input).buy.feeUsdt).toBe('0.00012507');
  });
  it('walks several price levels exactly', () => {
    const m = market(); m.buy.book.asks = [['100', '0.03'], ['101', '0.07']];
    expect(quotePair(m).buy.rawNotionalUsdt).toBe('10.07');
  });
  it('can report negative economics without authorizing a pair', () => {
    const m = market(); m.sell.book.bids = [['99', '1']];
    expect(quotePair(m).netUsdt.startsWith('-')).toBe(true);
    expect(() => evaluatePair({ ...m, balances: opening })).toThrow('non-positive-net');
  });
  it('validates rules, depth, age and alignment before reservation', () => {
    const changes = [
      (m: ReturnType<typeof market>) => { m.quantity = '0.11'; },
      (m: ReturnType<typeof market>) => { m.buy.book.asks = [['100', '0.01']]; },
      (m: ReturnType<typeof market>) => { m.buy.book.requestedAt = T - 5001; },
      (m: ReturnType<typeof market>) => { m.sell.book.requestedAt = T - 2000; m.sell.book.receivedAt = T - 1500; },
      (m: ReturnType<typeof market>) => { m.buy.instrument.minNotional = '11'; }
    ];
    for (const change of changes) { const m = market(); change(m); expect(() => quotePair(m)).toThrow(); }
  });
  it('keeps price-only arithmetic separate from eligibility', () => {
    const m = market(); m.buy.instrument.trading = false;
    expect(() => quotePair(m)).toThrow();
    expect(quoteBook(m.buy.book, 'buy', m.quantity, m.buy.costs, m.now).cashUsdt).toBe('10.015005');
  });
  it('requires capital on the correct venue, never pooling or borrowing it', () => {
    const balances = structuredClone(opening); balances.mexc.usdt = '0'; balances.okx.usdt = '999999';
    expect(() => evaluatePair({ ...market(), balances })).toThrow('insufficient-inventory');
    balances.mexc.usdt = '1000'; balances.okx.btc = '0';
    expect(() => evaluatePair({ ...market(), balances })).toThrow('insufficient-inventory');
  });
  it('reserves both legs atomically and blocks every overlapping pair', () => {
    const state = applyPairEvent(createPairState(opening), prepare());
    expect(viewPairState(state).reserved).toEqual({ mexc: { btc: '0', usdt: '10.015005' }, okx: { btc: '0.1', usdt: '0' } });
    const oneFilled = applyPairEvent(state, leg('buy', '0.1', 'filled'));
    expect(() => applyPairEvent(oneFilled, { ...prepare(), id: 'prepare-2', pairId: 'pair-2', at: T + 101 })).toThrow('unresolved-exposure');
    expect(viewPairState(state).balances).toEqual(opening);
  });
  it('partial fills below original minimum preserve remaining reservations and fees partition independently', () => {
    const state = applyPairEvent(createPairState(opening), prepare());
    const partial = applyPairEvent(state, leg('buy', '0.00001', 'partial', 'part'));
    expect(viewPairState(partial).reserved.mexc.usdt).not.toBe('0');
    const fromPartial = applyPairEvent(partial, leg('buy', '0.1', 'filled'));
    const direct = applyPairEvent(state, leg('buy', '0.1', 'filled'));
    expect(viewPairState(fromPartial).balances).toEqual(viewPairState(direct).balances);
    expect(viewPairState(fromPartial).positions).toEqual(viewPairState(direct).positions);
  });
  it('unknown outcome retains reserves and demands explicit reconciliation', () => {
    let state = applyPairEvent(createPairState(opening), prepare());
    state = applyPairEvent(state, leg('buy', '0.02', 'unknown'));
    expect(viewPairState(state).reserved.mexc.usdt).not.toBe('0');
    expect(() => applyPairEvent(state, leg('buy', '0.1', 'filled', 'retry'))).toThrow('reconciliation-required');
    state = applyPairEvent(state, { ...leg('buy', '0.1', 'filled', 'reconcile'), type: 'reconcile', status: 'filled', at: T + 86_400_000 });
    expect(viewPairState(state).balances.mexc.btc).toBe('1.1');
    expect(viewPairState(state).reserved.mexc.usdt).toBe('0');
  });
  it('does not execute a new fill on yesterday’s book', () => {
    const state = applyPairEvent(createPairState(opening), prepare());
    expect(() => applyPairEvent(state, { ...leg('buy', '0.1', 'filled'), at: T + 86_400_000 })).toThrow('stale-or-invalid-book-time');
  });
  it('keeps one-leg failure visible as residual exposure without inventing recovery', () => {
    const journal = [prepare(), leg('buy', '0.1', 'filled'), leg('sell', '0.04', 'rejected')];
    const state = replayPairJournal(opening, journal), view = viewPairState(state);
    expect(view.positions[0]).toMatchObject({ settlement: 'residual-exposure', residualBtc: '0.06' });
    expect(view.reserved).toEqual({ mexc: { btc: '0', usdt: '0' }, okx: { btc: '0', usdt: '0' } });
    expect(() => applyPairEvent(state, { ...prepare(), id: 'new', pairId: 'new', at: T + 102 })).toThrow('unresolved-exposure');
  });
  it('restarts deterministically, ignores exact duplicates, rejects conflicts without state damage', () => {
    const events = [prepare(), leg('buy', '0.04', 'partial', 'part'), leg('buy', '0.1', 'filled'), leg('sell', '0.1', 'filled')];
    const state = replayPairJournal(opening, events);
    expect(applyPairEvent(state, events[0])).toBe(state);
    const restored = events.slice(2).reduce(applyPairEvent, replayPairJournal(opening, events.slice(0, 2)));
    expect(viewPairState(restored)).toEqual(viewPairState(state));
    const before = viewPairState(state);
    expect(() => applyPairEvent(state, { ...events[0], at: T + 1 })).toThrow('event-id-conflict');
    expect(viewPairState(state)).toEqual(before);
    expect(viewPairState(state).positions[0]).toMatchObject({ cashDeltaUsdt: '0.1697001', residualBtc: '0', settlement: 'balanced' });
  });
  it('rejects cumulative regression and negative balances without partial posting', () => {
    const state = replayPairJournal(opening, [prepare(), leg('buy', '0.04', 'partial', 'part')]); const before = viewPairState(state);
    expect(() => applyPairEvent(state, leg('buy', '0.03', 'partial', 'regress'))).toThrow('invalid-cumulative-fill');
    expect(viewPairState(state)).toEqual(before);
    const bad = structuredClone(opening); bad.mexc.usdt = '1';
    expect(() => applyPairEvent(createPairState(bad), prepare())).toThrow('insufficient-inventory');
  });
});
