import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AccountTransport } from './transport.js';
import { AccountError, type AccountOptions } from './types.js';

const URL = 'https://api.mexc.com/api/v1/private/account/assets';
const credentialsSchema = z.object({
  apiKey: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  apiSecret: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/)
});
const rawAmount = z.string().max(256);
const rowSchema = z.object({
  currency: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),
  equity: rawAmount,
  availableBalance: rawAmount,
  bonus: rawAmount.nullish(),
  debtAmount: rawAmount.nullish(),
  availableCash: rawAmount.nullish()
});
const envelopeSchema = z.object({ success: z.boolean(), code: z.string().regex(/^\d{1,10}$/) });
const payloadSchema = z.object({ success: z.literal(true), code: z.literal('0'), data: z.array(rowSchema).max(200) });

// Expand the original JSON token using decimal digit positions, never Number.
// The only numeric conversion is a bounded integer exponent, not an amount.
function decimal(source: string): string {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(source);
  if (!match) throw new AccountError('account-invalid-response');
  const exponent = Number(match[4] ?? '0');
  if (Math.abs(exponent) > 150) throw new AccountError('account-invalid-response');
  const digits = match[2] + (match[3] ?? '');
  const point = match[2].length + exponent;
  const expanded = point <= 0 ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point) + '.' + digits.slice(point);
  const [whole, fraction = ''] = expanded.split('.');
  const integer = whole.replace(/^0+(?=\d)/, ''), tail = fraction.replace(/0+$/, '');
  if (integer.length > 90 || tail.length > 60) throw new AccountError('account-invalid-response');
  const absolute = integer + (tail ? '.' + tail : '');
  return match[1] && absolute !== '0' ? '-' + absolute : absolute;
}
function nullableAmount(source: string | null | undefined, nonnegative = false): string | null {
  if (source === undefined || source === null) return null;
  const result = decimal(source);
  if (nonnegative && result.startsWith('-')) throw new AccountError('account-invalid-response');
  return result;
}

export interface MexcFuturesBalances {
  venue: 'mexc';
  account: 'futures';
  requestedAt: number;
  receivedAt: number;
  balances: Array<{
    currency: string;
    equity: string;
    bonus: string | null;
    debtAmount: string | null;
    availableBalance: string;
    availableCash: string | null;
  }>;
}

/** Fixed GET-only MEXC Futures balance read. No orders, transfers or mode changes.
 * Protocol: https://www.mexc.com/api-docs/futures/integration-guide
 * Assets: https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-all-account-assets
 * Equity is the exchange's reported total equity. The API does not specify a
 * formula relating it to bonus/debt: preserve those separately, never double
 * count margin/PnL, and never infer freely withdrawable funds from equity.
 */
export class MexcFuturesAccountReader {
  readonly #transport: AccountTransport;
  readonly #credentials: z.infer<typeof credentialsSchema>;
  constructor(options: AccountOptions) {
    const parsed = credentialsSchema.safeParse(options?.credentials);
    if (!parsed.success) throw new AccountError('account-invalid-config');
    this.#credentials = parsed.data;
    this.#transport = new AccountTransport(options);
  }
  async getBalances(): Promise<MexcFuturesBalances> {
    const requestedAt = this.#transport.now();
    if (requestedAt > 8_640_000_000_000_000) throw new AccountError('account-invalid-clock');
    const timestamp = String(requestedAt);
    const signature = createHmac('sha256', this.#credentials.apiSecret)
      .update(this.#credentials.apiKey + timestamp).digest('hex');
    const payload = await this.#transport.request(URL, {
      ApiKey: this.#credentials.apiKey, 'Request-Time': timestamp, Signature: signature
    });
    const envelope = envelopeSchema.safeParse(payload);
    if (!envelope.success) throw new AccountError('account-invalid-response');
    if (envelope.data.code !== '0') {
      const code = envelope.data.code;
      if (['510', '429', '418'].includes(code)) {
        this.#transport.cooldown(60_000);
        throw new AccountError('account-rate-limited');
      }
      if (['401', '402', '602'].includes(code)) throw new AccountError('account-auth-failed');
      if (['403', '406', '511', '701'].includes(code)) throw new AccountError('account-access-denied');
      if (['604', '801'].includes(code)) throw new AccountError('account-unavailable');
      throw new AccountError('account-api-rejected');
    }
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success || new Set(parsed.data.data.map(row => row.currency)).size !== parsed.data.data.length) {
      throw new AccountError('account-invalid-response');
    }
    const balances = parsed.data.data.map(row => ({
      currency: row.currency,
      equity: decimal(row.equity),
      bonus: nullableAmount(row.bonus, true),
      debtAmount: nullableAmount(row.debtAmount, true),
      availableBalance: decimal(row.availableBalance),
      availableCash: nullableAmount(row.availableCash)
    }));
    const receivedAt = this.#transport.now();
    if (receivedAt < requestedAt || receivedAt - requestedAt > 120_000 || receivedAt > 8_640_000_000_000_000) {
      throw new AccountError('account-invalid-clock');
    }
    return { venue: 'mexc', account: 'futures', requestedAt, receivedAt, balances };
  }
}
