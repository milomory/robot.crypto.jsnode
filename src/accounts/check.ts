import { BybitAccountReader } from './bybit.js';
import { OkxAccountReader } from './okx.js';
import { HitbtcAccountReader } from './hitbtc.js';
import { AccountCredentialBundle } from './credentials.js';
import type { AccountOptions } from './types.js';

// A fixed first credential check returns operational metadata, not balances or keys.
// It can use full-permission credentials, but every possible request is a GET.
export async function checkAccount(bundle: AccountCredentialBundle, runtime: Pick<AccountOptions, 'fetch' | 'clock'> = {}) {
  const reader = bundle.reader(runtime);
  const permissions = reader instanceof BybitAccountReader || reader instanceof OkxAccountReader
    ? { verified: true, observed: await reader.getKeyPermissions() }
    : { verified: false, reason: 'permission-introspection-not-implemented' };
  const account = await reader.getBalances();
  const funding = reader instanceof OkxAccountReader || reader instanceof HitbtcAccountReader
    ? await reader.getFundingBalances() : null;
  await reader.getSpotFees('BTC/USDT');
  return { schema: 1, venue: bundle.venue, environment: bundle.environment, region: bundle.region,
    authenticatedReadsVerified: true, permissions,
    accountAssets: 'coins' in account ? account.coins.length : account.balances.length,
    fundingAssets: funding === null ? null : funding.balances.length,
    feeSymbol: 'BTC/USDT', feeReadVerified: true,
    effectiveOperations: ['account-reads'], tradingExecuted: false, transfersExecuted: false };
}
