import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { HitbtcAccountReader } from '../src/accounts/hitbtc.js';
import type { AccountSymbol } from '../src/accounts/types.js';

const credentials = { apiKey: 'test-key-with-full-permissions', apiSecret: 'test-private-secret' };
const now = 1_800_000_000_000;
const spot = [{ currency: 'BTC', available: '0.000000000000000001', reserved: '0.0100',
  reserved_margin: '0.0200', cross_margin_reserved: '0.0300' }];
const funding = [{ currency: 'USDT', available: '1000.123456789012345678', reserved: '0.00' }];
const fees = { make_rate: '-0.000100', take_rate: '0.001000' };
const metadata = { type: 'spot', base_currency: 'BTC', quote_currency: 'USDT', status: 'working' };

function setup(responses: { spot?: unknown; funding?: unknown; fees?: unknown; metadata?: unknown } = {}) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/3/spot/balance') return Response.json(responses.spot ?? spot);
    if (path === '/api/3/wallet/balance') return Response.json(responses.funding ?? funding);
    if (path.startsWith('/api/3/public/symbol/')) {
      return Response.json(responses.metadata ?? { ...metadata,
        base_currency: path.slice('/api/3/public/symbol/'.length).replace(/USDT$/, '') });
    }
    if (path.startsWith('/api/3/spot/fee/')) return Response.json(responses.fees ?? fees);
    throw new Error('Unexpected endpoint');
  });
  return { reader: new HitbtcAccountReader({ credentials, fetch: fetcher, clock: () => now }), fetcher };
}

describe('HitBTC account reader', () => {
  it('preserves exact balances and their separate native reservation categories', async () => {
    const { reader } = setup({ spot: [{ ...spot[0], private_id: 'do-not-expose' }] });
    expect(await reader.getBalances()).toEqual({ venue: 'hitbtc', scope: 'spot', balances: spot });
    expect(await reader.getFundingBalances()).toEqual({ venue: 'hitbtc', scope: 'funding', balances: funding });
    expect(JSON.stringify(reader)).not.toContain(credentials.apiSecret);
    expect(inspect(reader, { showHidden: true })).not.toContain(credentials.apiKey);
    expect(inspect(reader, { showHidden: true })).not.toContain(credentials.apiSecret);
  });

  it('keeps native USD separate from USDT instead of assuming they are the same currency', async () => {
    const balances = [
      { currency: 'USD', available: '5', reserved: '0' },
      { currency: 'USDT', available: '7', reserved: '0' }
    ];
    expect((await setup({ funding: balances }).reader.getFundingBalances()).balances).toEqual(balances);
  });

  it('does not invent a zero balance for an empty account response', async () => {
    const { reader } = setup({ spot: [], funding: [] });
    expect((await reader.getBalances()).balances).toEqual([]);
    expect((await reader.getFundingBalances()).balances).toEqual([]);
  });

  it.each(['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] as const)(
    'verifies %s metadata without credentials, then fetches its exact fee endpoint', async (symbol) => {
      const { reader, fetcher } = setup({ fees: { ...fees, private_account_id: 'ignored' } });
      expect(await reader.getSpotFees(symbol)).toEqual({ venue: 'hitbtc', symbol,
        makerRate: fees.make_rate, takerRate: fees.take_rate, rateUnit: 'fraction' });
      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        `https://api.hitbtc.com/api/3/public/symbol/${symbol.replace('/', '')}`,
        `https://api.hitbtc.com/api/3/spot/fee/${symbol.replace('/', '')}`
      ]);
      expect(fetcher.mock.calls[0][1]?.headers).toEqual({});
      expect(fetcher.mock.calls[1][1]?.headers).toEqual({
        Authorization: `Basic ${Buffer.from(`${credentials.apiKey}:${credentials.apiSecret}`).toString('base64')}`
      });
    }
  );

  it('has only fixed HTTPS GET methods even when the supplied key has write permissions', async () => {
    const { reader, fetcher } = setup();
    await reader.getBalances();
    await reader.getFundingBalances();
    await reader.getSpotFees('BTC/USDT');
    expect(Object.getOwnPropertyNames(HitbtcAccountReader.prototype).sort()).toEqual([
      'constructor', 'getBalances', 'getFundingBalances', 'getSpotFees'
    ]);
    for (const [input, options] of fetcher.mock.calls) {
      expect(new URL(String(input)).origin).toBe('https://api.hitbtc.com');
      expect(new URL(String(input)).search).toBe('');
      expect(options?.method).toBe('GET');
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.body).toBeUndefined();
      expect(String(input)).not.toContain(credentials.apiKey);
      expect(String(input)).not.toContain(credentials.apiSecret);
    }
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/user/api-keys'))).toBe(false);
  });

  it.each([
    { apiKey: '', apiSecret: 'secret' },
    { apiKey: 'bad:key', apiSecret: 'secret' },
    { apiKey: 'key\r\nX-Injected: yes', apiSecret: 'secret' },
    { apiKey: ' key', apiSecret: 'secret' },
    { apiKey: 'key', apiSecret: '' },
    { apiKey: 'key', apiSecret: 'secret\u0000' },
    { apiKey: 'key', apiSecret: 'secret\nvalue' },
    { apiKey: 'key', apiSecret: 's'.repeat(513) }
  ])('rejects invalid credentials before a request', (invalid) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => new HitbtcAccountReader({ credentials: invalid, fetch: fetcher })).toThrow('invalid-credentials');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['BTC/USD', 'DOGE/USDT', '__proto__', 'BTCUSDT?secret=x', 'BTC/USDT/../order'])(
    'rejects unsupported or injected symbol %s before any request', async (symbol) => {
      const { reader, fetcher } = setup();
      await expect(reader.getSpotFees(symbol as AccountSymbol)).rejects.toMatchObject({ code: 'invalid-symbol' });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each([
    { quote_currency: 'USD' }, { base_currency: 'ETH' }, { type: 'futures' },
    { status: 'suspended' }, { base_currency: null }
  ])('blocks private fees when public metadata does not verify the requested spot pair', async (changed) => {
    const { reader, fetcher } = setup({ metadata: { ...metadata, ...changed } });
    await expect(reader.getSpotFees('BTC/USDT')).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({});
  });

  it.each([
    [{ currency: 'BTC', available: 0.1, reserved: '0' }],
    [{ currency: 'BTC', available: '-0.1', reserved: '0' }],
    [{ currency: 'BTC', available: '1e-8', reserved: '0' }],
    [{ currency: 'BTC', available: '1', reserved: '0', reserved_margin: -1 }],
    [spot[0], spot[0]],
    { balance: spot },
    { error: { code: 1002, message: credentials.apiSecret } }
  ].map((payload) => ({ payload })))('rejects malformed or ambiguous balance data without echoing it', async ({ payload }) => {
    const { reader } = setup({ spot: payload });
    await expect(reader.getBalances()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([
    { make_rate: 0.001, take_rate: '0.001' },
    { make_rate: '0.001', take_rate: '1e-3' },
    { make_rate: '-2', take_rate: '0.001' },
    { make_rate: '0.001' },
    { error: { message: credentials.apiSecret } }
  ])('rejects malformed personal fee responses', async (payload) => {
    await expect(setup({ fees: payload }).reader.getSpotFees('BTC/USDT'))
      .rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('redacts private response and transport errors', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error(`${credentials.apiKey}:${credentials.apiSecret}`)),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(credentials.apiSecret, { status: 403 })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(credentials.apiSecret, { status: 500 }))
    ]) {
      const reader = new HitbtcAccountReader({ credentials, fetch: fetcher });
      await expect(reader.getBalances()).rejects.not.toThrow(credentials.apiSecret);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('shares a rate-limit cooldown between account and public metadata requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(credentials.apiSecret, { status: 429, headers: { 'retry-after': '120' } })
    );
    const reader = new HitbtcAccountReader({ credentials, fetch: fetcher, clock: () => now });
    await expect(reader.getBalances()).rejects.toMatchObject({ code: 'account-rate-limited' });
    await expect(reader.getFundingBalances()).rejects.toMatchObject({ code: 'account-rate-limited' });
    await expect(reader.getSpotFees('BTC/USDT')).rejects.toMatchObject({ code: 'account-rate-limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
