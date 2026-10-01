import { createHmac } from 'node:crypto';
import { AccountError, type AccountOptions, type AccountSymbol } from './types.js';
import { AccountTransport } from './transport.js';

const ORIGIN = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/;
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/;

export interface BybitKeyPermissions {
  venue: 'bybit';
  readOnly: boolean;
  /** Named mutation permissions are effective only when the key is read/write. */
  rights: { spotTrade: boolean; accountTransfer: boolean; subAccountTransfer: boolean; withdraw: boolean };
}
export interface BybitCoinBalance {
  coin: string;
  walletBalance: string;
  equity: string;
  usdValue: string;
  locked: string;
  borrowAmount: string;
  accruedInterest: string;
  spotBorrow?: string;
}
export interface BybitBalances {
  venue: 'bybit';
  accountType: 'UNIFIED';
  coins: BybitCoinBalance[];
  /** USD account-wide values can be unavailable in isolated mode. These are NOT transferable balances. */
  margin: { totalEquityUSD: string | null; totalWalletBalanceUSD: string | null; totalAvailableBalanceUSD: string | null };
}
export interface BybitSpotFees {
  venue: 'bybit';
  symbol: AccountSymbol;
  makerRate: string;
  takerRate: string;
  rateUnit: 'fraction';
}

function invalid(): never { throw new AccountError('account-invalid-response'); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function decimal(value: unknown, signed = false): string {
  if (typeof value !== 'string' || !(signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(value)) invalid();
  return value;
}
function nullableDecimal(value: unknown): string | null {
  return value === undefined || value === '' ? null : decimal(value, true);
}
function permissionList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 ||
      value.some(item => typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(item))) invalid();
  return value as string[];
}
function single(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) invalid();
  return object(value[0]);
}

/** Fixed mainnet reads only. No production routes, polling, vault access or mutation methods. */
export class BybitAccountReader {
  readonly #credentials: { apiKey: string; apiSecret: string };
  readonly #transport: AccountTransport;

  constructor(options: AccountOptions) {
    const credentials = options?.credentials;
    if (!credentials || typeof credentials.apiKey !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(credentials.apiKey) ||
        typeof credentials.apiSecret !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(credentials.apiSecret)) {
      throw new AccountError('account-invalid-config');
    }
    this.#credentials = { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret };
    this.#transport = new AccountTransport(options);
  }

  async #get(path: string, query = ''): Promise<Record<string, unknown>> {
    const timestamp = String(this.#transport.now());
    const signature = createHmac('sha256', this.#credentials.apiSecret)
      .update(timestamp + this.#credentials.apiKey + RECV_WINDOW + query).digest('hex');
    const raw = object(await this.#transport.request(ORIGIN + path + (query ? `?${query}` : ''), {
      'X-BAPI-API-KEY': this.#credentials.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'X-BAPI-SIGN': signature
    }));
    if (typeof raw.retCode !== 'number' || !Number.isSafeInteger(raw.retCode)) invalid();
    if (raw.retCode === 10006 || raw.retCode === 429) {
      this.#transport.cooldown(60_000);
      throw new AccountError('account-rate-limited');
    }
    if ([-2015, 33004, 10003, 10004, 10005, 10007, 10010].includes(raw.retCode)) {
      throw new AccountError('account-auth-failed');
    }
    if (raw.retCode !== 0) throw new AccountError('account-api-rejected');
    return object(raw.result);
  }

  async getKeyPermissions(): Promise<BybitKeyPermissions> {
    const result = await this.#get('/v5/user/query-api');
    if (result.readOnly !== 0 && result.readOnly !== 1) invalid();
    const permissions = object(result.permissions);
    const spot = permissionList(permissions.Spot);
    const wallet = permissionList(permissions.Wallet);
    const writable = result.readOnly === 0;
    return { venue: 'bybit', readOnly: !writable, rights: {
      spotTrade: writable && spot.includes('SpotTrade'),
      accountTransfer: writable && wallet.includes('AccountTransfer'),
      subAccountTransfer: writable && wallet.includes('SubMemberTransfer'),
      withdraw: writable && wallet.includes('Withdraw')
    } };
  }

  async getBalances(): Promise<BybitBalances> {
    const result = await this.#get('/v5/account/wallet-balance', 'accountType=UNIFIED');
    const account = single(result.list);
    if (account.accountType !== 'UNIFIED' || !Array.isArray(account.coin) || account.coin.length > 1000) invalid();
    const seen = new Set<string>();
    const coins = account.coin.map(item => {
      const row = object(item);
      if (typeof row.coin !== 'string' || !/^[A-Z0-9]{1,32}$/.test(row.coin) || seen.has(row.coin)) invalid();
      seen.add(row.coin);
      return { coin: row.coin, walletBalance: decimal(row.walletBalance, true),
        equity: decimal(row.equity, true), usdValue: decimal(row.usdValue, true),
        locked: decimal(row.locked), borrowAmount: decimal(row.borrowAmount), accruedInterest: decimal(row.accruedInterest),
        ...(row.spotBorrow === undefined ? {} : { spotBorrow: decimal(row.spotBorrow) }) };
    });
    return { venue: 'bybit', accountType: 'UNIFIED', coins,
      margin: { totalEquityUSD: nullableDecimal(account.totalEquity),
        totalWalletBalanceUSD: nullableDecimal(account.totalWalletBalance),
        totalAvailableBalanceUSD: nullableDecimal(account.totalAvailableBalance) } };
  }

  async getSpotFees(symbol: AccountSymbol): Promise<BybitSpotFees> {
    const wireSymbols: Record<string, string> = { 'BTC/USDT': 'BTCUSDT', 'ETH/USDT': 'ETHUSDT', 'SOL/USDT': 'SOLUSDT' };
    const wireSymbol = typeof symbol === 'string' && Object.hasOwn(wireSymbols, symbol) ? wireSymbols[symbol] : undefined;
    if (!wireSymbol) throw new AccountError('account-invalid-symbol');
    const result = await this.#get('/v5/account/fee-rate', `category=spot&symbol=${wireSymbol}`);
    const fee = single(result.list);
    if (result.category !== 'spot' || fee.symbol !== wireSymbol) invalid();
    return { venue: 'bybit', symbol, makerRate: decimal(fee.makerFeeRate, true),
      takerRate: decimal(fee.takerFeeRate, true), rateUnit: 'fraction' };
  }
}
