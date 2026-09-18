# Binance spot account connector (read-only)

Disabled by default. No background account polling and no order, cancellation,
transfer or withdrawal methods. Public paper-market data and paper accounting
remain separate from real account reads; real balances are not written to the
paper journal or used as a trading budget.

## Credentials and activation

Use a dedicated Binance HMAC API key with Reading enabled and trading, margin,
futures, options, withdrawals and transfers disabled. Prefer an IP allowlist.
On the server, provision `BINANCE_API_KEY` and `BINANCE_API_SECRET` through the
approved secret plane or the existing protected runtime env file (mode 0600).
Never enter them in chat, Git, browser storage, URLs or command arguments.
Set `BINANCE_READONLY_ENABLED=true` only after provisioning that key. Restart
only the crypto API container to load its environment. Do not reuse T-Invest
credentials or enable real execution.

Private routes require dashboard authentication even in development. Access
through the approved VPN/TLS surface or an SSH tunnel; do not use the direct
public HTTP dashboard for real account information. The existing private
inventory on Mac should record key purpose, allowed source IPs, storage location
and verification status without putting secret values in project documentation.

## Operator API

All routes use the dashboard's existing Basic Auth, return `Cache-Control:
no-store`, and are GET-only:

- `/api/exchanges/binance/status`: enabled/configured flags, last successful
  authenticated read time, rate-limit cooldown. `configured` does not imply
  successful authentication.
- `/api/exchanges/binance/account`: spot account type and non-zero balances.
- `/api/exchanges/binance/open-orders?symbol=BTC%2FUSDT`: open orders for a
  configured symbol.
- `/api/exchanges/binance/trades?symbol=BTC%2FUSDT&limit=100&fromId=0`: one bounded
  trade-history page. Limit is 1–1000. Omit `fromId` for the latest page; use
  `fromId=0` and then `nextFromId` to traverse forward. A full page can provide
  a cursor even when the next page is empty. This is not a complete-history sync.

Amounts remain decimal strings. Unsafe numeric IDs cause an explicit response
error rather than silent rounding. Symbols must belong to configured `SYMBOLS`.
Errors never include Binance response bodies, API keys, signatures or signed
URLs. Requests have a 5-second timeout, no redirects, and no automatic retries.
429/418 responses activate a shared connector cooldown using Retry-After.
Before each operation the connector gets server time and checks API-key
permissions; inaccessible or unsafe permissions fail closed. Account-level
`canTrade` is not used as a proxy for API-key permissions.

## Validation and limits

Offline tests cover signing, permissions, exact amounts, pagination, disabled
state, authentication, redaction, malformed responses and throttling. A live
connection is **not verified** until a provisioned key successfully completes an
account read. There is no UI for entering credentials or managing keys.

Protocol references:
- [Spot account reads](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints)
- [Signed request security](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security)
- [API-key permissions](https://developers.binance.com/docs/wallet/account/api-key-permission)
