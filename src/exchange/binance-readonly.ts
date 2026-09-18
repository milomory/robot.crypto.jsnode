import { createHmac } from 'node:crypto';
import { z } from 'zod';

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const id = z.number().int().nonnegative().safe();
const accountSchema = z.object({
  accountType: z.string(),
  balances: z.array(z.object({ asset: z.string(), free: decimal, locked: decimal }))
});
const ordersSchema = z.array(z.object({
  symbol: z.string(), orderId: id, clientOrderId: z.string(), price: decimal,
  origQty: decimal, executedQty: decimal, status: z.string(), type: z.string(),
  side: z.enum(['BUY', 'SELL']), time: id
}));
const tradesSchema = z.array(z.object({
  symbol: z.string(), id, orderId: id, price: decimal, qty: decimal, quoteQty: decimal,
  commission: decimal, commissionAsset: z.string(), time: id,
  isBuyer: z.boolean(), isMaker: z.boolean()
}));
const permissionsSchema = z.object({
  enableReading: z.literal(true), enableWithdrawals: z.literal(false),
  enableInternalTransfer: z.literal(false), enableMargin: z.literal(false),
  enableFutures: z.literal(false), permitsUniversalTransfer: z.literal(false),
  enableVanillaOptions: z.literal(false), enableSpotAndMarginTrading: z.literal(false),
  enableFixApiTrade: z.literal(false).optional(),
  enablePortfolioMarginTrading: z.literal(false).optional()
});

export class BinanceReadOnlyError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 502) {
    super(message);
  }
}

export interface BinanceReadOnlyConfig {
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  symbols: readonly string[];
}

// No execution interface, arbitrary URL, or configurable HTTP method is exposed.
// Decimal amounts stay strings; unsafe numeric IDs are rejected rather than rounded.
export class BinanceReadOnly {
  #config: BinanceReadOnlyConfig;
  #fetch: typeof fetch;
  #cooldownUntil = 0;
  #verifiedAt?: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(config: BinanceReadOnlyConfig, transport: typeof fetch = fetch) {
    this.#config = { ...config, symbols: [...config.symbols] };
    this.#fetch = transport;
  }

  status() {
    return {
      exchange: 'binance', access: 'read-only', enabled: this.#config.enabled,
      configured: Boolean(this.#config.apiKey && this.#config.apiSecret),
      verifiedAt: this.#verifiedAt ?? null,
      cooldownUntil: this.#cooldownUntil > Date.now() ? new Date(this.#cooldownUntil).toISOString() : null
    };
  }

  getAccount() {
    return this.#read('/api/v3/account', { omitZeroBalances: 'true' }, accountSchema);
  }

  getOpenOrders(symbol: string) {
    return this.#read('/api/v3/openOrders', { symbol: this.#symbol(symbol) }, ordersSchema);
  }

  async getTrades(symbol: string, limit = 100, fromId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 ||
        (fromId !== undefined && (!/^\d{1,19}$/.test(fromId) || BigInt(fromId) > 9223372036854775807n))) {
      throw new BinanceReadOnlyError('invalid-query', 'Invalid trade history cursor or limit', 400);
    }
    const params: Record<string, string> = { symbol: this.#symbol(symbol), limit: String(limit) };
    if (fromId !== undefined) params.fromId = fromId;
    const trades = await this.#read('/api/v3/myTrades', params, tradesSchema);
    return { trades, limit, fromId: fromId ?? null, nextFromId:
      trades.length === limit ? (BigInt(trades[trades.length - 1].id) + 1n).toString() : null };
  }

  #symbol(symbol: string): string {
    if (!this.#config.symbols.includes(symbol) || !/^[A-Z0-9]+\/[A-Z0-9]+$/.test(symbol)) {
      throw new BinanceReadOnlyError('invalid-symbol', 'Symbol is outside the configured universe', 400);
    }
    return symbol.replace('/', '');
  }

  async #read<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    // Serialize requests to avoid simultaneous permission checks and respect cooldowns.
    // No background poller; every operation is explicitly requested by the operator.
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!this.#config.enabled || !this.#config.apiKey || !this.#config.apiSecret) {
        throw new BinanceReadOnlyError('not-configured', 'Binance read-only connector is disabled or missing credentials', 503);
      }
      const start = Date.now();
      const time = z.object({ serverTime: id }).safeParse(await this.#request('/api/v3/time'));
      if (!time.success) throw new BinanceReadOnlyError('invalid-response', 'Invalid Binance server time');
      const offset = time.data.serverTime - Math.round((start + Date.now()) / 2);
      const permissions = await this.#request('/sapi/v1/account/apiRestrictions', {}, offset);
      if (!permissionsSchema.safeParse(permissions).success) {
        this.#verifiedAt = undefined;
        throw new BinanceReadOnlyError('unsafe-permissions', 'A dedicated read-only key without trading, transfer or withdrawal permissions is required', 503);
      }
      const payload = await this.#request(path, params, offset);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new BinanceReadOnlyError('invalid-response', 'Invalid Binance account response');
      this.#verifiedAt = new Date().toISOString();
      return parsed.data;
    } catch (error) {
      this.#verifiedAt = undefined;
      if (error instanceof BinanceReadOnlyError) throw error;
      // Never surface upstream bodies, signed URLs, headers, secrets or transport errors.
      throw new BinanceReadOnlyError('unavailable', 'Binance read-only request failed');
    } finally {
      release();
    }
  }

  async #request(path: string, params: Record<string, string> = {}, offset?: number): Promise<unknown> {
    if (!['/api/v3/time', '/sapi/v1/account/apiRestrictions', '/api/v3/account', '/api/v3/openOrders', '/api/v3/myTrades'].includes(path)) {
      throw new BinanceReadOnlyError('unsupported', 'Unsupported read-only endpoint');
    }
    if (Date.now() < this.#cooldownUntil) {
      throw new BinanceReadOnlyError('rate-limited', 'Binance cooldown is active', 429);
    }
    const query = new URLSearchParams(params);
    const headers: Record<string, string> = {};
    if (offset !== undefined) {
      query.set('recvWindow', '5000');
      query.set('timestamp', String(Date.now() + offset));
      query.set('signature', createHmac('sha256', this.#config.apiSecret).update(query.toString()).digest('hex'));
      headers['X-MBX-APIKEY'] = this.#config.apiKey;
    }
    const response = await this.#fetch(`https://api.binance.com${path}?${query}`, {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (response.status === 429 || response.status === 418) {
      const seconds = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds : (response.status === 418 ? 86400 : 60);
      this.#cooldownUntil = Date.now() + Math.min(delay, 7 * 86400) * 1000;
      throw new BinanceReadOnlyError('rate-limited', 'Binance rate limit reached', 429);
    }
    if (!response.ok) {
      throw new BinanceReadOnlyError('upstream-rejected', `Binance rejected read-only request (HTTP ${response.status})`);
    }
    return response.json();
  }
}
