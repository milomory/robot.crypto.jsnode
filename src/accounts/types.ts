export type AccountVenue = 'bybit' | 'okx' | 'hitbtc' | 'mexc';
export type AccountSymbol = 'BTC/USDT' | 'ETH/USDT' | 'SOL/USDT';
export interface AccountCredentials { apiKey: string; apiSecret: string; passphrase?: string }
export interface AccountOptions { credentials: AccountCredentials; fetch?: typeof fetch; clock?: () => number }

// Only fixed reason literals belong here, never upstream text or credential values.
export class AccountError extends Error {
  readonly reason: string;
  constructor(readonly code: string) { super(code); this.name = 'AccountError'; this.reason = code; }
}
export function validateCredentials(value: AccountCredentials): void {
  if (!value || !safe(value.apiKey, 1024) || !safe(value.apiSecret, 4096) ||
      (value.passphrase !== undefined && !safe(value.passphrase, 1024))) {
    throw new AccountError('account-invalid-config');
  }
}
function safe(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}
