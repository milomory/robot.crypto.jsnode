import { ExecutionHistoryReader } from './execution-reader.js';
import { z } from 'zod';
import { BybitAccountReader } from './bybit.js';
import { OkxAccountReader } from './okx.js';
import { HitbtcAccountReader } from './hitbtc.js';
import { MexcFuturesAccountReader } from './mexc-futures.js';
import { MexcAccountReader } from './mexc.js';
import { AccountError, type AccountCredentials, type AccountOptions, type AccountVenue } from './types.js';

const credential = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const base = z.object({ schema: z.literal(1), environment: z.literal('mainnet'), region: z.literal('global'),
  apiKey: credential.max(1024), apiSecret: credential });
const schema = z.discriminatedUnion('venue', [
  base.extend({ venue: z.literal('bybit') }).strict(),
  base.extend({ venue: z.literal('okx'), passphrase: z.string().min(1).max(1024).regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/) }).strict(),
  base.extend({ venue: z.literal('hitbtc') }).strict(),
  base.extend({ venue: z.literal('mexc') }).strict()
]);
type Runtime = Pick<AccountOptions, 'fetch' | 'clock'>;

// Secrets stay in private fields and never appear in a bundle's JSON/inspect view.
// This parser is the consumer boundary; it does not fetch or provision vault entries.
export class AccountCredentialBundle {
  readonly venue: AccountVenue;
  readonly environment = 'mainnet' as const;
  readonly region = 'global' as const;
  readonly #credentials: AccountCredentials;
  private constructor(input: z.infer<typeof schema>) {
    this.venue = input.venue;
    this.#credentials = { apiKey: input.apiKey, apiSecret: input.apiSecret,
      ...(input.venue === 'okx' ? { passphrase: input.passphrase } : {}) };
  }
  static parse(text: string) {
    try {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024) throw new Error();
      const input = schema.safeParse(JSON.parse(text));
      if (!input.success) throw new Error();
      return new AccountCredentialBundle(input.data);
    } catch { throw new AccountError('account-invalid-credential-bundle'); }
  }
  executionHistoryReader(runtime: Runtime = {}) {
    if (this.venue !== 'mexc' && this.venue !== 'okx') throw new AccountError('account-unsupported-venue');
    return new ExecutionHistoryReader(this.venue, { ...runtime, credentials: this.#credentials });
  }
  mexcFuturesReader(runtime: Runtime = {}) {
    if (this.venue !== 'mexc') throw new AccountError('account-unsupported-venue');
    return new MexcFuturesAccountReader({ ...runtime, credentials: this.#credentials });
  }
  reader(runtime: Runtime = {}) {
    const options = { ...runtime, credentials: this.#credentials };
    if (this.venue === 'bybit') return new BybitAccountReader(options);
    if (this.venue === 'okx') return new OkxAccountReader(options);
    if (this.venue === 'hitbtc') return new HitbtcAccountReader(options);
    return new MexcAccountReader(options);
  }
}
