import { describe, expect, it } from 'vitest';
import { PaperAccount, canonical, type AccountConfig } from '../src/paper-v2/ledger.js';
import type { Book } from '../src/paper-v2/exact.js';
import type { Step } from '../src/paper-v2/schema.js';

const T = 1_000_000;
function config(venue: AccountConfig['venue'] = 'bybit'): AccountConfig {
  return { venue, symbol: 'BTC/USDT', opening: { USDT: '1000', BTC: '0' },
    costs: { feeBps: 0, slippageBps: 0, feeAsset: 'USDT' },
    instrument: { venue, symbol: 'BTC/USDT', fetchedAt: T - 100, trading: true,
      minQuantity: '0.00000001', maxQuantity: '100', quantityStep: '0.00000001' } };
}
function book(at: number, bid = '0.9', ask = '1', venue: Book['venue'] = 'bybit'): Book {
  return { venue, symbol: 'BTC/USDT', bids: [[bid, '10']], asks: [[ask, '10']],
    requestedAt: at - 20, receivedAt: at - 10, sourceAt: at - 15 };
}
function trade(id: string, at: number, side: 'buy' | 'sell', quantity: string,
  bid = '0.9', ask = '1', venue: Book['venue'] = 'bybit'): Step {
  return { id, at, book: book(at, bid, ask, venue), intent: { side, quantity } };
}

describe('paper-v2 ledger adversarial accounting', () => {
  it('releases FIFO costs across lots and carries a fractional atom to the final close', () => {
    const account = new PaperAccount(config());
    // First lot costs 1.5 quote atoms, rounded up to 2; second costs exactly 3.
    account.apply(trade('a', T, 'buy', '0.00000003', '0.4', '0.5'));
    account.apply(trade('b', T + 100, 'buy', '0.00000002', '1', '1.5'));
    const partial = account.apply(trade('c', T + 200, 'sell', '0.00000004', '2', '3'));
    // Close all of lot a (2 atoms cost) and half of b (floor(3/2) = 1).
    expect(partial.releasedCostUSDT).toBe('0.00000003');
    expect(partial.realisedPnLUSDT).toBe('0.00000005');
    expect(partial.account.lots).toEqual([{ id: 'fill:b', quantityBTC: '0.00000001', costUSDT: '0.00000002' }]);
    const close = account.apply(trade('d', T + 300, 'sell', '0.00000001', '2', '3'));
    expect(close.releasedCostUSDT).toBe('0.00000002');
    expect(close.realisedPnLUSDT).toBe('0.00000000');
    expect(account.snapshot()).toMatchObject({ balances: { bybit: { BTC: '0.00000000', USDT: '1000.00000005' } },
      realisedPnLUSDT: '0.00000005', costBasisUSDT: '0.00000000', lots: [], reconciled: true });
  });

  it('preserves cents and atoms above Number.MAX_SAFE_INTEGER', () => {
    const input = config(); input.opening.USDT = '9007199254740993.00000001';
    const account = new PaperAccount(input);
    account.apply(trade('buy', T, 'buy', '1'));
    expect(account.snapshot().balances.bybit?.USDT).toBe('9007199254740992.00000001');
    account.apply(trade('sell', T + 100, 'sell', '1', '2', '3'));
    expect(account.snapshot().balances.bybit?.USDT).toBe('9007199254740994.00000001');
    expect(account.snapshot().realisedPnLUSDT).toBe('1.00000000');
  });

  it('capitalises buy costs, deducts exit costs and never counts fees twice', () => {
    const input = config(); input.costs = { feeBps: 10, slippageBps: 5, feeAsset: 'USDT' };
    const account = new PaperAccount(input);
    const purchase = account.apply(trade('buy', T, 'buy', '1', '99', '100'));
    expect(purchase.postings.USDT).toBe('-100.15005000');
    expect(purchase.feeUSDT).toBe('0.10005000');
    const before = account.snapshot();
    expect(account.value(book(T + 100, '110', '111'), T + 100)).toMatchObject({ available: true,
      equityUSDT: '1009.68500500', liquidationUSDT: '109.83505500', unrealisedPnLUSDT: '9.68500500' });
    expect(account.snapshot()).toEqual(before); // Valuation never posts hypothetical exit fees.
    const sale = account.apply(trade('sell', T + 100, 'sell', '1', '110', '111'));
    expect(sale.postings.USDT).toBe('109.83505500');
    expect(account.snapshot()).toMatchObject({ realisedPnLUSDT: '9.68500500', feesUSDT: '0.20999500',
      balances: { bybit: { BTC: '0.00000000', USDT: '1009.68500500' } }, costBasisUSDT: '0.00000000' });
  });

  it.each([
    ['missing-book', () => ({ id: 'bad', at: T, intent: { side: 'buy', quantity: '1' } } as Step)],
    ['insufficient-cash', () => trade('bad', T, 'buy', '1', '1000', '1001')],
    ['insufficient-base', () => trade('bad', T, 'sell', '1')],
    ['insufficient-depth', () => { const s = trade('bad', T, 'buy', '1'); s.book!.asks[0][1] = '0.5'; return s; }],
    ['book-account-mismatch', () => trade('bad', T, 'buy', '1', '0.9', '1', 'okx')],
    ['stale-or-invalid-receipt-time', () => { const s = trade('bad', T, 'buy', '1'); s.book = book(T - 6000); return s; }],
  ] as const)('rejects %s without changing balances, lots, fees or rounding', (reason, make) => {
    const account = new PaperAccount(config()), before = account.snapshot();
    const event = account.apply(make());
    expect(event).toMatchObject({ status: 'rejected', reason, feeUSDT: '0.00000000',
      postings: { BTC: '0.00000000', USDT: '0.00000000' } });
    expect(account.snapshot()).toEqual(before);
    expect(account.events()).toHaveLength(1); // Rejection remains auditable.
  });

  it('does not use books received after the event, even within one second', () => {
    const account = new PaperAccount(config()), before = account.snapshot();
    const step = trade('future', T, 'buy', '1'); step.book = book(T + 100);
    expect(account.apply(step).status).toBe('rejected');
    expect(account.snapshot()).toEqual(before);
  });

  it('does not use instrument rules fetched after the event', () => {
    const input = config(); input.instrument.fetchedAt = T + 100;
    const account = new PaperAccount(input), before = account.snapshot();
    expect(account.apply(trade('future-rules', T, 'buy', '1')).status).toBe('rejected');
    expect(account.snapshot()).toEqual(before);
  });

  it('deduplicates old accepted and rejected IDs, but rejects conflicting payloads', () => {
    const account = new PaperAccount(config());
    const rejected = trade('reject', T, 'sell', '1');
    const first = trade('first', T + 100, 'buy', '1');
    const rejection = account.apply(rejected), fill = account.apply(first);
    account.apply(trade('later', T + 200, 'sell', '0.5', '2', '3'));
    const before = account.snapshot(), journal = account.events();
    expect(account.apply(rejected)).toEqual(rejection);
    expect(account.apply(structuredClone(first))).toEqual(fill);
    expect(() => account.apply({ ...first, intent: { side: 'buy', quantity: '2' } })).toThrow('event-id-conflict');
    expect(() => account.apply(trade('new-old', T + 50, 'buy', '1'))).toThrow('out-of-order-event');
    expect(account.snapshot()).toEqual(before);
    expect(account.events()).toEqual(journal);
  });

  it('replaying a prefix and remainder equals one full replay, including duplicate delivery', () => {
    const steps = [trade('a', T, 'buy', '0.00000003', '0.4', '0.5'),
      trade('b', T + 100, 'buy', '0.00000002', '1', '1.5'),
      trade('c', T + 200, 'sell', '0.00000004', '2', '3'),
      trade('d', T + 300, 'sell', '0.00000001', '2', '3')];
    const whole = new PaperAccount(config()), resumed = new PaperAccount(config());
    steps.forEach(s => whole.apply(s));
    steps.slice(0, 2).forEach(s => resumed.apply(s));
    // A consumer can redeliver the prefix without creating new fills.
    steps.forEach(s => resumed.apply(s));
    expect(canonical(resumed.events())).toBe(canonical(whole.events()));
    expect(resumed.snapshot()).toEqual(whole.snapshot());
  });

  it('defensively copies configuration, input books, returned events and snapshots', () => {
    const input = config(), account = new PaperAccount(input);
    input.costs.feeBps = 9999; input.instrument.trading = false; input.opening.USDT = '0';
    const step = trade('first', T, 'buy', '1'), original = structuredClone(step);
    const returned = account.apply(step), stored = structuredClone(returned);
    step.book!.asks[0][0] = '999';
    returned.account.lots[0].costUSDT = '0'; returned.account.balances.bybit!.USDT = '0';
    returned.fill!.cashUSDT = '0';
    const snapshot = account.snapshot(); snapshot.lots[0].quantityBTC = '99';
    const events = account.events(); events[0].account.costBasisUSDT = '0'; events.length = 0;
    expect(account.apply(original)).toEqual(stored);
    expect(account.events()).toEqual([stored]);
    expect(account.snapshot()).toEqual(stored.account);
    expect(account.snapshot().balances.bybit?.USDT).toBe('999.00000000');
  });

  it('keeps funded venues separate and rejects a fill from a different venue', () => {
    const bybit = new PaperAccount(config('bybit')), okx = new PaperAccount(config('okx'));
    bybit.apply(trade('same-id', T, 'buy', '1'));
    okx.apply(trade('same-id', T, 'buy', '2', '0.9', '1', 'okx'));
    const okxBefore = okx.snapshot();
    expect(bybit.apply(trade('wrong-venue', T + 100, 'sell', '1', '2', '3', 'okx')).status).toBe('rejected');
    expect(bybit.snapshot().balances).toEqual({ bybit: { BTC: '1.00000000', USDT: '999.00000000' } });
    expect(okx.snapshot()).toEqual(okxBefore);
    expect(okxBefore.balances).toEqual({ okx: { BTC: '2.00000000', USDT: '998.00000000' } });
  });

  it('requires opening cost, values initial BTC, and exposes missing/stale valuation', () => {
    const input = config(); input.opening = { USDT: '10', BTC: '2' };
    expect(() => new PaperAccount(input)).toThrow('missing-opening-cost');
    input.opening.costBasisUSDT = '100';
    const account = new PaperAccount(input), before = account.snapshot();
    expect(account.value(book(T, '60', '61'), T)).toMatchObject({ available: true,
      equityUSDT: '130.00000000', liquidationUSDT: '120.00000000', unrealisedPnLUSDT: '20.00000000' });
    expect(account.value(undefined, T)).toEqual({ available: false, at: T, reason: 'missing-book' });
    expect(account.value(book(T - 6000), T)).toMatchObject({ available: false, reason: 'stale-or-invalid-receipt-time' });
    const shallow = book(T); shallow.bids[0][1] = '1';
    expect(account.value(shallow, T)).toMatchObject({ available: false, reason: 'insufficient-depth' });
    expect(account.snapshot()).toEqual(before);
    const sale = account.apply(trade('close-half', T, 'sell', '1', '60', '61'));
    expect(sale.releasedCostUSDT).toBe('50.00000000');
    expect(sale.account.realisedPnLUSDT).toBe('10.00000000');
    expect(account.value(book(T, '60', '61'), T)).toMatchObject({ available: true,
      equityUSDT: '130.00000000', unrealisedPnLUSDT: '10.00000000' });
  });

  it('values a cash-only account without fabricated market data', () => {
    const account = new PaperAccount(config());
    expect(account.value(undefined, T)).toEqual({ available: true, at: T, equityUSDT: '1000.00000000',
      liquidationUSDT: '0.00000000', unrealisedPnLUSDT: '0.00000000', sourceTimePresent: null });
    expect(account.events()).toEqual([]);
  });
});
