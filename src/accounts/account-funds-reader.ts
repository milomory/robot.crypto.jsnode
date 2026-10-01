/** Private, sequential identity/funds observations. No enrollment or trading admission. */
import { createHmac } from 'node:crypto';
import type { AccountIdentityRead, AccountIdentityVenue, OkxAccountIdentityType } from './account-identity-reader.js';
import { AccountTransport } from './transport.js';
import { AccountError, type AccountOptions } from './types.js';

const MAX_ROWS = 2_000;
const WINDOW_MS = 30_000;
const MONEY = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/;
const OKX_TYPES = ['0', '1', '2', '5', '9', '12'] as const;
type MissingKind = 'missing' | 'null' | 'empty';
type Timing = { readonly requestedAt: number; readonly receivedAt: number };
type Unavailable = Readonly<Record<string, MissingKind>>;
export type MexcFundsRow = {
  readonly currency: string; readonly free: string; readonly locked: string; readonly available: string | null;
  readonly unavailableFields: Unavailable;
};
export type OkxFundsRow = {
  readonly currency: string; readonly cashBal: string | null; readonly availBal: string | null;
  readonly frozenBal: string | null; readonly liab: string | null; readonly crossLiab: string | null;
  readonly isoLiab: string | null; readonly interest: string | null; readonly borrowFroz: string | null;
  readonly sourceUpdatedAt: string | null; readonly unavailableFields: Unavailable;
};
export type OkxFundsConfiguration = {
  readonly accountMode: string | null; readonly autoLoan: boolean | null;
  readonly enableSpotBorrow: boolean | null; readonly spotBorrowAutoRepay: boolean | null;
  readonly unavailableFields: Unavailable;
};
export const ACCOUNT_FUNDS_REASONS = [
  'mexc-available-semantics-unconfirmed', 'mexc-account-type-unconfirmed', 'mexc-can-trade-unconfirmed',
  'okx-mode-not-supported', 'okx-borrow-enabled-or-unknown', 'required-assets-not-reported', 'fields-unavailable',
  'negative-amount-reported', 'liability-reported', 'precision-over-18', 'source-time-in-future', 'money-admission-not-implemented',
] as const;
export type AccountFundsReason = typeof ACCOUNT_FUNDS_REASONS[number];
type Common = {
  readonly schema: 1; readonly environment: 'mainnet'; readonly identity: AccountIdentityRead;
  readonly requestCount: 2; readonly identityAccepted: true; readonly fundsAdmission: false; readonly executable: false;
  readonly assessment: {
    readonly requiredAssets: Readonly<Record<'BTC' | 'USDT' | 'MX', boolean>>;
    readonly reasons: readonly AccountFundsReason[];
  };
};
export type AccountFundsSnapshot = Common & (
  { readonly venue: 'mexc'; readonly origin: 'https://api.mexc.com'; readonly configuration: null;
    readonly funds: Timing & { readonly source: '/api/v3/account'; readonly sourceUpdatedAt: string | null;
      readonly accountType: string | null; readonly canTrade: boolean | null;
      readonly unavailableFields: Unavailable; readonly balances: readonly MexcFundsRow[] } } |
  { readonly venue: 'okx'; readonly origin: 'https://www.okx.com'; readonly configuration: OkxFundsConfiguration;
    readonly funds: Timing & { readonly source: '/api/v5/account/balance'; readonly sourceUpdatedAt: string | null;
      readonly unavailableFields: Unavailable; readonly balances: readonly OkxFundsRow[] } });
export type AccountFundsReadOptions = {
  /** Trusted private policy check. Exactly true is required before the funds request. */
  readonly acceptIdentity: (identity: AccountIdentityRead) => boolean | Promise<boolean>;
};
function invalid(): never { throw new AccountError('account-invalid-response'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function single(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) return invalid();
  return object(value[0]);
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) return invalid();
  return value.map(object);
}
function uid(value: unknown, venue: AccountIdentityVenue): string {
  if (typeof value !== 'string' || !(venue === 'mexc' ? /^[\x21-\x7e]{1,256}$/ : /^[1-9]\d{0,63}$/).test(value)) return invalid();
  return value;
}
function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value)) return invalid();
  return value;
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !MONEY.test(value)) return invalid();
  return value;
}
function unavailable(row: Record<string, unknown>, key: string, fields: Record<string, MissingKind>): boolean {
  const value = row[key];
  if (value === undefined || value === null || value === '') {
    fields[key] = value === undefined ? 'missing' : value === null ? 'null' : 'empty'; return true;
  }
  return false;
}
function nullableMoney(row: Record<string, unknown>, key: string, fields: Record<string, MissingKind>): string | null {
  return unavailable(row, key, fields) ? null : money(row[key]);
}
function nullableBoolean(row: Record<string, unknown>, key: string, fields: Record<string, MissingKind>): boolean | null {
  if (unavailable(row, key, fields)) return null;
  if (typeof row[key] !== 'boolean') return invalid();
  return row[key];
}
function nullableTag(row: Record<string, unknown>, key: string, fields: Record<string, MissingKind>): string | null {
  if (unavailable(row, key, fields)) return null;
  const value = row[key];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) return invalid();
  return value;
}
function sourceTime(row: Record<string, unknown>, key: string, fields: Record<string, MissingKind>, numeric = false): string | null {
  if (unavailable(row, key, fields)) return null;
  const raw = row[key];
  const value = numeric && typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 8_640_000_000_000_000) return invalid();
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function unique<T extends { currency: string }>(rows: T[]): T[] {
  if (new Set(rows.map(row => row.currency)).size !== rows.length) return invalid();
  return rows;
}

/**
 * Exactly two GETs per instance; immutable credentials, no retry, redirect or pagination.
 * Official contracts checked 2026-09-30:
 * https://www.mexc.com/api-docs/spot-v3/spot-account-trade/account-information
 * https://my.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration
 * https://my.okx.com/docs-v5/en/#trading-account-rest-api-get-balance
 */
export class AccountFundsReader {
  readonly #venue: AccountIdentityVenue;
  readonly #credentials: AccountOptions['credentials'];
  readonly #transport: AccountTransport;
  #used = false;
  #expired = false;
  #startedAt: number | null = null;
  #lastAt: number | null = null;
  get venue(): AccountIdentityVenue { return this.#venue; }
  constructor(venue: AccountIdentityVenue, options: AccountOptions) {
    if (!['mexc', 'okx'].includes(venue) || !options?.credentials || (venue === 'okx' && !options.credentials.passphrase)) {
      throw new AccountError('account-invalid-config');
    }
    this.#venue = venue;
    this.#credentials = Object.freeze({ ...options.credentials });
    const clock = options.clock ?? Date.now;
    this.#transport = new AccountTransport({ credentials: this.#credentials, fetch: options.fetch, clock: () => {
      let at: number;
      try { at = clock(); } catch { throw new AccountError('account-invalid-clock'); }
      if (!Number.isSafeInteger(at) || at <= 0 || at > 8_640_000_000_000_000 || (this.#lastAt !== null && at < this.#lastAt)) {
        throw new AccountError('account-invalid-clock');
      }
      if (this.#expired || (this.#startedAt !== null && at - this.#startedAt > WINDOW_MS)) throw new AccountError('account-timeout');
      this.#lastAt = at;
      return at;
    } }, 'account-funds');
    Object.freeze(this);
  }
  #private(value: unknown): void {
    const text = JSON.stringify(value);
    for (const secret of Object.values(this.#credentials)) {
      if (secret && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))) return invalid();
    }
  }
  async #get(source: string): Promise<{ row: Record<string, unknown>; timing: Timing }> {
    const requestedAt = this.#transport.now();
    let raw: unknown;
    if (this.#venue === 'mexc') {
      const query = new URLSearchParams(source === '/api/v3/account' ? { recvWindow: '5000', timestamp: String(requestedAt) } : { timestamp: String(requestedAt) }).toString();
      const signature = createHmac('sha256', this.#credentials.apiSecret).update(query).digest('hex');
      raw = await this.#transport.request(`https://api.mexc.com${source}?${query}&signature=${signature}`, { 'X-MEXC-APIKEY': this.#credentials.apiKey });
      const row = object(raw);
      if ('code' in row && row.code !== 0) {
        // This reader is single-use. Preserve a known limit even if the capture
        // clock has expired, so its protected caller can persist shared cooldown.
        if (row.code === 418 || row.code === 429) throw new AccountError('account-rate-limited');
        throw new AccountError('account-api-rejected');
      }
      return { row, timing: { requestedAt, receivedAt: this.#transport.now() } };
    }
    const stamp = new Date(requestedAt).toISOString();
    const signature = createHmac('sha256', this.#credentials.apiSecret).update(`${stamp}GET${source}`).digest('base64');
    raw = await this.#transport.request(`https://www.okx.com${source}`, { 'OK-ACCESS-KEY': this.#credentials.apiKey,
      'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': stamp, 'OK-ACCESS-PASSPHRASE': this.#credentials.passphrase!, 'Content-Type': 'application/json' });
    const envelope = object(raw);
    // No next request is possible after failure; the caller owns durable cooldown.
    if (['50011', '50013', '50040'].includes(String(envelope.code))) throw new AccountError('account-rate-limited');
    if (envelope.code !== '0') throw new AccountError('account-api-rejected');
    return { row: single(envelope.data), timing: { requestedAt, receivedAt: this.#transport.now() } };
  }
  async getSnapshot(options: AccountFundsReadOptions): Promise<AccountFundsSnapshot> {
    if (this.#used) throw new AccountError('account-reader-used');
    if (!options || typeof options.acceptIdentity !== 'function') throw new AccountError('account-invalid-config');
    const acceptIdentity = options.acceptIdentity;
    this.#used = true;
    this.#startedAt = this.#transport.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      this.#expired = true; reject(new AccountError('account-timeout'));
    }, WINDOW_MS); });
    try { return await Promise.race([this.#capture(acceptIdentity), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async #capture(accept: AccountFundsReadOptions['acceptIdentity']): Promise<AccountFundsSnapshot> {
    const { row: config, timing } = await this.#get(this.#venue === 'mexc' ? '/api/v3/uid' : '/api/v5/account/config');
    let identity: AccountIdentityRead;
    let configuration: OkxFundsConfiguration | null = null;
    if (this.#venue === 'mexc') {
      identity = freeze({ venue: 'mexc', uid: uid(config.uid, 'mexc'), mainUid: null, accountType: null,
        mainAccountConfirmed: false, mainAccountEvidence: 'not-reported', source: '/api/v3/uid', ...timing });
    } else {
      const id = uid(config.uid, 'okx'), mainUid = uid(config.mainUid, 'okx');
      if (!OKX_TYPES.includes(config.type as OkxAccountIdentityType) || (config.type === '0') !== (id === mainUid)) return invalid();
      identity = freeze({ venue: 'okx', uid: id, mainUid, accountType: config.type as OkxAccountIdentityType,
        mainAccountConfirmed: config.type === '0', mainAccountEvidence: 'uid-mainUid-and-account-type', source: '/api/v5/account/config', ...timing });
      const unavailableFields: Record<string, MissingKind> = {};
      configuration = freeze({ accountMode: nullableTag(config, 'acctLv', unavailableFields),
        autoLoan: nullableBoolean(config, 'autoLoan', unavailableFields), enableSpotBorrow: nullableBoolean(config, 'enableSpotBorrow', unavailableFields),
        spotBorrowAutoRepay: nullableBoolean(config, 'spotBorrowAutoRepay', unavailableFields), unavailableFields });
    }
    this.#private({ identity, configuration });
    let accepted: boolean;
    try { accepted = await accept(identity); } catch { throw new AccountError('account-identity-mismatch'); }
    this.#transport.now();
    if (accepted !== true) throw new AccountError('account-identity-mismatch');
    const { row, timing: fundsTiming } = await this.#get(this.#venue === 'mexc' ? '/api/v3/account' : '/api/v5/account/balance');
    const unavailableFields: Record<string, MissingKind> = {};
    let snapshot: Omit<AccountFundsSnapshot, 'assessment'>;
    const common = { schema: 1 as const, environment: 'mainnet' as const, identity, requestCount: 2 as const,
      identityAccepted: true as const, fundsAdmission: false as const, executable: false as const };
    if (this.#venue === 'mexc') {
      const balances = unique(list(row.balances).map(value => {
        const unavailableFields: Record<string, MissingKind> = {};
        return { currency: currency(value.asset), free: money(value.free), locked: money(value.locked),
          available: nullableMoney(value, 'available', unavailableFields), unavailableFields };
      }));
      snapshot = { ...common, venue: 'mexc', origin: 'https://api.mexc.com', configuration: null,
        funds: { source: '/api/v3/account', ...fundsTiming, sourceUpdatedAt: sourceTime(row, 'updateTime', unavailableFields, true),
          accountType: nullableTag(row, 'accountType', unavailableFields), canTrade: nullableBoolean(row, 'canTrade', unavailableFields), unavailableFields, balances } };
    } else {
      const balances = unique(list(row.details).map(value => {
        const unavailableFields: Record<string, MissingKind> = {};
        return { currency: currency(value.ccy), cashBal: nullableMoney(value, 'cashBal', unavailableFields),
          availBal: nullableMoney(value, 'availBal', unavailableFields), frozenBal: nullableMoney(value, 'frozenBal', unavailableFields),
          liab: nullableMoney(value, 'liab', unavailableFields), crossLiab: nullableMoney(value, 'crossLiab', unavailableFields),
          isoLiab: nullableMoney(value, 'isoLiab', unavailableFields), interest: nullableMoney(value, 'interest', unavailableFields),
          borrowFroz: nullableMoney(value, 'borrowFroz', unavailableFields), sourceUpdatedAt: sourceTime(value, 'uTime', unavailableFields), unavailableFields };
      }));
      snapshot = { ...common, venue: 'okx', origin: 'https://www.okx.com', configuration: configuration!,
        funds: { source: '/api/v5/account/balance', ...fundsTiming, sourceUpdatedAt: sourceTime(row, 'uTime', unavailableFields), unavailableFields, balances } };
    }
    const result = { ...snapshot, assessment: assess(snapshot) } as AccountFundsSnapshot;
    this.#private(result);
    this.#transport.now();
    return freeze(result);
  }
}

function assess(snapshot: Omit<AccountFundsSnapshot, 'assessment'>): AccountFundsSnapshot['assessment'] {
  const reasons = new Set<AccountFundsReason>(['money-admission-not-implemented']);
  const requiredAssets = { BTC: false, USDT: false, MX: false };
  const fields = snapshot.funds.balances;
  for (const asset of ['BTC', 'USDT', 'MX'] as const) requiredAssets[asset] = fields.some(row => row.currency === asset);
  if (Object.values(requiredAssets).some(value => !value)) reasons.add('required-assets-not-reported');
  if (Object.keys(snapshot.funds.unavailableFields).length) reasons.add('fields-unavailable');
  if (snapshot.funds.sourceUpdatedAt !== null && Number(snapshot.funds.sourceUpdatedAt) > snapshot.funds.receivedAt) reasons.add('source-time-in-future');
  for (const row of fields) {
    if (Object.keys(row.unavailableFields).length) reasons.add('fields-unavailable');
    for (const [field, value] of Object.entries(row)) {
      if (field === 'currency' || field === 'unavailableFields' || value === null || typeof value !== 'string') continue;
      if (field === 'sourceUpdatedAt') { if (Number(value) > snapshot.funds.receivedAt) reasons.add('source-time-in-future'); continue; }
      if (value.startsWith('-')) reasons.add('negative-amount-reported');
      if ((value.split('.')[1]?.length ?? 0) > 18) reasons.add('precision-over-18');
      if (['liab', 'crossLiab', 'isoLiab', 'interest', 'borrowFroz'].includes(field) && /[1-9]/.test(value)) reasons.add('liability-reported');
    }
  }
  if (snapshot.venue === 'mexc') {
    reasons.add('mexc-available-semantics-unconfirmed');
    if (!('accountType' in snapshot.funds) || snapshot.funds.accountType !== 'SPOT') reasons.add('mexc-account-type-unconfirmed');
    if (!('canTrade' in snapshot.funds) || snapshot.funds.canTrade !== true) reasons.add('mexc-can-trade-unconfirmed');
  } else {
    if (snapshot.configuration?.accountMode !== '1') reasons.add('okx-mode-not-supported');
    if (!snapshot.configuration || Object.keys(snapshot.configuration.unavailableFields).length) reasons.add('fields-unavailable');
    if (snapshot.configuration?.autoLoan !== false || snapshot.configuration?.enableSpotBorrow !== false ||
      snapshot.configuration?.spotBorrowAutoRepay !== false) reasons.add('okx-borrow-enabled-or-unknown');
  }
  return { requiredAssets, reasons: [...reasons] };
}
