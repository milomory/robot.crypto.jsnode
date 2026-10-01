import { AccountError, validateCredentials, type AccountOptions } from './types.js';

const MAX_BYTES = 256 * 1024;
const NATIVE_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const OKX_SYMBOLS = new Set(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
function exactQuery(url: URL, expected: Record<string, string | Set<string>>) {
  const entries = [...url.searchParams];
  return entries.length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => {
    const actual = url.searchParams.getAll(key);
    return actual.length === 1 && (typeof value === 'string' ? actual[0] === value : value.has(actual[0]));
  });
}
function mexcQuery(url: URL, additional: Record<string, string | Set<string>> = {}) {
  const timestamp = url.searchParams.get('timestamp') ?? '';
  const signature = url.searchParams.get('signature') ?? '';
  return /^(?:0|[1-9]\d{0,15})$/.test(timestamp) && Number.isSafeInteger(Number(timestamp)) &&
    /^[a-f0-9]{64}$/.test(signature) && url.search.slice(1) === url.searchParams.toString() &&
    exactQuery(url, { ...additional, recvWindow: '5000', timestamp, signature });
}
function windowQuery(url: URL, start: string, end: string) {
  const a = url.searchParams.get(start) ?? '', b = url.searchParams.get(end) ?? '';
  return /^[1-9]\d{0,15}$/.test(a) && /^[1-9]\d{0,15}$/.test(b) &&
    Number.isSafeInteger(Number(a)) && Number.isSafeInteger(Number(b)) &&
    Number(a) <= Number(b) && Number(b) - Number(a) <= 7 * 86400_000;
}
type AccountTransportScope = 'accounts' | 'execution-history' | 'order-recovery' | 'account-identity' | 'account-funds' | 'account-fees' | 'okx-capacity';
function allowed(input: string, scope: AccountTransportScope = 'accounts'): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new AccountError('account-unsupported-endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.href !== input) {
    throw new AccountError('account-unsupported-endpoint');
  }
  if (scope === 'okx-capacity') {
    const pass = url.origin === 'https://www.okx.com' &&
      (url.href === 'https://www.okx.com/api/v5/account/config' ||
       url.href === 'https://www.okx.com/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDT');
    if (!pass) throw new AccountError('account-unsupported-endpoint');
    return url;
  }
  if (scope === 'account-fees') {
    if (url.search.slice(1) !== url.searchParams.toString()) throw new AccountError('account-unsupported-endpoint');
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    const uid = url.origin === 'https://api.mexc.com' && url.pathname === '/api/v3/uid' &&
      /^[1-9]\d{0,15}$/.test(timestamp) && Number.isSafeInteger(Number(timestamp)) &&
      /^[a-f0-9]{64}$/.test(signature) && exactQuery(url, { timestamp, signature });
    const mexc = url.origin === 'https://api.mexc.com' && (
      (url.pathname === '/api/v3/tradeFee' && mexcQuery(url, { symbol: 'BTCUSDT' })) ||
      (url.pathname === '/api/v3/mxDeduct/enable' && mexcQuery(url)));
    const okx = url.origin === 'https://www.okx.com' && (
      (url.pathname === '/api/v5/account/config' && url.search === '' && !input.endsWith('?')) ||
      (url.pathname === '/api/v5/account/trade-fee' && exactQuery(url, { instType: 'SPOT', instId: 'BTC-USDT' })));
    if (!uid && !mexc && !okx) throw new AccountError('account-unsupported-endpoint');
    return url;
  }
  if (scope === 'account-funds') {
    if (url.search.slice(1) !== url.searchParams.toString()) throw new AccountError('account-unsupported-endpoint');
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    const uid = url.origin === 'https://api.mexc.com' && url.pathname === '/api/v3/uid' &&
      /^[1-9]\d{0,15}$/.test(timestamp) && Number.isSafeInteger(Number(timestamp)) &&
      /^[a-f0-9]{64}$/.test(signature) && exactQuery(url, { timestamp, signature });
    const account = url.origin === 'https://api.mexc.com' && url.pathname === '/api/v3/account' && mexcQuery(url);
    const okx = url.origin === 'https://www.okx.com' &&
      ['/api/v5/account/config', '/api/v5/account/balance'].includes(url.pathname) && url.search === '' && !input.endsWith('?');
    if (!uid && !account && !okx) throw new AccountError('account-unsupported-endpoint');
    return url;
  }
  if (scope === 'account-identity') {
    if (url.search.slice(1) !== url.searchParams.toString()) throw new AccountError('account-unsupported-endpoint');
    // The documented UID endpoint lists timestamp/signature only; it does not
    // inherit the parameters or endpoints of the accounts/history scopes.
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    const mexc = url.origin === 'https://api.mexc.com' && url.pathname === '/api/v3/uid' &&
      /^[1-9]\d{0,15}$/.test(timestamp) && Number.isSafeInteger(Number(timestamp)) &&
      /^[a-f0-9]{64}$/.test(signature) && exactQuery(url, { timestamp, signature });
    const okx = url.origin === 'https://www.okx.com' && url.pathname === '/api/v5/account/config' && url.search === '' && !input.endsWith('?');
    if (!mexc && !okx) throw new AccountError('account-unsupported-endpoint');
    return url;
  }
  if (scope === 'order-recovery') {
    if (url.search.slice(1) !== url.searchParams.toString()) throw new AccountError('account-unsupported-endpoint');
    const orderId = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get(name) ?? '');
    const clientId = (name: string) => /^[A-Za-z0-9]{32}$/.test(url.searchParams.get(name) ?? '');
    let accepted = false;
    if (url.origin === 'https://api.mexc.com') {
      if (url.pathname === '/api/v3/order') {
        if (orderId('orderId')) accepted = mexcQuery(url, { symbol: 'BTCUSDT', orderId: url.searchParams.get('orderId')! });
        if (clientId('origClientOrderId')) accepted ||= mexcQuery(url, { symbol: 'BTCUSDT', origClientOrderId: url.searchParams.get('origClientOrderId')! });
      }
      if (url.pathname === '/api/v3/myTrades' && orderId('orderId')) {
        accepted = mexcQuery(url, { symbol: 'BTCUSDT', orderId: url.searchParams.get('orderId')!, limit: '1000' });
      }
    } else if (url.origin === 'https://www.okx.com') {
      if (url.pathname === '/api/v5/trade/order') {
        if (orderId('ordId')) accepted = exactQuery(url, { instId: 'BTC-USDT', ordId: url.searchParams.get('ordId')! });
        if (clientId('clOrdId')) accepted ||= exactQuery(url, { instId: 'BTC-USDT', clOrdId: url.searchParams.get('clOrdId')! });
      }
      if (url.pathname === '/api/v5/trade/fills-history' && orderId('ordId') && windowQuery(url, 'begin', 'end')) {
        accepted = exactQuery(url, { instType: 'SPOT', instId: 'BTC-USDT', ordId: url.searchParams.get('ordId')!,
          begin: url.searchParams.get('begin')!, end: url.searchParams.get('end')!, limit: '100' });
      }
    }
    if (!accepted) throw new AccountError('account-unsupported-endpoint');
    return url;
  }
  if (scope === 'execution-history') {
    const id = (name: string) => /^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get(name) ?? '');
    const cursor: Record<string, string> = url.searchParams.has('after') ? { after: url.searchParams.get('after')! } : {};
    const order: Record<string, string> = url.searchParams.has('ordId') ? { ordId: url.searchParams.get('ordId')! } : {};
    let accepted = false;
    if (url.origin === 'https://api.mexc.com') {
      if (url.pathname === '/api/v3/order' && id('orderId')) accepted = mexcQuery(url, { symbol: 'BTCUSDT', orderId: url.searchParams.get('orderId')! });
      if (url.pathname === '/api/v3/myTrades') {
        if (url.searchParams.has('orderId') && id('orderId')) accepted = mexcQuery(url, { symbol: 'BTCUSDT', orderId: url.searchParams.get('orderId')!, limit: '1000' });
        else if (windowQuery(url, 'startTime', 'endTime')) accepted = mexcQuery(url, { symbol: 'BTCUSDT', startTime: url.searchParams.get('startTime')!, endTime: url.searchParams.get('endTime')!, limit: '1000' });
      }
    } else if (url.origin === 'https://www.okx.com') {
      if (url.pathname === '/api/v5/trade/order' && id('ordId')) accepted = exactQuery(url, { instId: 'BTC-USDT', ordId: url.searchParams.get('ordId')! });
      if (url.pathname === '/api/v5/trade/fills-history' && windowQuery(url, 'begin', 'end') &&
          (!url.searchParams.has('after') || /^[1-9][0-9]{0,39}$/.test(cursor.after!)) && (!url.searchParams.has('ordId') || id('ordId'))) {
        accepted = exactQuery(url, { instType: 'SPOT', instId: 'BTC-USDT', begin: url.searchParams.get('begin')!, end: url.searchParams.get('end')!, limit: '100', ...order, ...cursor });
      }
      if (url.pathname === '/api/v5/account/bills' && windowQuery(url, 'begin', 'end') &&
          (!url.searchParams.has('after') || /^[1-9][0-9]{0,39}$/.test(cursor.after!))) {
        accepted = exactQuery(url, { instType: 'SPOT', instId: 'BTC-USDT', begin: url.searchParams.get('begin')!, end: url.searchParams.get('end')!, limit: '100', ...cursor });
      }
    }
    if (!accepted) throw new AccountError('account-unsupported-endpoint');
    return url;
  }
  let pass = false;
  if (url.origin === 'https://api.bybit.com') {
    if (url.pathname === '/v5/user/query-api') pass = exactQuery(url, {});
    if (url.pathname === '/v5/account/wallet-balance') pass = exactQuery(url, { accountType: 'UNIFIED' });
    if (url.pathname === '/v5/account/fee-rate') pass = exactQuery(url, { category: 'spot', symbol: NATIVE_SYMBOLS });
  } else if (url.origin === 'https://www.okx.com') {
    if (url.pathname === '/api/v5/asset/asset-valuation') pass = exactQuery(url, { ccy: 'USDT' });
    if (url.pathname === '/api/v5/finance/savings/balance') pass = exactQuery(url, { ccy: 'USDT' });
    if (url.pathname === '/api/v5/finance/savings/lending-history') {
      const after = url.searchParams.get('after');
      const cursor: Record<string, string> = after === null ? {} : { after };
      pass = (after === null || (/^[1-9]\d{0,15}$/.test(after) && Number.isSafeInteger(Number(after)))) &&
        exactQuery(url, { ccy: 'USDT', limit: '100', ...cursor });
    }
    if (['/api/v5/account/config', '/api/v5/account/balance', '/api/v5/asset/balances'].includes(url.pathname)) pass = exactQuery(url, {});
    if (url.pathname === '/api/v5/trade/orders-pending') pass = exactQuery(url, { instType: 'SPOT', limit: '100' });
    if (url.pathname === '/api/v5/trade/fills-history') pass = windowQuery(url, 'begin', 'end') && exactQuery(url, {
      instType: 'SPOT', begin: url.searchParams.get('begin')!, end: url.searchParams.get('end')!, limit: '100' });
    if (['/api/v5/asset/deposit-history','/api/v5/asset/withdrawal-history'].includes(url.pathname)) pass = exactQuery(url, { limit: '100' });
    if (url.pathname === '/api/v5/account/trade-fee') pass = exactQuery(url, { instType: 'SPOT', instId: OKX_SYMBOLS });
  } else if (url.origin === 'https://api.mexc.com') {
    if (url.pathname === '/api/v1/private/account/assets') pass = exactQuery(url, {});
    if (url.pathname === '/api/v3/account') pass = mexcQuery(url);
    if (url.pathname === '/api/v3/mxDeduct/enable') pass = mexcQuery(url);
    if (url.pathname === '/api/v3/openOrders') pass = mexcQuery(url);
    if (['/api/v3/myTrades','/api/v3/capital/deposit/hisrec','/api/v3/capital/withdraw/history'].includes(url.pathname)) {
      pass = windowQuery(url, 'startTime', 'endTime') && mexcQuery(url, {
        ...(url.pathname === '/api/v3/myTrades' ? { symbol: NATIVE_SYMBOLS } : {}),
        startTime: url.searchParams.get('startTime')!, endTime: url.searchParams.get('endTime')!, limit: '100' });
    }
    if (url.pathname === '/api/v3/tradeFee') pass = mexcQuery(url, { symbol: NATIVE_SYMBOLS });
  } else if (url.origin === 'https://api.hitbtc.com') {
    if (['/api/3/spot/balance', '/api/3/wallet/balance'].includes(url.pathname)) pass = exactQuery(url, {});
    for (const symbol of NATIVE_SYMBOLS) {
      if ([`/api/3/spot/fee/${symbol}`, `/api/3/public/symbol/${symbol}`].includes(url.pathname)) pass = exactQuery(url, {});
    }
  }
  if (!pass) throw new AccountError('account-unsupported-endpoint');
  return url;
}

// Futures balances arrive as JSON numbers. Validate the original JSON first,
// then quote only its unquoted numeric tokens before decoding. This retains
// every source digit (including exponent notation), without affecting strings
// or silently repairing invalid JSON. All other endpoint decoders stay intact.
function parseFuturesNumbers(text: string): unknown {
  JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[^"\d-]+/g);
  if (!tokens || tokens.join('') !== text) throw new AccountError('account-invalid-response');
  return JSON.parse(tokens.map(token => /^[\d-]/.test(token) ? JSON.stringify(token) : token).join(''));
}

// This opaque token preserves JSON numbers without turning numeric UIDs into strings.
// Only isolated fee/capacity scopes use this decoder; legacy readers retain their contracts.
class ExactFeeNumber {
  constructor(readonly lexeme: string) { Object.freeze(this); }
}
export function accountFeeNumericLexeme(value: unknown): string | null {
  return value instanceof ExactFeeNumber ? value.lexeme : null;
}
function parseAccountFeeJson(raw: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  JSON.parse(text); // Reject invalid grammar before token-preserving traversal.
  let at = 0, nodes = 0;
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? '\u0000')) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new AccountError('account-invalid-response');
  };
  const value = (depth: number): unknown => {
    if (depth > 32 || ++nodes > 10_000) throw new AccountError('account-invalid-response');
    whitespace();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; whitespace();
      const result: Record<string, unknown> = Object.create(null), keys = new Set<string>();
      if (text[at] === '}') { at++; return result; }
      while (true) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new AccountError('account-invalid-response');
        keys.add(key); whitespace(); at++; result[key] = value(depth + 1); whitespace();
        if (text[at++] === '}') return result;
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); const result: unknown[] = [];
      if (text[at] === ']') { at++; return result; }
      while (true) { result.push(value(depth + 1)); whitespace(); if (text[at++] === ']') return result; }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (!match) throw new AccountError('account-invalid-response');
    at += match[0].length; return new ExactFeeNumber(match[0]);
  };
  const result = value(0); whitespace();
  if (at !== text.length) throw new AccountError('account-invalid-response');
  return result;
}

// GET-only transport. No production configuration, environment, secret lookup or write endpoint.
// Refuse overlapping reads instead of queuing already-signed timestamps until they expire.
export class AccountTransport {
  #fetch: typeof fetch;
  #clock: () => number;
  #busy = false;
  readonly #scope: AccountTransportScope;
  #cooldownUntil = 0;
  constructor(options: AccountOptions, scope: AccountTransportScope = 'accounts') {
    if (!['accounts', 'execution-history', 'order-recovery', 'account-identity', 'account-funds', 'account-fees', 'okx-capacity'].includes(scope)) throw new AccountError('account-invalid-config');
    this.#scope = scope;
    validateCredentials(options.credentials);
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? Date.now;
  }
  now() {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new AccountError('account-invalid-clock');
    return value;
  }
  cooldown(ms: number) {
    if (Number.isNaN(ms) || ms < 0) throw new AccountError('account-invalid-cooldown');
    this.#cooldownUntil = Math.max(this.#cooldownUntil, this.now() + Math.max(60_000, ms));
  }
  async request(input: string, headers: Record<string, string>): Promise<unknown> {
    const url = allowed(input, this.#scope);
    if (url.pathname.startsWith('/api/3/public/') && Object.keys(headers).length) {
      throw new AccountError('account-public-credentials-forbidden');
    }
    if (this.#busy) throw new AccountError('account-busy');
    if (this.now() < this.#cooldownUntil) throw new AccountError('account-rate-limited');
    this.#busy = true;
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void activeReader?.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AccountError('account-timeout')); }, 5000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.#fetch(url.href, { method: 'GET', headers, redirect: 'error',
          credentials: 'omit', cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new AccountError('account-timeout');
        }
        if (response.status === 429 || response.status === 418) {
          try {
            const retry = response.headers.get('retry-after');
            let delay = 60_000;
            if (retry && /^\d+(?:\.\d+)?$/.test(retry)) delay = Math.max(delay, Number(retry) * 1000);
            else if (retry) { const at = Date.parse(retry); if (Number.isFinite(at)) delay = Math.max(delay, at - this.now()); }
            this.cooldown(delay);
          } catch (error) {
            if (this.#scope !== 'account-fees' && this.#scope !== 'okx-capacity') throw error;
            // Preserve a known rejection for the durable owner even if the
            // single-use capture clock expired while the response arrived.
            this.#cooldownUntil = Infinity;
          }
          void response.body?.cancel().catch(() => {});
          throw new AccountError('account-rate-limited');
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          // MEXC documents HTTP 403 as a possible WAF rejection, not proof of bad credentials.
          if (response.status === 403 && url.origin === 'https://api.mexc.com') throw new AccountError('account-access-denied');
          throw new AccountError(response.status === 401 || response.status === 403 ? 'account-auth-failed' : 'account-api-rejected');
        }
        const size = response.headers.get('content-length');
        if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) {
          void response.body?.cancel().catch(() => {});
          throw new AccountError('account-response-too-large');
        }
        if (!response.body) throw new AccountError('account-invalid-response');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        activeReader = reader;
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (controller.signal.aborted) throw new AccountError('account-timeout');
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) throw new AccountError('account-response-too-large');
            chunks.push(chunk.value);
          }
        } finally { void reader.cancel().catch(() => {}); activeReader = undefined; }
        try {
          const body = Buffer.concat(chunks, bytes);
          if (this.#scope === 'account-fees' || this.#scope === 'okx-capacity') return parseAccountFeeJson(body);
          const text = body.toString('utf8');
          return url.origin === 'https://api.mexc.com' && url.pathname === '/api/v1/private/account/assets'
            ? parseFuturesNumbers(text) : JSON.parse(text);
        }
        catch { throw new AccountError('account-invalid-response'); }
      })()]);
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError('account-unavailable');
    } finally {
      clearTimeout(timer!);
      controller.abort();
      controller.signal.removeEventListener('abort', cancelReader);
      this.#busy = false;
    }
  }
}
