import { afterEach, describe, expect, it, vi } from 'vitest';
import { MexcAccountReader } from '../src/accounts/mexc.js';
import { OkxAccountReader } from '../src/accounts/okx.js';
import { AccountTransport } from '../src/accounts/transport.js';
import { AccountError, type AccountSymbol } from '../src/accounts/types.js';
import { mexcTrades, mexcOrders, mexcTransfers, okxTrades, okxOrders, okxTransfers,
  type OperationFeed } from '../src/accounts/operation-records.js';
import { observeRecentOperations } from '../src/accounts/operations.js';
import { dashboardOperationSchema, type DashboardOperation } from '../src/accounts/dashboard-contract.js';

const now = 1_800_000_000_000, week = 7 * 86400_000;
const mexcCredentials = { apiKey: 'MEXC_TEST_KEY', apiSecret: 'MEXC_TEST_SECRET' };
const okxCredentials = { apiKey: 'OKX_TEST_KEY', apiSecret: 'OKX_TEST_SECRET', passphrase: 'OKX_TEST_PASSPHRASE' };
const mt = (delta: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', id: '123', price: '10000', qty: '0.01',
  quoteQty: '100', commission: '0.01', commissionAsset: 'USDT', time: now - 1000, isBuyer: true, ...delta });
const mo = (delta: Record<string, unknown> = {}) => ({ symbol: 'BTCUSDT', orderId: '123', origQty: '1',
  executedQty: '0.1', side: 'BUY', status: 'PARTIALLY_FILLED', time: now - 1000, ...delta });
const ot = (delta: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', billId: '123',
  fillSz: '0.01', fillPx: '10000', fee: '-0.01', feeCcy: 'USDT', fillTime: String(now - 1000), side: 'buy', ...delta });
const oo = (delta: Record<string, unknown> = {}) => ({ instType: 'SPOT', instId: 'BTC-USDT', ordId: '123',
  sz: '1', side: 'buy', state: 'live', cTime: String(now - 1000), ordType: 'limit', ...delta });
const md = (delta: Record<string, unknown> = {}) => ({ coin: 'USDT', amount: '5', status: 5, txId: 'synthetic-private-tx', insertTime: now - 1000, ...delta });
const mw = (delta: Record<string, unknown> = {}) => ({ coin: 'USDT', amount: '5', status: 3, id: 'withdraw-123', applyTime: now - 1000, transactionFee: '0', ...delta });
const od = (delta: Record<string, unknown> = {}) => ({ ccy: 'USDT', amt: '5', ts: String(now - 1000), state: '2', depId: 'deposit-123', ...delta });
const ow = (delta: Record<string, unknown> = {}) => ({ ccy: 'USDT', amt: '5', ts: String(now - 1000), state: '0', wdId: 'withdraw-123', fee: '0.1', feeCcy: 'USDT', ...delta });
const empty = (): OperationFeed => ({ items: [], truncated: false });
const item = (delta: Partial<DashboardOperation> = {}): DashboardOperation => ({ id: 'test:trade:1', venue: 'mexc', type: 'trade',
  symbol: 'BTC/USDT', asset: 'BTC', side: 'buy', amount: '0.01', quoteAmount: '100', fee: '0.01', feeAsset: 'USDT',
  status: 'completed', at: now - 1000, isOpen: false, ...delta });
function stubs() {
  const reader = () => ({ getOpenOrders: vi.fn(async () => empty()), getRecentTrades: vi.fn(async () => empty()),
    getDeposits: vi.fn(async () => empty()), getWithdrawals: vi.fn(async () => empty()) });
  return { mexc: reader(), okx: reader() };
}
afterEach(() => vi.useRealTimers());

describe('private operation projections', () => {
  it('retains exact amounts and strips addresses, memos, identities, private fields and raw exchange objects', () => {
    const digits = '0.123456789012345678901234567890';
    const result = mexcTransfers([md({ amount: digits, address: 'synthetic-private-address', memo: 'synthetic-private-memo',
      apiKey: 'synthetic-private-key' })], 'deposit', now);
    expect(result.items[0]).toMatchObject({ amount: digits, status: 'completed', type: 'deposit' });
    expect(result.items[0].id).toMatch(/^mexc:deposit:[a-f0-9]{32}$/);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
    expect(dashboardOperationSchema.safeParse(result.items[0]).success).toBe(true);
  });
  it('accepts an official pending MEXC withdrawal with null txId', () => {
    const result = mexcTransfers([mw({ txId: null })], 'withdrawal', now);
    expect(result.items[0]).toMatchObject({ status: 'pending', isOpen: true, fee: '0', feeAsset: 'USDT' });
  });
  it('requires deposit or withdrawal identity rather than emitting a made-up event', () => {
    expect(() => mexcTransfers([md({ txId: undefined })], 'deposit', now)).toThrow('account-invalid-response');
    expect(() => mexcTransfers([mw({ id: undefined })], 'withdrawal', now)).toThrow('account-invalid-response');
    expect(() => okxTransfers([ow({ wdId: undefined })], 'withdrawal', now)).toThrow('account-invalid-response');
  });
  it.each([['mexc', 'deposit'], ['mexc', 'withdrawal'], ['okx', 'deposit'], ['okx', 'withdrawal']] as const)(
    '%s %s unknown states never become success', (venue, kind) => {
      const result = venue === 'mexc' ? mexcTransfers([kind === 'deposit' ? md({ status: 999 }) : mw({ status: 999 })], kind, now)
        : okxTransfers([kind === 'deposit' ? od({ state: '999' }) : ow({ state: '999' })], kind, now);
      expect(result.items[0].status).toBe('unknown');
    });
  it('maps failure and cancellation separately from completion', () => {
    expect(mexcTransfers([mw({ status: 8 })], 'withdrawal', now).items[0].status).toBe('failed');
    expect(mexcTransfers([mw({ status: 9 })], 'withdrawal', now).items[0].status).toBe('cancelled');
    expect(okxTransfers([ow({ state: '-1' })], 'withdrawal', now).items[0].status).toBe('failed');
    expect(okxTransfers([ow({ state: '-2' })], 'withdrawal', now).items[0].status).toBe('cancelled');
    expect(okxTransfers([ow({ state: '2' })], 'withdrawal', now).items[0].status).toBe('completed');
  });
  it('preserves OKX fee cost/rebate sign and multiplies quote values without float conversion', () => {
    const values = okxTrades([ot({ billId: '1', fillSz: '0.000000000000000000000000000001', fillPx: '0.000000000000000000000000000002', fee: '-0.002' }),
      ot({ billId: '2', fee: '0.001' }), ot({ billId: '3', fee: '-0.000' })], now).items;
    expect(values[0].quoteAmount).toBe('0.' + '0'.repeat(59) + '2');
    expect(values.map(row => row.fee)).toEqual(['0.002', '-0.001', '0']);
    expect(okxTrades([ot({ fillSz: '0', fillPx: '0.1' })], now).items[0].quoteAmount).toBe('0');
  });
  it('uses native trade quote amount and identifies quote-sized market orders correctly', () => {
    expect(mexcTrades([mt({ quoteQty: '123.000000000000000000001' })], 'BTCUSDT', now).items[0].quoteAmount).toBe('123.000000000000000000001');
    expect(okxOrders([oo({ ordType: 'market', tgtCcy: 'quote_ccy', sz: '20' })], now).items[0]).toMatchObject({ asset: 'USDT', amount: '20', isOpen: true });
    expect(okxOrders([oo({ ordType: 'market', side: 'sell' })], now).items[0].asset).toBe('BTC');
    expect(okxOrders([oo({ ordType: 'market', tgtCcy: 'base_ccy' })], now).items[0].asset).toBe('BTC');
  });
  it('keeps identity stable across statuses and private metadata changes, rejects duplicates', () => {
    const before = okxOrders([oo()], now).items[0].id;
    expect(okxOrders([oo({ state: 'partially_filled', private: 'changed' })], now).items[0].id).toBe(before);
    expect(() => okxOrders([oo(), oo()], now)).toThrow('account-invalid-response');
    expect(() => mexcTrades([mt(), mt()], 'BTCUSDT', now)).toThrow('account-invalid-response');
  });
  it('does not mislabel unsupported quote currencies or unknown order states', () => {
    expect(() => mexcOrders([mo({ symbol: 'BTCXYZ' })], now)).toThrow('account-invalid-response');
    expect(() => mexcOrders([mo({ status: 'FUTURE_STATE' })], now)).toThrow('account-invalid-response');
    expect(() => okxOrders([oo({ state: 'future_state' })], now)).toThrow('account-invalid-response');
  });
  it.each([NaN, 1.1, '1e2', '-1', 'synthetic-private-value'])('rejects malformed money %s without echo', amount => {
    expect(() => mexcTrades([mt({ qty: amount })], 'BTCUSDT', now)).toThrow(/^account-invalid-response$/);
  });
  it('rejects wrong identity, unsafe numeric ids and future timestamps', () => {
    expect(() => mexcTrades([mt({ symbol: 'ETHUSDT' })], 'BTCUSDT', now)).toThrow('account-invalid-response');
    expect(() => mexcTrades([mt({ id: Number.MAX_SAFE_INTEGER + 1 })], 'BTCUSDT', now)).toThrow('account-invalid-response');
    expect(() => okxTrades([ot({ instType: 'SWAP' })], now)).toThrow('account-invalid-response');
    expect(() => mexcTrades([mt({ time: now + 1 })], 'BTCUSDT', now)).toThrow('account-invalid-response');
  });
  it('marks bounded feeds truncated instead of claiming the complete history', () => {
    expect(okxTrades(Array.from({ length: 100 }, (_, n) => ot({ billId: String(n) })), now).truncated).toBe(true);
    expect(mexcTrades(Array.from({ length: 99 }, (_, n) => mt({ id: String(n) })), 'BTCUSDT', now).truncated).toBe(false);
    expect(() => okxTrades(Array.from({ length: 1001 }, (_, n) => ot({ billId: String(n) })), now)).toThrow('account-invalid-response');
  });
});

describe('signed history reads and transport boundary', () => {
  it('signs the fixed MEXC trade window with the independent Python HMAC vector', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([mt()]));
    const client = new MexcAccountReader({ credentials: mexcCredentials, fetch, clock: () => now });
    await client.getRecentTrades('BTC/USDT');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.mexc.com/api/v3/myTrades?symbol=BTCUSDT&startTime=1799395200000&endTime=1800000000000&limit=100&recvWindow=5000&timestamp=1800000000000&signature=cf332d67c00b593c11f20f51f8ab0d626dca6372df031e3ddf525e1f386ce1e0',
      expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { 'X-MEXC-APIKEY': mexcCredentials.apiKey } }));
  });
  it('signs the exact OKX path and window using the independent Python HMAC vector', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: '0', data: [ot()] }));
    const client = new OkxAccountReader({ credentials: okxCredentials, fetch, clock: () => now });
    await client.getRecentTrades();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://www.okx.com/api/v5/trade/fills-history?instType=SPOT&begin=1799395200000&end=1800000000000&limit=100',
      expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: expect.objectContaining({ 'OK-ACCESS-TIMESTAMP': '2027-01-15T08:00:00.000Z', 'OK-ACCESS-SIGN': 'STGBr41uKEKI9m7+0O5uVX23WjZ/b+iv4uAhGJt7ikg=' }) }));
  });
  it('uses only fixed GETs for current orders, deposits and withdrawals and returns no raw private fields', async () => {
    const mf = vi.fn<typeof globalThis.fetch>(async target => Response.json(String(target).includes('openOrders') ? [mo()]
      : String(target).includes('deposit') ? [md({ address: 'synthetic-private-address' })] : [mw()]));
    const of = vi.fn<typeof globalThis.fetch>(async target => Response.json({ code: '0', data: String(target).includes('orders-pending') ? [oo()]
      : String(target).includes('deposit') ? [od({ to: 'synthetic-private-address' })] : [ow()] }));
    const mexc = new MexcAccountReader({ credentials: mexcCredentials, fetch: mf, clock: () => now });
    const okx = new OkxAccountReader({ credentials: okxCredentials, fetch: of, clock: () => now });
    const results = [await mexc.getOpenOrders(), await mexc.getDeposits(), await mexc.getWithdrawals(),
      await okx.getOpenOrders(), await okx.getDeposits(), await okx.getWithdrawals()];
    expect([...mf.mock.calls, ...of.mock.calls].every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/synthetic-private|TEST_SECRET|TEST_KEY|PASSPHRASE/);
  });
  it('refuses unsupported trade symbols before network', async () => {
    const fetch = vi.fn(); const client = new MexcAccountReader({ credentials: mexcCredentials, fetch, clock: () => now });
    await expect(client.getRecentTrades('BTC/USDT&side=BUY' as AccountSymbol)).rejects.toThrow('account-invalid-symbol');
    expect(fetch).not.toHaveBeenCalled();
  });
  const suffix = 'recvWindow=5000&timestamp=1800000000000&signature=' + 'a'.repeat(64);
  it.each([
    'https://www.okx.com/api/v5/trade/order', 'https://www.okx.com/api/v5/trade/cancel-order',
    'https://www.okx.com/api/v5/asset/transfer', 'https://www.okx.com/api/v5/asset/withdrawal',
    'https://www.okx.com/api/v5/trade/orders-pending?instType=SWAP&limit=100',
    'https://www.okx.com/api/v5/asset/deposit-history?limit=101',
    'https://www.okx.com/api/v5/asset/deposit-history?limit=100&limit=100',
    'https://www.okx.com/api/v5/trade/fills-history?instType=SPOT&begin=1&end=1800000000000&limit=100',
    'https://api.mexc.com/api/v3/myTrades?symbol=BTCUSDT&startTime=1800000000000&endTime=1799999999999&limit=100&' + suffix,
    'https://api.mexc.com/api/v3/myTrades?symbol=DOGEUSDT&startTime=1799999999000&endTime=1800000000000&limit=100&' + suffix,
    'https://api.mexc.com/api/v3/order?' + suffix,
    'https://api.mexc.com/api/v3/capital/withdraw/apply?' + suffix,
    'https://api.mexc.com/api/v3/openOrders?symbol=BTCUSDT&' + suffix,
    'https://api.mexc.com/api/v3/openOrders?' + suffix + '&signature=' + 'b'.repeat(64)
  ])('rejects mutation or expanded history target before I/O %s', async target => {
    const fetch = vi.fn(); const transport = new AccountTransport({ credentials: mexcCredentials, fetch, clock: () => now });
    await expect(transport.request(target, {})).rejects.toThrow('account-unsupported-endpoint');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shares cooldown between history and existing account reads without retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: 429, msg: 'synthetic-private' }));
    const client = new MexcAccountReader({ credentials: mexcCredentials, fetch, clock: () => now });
    await expect(client.getDeposits()).rejects.toThrow('account-rate-limited');
    await expect(client.getBalances()).rejects.toThrow('account-rate-limited');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled history body and discards its private text', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel })));
    const client = new OkxAccountReader({ credentials: okxCredentials, fetch, clock: () => now });
    const rejected = expect(client.getWithdrawals()).rejects.toThrow(/^account-timeout$/);
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('bounded combined recent operation collection', () => {
  it('keeps current orders older than the history window while excluding old completed records', async () => {
    const { mexc, okx } = stubs();
    mexc.getOpenOrders.mockResolvedValue({ items: [item({ id: 'old-open', type: 'order', at: now - week - 1, isOpen: true, status: 'pending' })], truncated: false });
    mexc.getRecentTrades.mockResolvedValue({ items: [item({ at: now - week - 1 }), item({ id: 'boundary', at: now - week })], truncated: false });
    const result = await observeRecentOperations(mexc, okx, { clock: () => now });
    expect(result.items.map(row => row.id)).toEqual(['boundary', 'old-open']);
    expect(result.status).toBe('available');
    expect(mexc.getRecentTrades.mock.calls.map(args => args[0])).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(result.coverageLabel).toContain('Внутренние переводы не включены');
    expect(result.coverageLabel.length).toBeLessThanOrEqual(240);
  });
  it('preserves successful feeds as partial when another one fails, without leaking its exception', async () => {
    const { mexc, okx } = stubs();
    mexc.getDeposits.mockRejectedValue(new Error('synthetic-private-error'));
    okx.getRecentTrades.mockResolvedValue({ items: [item({ venue: 'okx' })], truncated: false });
    const result = await observeRecentOperations(mexc, okx, { clock: () => now });
    expect(result.status).toBe('partial'); expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });
  it('stops subsequent reads on a limited venue, persists backoff once and continues the other venue', async () => {
    const { mexc, okx } = stubs(); const persist = vi.fn(async () => {});
    mexc.getOpenOrders.mockRejectedValue(new AccountError('account-rate-limited'));
    const result = await observeRecentOperations(mexc, okx, { clock: () => now, onRateLimit: persist });
    expect(result.status).toBe('partial'); expect(persist).toHaveBeenCalledExactlyOnceWith('mexc');
    expect(mexc.getRecentTrades).not.toHaveBeenCalled(); expect(mexc.getDeposits).not.toHaveBeenCalled();
    expect(okx.getWithdrawals).toHaveBeenCalledOnce();
  });
  it('stops before a request cannot fit the remaining deadline', async () => {
    const { mexc, okx } = stubs();
    const result = await observeRecentOperations(mexc, okx, { clock: () => now, deadline: now + 4999 });
    expect(result.status).toBe('error'); expect(result.items).toEqual([]);
    expect(mexc.getOpenOrders).not.toHaveBeenCalled(); expect(okx.getOpenOrders).not.toHaveBeenCalled();
  });
  it('marks truncation and prioritizes current operations at the 500-item cap', async () => {
    const { mexc, okx } = stubs();
    mexc.getRecentTrades.mockResolvedValue({ items: Array.from({ length: 510 }, (_, n) => item({ id: `trade:${n}`, at: now - n })), truncated: true });
    okx.getOpenOrders.mockResolvedValue({ items: [item({ id: 'old:open', venue: 'okx', type: 'order', isOpen: true, at: now - week - 1 })], truncated: false });
    const result = await observeRecentOperations(mexc, okx, { clock: () => now });
    expect(result.status).toBe('partial'); expect(result.items).toHaveLength(500);
    expect(result.items.some(row => row.id === 'old:open')).toBe(true);
    expect(new Set(result.items.map(row => row.id)).size).toBe(500);
    expect(result.coverageLabel.length).toBeLessThanOrEqual(240);
  });
  it('fails closed when cooldown persistence itself fails', async () => {
    const { mexc, okx } = stubs();
    mexc.getOpenOrders.mockRejectedValue(new AccountError('account-rate-limited'));
    await expect(observeRecentOperations(mexc, okx, { clock: () => now,
      onRateLimit: async () => { throw new Error('synthetic-persistence-failure'); } })).rejects.toThrow();
    expect(mexc.getDeposits).not.toHaveBeenCalled();
  });
});
