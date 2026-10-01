import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AccountError, type AccountOptions, type AccountSymbol } from './types.js';
import { AccountTransport } from './transport.js';
import { mexcTrades, mexcOrders, mexcTransfers } from './operation-records.js';

const ORIGIN = 'https://api.mexc.com';
const instruments: Record<AccountSymbol, string> = {
  'BTC/USDT': 'BTCUSDT', 'ETH/USDT': 'ETHUSDT', 'SOL/USDT': 'SOLUSDT'
};
const credentialsSchema = z.object({
  apiKey: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  apiSecret: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/)
});
const amount = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const balanceSchema = z.object({
  asset: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/), free: amount, locked: amount,
  available: amount.optional()
});
const accountSchema = z.object({
  accountType: z.literal('SPOT'), canTrade: z.boolean(), canWithdraw: z.boolean(), canDeposit: z.boolean(),
  updateTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  balances: z.array(balanceSchema).max(5000)
});
// MEXC documents numeric rates, including 0E-18. Retain decimal strings when
// supplied, and disclose number precision rather than inventing missing digits.
const rate = z.union([
  z.string().regex(/^(?:0(?:\.\d{1,30})?|1(?:\.0{1,30})?)$/),
  z.number().finite().min(0).max(1)
]);
const feeSchema = z.object({ code: z.literal(0), data: z.object({ makerCommission: rate, takerCommission: rate }) });
const mxDeductSchema = z.object({ code: z.literal(0), data: z.object({ mxDeductEnable: z.boolean() }) });
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AccountError('account-invalid-response');
  return result.data;
}

/** MEXC spot V3 GET-only account and operation history reads.
 * Protocol: https://www.mexc.com/api-docs/spot-v3/introduction
 * Signed GET URLs contain a short-lived signature and must never be logged.
 */
export class MexcAccountReader {
  readonly #transport: AccountTransport;
  readonly #credentials: z.infer<typeof credentialsSchema>;
  constructor(options: AccountOptions) {
    const result = credentialsSchema.safeParse(options?.credentials);
    if (!result.success) throw new AccountError('account-invalid-config');
    this.#credentials = result.data;
    this.#transport = new AccountTransport(options);
  }
  async #get(path: '/api/v3/account' | '/api/v3/mxDeduct/enable' | '/api/v3/tradeFee' | '/api/v3/myTrades' | '/api/v3/openOrders' | '/api/v3/capital/deposit/hisrec' | '/api/v3/capital/withdraw/history', params: Record<string, string> = {}) {
    const query = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(this.#transport.now()) }).toString();
    const signature = createHmac('sha256', this.#credentials.apiSecret).update(query).digest('hex');
    const payload = await this.#transport.request(`${ORIGIN}${path}?${query}&signature=${signature}`, {
      'X-MEXC-APIKEY': this.#credentials.apiKey
    });
    if (Array.isArray(payload)) return payload;
    const envelope = parse(z.object({ code: z.number().int().optional() }), payload);
    if (envelope.code !== undefined && envelope.code !== 0) {
      if (envelope.code === 429 || envelope.code === 418) {
        this.#transport.cooldown(60_000);
        throw new AccountError('account-rate-limited');
      }
      if (envelope.code === 700003 || envelope.code === 10073) throw new AccountError('account-clock-skew');
      if (envelope.code === 403) throw new AccountError('account-access-denied');
      if ([400, 401, 602, 10072, 700001, 700002, 700006, 700007].includes(envelope.code)) throw new AccountError('account-auth-failed');
      throw new AccountError('account-api-rejected');
    }
    return payload;
  }
  async getBalances() {
    const account = parse(accountSchema, await this.#get('/api/v3/account'));
    if (new Set(account.balances.map(row => row.asset)).size !== account.balances.length) throw new AccountError('account-invalid-response');
    return {
      venue: 'mexc' as const, account: 'spot' as const, updatedAt: account.updateTime,
      // These describe the account, not the API key's effective permissions.
      accountCapabilities: { canTrade: account.canTrade, canWithdraw: account.canWithdraw, canDeposit: account.canDeposit },
      balances: account.balances.map(row => ({ currency: row.asset, free: row.free, locked: row.locked, available: row.available ?? null }))
    };
  }
  async getSpotFees(symbol: AccountSymbol) {
    if (!Object.hasOwn(instruments, symbol)) throw new AccountError('account-invalid-symbol');
    const { data } = parse(feeSchema, await this.#get('/api/v3/tradeFee', { symbol: instruments[symbol] }));
    return {
      venue: 'mexc' as const, symbol, makerRate: String(data.makerCommission), takerRate: String(data.takerCommission),
      rateUnit: 'fraction' as const,
      ratePrecision: typeof data.makerCommission === 'number' || typeof data.takerCommission === 'number'
        ? 'json-number' as const : 'decimal-string' as const
    };
  }
  /** Reads the current setting only; it does not prove which currency a future fill will charge.
   * https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-mx-deduct-status
   */
  async getMxDeductStatus(): Promise<{ enabled: boolean }> {
    const { data } = parse(mxDeductSchema, await this.#get('/api/v3/mxDeduct/enable'));
    return { enabled: data.mxDeductEnable };
  }
  #window() {
    const now = this.#transport.now();
    return { startTime: String(Math.max(1, now - 7 * 86400_000)), endTime: String(now), limit: '100' };
  }
  async getOpenOrders() {
    return mexcOrders(await this.#get('/api/v3/openOrders'), this.#transport.now());
  }
  async getRecentTrades(symbol: AccountSymbol) {
    if (!Object.hasOwn(instruments, symbol)) throw new AccountError('account-invalid-symbol');
    return mexcTrades(await this.#get('/api/v3/myTrades', { symbol: instruments[symbol], ...this.#window() }), instruments[symbol], this.#transport.now());
  }
  async getDeposits() {
    return mexcTransfers(await this.#get('/api/v3/capital/deposit/hisrec', this.#window()), 'deposit', this.#transport.now());
  }
  async getWithdrawals() {
    return mexcTransfers(await this.#get('/api/v3/capital/withdraw/history', this.#window()), 'withdrawal', this.#transport.now());
  }

}
