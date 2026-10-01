/** Private, account-bound spot fee observation. This module cannot place orders or change fee settings. */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AccountTransport, accountFeeNumericLexeme } from './transport.js';
import { AccountError, type AccountOptions } from './types.js';
import type { AccountIdentityRead, AccountIdentityVenue, OkxAccountIdentityType } from './account-identity-reader.js';

const WINDOW_MS = 30_000;
const time = z.number().int().positive().safe().max(8_640_000_000_000_000);
const interval = { requestedAt: time, receivedAt: time };
const sourceTime = z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) <= 8_640_000_000_000_000).nullable();
const rawRate = z.string().max(96).regex(/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?(?:[eE][+-]?\d{1,3})?$/);
const costRate = z.string().regex(/^(?:0(?:\.\d{1,30})?|1(?:\.0{1,30})?)$/);
const feeTypes = ['0', '1', '2', '5', '9', '12'] as const;
const mexcIdentity = z.object({ ...interval, venue: z.literal('mexc'), uid: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/),
  mainUid: z.null(), accountType: z.null(), mainAccountConfirmed: z.literal(false), mainAccountEvidence: z.literal('not-reported'), source: z.literal('/api/v3/uid') }).strict();
const okxIdentity = z.object({ ...interval, venue: z.literal('okx'), uid: z.string().regex(/^[1-9]\d{0,63}$/),
  mainUid: z.string().regex(/^[1-9]\d{0,63}$/), accountType: z.enum(feeTypes), mainAccountConfirmed: z.boolean(),
  mainAccountEvidence: z.literal('uid-mainUid-and-account-type'), source: z.literal('/api/v5/account/config') }).strict();
export const ACCOUNT_FEE_BLOCKERS = ['fee-currency-unconfirmed', 'mx-fee-conversion-unconfirmed',
  'source-time-unavailable', 'source-time-in-future', 'source-time-stale', 'rate-precision-over-18'] as const;
export type AccountFeeBlocker = typeof ACCOUNT_FEE_BLOCKERS[number];
const feeCommon = { ...interval, sourceUpdatedAt: sourceTime, makerRateRaw: rawRate, takerRateRaw: rawRate,
  makerCostRate: costRate, takerCostRate: costRate };
const common = { schema: z.literal(1), environment: z.literal('mainnet'), symbol: z.literal('BTC/USDT'),
  identityAccepted: z.literal(true), executable: z.literal(false), blockers: z.array(z.enum(ACCOUNT_FEE_BLOCKERS)).max(ACCOUNT_FEE_BLOCKERS.length) };
const schema = z.discriminatedUnion('venue', [
  z.object({ ...common, venue: z.literal('mexc'), origin: z.literal('https://api.mexc.com'), requestCount: z.literal(3), identity: mexcIdentity,
    fees: z.object({ ...feeCommon, source: z.literal('/api/v3/tradeFee?symbol=BTCUSDT'), rateConvention: z.literal('positive-fee'), feeGroupId: z.null() }).strict(),
    configuration: z.object({ ...interval, source: z.literal('/api/v3/mxDeduct/enable'), mxDeductEnabled: z.boolean(), feeCurrencyMode: z.literal('unknown') }).strict() }).strict(),
  z.object({ ...common, venue: z.literal('okx'), origin: z.literal('https://www.okx.com'), requestCount: z.literal(2), identity: okxIdentity,
    fees: z.object({ ...feeCommon, source: z.literal('/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT'),
      rateConvention: z.literal('negative-fee-positive-rebate'), feeGroupId: z.string().regex(/^\d{1,6}$/) }).strict(),
    configuration: z.object({ feeType: z.enum(['0', '1']).nullable(), feeCurrencyMode: z.enum(['received-asset', 'quote', 'unknown']) }).strict() }).strict(),
]);
export type AccountFeeSnapshot = z.infer<typeof schema>;
export type AccountFeeReadOptions = Readonly<{ acceptIdentity: (identity: AccountIdentityRead) => boolean | Promise<boolean> }>;
function invalid(): never { throw new AccountError('account-invalid-response'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function single(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) return invalid();
  return object(value[0]);
}
function lexeme(value: unknown): string {
  const result = typeof value === 'string' ? value : accountFeeNumericLexeme(value);
  if (result === null || !rawRate.safeParse(result).success) return invalid();
  return result;
}
/** Exact expansion with bounded exponents; rebates never become expected income. */
function costs(raw: string, venue: AccountIdentityVenue): string {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!parts) return invalid();
  const exponent = Number(parts[4] ?? 0);
  if (Math.abs(exponent) > 100) return invalid();
  const digits = parts[2] + (parts[3] ?? '');
  if (/^0+$/.test(digits)) return '0';
  const point = parts[2].length + exponent;
  let expanded = point <= 0 ? '0.' + '0'.repeat(-point) + digits :
    point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  let [whole, fraction = ''] = expanded.split('.');
  whole = whole.replace(/^0+(?=\d)/, ''); fraction = fraction.replace(/0+$/, '');
  expanded = whole + (fraction ? '.' + fraction : '');
  if (!costRate.safeParse(expanded).success || (venue === 'mexc' && parts[1] === '-')) return invalid();
  return venue === 'okx' && parts[1] !== '-' ? '0' : expanded;
}
function expectedBlockers(value: AccountFeeSnapshot): AccountFeeBlocker[] {
  const result: AccountFeeBlocker[] = [];
  if (value.configuration.feeCurrencyMode === 'unknown') result.push('fee-currency-unconfirmed');
  if (value.venue === 'mexc' && value.configuration.mxDeductEnabled) result.push('mx-fee-conversion-unconfirmed');
  if (value.fees.sourceUpdatedAt === null) result.push('source-time-unavailable');
  else if (Number(value.fees.sourceUpdatedAt) > value.fees.receivedAt) result.push('source-time-in-future');
  else if (value.fees.requestedAt - Number(value.fees.sourceUpdatedAt) > 60_000) result.push('source-time-stale');
  if ([value.fees.makerCostRate, value.fees.takerCostRate].some(rate => (rate.split('.')[1]?.length ?? 0) > 18)) result.push('rate-precision-over-18');
  return result;
}
/** Strict protected-archive decoder; derived cost/mode/blockers are verified, never trusted. */
export function parseAccountFeeSnapshot(value: unknown): AccountFeeSnapshot {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalid();
  const result = parsed.data;
  const intervals = [result.identity, result.fees, ...(result.venue === 'mexc' ? [result.configuration] : [])];
  if (intervals.some((item, index) => item.receivedAt < item.requestedAt ||
    (index > 0 && item.requestedAt < intervals[index - 1].receivedAt)) ||
    intervals.at(-1)!.receivedAt - intervals[0].requestedAt > WINDOW_MS) return invalid();
  if (result.venue === 'okx' && ((result.identity.accountType === '0') !== (result.identity.uid === result.identity.mainUid) ||
    result.identity.mainAccountConfirmed !== (result.identity.accountType === '0') || result.configuration.feeCurrencyMode !==
      (result.configuration.feeType === '0' ? 'received-asset' : result.configuration.feeType === '1' ? 'quote' : 'unknown'))) return invalid();
  if (result.fees.makerCostRate !== costs(result.fees.makerRateRaw, result.venue) ||
    result.fees.takerCostRate !== costs(result.fees.takerRateRaw, result.venue) ||
    JSON.stringify(result.blockers) !== JSON.stringify(expectedBlockers(result))) return invalid();
  return freeze(result);
}
function sourceTimestamp(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? raw : accountFeeNumericLexeme(raw);
  if (!sourceTime.safeParse(value).success || value === null) return invalid();
  return value;
}

/** Exact 3 MEXC / 2 OKX GETs, immutable credentials, identity checked before fee requests.
 * Official contracts checked 2026-10-01:
 * https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-symbol-commission
 * https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-mx-deduct-status
 * https://my.okx.com/docs-v5/en/#trading-account-rest-api-get-fee-rates
 * https://my.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration
 */
export class AccountFeeReader {
  readonly #venue: AccountIdentityVenue;
  readonly #credentials: AccountOptions['credentials'];
  readonly #transport: AccountTransport;
  #used = false;
  #expired = false;
  #startedAt: number | null = null;
  #lastAt: number | null = null;
  get venue(): AccountIdentityVenue { return this.#venue; }
  constructor(venue: AccountIdentityVenue, options: AccountOptions) {
    if (!['mexc', 'okx'].includes(venue) || !options?.credentials || (venue === 'okx' && !options.credentials.passphrase)) throw new AccountError('account-invalid-config');
    this.#venue = venue; this.#credentials = Object.freeze({ ...options.credentials });
    const clock = options.clock ?? Date.now;
    this.#transport = new AccountTransport({ credentials: this.#credentials, fetch: options.fetch, clock: () => {
      let at: number;
      try { at = clock(); } catch { throw new AccountError('account-invalid-clock'); }
      if (!Number.isSafeInteger(at) || at <= 0 || at > 8_640_000_000_000_000 || (this.#lastAt !== null && at < this.#lastAt)) throw new AccountError('account-invalid-clock');
      if (this.#expired || (this.#startedAt !== null && at - this.#startedAt > WINDOW_MS)) throw new AccountError('account-timeout');
      this.#lastAt = at; return at;
    } }, 'account-fees');
    Object.freeze(this);
  }
  #private(value: unknown): void {
    const text = JSON.stringify(value);
    for (const secret of Object.values(this.#credentials)) {
      if (secret && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))) return invalid();
    }
  }
  async #get(source: string): Promise<{ row: Record<string, unknown>; requestedAt: number; receivedAt: number }> {
    const requestedAt = this.#transport.now();
    let raw: unknown;
    if (this.#venue === 'mexc') {
      const [path, fixed = ''] = source.split('?');
      const query = new URLSearchParams(fixed);
      if (path !== '/api/v3/uid') query.set('recvWindow', '5000');
      query.set('timestamp', String(requestedAt));
      const signature = createHmac('sha256', this.#credentials.apiSecret).update(query.toString()).digest('hex');
      raw = await this.#transport.request(`https://api.mexc.com${path}?${query}&signature=${signature}`, { 'X-MEXC-APIKEY': this.#credentials.apiKey });
      const row = object(raw);
      if ('code' in row) {
        const code = accountFeeNumericLexeme(row.code);
        if (code === '418' || code === '429') throw new AccountError('account-rate-limited');
        if (code !== '0') throw new AccountError('account-api-rejected');
      } else if (path !== '/api/v3/uid') return invalid();
      return { row, requestedAt, receivedAt: this.#transport.now() };
    }
    const stamp = new Date(requestedAt).toISOString();
    const signature = createHmac('sha256', this.#credentials.apiSecret).update(`${stamp}GET${source}`).digest('base64');
    raw = await this.#transport.request(`https://www.okx.com${source}`, { 'OK-ACCESS-KEY': this.#credentials.apiKey,
      'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': stamp, 'OK-ACCESS-PASSPHRASE': this.#credentials.passphrase!, 'Content-Type': 'application/json' });
    const envelope = object(raw);
    if (typeof envelope.code === 'string' && ['50011', '50013', '50040'].includes(envelope.code)) throw new AccountError('account-rate-limited');
    if (envelope.code !== '0') throw new AccountError('account-api-rejected');
    return { row: single(envelope.data), requestedAt, receivedAt: this.#transport.now() };
  }
  async getSnapshot(options: AccountFeeReadOptions): Promise<AccountFeeSnapshot> {
    if (this.#used) throw new AccountError('account-reader-used');
    if (!options || typeof options.acceptIdentity !== 'function') throw new AccountError('account-invalid-config');
    const accept = options.acceptIdentity;
    this.#used = true; this.#startedAt = this.#transport.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      this.#expired = true; reject(new AccountError('account-timeout'));
    }, WINDOW_MS); });
    try { return await Promise.race([this.#capture(accept), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async #capture(accept: AccountFeeReadOptions['acceptIdentity']): Promise<AccountFeeSnapshot> {
    const captured = await this.#get(this.#venue === 'mexc' ? '/api/v3/uid' : '/api/v5/account/config');
    const { row: config, requestedAt, receivedAt } = captured;
    let identity: AccountIdentityRead;
    if (this.#venue === 'mexc') {
      const parsed = mexcIdentity.safeParse({ venue: 'mexc', uid: config.uid, mainUid: null, accountType: null,
        mainAccountConfirmed: false, mainAccountEvidence: 'not-reported', source: '/api/v3/uid', requestedAt, receivedAt });
      if (!parsed.success) return invalid();
      identity = freeze(parsed.data);
    } else {
      const parsed = okxIdentity.safeParse({ venue: 'okx', uid: config.uid, mainUid: config.mainUid, accountType: config.type as OkxAccountIdentityType,
        mainAccountConfirmed: config.type === '0', mainAccountEvidence: 'uid-mainUid-and-account-type', source: '/api/v5/account/config', requestedAt, receivedAt });
      if (!parsed.success || (parsed.data.accountType === '0') !== (parsed.data.uid === parsed.data.mainUid)) return invalid();
      identity = freeze(parsed.data);
    }
    this.#private(identity);
    let accepted: boolean;
    try { accepted = await accept(identity); } catch { throw new AccountError('account-identity-mismatch'); }
    this.#transport.now();
    if (accepted !== true) throw new AccountError('account-identity-mismatch');
    const feeSource = this.#venue === 'mexc' ? '/api/v3/tradeFee?symbol=BTCUSDT' : '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT';
    const observed = await this.#get(feeSource);
    const shared = { schema: 1 as const, environment: 'mainnet' as const, symbol: 'BTC/USDT' as const,
      identityAccepted: true as const, executable: false as const, identity };
    let snapshot: AccountFeeSnapshot;
    if (this.#venue === 'mexc') {
      const data = object(observed.row.data), makerRateRaw = lexeme(data.makerCommission), takerRateRaw = lexeme(data.takerCommission);
      const makerCostRate = costs(makerRateRaw, 'mexc'), takerCostRate = costs(takerRateRaw, 'mexc');
      const sourceUpdatedAt = sourceTimestamp(observed.row.timestamp);
      const mx = await this.#get('/api/v3/mxDeduct/enable');
      const mxDeductEnabled = object(mx.row.data).mxDeductEnable;
      if (typeof mxDeductEnabled !== 'boolean') return invalid();
      snapshot = { ...shared, venue: 'mexc', origin: 'https://api.mexc.com', requestCount: 3, identity: identity as Extract<AccountIdentityRead, { venue: 'mexc' }>,
        fees: { source: feeSource as '/api/v3/tradeFee?symbol=BTCUSDT', requestedAt: observed.requestedAt, receivedAt: observed.receivedAt,
          sourceUpdatedAt, makerRateRaw, takerRateRaw, makerCostRate,
          takerCostRate, rateConvention: 'positive-fee', feeGroupId: null },
        configuration: { source: '/api/v3/mxDeduct/enable', requestedAt: mx.requestedAt, receivedAt: mx.receivedAt,
          mxDeductEnabled, feeCurrencyMode: 'unknown' }, blockers: [] };
    } else {
      const row = observed.row;
      if (row.instType !== 'SPOT' || (row.instId !== undefined && row.instId !== 'BTC-USDT')) return invalid();
      const group = single(row.feeGroup), makerRateRaw = lexeme(group.maker), takerRateRaw = lexeme(group.taker);
      const feeType = config.feeType === '0' || config.feeType === '1' ? config.feeType : null;
      snapshot = { ...shared, venue: 'okx', origin: 'https://www.okx.com', requestCount: 2, identity: identity as Extract<AccountIdentityRead, { venue: 'okx' }>,
        fees: { source: feeSource as '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT', requestedAt: observed.requestedAt, receivedAt: observed.receivedAt,
          sourceUpdatedAt: sourceTimestamp(row.ts), makerRateRaw, takerRateRaw, makerCostRate: costs(makerRateRaw, 'okx'),
          takerCostRate: costs(takerRateRaw, 'okx'), rateConvention: 'negative-fee-positive-rebate', feeGroupId: group.groupId as string },
        configuration: { feeType, feeCurrencyMode: feeType === '0' ? 'received-asset' : feeType === '1' ? 'quote' : 'unknown' }, blockers: [] };
    }
    snapshot.blockers = expectedBlockers(snapshot);
    this.#private(snapshot);
    return parseAccountFeeSnapshot(snapshot);
  }
}
