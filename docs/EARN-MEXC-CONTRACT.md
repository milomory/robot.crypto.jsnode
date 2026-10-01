# MEXC Earn read contract — reviewed 2026-09-28

The account dashboard must say **«Интеграция начислений MEXC ещё не подключена»**.
It must not say that MEXC has no Earn API. MEXC now publishes financial read
capabilities through its official CLI. Their integration into our protected
reader remains unverified; this is a protocol/adapter gap, not a failed key check.
No private request, CLI installation/execution, credential export, account change
or server change was made in this review.

`src/accounts/mexc-earn-contract.ts` and `src/accounts/mexc-earn.ts` expose strict
capability metadata. `observedAt` is null because no account was observed.
Principal, 7/30-day accruals and realized annualized yields are null, never zero.
The six product entries are coverage categories, not the user's positions or
proof that the user participates in any product. Their enrollment is unknown.
The factory accepts no credentials and makes no network request.

## Official interface discovered

MEXC added the CLI documentation on September 14, 2026. The current documented
installation is `@mexc-ai/cli`; terminal documentation explicitly lists financial
asset and position queries. Its scope table includes flexible, fixed,
contract-hold and common financial modules. Sources:
[CLI change log](https://www.mexc.com/api-docs/cli/change-log),
[installation](https://www.mexc.com/api-docs/cli/installation),
[terminal commands](https://www.mexc.com/api-docs/cli/terminal-usage),
[module coverage](https://www.mexc.com/api-docs/cli/ai-agent).

For reproducible protocol inspection only, public npm packages version 0.0.21
(published September 11) were downloaded and checked against registry SHA-512
integrity. Neither package was installed or executed. The native artifact was
staged without executable permission in `/tmp`; nothing from it was copied into
this repository. Relevant embedded documentation: `mexc-auth`,
`mexc-financial-openapi-common`, `mexc-financial-openapi-flexible`,
`mexc-financial-openapi-fixed`, `mexc-financial-openapi-contract-hold`.

- [Launcher package metadata](https://registry.npmjs.org/@mexc-ai%2fcli/0.0.21):
  package archive SHA-1 `8eb3eaa0c71f7d42149294d5ed464d0aee47e13f`.
- [Linux package metadata](https://registry.npmjs.org/@mexc-ai%2fcli-linux-x64/0.0.21):
  package archive SHA-1 `3c2bcf1abb18fd48fa599c16e151ffe1a901efe2`.

These hashes identify the reviewed public distribution, not a trusted deployed
client or acceptance of its private-account behavior.

## Candidate read operations

All paths below are classified as signed, identity-required, idempotent **reads**
in that version's embedded documentation. They are discoveries for a future
adapter, not additions to this project's transport allowlist.

| Data | Exact GET path | Documented parameters / limitation |
| --- | --- | --- |
| Financial assets | `/api/v3/financial/cli/common/member/assets/v2` | No parameters. `totalAsset`, `totalProfit`, `yesterdayProfit` are USDT string amounts; on-chain Earn is excluded. No proven window for `totalProfit`. |
| Positions by currency | `/api/v3/financial/cli/common/member/positions` | Optional `currency` fuzzy search; `hideSmall` defaults false. Keep small holdings visible. |
| Positions by product | `/api/v3/financial/cli/common/member/positions_by_product/v2` | Optional `financialTypes`: `FLEXIBLE`, `FIXED`, `BLC_EARN`. Mapping of `BLC_EARN` to a user-facing product has not been verified. |
| Flexible accrual records | `/api/v3/financial/cli/flexible/member/profit_record/page` | Optional `currencyId`, `financialNo`, `startTime`, `endTime`, `page`, `pageSize`; page defaults 1, pageSize defaults 20. |
| Fixed accrual records | `/api/v3/financial/cli/fixed/member/profit_record/page` | Same documented filters and defaults as flexible. |
| Futures Earn accrual records | `/api/v3/financial/cli/contract_hold/member/profit_record` | Optional `currencyId`, `startTime`, `endTime`, `page`, `pageSize`; page defaults 1, pageSize defaults 20. |
| Futures Earn positions | `/api/v3/financial/cli/contract_hold/member/positions` | No documented parameters. |

History timestamps use exactly 13 digits of UTC Unix milliseconds. Future code
must verify page termination, unique record identity, currency/unit, settlement
status and timestamp meaning before summing 7/30-day accrual. A bounded partial
read must remain partial, with unknown totals. Response schemas and maximum
history ranges/page sizes were not established by the reviewed documentation.

The financial modules use OpenAPI identity from the request credentials; an
account/member id is not a query parameter. CLI resource scopes are
`financial-openapi.common`, `.flexible`, `.fixed`, `.contract-hold`, action `read`.
These are **not proof of the exact key-permission label in the MEXC cabinet**.
The [credential guide](https://www.mexc.com/api-docs/cli/configure-api-key)
recommends read access for data queries, but does not publish that finer mapping.

No numeric rate/weight limit for these financial gateway operations was found.
Do not borrow the Spot API weight or Futures account limit for them. Current CLI
error documentation describes 429 throttling and 418 bans; a future direct
adapter must use the existing shared cooldown/deadline policy with no automatic
retry inside a capture.

## Why the adapter is not enabled

The native artifact contains `https://gateway-cli.mexc.com` and
`X-MEXC-CLI-TIMESTAMP`, `X-MEXC-CLI-SIGNATURE`, `X-MEXC-CLI-VERSION` headers. This is
static artifact evidence only: effective runtime routing was not observed.
Its authentication documentation calls signing internal to the CLI. A direct
financial-reader signature contract and independent signing vector were not
published in the reviewed pages. Existing `api.mexc.com` Spot HMAC signing must
not be assumed compatible.

The reviewed native package passes generic response data; it does not establish
the detailed position/accrual response schema. Only the three common asset
amount fields above were explicitly documented. Inventing `profitAmount`,
`principal`, page counts or timestamp fields would create false accounting.

There is also a **state-changing GET**:
`/api/v3/financial/cli/flexible/auto_pledge/setting`.
Therefore a financial URL-prefix + GET policy is unsafe. Future integration must
allow exact verified read operations only; omit auto-pledge settings, enrollment,
subscription/redemption, calculators and transfer routes.

Next adapter work requires an official direct signing/schema contract or an
approved isolated official-client integration compatible with the protected
secret workflow; then fixture validation, exact-path tests, bounded read-only
account acceptance and coverage reconciliation. No new key or permission has
been requested by this change. Existing keys were not tested against the new
gateway, so compatibility is unknown.

## Product coverage and double counting

- **Hold and Earn:** principal remains in Spot. Holding an eligible token alone
  does not prove the account's enrollment; some products require manual entry.
  It uses hourly average balances and distributes daily to Spot. The existing
  Spot balance includes that wallet's funds; never add an Earn copy to it.
  [Official FAQ](https://www.mexc.com/support/article/faq-on-mexc-hold-and-earn-300971637154263040).
- **Futures Earn:** funds remain in the Futures wallet. Interest-bearing principal
  depends on averaged snapshots and product rules, so current account equity is
  not a substitute. The September 23 FAQ describes daily calculation and payout
  the following day. Never add a second copy of principal to Futures assets.
  [Official FAQ](https://www.mexc.com/support/article/faq-on-futures-earn-300973526939872256).
- **Flexible Savings:** current product/accrual reads remain unconnected. The
  February 4, 2026 upgrade introduced hourly accrual; old daily-only rules should
  not be used to infer missing income.
  [Official upgrade](https://www.mexc.com/announcements/article/flexible-savings-upgrade-17827791533333).
- **Fixed Savings:** position, maturity and distributed income need actual
  product records; the CLI advertises fixed-product reads above.
- **On-chain Earn:** excluded from common `member/assets/v2`; the current API
  coverage has not been established. Unknown is not zero.
- **Earn Plus:** a separate current product; actual account participation and its
  mapping to the financial API remain unverified.
  [Official comparison](https://www.mexc.com/en-GB/learn/article/mexc-earn-plus-vs-flexible-savings-which-usdt-earn-product-is-right-for-you-/1).

No product in this projection contributes to the portfolio total. Do not derive
interest from wallet balance changes, deposits/withdrawals, advertised APR, or a
current principal multiplied by a rate. Do not annualize a 7/30-day distribution
without a verified exposure denominator for that same interval.

## Local validation

`tests/accounts-mexc-earn.test.ts` rejects fabricated zero/value metrics, account
observation timestamps, active enrollment, wallet-overlap changes, incomplete
capability coverage and private/arbitrary fields. Runtime/private acceptance is
not applicable to the metadata-only factory and has not been claimed.
