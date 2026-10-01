import { createHmac } from 'node:crypto';
import { AccountTransport } from './transport.js';
import { AccountError, type AccountOptions } from './types.js';
import { projectExecutionOrder, projectExecutionRows } from './execution-records.js';
export type HistoryVenue = 'mexc' | 'okx';
export type HistoryWindow = { from: number; to: number };
export type HistoryRead = { kind: 'fills' | 'order' | 'bills'; requestedAt: number; receivedAt: number;
  query: Record<string, string>; data: unknown };
function id(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new AccountError('account-invalid-order-id');
  return value;
}
function window(value: HistoryWindow) {
  if (!value || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to) || value.from <= 0 ||
      value.to < value.from || value.to - value.from > 7 * 86400_000) throw new AccountError('account-invalid-history-window');
  return value;
}
/** Dedicated, read-only route scope. Never exposes credentials or signed request metadata. */
export class ExecutionHistoryReader {
  readonly venue: HistoryVenue;
  readonly #transport: AccountTransport;
  readonly #credentials: AccountOptions['credentials'];
  constructor(venue: HistoryVenue, options: AccountOptions) {
    if (!['mexc', 'okx'].includes(venue) || (venue === 'okx' && !options?.credentials?.passphrase)) throw new AccountError('account-invalid-config');
    this.venue = venue; this.#credentials = { ...options.credentials };
    this.#transport = new AccountTransport(options, 'execution-history');
  }
  async #get(kind: HistoryRead['kind'], path: string, query: Record<string, string>): Promise<HistoryRead> {
    const requestedAt = this.#transport.now();
    if (requestedAt <= 0 || requestedAt > 8_640_000_000_000_000) throw new AccountError('account-invalid-clock');
    let raw: unknown;
    if (this.venue === 'mexc') {
      const unsigned = new URLSearchParams({ ...query, recvWindow: '5000', timestamp: String(requestedAt) }).toString();
      const signature = createHmac('sha256', this.#credentials.apiSecret).update(unsigned).digest('hex');
      raw = await this.#transport.request(`https://api.mexc.com${path}?${unsigned}&signature=${signature}`, { 'X-MEXC-APIKEY': this.#credentials.apiKey });
      if (raw && !Array.isArray(raw) && typeof raw === 'object' && 'code' in raw && raw.code !== 0) {
        if ([429, 418].includes(raw.code as number)) { this.#transport.cooldown(60_000); throw new AccountError('account-rate-limited'); }
        throw new AccountError('account-api-rejected');
      }
    } else {
      const suffix = new URLSearchParams(query).toString(), target = `${path}?${suffix}`, stamp = new Date(requestedAt).toISOString();
      const signature = createHmac('sha256', this.#credentials.apiSecret).update(`${stamp}GET${target}`).digest('base64');
      const response = await this.#transport.request('https://www.okx.com' + target, {
        'OK-ACCESS-KEY': this.#credentials.apiKey, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': stamp,
        'OK-ACCESS-PASSPHRASE': this.#credentials.passphrase!, 'Content-Type': 'application/json' });
      if (!response || typeof response !== 'object' || !('code' in response) || !('data' in response)) throw new AccountError('account-invalid-response');
      if (['50011', '50013', '50040'].includes(String(response.code))) { this.#transport.cooldown(60_000); throw new AccountError('account-rate-limited'); }
      if (response.code !== '0') throw new AccountError('account-api-rejected');
      raw = response.data;
    }
    const receivedAt = this.#transport.now();
    if (receivedAt < requestedAt) throw new AccountError('account-invalid-clock');
    const data = kind === 'order' ? projectExecutionOrder(this.venue, raw) : projectExecutionRows(this.venue, kind, raw);
    const selected = query.orderId ?? query.ordId;
    if (selected !== undefined) {
      const rows = Array.isArray(data) ? data : [data];
      if (rows.some(row => ('orderId' in row ? row.orderId : 'ordId' in row ? row.ordId : undefined) !== selected)) throw new AccountError('account-invalid-response');
    }
    return { kind, requestedAt, receivedAt, query: { ...query }, data };
  }
  getOrder(orderId: string) {
    return this.venue === 'mexc' ? this.#get('order', '/api/v3/order', { symbol: 'BTCUSDT', orderId: id(orderId) })
      : this.#get('order', '/api/v5/trade/order', { instId: 'BTC-USDT', ordId: id(orderId) });
  }
  getFills(range: HistoryWindow, orderId?: string, after?: string) {
    window(range);
    if (this.venue === 'mexc') {
      if (after !== undefined) throw new AccountError('account-unsupported-cursor');
      return this.#get('fills', '/api/v3/myTrades', { symbol: 'BTCUSDT',
        ...(orderId === undefined ? { startTime: String(range.from), endTime: String(range.to) } : { orderId: id(orderId) }), limit: '1000' });
    }
    return this.#get('fills', '/api/v5/trade/fills-history', { instType: 'SPOT', instId: 'BTC-USDT', begin: String(range.from), end: String(range.to),
      limit: '100', ...(orderId === undefined ? {} : { ordId: id(orderId) }), ...(after === undefined ? {} : { after: id(after) }) });
  }
  getBills(range: HistoryWindow, after?: string) {
    window(range);
    if (this.venue !== 'okx') throw new AccountError('account-unsupported-venue');
    return this.#get('bills', '/api/v5/account/bills', { instType: 'SPOT', instId: 'BTC-USDT', begin: String(range.from), end: String(range.to),
      limit: '100', ...(after === undefined ? {} : { after: id(after) }) });
  }
}
