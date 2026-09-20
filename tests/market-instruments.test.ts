import { describe, expect, it, vi } from 'vitest';
import { checkSize, fetchInstruments, parseInstrument, type Instrument } from '../src/lab/instruments.js';
import { createRun, summarize, type ObservationSample } from '../src/lab/observations.js';

const now = Date.now();
const rule: Instrument = { venue: 'bybit', symbol: 'BTC/USDT', fetchedAt: now, trading: true,
  lots: [{ min: '0.00001', max: '100', step: '0.00001' }], minQuote: '5', notionalReference: 'snapshot-estimate' };
describe('public market-order size rules', () => {
  it('uses exact decimal step checks including exponent notation', () => {
    expect(() => checkSize(rule, .00002, 5, now)).not.toThrow();
    expect(() => checkSize(rule, .000021, 5, now)).toThrow('quantity-step-mismatch');
    expect(() => checkSize({ ...rule, lots: [{ min: '0.00000001', max: '1', step: '0.00000001' }] }, 1e-8, 5, now)).not.toThrow();
    expect(() => checkSize({ ...rule, lots: [{ min: '0', max: '1', step: '0.1' }] }, .3, 5, now)).not.toThrow();
    expect(() => checkSize({ ...rule, lots: [{ min: '0', max: '1', step: '0.1' }] }, .1 + .2, 5, now)).toThrow('quantity-step-mismatch');
  });
  it('rejects min/max quantity, notional, inactive and stale instruments', () => {
    expect(() => checkSize(rule, .000001, 5, now)).toThrow('below-minimum-quantity');
    expect(() => checkSize(rule, 101, 5, now)).toThrow('above-maximum-quantity');
    expect(() => checkSize(rule, .00002, 4.99, now)).toThrow('below-minimum-notional');
    expect(() => checkSize({ ...rule, maxQuote: '6' }, .00002, 7, now)).toThrow('above-maximum-notional');
    expect(() => checkSize({ ...rule, trading: false }, .00002, 5, now)).toThrow('market-not-trading');
    expect(() => checkSize(rule, .00002, 5, now + 3_600_001)).toThrow('stale-instrument');
  });
  it('applies Binance lot AND market lot filters, zero step disabled, notional market flags respected', () => {
    const p = { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', filters: [
      { filterType: 'LOT_SIZE', minQty: '0.01', maxQty: '100', stepSize: '0.01' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '1', stepSize: '0' },
      { filterType: 'NOTIONAL', minNotional: '5', maxNotional: '6', applyMinToMarket: true, applyMaxToMarket: false }
    ] }] };
    const parsed = parseInstrument('binance', 'BTC/USDT', p, now);
    expect(parsed.maxQuote).toBeUndefined();
    expect(() => checkSize(parsed, 1, 100, now)).not.toThrow();
    expect(() => checkSize(parsed, 2, 100, now)).toThrow('above-maximum-quantity');
    expect(() => checkSize(parsed, .011, 100, now)).toThrow('quantity-step-mismatch');
    expect(() => parseInstrument('binance', 'ETH/USDT', p, now)).toThrow(/^invalid-instrument$/);
  });
  it('rejects malformed precision without exposing the response', () => {
    expect(() => parseInstrument('bybit', 'BTC/USDT', { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', status: 'Trading',
      lotSizeFilter: { basePrecision: 'PRIVATE_SENTINEL', minOrderQty: '0.00001', maxMarketOrderQty: '120', minOrderAmt: '5' } }] } }, now)).toThrow(/^invalid-instrument$/);
  });
  it('valid Bybit and OKX envelopes preserve public rules', () => {
    const b = parseInstrument('bybit', 'BTC/USDT', { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', status: 'Trading',
      lotSizeFilter: { basePrecision: '0.000001', minOrderQty: '0.000001', maxMarketOrderQty: '120', minOrderAmt: '5' } }] } }, now);
    expect(b.lots[0].step).toBe('0.000001');
    const o = parseInstrument('okx', 'BTC/USDT', { code: '0', data: [{ instId: 'BTC-USDT', state: 'live', lotSz: '0.00000001', minSz: '0.00001', maxMktSz: '1000000' }] }, now);
    expect(o.minQuote).toBeUndefined(); expect(o.notionalReference).toBe('not-published');
  });
  it('does not echo failures and only uses public GET without credentials', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE_SENTINEL', { status: 403 }));
    const results = await fetchInstruments('BTC/USDT', request);
    expect(Object.values(results).every(r => !r.available)).toBe(true);
    expect(JSON.stringify(results)).not.toContain('PRIVATE_SENTINEL');
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
  });
  it('keeps old observations explicitly unvalidated and rejects newly invalid sizes', () => {
    const run = createRun('test', 'BTC/USDT', .00002, 1);
    const at = run.startedAt;
    const sample: ObservationSample = { schema: 1, runId: run.runId, sequence: 0, startedAt: at, checkedAt: at + 100,
      sources: ['binance', 'bybit', 'okx'].map(venue => ({ venue, available: true, book: {
        venue, symbol: run.symbol, requestedAt: at, receivedAt: at + 100, bids: [[99, 1]], asks: [[100, 1]]
      } })) as ObservationSample['sources'] };
    expect(summarize(run, [sample]).pairs['binance->bybit'].sizeChecked).toBe(0);
    run.instruments = Object.fromEntries(['binance', 'bybit', 'okx'].map(venue => [venue, { available: true,
      instrument: { ...rule, venue, fetchedAt: at } }])) as NonNullable<typeof run.instruments>;
    const report = summarize(run, [sample]);
    expect(report.pairs['binance->bybit'].reasons).toEqual({ 'below-minimum-notional': 1 });
    expect(report.pairs['binance->bybit'].valid).toBe(0);
  });
});
