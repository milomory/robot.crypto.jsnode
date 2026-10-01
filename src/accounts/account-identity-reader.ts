/** Private account identity observation; never enrollment or permission to trade. */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AccountTransport } from './transport.js';
import { AccountError, type AccountOptions } from './types.js';

export type AccountIdentityVenue = 'mexc' | 'okx';
// MEXC documents an opaque string, not a decimal identifier. Preserve every byte;
// the 256-visible-ASCII limit is our bounded decoder policy, with no normalization.
const mexcUid = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
// OKX keeps its existing conservative local decimal/64-character decoder limit.
const okxUid = z.string().regex(/^[1-9][0-9]{0,63}$/);
const mexcIdentity = z.object({ uid: mexcUid });
const okxIdentity = z.object({ uid: okxUid, mainUid: okxUid, type: z.enum(['0', '1', '2', '5', '9', '12']) })
  .refine(row => (row.type === '0') === (row.uid === row.mainUid));
export type OkxAccountIdentityType = z.infer<typeof okxIdentity>['type'];
type Timing = { readonly requestedAt: number; readonly receivedAt: number };
/** Raw IDs belong only in a protected caller/archive, not a dashboard or logs. */
export type AccountIdentityRead = Timing & (
  { readonly venue: 'mexc'; readonly uid: string; readonly mainUid: null; readonly accountType: null;
    readonly mainAccountConfirmed: false; readonly mainAccountEvidence: 'not-reported'; readonly source: '/api/v3/uid' } |
  { readonly venue: 'okx'; readonly uid: string; readonly mainUid: string; readonly accountType: OkxAccountIdentityType;
    readonly mainAccountConfirmed: boolean; readonly mainAccountEvidence: 'uid-mainUid-and-account-type'; readonly source: '/api/v5/account/config' });

function invalid(identityDiagnosticCode?: 'mexc-uid-missing' | 'mexc-uid-numeric' | 'mexc-uid-invalid-string' | 'mexc-uid-invalid-type' |
  'okx-invalid-envelope' | 'okx-invalid-row-count' | 'okx-uid-invalid' | 'okx-mainuid-invalid' |
  'okx-account-type-unknown' | 'okx-account-type-conflict'): never {
  const error = new AccountError('account-invalid-response');
  if (identityDiagnosticCode) Object.defineProperty(error, 'identityDiagnosticCode', { value: identityDiagnosticCode });
  throw error;
}
function timestamp(value: number) {
  if (value <= 0 || value > 8_640_000_000_000_000) throw new AccountError('account-invalid-clock');
  return value;
}

/**
 * One fixed GET per call. Credentials are injected and copied; no environment,
 * vault lookup, automatic retry, account enumeration, or expected-UID binding.
 * Sources:
 * https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-uid
 * https://my.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration
 */
export class AccountIdentityReader {
  readonly #venue: AccountIdentityVenue;
  get venue(): AccountIdentityVenue { return this.#venue; }
  readonly #transport: AccountTransport;
  readonly #credentials: AccountOptions['credentials'];

  constructor(venue: AccountIdentityVenue, options: AccountOptions) {
    if (!['mexc', 'okx'].includes(venue) || !options?.credentials ||
        (venue === 'okx' && !options.credentials.passphrase)) throw new AccountError('account-invalid-config');
    this.#venue = venue;
    this.#transport = new AccountTransport(options, 'account-identity');
    this.#credentials = Object.freeze({ ...options.credentials });
    Object.freeze(this);
  }

  async getIdentity(): Promise<AccountIdentityRead> {
    const requestedAt = timestamp(this.#transport.now());
    if (this.#venue === 'mexc') {
      const source = '/api/v3/uid';
      const unsigned = new URLSearchParams({ timestamp: String(requestedAt) }).toString();
      const signature = createHmac('sha256', this.#credentials.apiSecret).update(unsigned).digest('hex');
      const raw = await this.#transport.request(`https://api.mexc.com${source}?${unsigned}&signature=${signature}`,
        { 'X-MEXC-APIKEY': this.#credentials.apiKey });
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'code' in raw && raw.code !== 0) {
        if ([429, 418].includes(raw.code as number)) {
          this.#transport.cooldown(60_000); throw new AccountError('account-rate-limited');
        }
        throw new AccountError('account-api-rejected');
      }
      const parsed = mexcIdentity.safeParse(raw);
      if (!parsed.success) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('uid' in raw)) return invalid('mexc-uid-missing');
        return invalid(typeof raw.uid === 'number' ? 'mexc-uid-numeric' :
          typeof raw.uid === 'string' ? 'mexc-uid-invalid-string' : 'mexc-uid-invalid-type');
      }
      const receivedAt = timestamp(this.#transport.now());
      if (receivedAt < requestedAt) throw new AccountError('account-invalid-clock');
      // UID alone cannot distinguish a main account from a subaccount.
      return Object.freeze({ venue: 'mexc', uid: parsed.data.uid, mainUid: null, accountType: null,
        mainAccountConfirmed: false, mainAccountEvidence: 'not-reported', source, requestedAt, receivedAt });
    }

    const source = '/api/v5/account/config', stamp = new Date(requestedAt).toISOString();
    const signature = createHmac('sha256', this.#credentials.apiSecret).update(`${stamp}GET${source}`).digest('base64');
    const raw = await this.#transport.request(`https://www.okx.com${source}`, {
      'OK-ACCESS-KEY': this.#credentials.apiKey, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': stamp,
      'OK-ACCESS-PASSPHRASE': this.#credentials.passphrase!, 'Content-Type': 'application/json',
    });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('code' in raw) || !('data' in raw)) return invalid('okx-invalid-envelope');
    if (['50011', '50013', '50040'].includes(String(raw.code))) {
      this.#transport.cooldown(60_000); throw new AccountError('account-rate-limited');
    }
    if (raw.code !== '0') throw new AccountError('account-api-rejected');
    const parsed = z.array(okxIdentity).length(1).safeParse(raw.data);
    if (!parsed.success) {
      if (!Array.isArray(raw.data) || raw.data.length !== 1) return invalid('okx-invalid-row-count');
      const row: unknown = raw.data[0];
      if (!row || typeof row !== 'object' || Array.isArray(row) || !('uid' in row) || !okxUid.safeParse(row.uid).success) return invalid('okx-uid-invalid');
      if (!('mainUid' in row) || !okxUid.safeParse(row.mainUid).success) return invalid('okx-mainuid-invalid');
      if (!('type' in row) || !z.enum(['0', '1', '2', '5', '9', '12']).safeParse(row.type).success) return invalid('okx-account-type-unknown');
      return invalid('okx-account-type-conflict');
    }
    const receivedAt = timestamp(this.#transport.now());
    if (receivedAt < requestedAt) throw new AccountError('account-invalid-clock');
    const row = parsed.data[0];
    return Object.freeze({ venue: 'okx', uid: row.uid, mainUid: row.mainUid, accountType: row.type,
      mainAccountConfirmed: row.type === '0', mainAccountEvidence: 'uid-mainUid-and-account-type',
      source, requestedAt, receivedAt });
  }
}
