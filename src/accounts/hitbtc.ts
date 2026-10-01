import { z } from 'zod';
import { AccountError, type AccountOptions, type AccountSymbol } from './types.js';
import { AccountTransport } from './transport.js';

const ORIGIN = 'https://api.hitbtc.com';
const instruments: Record<AccountSymbol, { native: string; base: string }> = {
  'BTC/USDT': { native: 'BTCUSDT', base: 'BTC' },
  'ETH/USDT': { native: 'ETHUSDT', base: 'ETH' },
  'SOL/USDT': { native: 'SOLUSDT', base: 'SOL' }
};
const credential = z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/);
const credentialsSchema = z.object({
  apiKey: credential.refine((value) => !value.includes(':')),
  apiSecret: credential
});
const currencySchema = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const rateSchema = z.string().regex(/^-?(?:0(?:\.\d{1,30})?|1(?:\.0{1,30})?)$/);
const balanceSchema = z.object({
  currency: currencySchema,
  available: amountSchema,
  reserved: amountSchema
});
const spotBalanceSchema = balanceSchema.extend({
  reserved_margin: amountSchema.optional(),
  cross_margin_reserved: amountSchema.optional()
});
const metadataSchema = z.object({
  type: z.literal('spot'),
  base_currency: currencySchema,
  quote_currency: z.literal('USDT'),
  status: z.literal('working')
});
const feeSchema = z.object({ make_rate: rateSchema, take_rate: rateSchema });

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AccountError('invalid-response');
  return result.data;
}

function validateUniqueCurrencies(balances: { currency: string }[]): void {
  if (new Set(balances.map((balance) => balance.currency)).size !== balances.length) {
    throw new AccountError('invalid-response');
  }
}

/** Read-only V3 surface, including for credentials that also permit writes.
 * Protocol: https://api.hitbtc.com/#basic and #get-trading-commission.
 * No API-key enumeration, orders, transfers, or withdrawals are implemented.
 */
export class HitbtcAccountReader {
  readonly #transport: AccountTransport;
  readonly #authorization: string;

  constructor(options: AccountOptions) {
    const result = credentialsSchema.safeParse(options?.credentials);
    if (!result.success) throw new AccountError('invalid-credentials');
    this.#authorization = `Basic ${Buffer.from(`${result.data.apiKey}:${result.data.apiSecret}`, 'utf8').toString('base64')}`;
    this.#transport = new AccountTransport(options);
  }

  async getBalances() {
    const payload = await this.#transport.request(`${ORIGIN}/api/3/spot/balance`, {
      Authorization: this.#authorization
    });
    const balances = parse(z.array(spotBalanceSchema).max(5000), payload);
    validateUniqueCurrencies(balances);
    return { venue: 'hitbtc' as const, scope: 'spot' as const, balances };
  }

  async getFundingBalances() {
    const payload = await this.#transport.request(`${ORIGIN}/api/3/wallet/balance`, {
      Authorization: this.#authorization
    });
    const balances = parse(z.array(balanceSchema).max(5000), payload);
    validateUniqueCurrencies(balances);
    return { venue: 'hitbtc' as const, scope: 'funding' as const, balances };
  }

  async getSpotFees(symbol: AccountSymbol) {
    if (!Object.hasOwn(instruments, symbol)) throw new AccountError('invalid-symbol');
    const instrument = instruments[symbol];
    // Validate exact assets from public metadata on every call. Never substitute
    // a USD market for USDT or send credentials to this public endpoint.
    const metadata = parse(metadataSchema, await this.#transport.request(
      `${ORIGIN}/api/3/public/symbol/${instrument.native}`, {}
    ));
    if (metadata.base_currency !== instrument.base) throw new AccountError('invalid-response');
    // The exchange requires its "Place/cancel orders" access right even for this
    // GET. Possession of that right does not add write methods to this reader.
    const fee = parse(feeSchema, await this.#transport.request(
      `${ORIGIN}/api/3/spot/fee/${instrument.native}`, { Authorization: this.#authorization }
    ));
    return {
      venue: 'hitbtc' as const,
      symbol,
      makerRate: fee.make_rate,
      takerRate: fee.take_rate,
      rateUnit: 'fraction' as const
    };
  }
}
