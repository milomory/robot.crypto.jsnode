/** Fixed read-only cash capacity observation; neither a reservation nor an order admission. */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AccountTransport } from './transport.js';
import { AccountError, type AccountOptions } from './types.js';
import type { AccountIdentityRead } from './account-identity-reader.js';
export const OKX_CAPACITY_SOURCE = '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDT' as const;
const CONFIG = '/api/v5/account/config' as const;
const time = z.number().int().positive().safe().max(8_640_000_000_000_000);
const interval = { requestedAt: time, receivedAt: time };
const amount = z.string().max(61).regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const identitySchema = z.object({ ...interval, venue: z.literal('okx'), uid: z.string().regex(/^[1-9]\d{0,63}$/),
  mainUid: z.string().regex(/^[1-9]\d{0,63}$/), accountType: z.literal('0'), mainAccountConfirmed: z.literal(true),
  mainAccountEvidence: z.literal('uid-mainUid-and-account-type'), source: z.literal(CONFIG) }).strict();
const fields = ['accountMode', 'autoLoan', 'enableSpotBorrow', 'spotBorrowAutoRepay', 'feeType'] as const;
const configurationSchema = z.object({ accountMode: z.enum(['1','2','3','4']).nullable(), autoLoan: z.boolean().nullable(),
  enableSpotBorrow: z.boolean().nullable(), spotBorrowAutoRepay: z.boolean().nullable(), feeType: z.enum(['0','1']).nullable(),
  unavailableFields: z.object({ accountMode: z.enum(['missing','null','empty']).optional(), autoLoan: z.enum(['missing','null','empty']).optional(),
    enableSpotBorrow: z.enum(['missing','null','empty']).optional(), spotBorrowAutoRepay: z.enum(['missing','null','empty']).optional(),
    feeType: z.enum(['missing','null','empty']).optional() }).strict() }).strict();
const configSchema = z.object({ identity: identitySchema, configuration: configurationSchema }).strict();
export const OKX_CAPACITY_BLOCKERS = ['source-time-unavailable', 'capacity-not-reserved', 'fee-inclusion-unconfirmed',
  'separate-funds-evidence-required', 'account-mode-unconfirmed', 'account-mode-not-spot', 'borrow-settings-unconfirmed',
  'borrow-setting-enabled', 'fee-currency-unconfirmed'] as const;
const snapshotSchema = z.object({ schema: z.literal(1), venue: z.literal('okx'), environment: z.literal('mainnet'),
  origin: z.literal('https://www.okx.com'), symbol: z.literal('BTC/USDT'), requestCount: z.literal(3),
  identityAccepted: z.literal(true), configurationStable: z.literal(true), executable: z.literal(false), before: configSchema, after: configSchema,
  capacity: z.object({ ...interval, source: z.literal(OKX_CAPACITY_SOURCE), sourceUpdatedAt: z.null(),
    buyQuoteAvailable: amount, sellBaseAvailable: amount, quoteCurrencyEcho: z.enum(['not-reported', 'empty', 'matched']), buyUnit: z.literal('USDT'), sellUnit: z.literal('BTC') }).strict(),
  blockers: z.array(z.enum(OKX_CAPACITY_BLOCKERS)).max(OKX_CAPACITY_BLOCKERS.length) }).strict();
export type OkxCapacitySnapshot = z.infer<typeof snapshotSchema>;
export type OkxCapacityReadOptions = Readonly<{ acceptIdentity: (identity: AccountIdentityRead) => boolean | Promise<boolean> }>;
type Config = z.infer<typeof configSchema>;
export const CAPACITY_READ_STEPS = ['before-config', 'capacity', 'after-config', 'snapshot'] as const;
export const CAPACITY_REJECTION_REASONS = ['shape', 'identity-shape', 'configuration-shape', 'instrument',
  'buy-amount', 'sell-amount', 'configuration-changed', 'snapshot-invariant', 'quote-currency', 'other'] as const;
export type CapacityFailureDiagnostic = Readonly<{ step: typeof CAPACITY_READ_STEPS[number]; reason: typeof CAPACITY_REJECTION_REASONS[number] }>;
const rejectionReasons = new WeakMap<object, CapacityFailureDiagnostic['reason']>();
const failureDetails = new WeakMap<object, CapacityFailureDiagnostic>();
export function getCapacityFailureDiagnostic(error: unknown): CapacityFailureDiagnostic | null {
  return error && typeof error === 'object' ? failureDetails.get(error) ?? null : null;
}
const invalid = (reason: CapacityFailureDiagnostic['reason'] = 'shape'): never => {
  const error = new AccountError('account-invalid-response'); rejectionReasons.set(error, reason); throw error;
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function blockers(config: Config['configuration']): OkxCapacitySnapshot['blockers'] {
  const result: OkxCapacitySnapshot['blockers'] = ['source-time-unavailable', 'capacity-not-reserved', 'fee-inclusion-unconfirmed', 'separate-funds-evidence-required'];
  if (config.accountMode === null) result.push('account-mode-unconfirmed');
  else if (config.accountMode !== '1') result.push('account-mode-not-spot');
  const borrow = [config.autoLoan, config.enableSpotBorrow, config.spotBorrowAutoRepay];
  if (borrow.includes(null)) result.push('borrow-settings-unconfirmed');
  if (borrow.includes(true)) result.push('borrow-setting-enabled');
  if (config.feeType === null) result.push('fee-currency-unconfirmed');
  return result;
}
function sameConfig(a: Config, b: Config): boolean {
  return a.identity.uid === b.identity.uid && a.identity.mainUid === b.identity.mainUid && JSON.stringify(a.configuration) === JSON.stringify(b.configuration);
}
export function parseOkxCapacitySnapshot(value: unknown): OkxCapacitySnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return invalid();
  const result = parsed.data;
  for (const config of [result.before, result.after]) {
    if (config.identity.uid !== config.identity.mainUid) return invalid();
    for (const field of fields) if ((config.configuration[field] === null) !== (config.configuration.unavailableFields[field] !== undefined)) return invalid();
  }
  const sequence = [result.before.identity.requestedAt, result.before.identity.receivedAt, result.capacity.requestedAt,
    result.capacity.receivedAt, result.after.identity.requestedAt, result.after.identity.receivedAt];
  if (sequence.some((at, i) => i > 0 && at < sequence[i - 1]) || sequence[5] - sequence[0] > 30_000 || !sameConfig(result.before, result.after) ||
      JSON.stringify(result.blockers) !== JSON.stringify(blockers(result.before.configuration))) return invalid();
  return freeze(result);
}
function configuration(row: Record<string, unknown>, requestedAt: number, receivedAt: number): Config {
  const values: Record<string, unknown> = {}, unavailableFields: Record<string, string> = {};
  for (const field of fields) {
    const raw = row[field === 'accountMode' ? 'acctLv' : field];
    if (raw === undefined || raw === null || raw === '') {
      values[field] = null; unavailableFields[field] = raw === undefined ? 'missing' : raw === null ? 'null' : 'empty';
    } else values[field] = raw;
  }
  const parsed = configSchema.safeParse({ identity: { venue: 'okx', uid: row.uid, mainUid: row.mainUid, accountType: row.type,
    mainAccountConfirmed: row.type === '0', mainAccountEvidence: 'uid-mainUid-and-account-type', source: CONFIG, requestedAt, receivedAt },
    configuration: { ...values, unavailableFields } });
  if (!parsed.success) {
    if (!identitySchema.safeParse({ venue: 'okx', uid: row.uid, mainUid: row.mainUid, accountType: row.type,
      mainAccountConfirmed: row.type === '0', mainAccountEvidence: 'uid-mainUid-and-account-type', source: CONFIG, requestedAt, receivedAt }).success) return invalid('identity-shape');
    return invalid('configuration-shape');
  }
  if (parsed.data.identity.uid !== parsed.data.identity.mainUid) return invalid('identity-shape');
  return freeze(parsed.data);
}
/** Three sequential GETs; matching settings do not prove atomicity or absence of debt. */
export class OkxCapacityReader {
  readonly #credentials: AccountOptions['credentials'];
  readonly #transport: AccountTransport;
  #step: CapacityFailureDiagnostic['step'] = 'before-config';
  #used = false;
  #expired = false;
  #startedAt: number | null = null;
  #lastAt: number | null = null;
  constructor(options: AccountOptions) {
    if (!options?.credentials?.passphrase) throw new AccountError('account-invalid-config');
    this.#credentials = Object.freeze({ ...options.credentials });
    const clock = options.clock ?? Date.now;
    this.#transport = new AccountTransport({ credentials: this.#credentials, fetch: options.fetch, clock: () => {
      let at: number;
      try { at = clock(); } catch { throw new AccountError('account-invalid-clock'); }
      if (!time.safeParse(at).success || (this.#lastAt !== null && at < this.#lastAt)) throw new AccountError('account-invalid-clock');
      if (this.#expired || (this.#startedAt !== null && at - this.#startedAt > 30_000)) throw new AccountError('account-timeout');
      this.#lastAt = at; return at;
    } }, 'okx-capacity');
    Object.freeze(this);
  }
  #private(value: unknown) {
    const text = JSON.stringify(value);
    for (const secret of Object.values(this.#credentials)) if (secret &&
      (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))) return invalid();
  }
  async #get(source: typeof CONFIG | typeof OKX_CAPACITY_SOURCE) {
    const requestedAt = this.#transport.now(), stamp = new Date(requestedAt).toISOString();
    const sign = createHmac('sha256', this.#credentials.apiSecret).update(`${stamp}GET${source}`).digest('base64');
    const raw = object(await this.#transport.request(`https://www.okx.com${source}`, { 'OK-ACCESS-KEY': this.#credentials.apiKey,
      'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': stamp, 'OK-ACCESS-PASSPHRASE': this.#credentials.passphrase!, 'Content-Type': 'application/json' }));
    if (typeof raw.code === 'string' && ['50011', '50013', '50040'].includes(raw.code)) throw new AccountError('account-rate-limited');
    if (raw.code !== '0') throw new AccountError('account-api-rejected');
    if (!Array.isArray(raw.data) || raw.data.length !== 1) return invalid();
    return { row: object(raw.data[0]), requestedAt, receivedAt: this.#transport.now() };
  }
  async #accept(config: Config, accept: OkxCapacityReadOptions['acceptIdentity']) {
    this.#private(config);
    let accepted: boolean;
    try { accepted = await accept(config.identity); } catch { throw new AccountError('account-identity-mismatch'); }
    this.#transport.now();
    if (accepted !== true) throw new AccountError('account-identity-mismatch');
  }
  async getSnapshot(options: OkxCapacityReadOptions): Promise<OkxCapacitySnapshot> {
    if (this.#used) throw new AccountError('account-reader-used');
    if (!options || typeof options.acceptIdentity !== 'function') throw new AccountError('account-invalid-config');
    const accept = options.acceptIdentity;
    this.#used = true; this.#startedAt = this.#transport.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      this.#expired = true; reject(new AccountError('account-timeout'));
    }, 30_000); });
    try { return await Promise.race([this.#capture(accept), timeout]); }
    catch (error) {
      if (error && typeof error === 'object') failureDetails.set(error, Object.freeze({ step: this.#step, reason: rejectionReasons.get(error) ?? 'other' }));
      throw error;
    }
    finally { if (timer) clearTimeout(timer); }
  }
  async #capture(accept: OkxCapacityReadOptions['acceptIdentity']): Promise<OkxCapacitySnapshot> {
    const first = await this.#get(CONFIG), before = configuration(first.row, first.requestedAt, first.receivedAt);
    await this.#accept(before, accept);
    this.#step = 'capacity';
    const observed = await this.#get(OKX_CAPACITY_SOURCE), row = observed.row;
    if (row.instId !== 'BTC-USDT') return invalid('instrument');
    // The documented response does not require tradeQuoteCcy. An empty optional
    // echo supplies no evidence; units remain bound to BTC-USDT and the fixed request.
    if (row.tradeQuoteCcy !== undefined && row.tradeQuoteCcy !== '' && row.tradeQuoteCcy !== 'USDT') return invalid('quote-currency');
    if (!amount.safeParse(row.availBuy).success) return invalid('buy-amount');
    if (!amount.safeParse(row.availSell).success) return invalid('sell-amount');
    const capacity = { source: OKX_CAPACITY_SOURCE, requestedAt: observed.requestedAt, receivedAt: observed.receivedAt,
      quoteCurrencyEcho: row.tradeQuoteCcy === undefined ? 'not-reported' : row.tradeQuoteCcy === '' ? 'empty' : 'matched',
      sourceUpdatedAt: null, buyQuoteAvailable: row.availBuy as string, sellBaseAvailable: row.availSell as string, buyUnit: 'USDT' as const, sellUnit: 'BTC' as const };
    this.#private(capacity);
    this.#step = 'after-config';
    const last = await this.#get(CONFIG), after = configuration(last.row, last.requestedAt, last.receivedAt);
    await this.#accept(after, accept);
    this.#step = 'snapshot';
    if (!sameConfig(before, after)) return invalid('configuration-changed');
    return parseOkxCapacitySnapshot({ schema: 1, venue: 'okx', environment: 'mainnet', origin: 'https://www.okx.com', symbol: 'BTC/USDT',
      requestCount: 3, identityAccepted: true, configurationStable: true, executable: false, before, capacity, after,
      blockers: blockers(before.configuration) });
  }
}
