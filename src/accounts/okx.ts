import { createHmac } from 'node:crypto';
import { okxTrades, okxOrders, okxTransfers } from './operation-records.js';
import { AccountTransport } from './transport.js';
import type { OkxEarnBalance, OkxEarnHistoryRecord } from './earn-contract.js';
import { AccountError, type AccountOptions, type AccountSymbol } from './types.js';

// The global OKX origin is fixed. Regional accounts must be handled explicitly
// before credentials are provisioned; never discover a destination by redirect.
const ORIGIN = 'https://www.okx.com';
const SYMBOLS: Record<AccountSymbol, string> = {
  'BTC/USDT': 'BTC-USDT', 'ETH/USDT': 'ETH-USDT', 'SOL/USDT': 'SOL-USDT',
};
const DECIMAL = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/;
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/;

function invalid(): never { throw new AccountError('account-invalid-response'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 2_000) return invalid();
  return value;
}
function single(value: unknown): Record<string, unknown> {
  const items = array(value);
  if (items.length !== 1) return invalid();
  return object(items[0]);
}
function decimal(value: unknown, signed = true): string {
  if (typeof value !== 'string' || !(signed ? DECIMAL : POSITIVE_DECIMAL).test(value)) return invalid();
  return value;
}
function nullableDecimal(value: unknown, signed = true): string | null {
  return value === '' ? null : decimal(value, signed);
}
function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(value)) return invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)
    || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
  return value;
}
function credential(value: unknown, passphrase = false): string {
  if (typeof value !== 'string' || !(passphrase ? /^[\x21-\x7e](?:[\x20-\x7e]{0,1022}[\x21-\x7e])?$/ : /^[\x21-\x7e]{1,4096}$/).test(value)) {
    throw new AccountError('account-invalid-credentials');
  }
  return value;
}
function uniqueCurrencies<T extends { currency: string }>(items: T[]): T[] {
  if (new Set(items.map((item) => item.currency)).size !== items.length) return invalid();
  return items;
}

export type OkxKeyPermissions = {
  venue: 'okx'; read: boolean; trade: boolean; withdraw: boolean;
  unknownPermissionsPresent: boolean; accountMode: '1' | '2' | '3' | '4';
  feeType: '0' | '1' | null;
};
export type OkxTradingBalances = {
  venue: 'okx'; account: 'trading'; updatedAt: string; totalEquityUsd: string;
  balances: Array<{
    currency: string; cashBalance: string; equity: string; availableBalance: string | null;
    availableEquity: string | null; frozenBalance: string | null; updatedAt: string;
  }>;
};
export type OkxFundingBalances = {
  venue: 'okx'; account: 'funding';
  balances: Array<{ currency: string; balance: string; availableBalance: string; frozenBalance: string }>;
};
export type OkxAssetValuation = {
  venue: 'okx'; currency: 'USDT'; totalUsdt: string; updatedAt: string;
  wallets: { trading: string; funding: string; earn: string; classic: string };
  breakdownMatchesTotal: boolean;
};
export type OkxSpotFees = {
  venue: 'okx'; symbol: AccountSymbol; makerRate: string; takerRate: string;
  rateConvention: 'negative-fee-positive-rebate'; source: 'fee-group'; updatedAt: string;
};

/** Isolated account reads. No runtime wiring, trade, transfer or withdrawal methods. */
export class OkxAccountReader {
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #passphrase: string;
  readonly #transport: AccountTransport;

  constructor(options: AccountOptions) {
    this.#apiKey = credential(options?.credentials?.apiKey);
    this.#apiSecret = credential(options?.credentials?.apiSecret);
    this.#passphrase = credential(options?.credentials?.passphrase, true);
    this.#transport = new AccountTransport(options);
  }

  async #get(path: string): Promise<unknown[]> {
    const now = this.#transport.now();
    if (!Number.isSafeInteger(now) || now <= 0 || now > 8_640_000_000_000_000) {
      throw new AccountError('account-invalid-clock');
    }
    const time = new Date(now).toISOString();
    const sign = createHmac('sha256', this.#apiSecret).update(`${time}GET${path}`).digest('base64');
    const raw = object(await this.#transport.request(`${ORIGIN}${path}`, {
      'OK-ACCESS-KEY': this.#apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': time,
      'OK-ACCESS-PASSPHRASE': this.#passphrase,
      'Content-Type': 'application/json',
    }));
    if (typeof raw.code !== 'string') return invalid();
    if (raw.code === '50011' || raw.code === '50013' || raw.code === '50040') {
      this.#transport.cooldown(60_000);
      throw new AccountError('account-rate-limited');
    }
    if (raw.code === '50102') throw new AccountError('account-clock-skew');
    if (raw.code !== '0') throw new AccountError('account-api-rejected');
    return array(raw.data);
  }

  async getKeyPermissions(): Promise<OkxKeyPermissions> {
    const row = single(await this.#get('/api/v5/account/config'));
    if (typeof row.perm !== 'string' || row.perm.length === 0 || row.perm.length > 512
      || !['1', '2', '3', '4'].includes(String(row.acctLv)) || typeof row.acctLv !== 'string') return invalid();
    const permissions = row.perm.split(',');
    if (permissions.some((permission) => !/^[a-z][a-z_]{0,31}$/.test(permission))
      || new Set(permissions).size !== permissions.length) return invalid();
    return {
      venue: 'okx', read: permissions.includes('read_only'), trade: permissions.includes('trade'),
      withdraw: permissions.includes('withdraw'),
      unknownPermissionsPresent: permissions.some((permission) => !['read_only', 'trade', 'withdraw'].includes(permission)),
      accountMode: row.acctLv as OkxKeyPermissions['accountMode'],
      // GET account/config: 0 charges the obtained asset, 1 the quote asset.
      // Missing/future values stay unknown; never infer the account setting.
      feeType: row.feeType === '0' || row.feeType === '1' ? row.feeType : null,
    };
  }

  async getBalances(): Promise<OkxTradingBalances> {
    const row = single(await this.#get('/api/v5/account/balance'));
    return {
      venue: 'okx', account: 'trading', updatedAt: timestamp(row.uTime), totalEquityUsd: decimal(row.totalEq),
      balances: uniqueCurrencies(array(row.details).map((value) => {
        const item = object(value);
        return {
          currency: currency(item.ccy), cashBalance: decimal(item.cashBal), equity: decimal(item.eq),
          availableBalance: nullableDecimal(item.availBal), availableEquity: nullableDecimal(item.availEq),
          frozenBalance: nullableDecimal(item.frozenBal, false), updatedAt: timestamp(item.uTime),
        };
      })),
    };
  }

  async getFundingBalances(): Promise<OkxFundingBalances> {
    const rows = await this.#get('/api/v5/asset/balances');
    return {
      venue: 'okx', account: 'funding', balances: uniqueCurrencies(rows.map((value) => {
        const item = object(value);
        return { currency: currency(item.ccy), balance: decimal(item.bal, false),
          availableBalance: decimal(item.availBal, false), frozenBalance: decimal(item.frozenBal, false) };
      })),
    };
  }

  async getAssetValuation(): Promise<OkxAssetValuation> {
    const requestedAt = this.#transport.now();
    // The default denomination is BTC. Pin USDT in both signed request and
    // response projection; account.totalEq elsewhere is USD, not USDT.
    const row = single(await this.#get('/api/v5/asset/asset-valuation?ccy=USDT'));
    const receivedAt = this.#transport.now();
    if (receivedAt < requestedAt || receivedAt > 8_640_000_000_000_000) throw new AccountError('account-invalid-clock');
    const updatedAt = timestamp(row.ts);
    if (BigInt(updatedAt) > BigInt(receivedAt)) return invalid();
    const details = object(row.details);
    const wallets = { trading: decimal(details.trading), funding: decimal(details.funding, false),
      earn: decimal(details.earn, false), classic: decimal(details.classic, false) };
    const totalUsdt = decimal(row.totalBal);
    const values = [totalUsdt, ...Object.values(wallets)];
    const scale = Math.max(...values.map(value => value.split('.')[1]?.length ?? 0));
    const atoms = (value: string) => {
      const negative = value.startsWith('-');
      const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
      return BigInt(whole + fraction.padEnd(scale, '0')) * (negative ? -1n : 1n);
    };
    // OKX documents totalBal as its total valuation, without guaranteeing that
    // separately presented wallet figures sum exactly (even its example does
    // not). Preserve that official total and expose exact agreement only as a
    // diagnostic; never synthesize a replacement total or tolerance.
    const breakdownMatchesTotal = atoms(totalUsdt) === Object.values(wallets).reduce((sum, value) => sum + atoms(value), 0n);
    return { venue: 'okx', currency: 'USDT', totalUsdt, updatedAt, wallets, breakdownMatchesTotal };
  }

  async getEarnBalance(): Promise<OkxEarnBalance | null> {
    const rows = await this.#get('/api/v5/finance/savings/balance?ccy=USDT');
    if (rows.length === 0) return null;
    const row = single(rows);
    if (row.ccy !== 'USDT') return invalid();
    // `rate` remains documented as a user-selected minimum APR, a setting
    // removed on 2026-08-27. Neither that field nor balance earnings (whose
    // period is unspecified) can represent actual recent yield.
    return { currency: 'USDT', amount: decimal(row.amt, false),
      lendingAmount: decimal(row.loanAmt, false), pendingAmount: decimal(row.pendingAmt, false),
      reportedEarnings: decimal(row.earnings) };
  }

  async getEarnHistoryPage(after?: string): Promise<OkxEarnHistoryRecord[]> {
    const requestedAt = this.#transport.now();
    if (after !== undefined && (timestamp(after) !== after || Number(after) > requestedAt)) return invalid();
    const rows = await this.#get('/api/v5/finance/savings/lending-history?ccy=USDT&limit=100' +
      (after === undefined ? '' : `&after=${after}`));
    const receivedAt = this.#transport.now();
    if (receivedAt < requestedAt || receivedAt > 8_640_000_000_000_000) throw new AccountError('account-invalid-clock');
    if (rows.length > 100) return invalid();
    const records = rows.map(value => {
      const row = object(value), at = Number(timestamp(row.ts));
      if (row.ccy !== 'USDT' || at > receivedAt || (after !== undefined && at > Number(after))) return invalid();
      return { currency: 'USDT' as const, amount: decimal(row.amt, false), earnings: decimal(row.earnings), at };
    });
    // Keep duplicate timestamps for explicit conflict detection by the bounded
    // collector. A response out of descending order cannot establish a cursor.
    if (records.some((row, index) => index > 0 && row.at > records[index - 1].at)) return invalid();
    return records;
  }

  async getSpotFees(symbol: AccountSymbol): Promise<OkxSpotFees> {
    if (!Object.hasOwn(SYMBOLS, symbol)) throw new AccountError('account-unsupported-symbol');
    const instrument = SYMBOLS[symbol];
    const row = single(await this.#get(`/api/v5/account/trade-fee?instType=SPOT&instId=${instrument}`));
    if (row.instType !== 'SPOT' || (row.instId !== undefined && row.instId !== instrument)) return invalid();
    // Deprecated top-level maker/taker fields must not mask an ambiguous group.
    // The instId-targeted request must resolve to exactly one fee group.
    const group = single(row.feeGroup);
    if (typeof group.groupId !== 'string' || !/^\d{1,6}$/.test(group.groupId)) return invalid();
    return {
      venue: 'okx', symbol, makerRate: decimal(group.maker), takerRate: decimal(group.taker),
      rateConvention: 'negative-fee-positive-rebate', source: 'fee-group', updatedAt: timestamp(row.ts),
    };
  }
  async getOpenOrders() {
    return okxOrders(await this.#get('/api/v5/trade/orders-pending?instType=SPOT&limit=100'), this.#transport.now());
  }
  async getRecentTrades() {
    const now = this.#transport.now();
    return okxTrades(await this.#get(`/api/v5/trade/fills-history?instType=SPOT&begin=${Math.max(1, now - 7 * 86400_000)}&end=${now}&limit=100`), this.#transport.now());
  }
  async getDeposits() {
    return okxTransfers(await this.#get('/api/v5/asset/deposit-history?limit=100'), 'deposit', this.#transport.now());
  }
  async getWithdrawals() {
    return okxTransfers(await this.#get('/api/v5/asset/withdrawal-history?limit=100'), 'withdrawal', this.#transport.now());
  }

}
