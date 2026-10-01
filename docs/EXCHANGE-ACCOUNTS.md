# Bybit, OKX, HitBTC and MEXC account integration

2026-09-25 update: MEXC and OKX account/fee reads are now verified from Hyperion,
and a separate recurring observer is active for this pair. See
[deployed scope, evidence and rollback](PAIR-OBSERVER.md). Bybit/HitBTC private
keys remain unverified. Historical preparation below describes the earlier
standalone check; it is superseded by that runbook for MEXC/OKX deployment status.

2026-09-21. The user selected these four venues, Memory Core's existing key
vault, and keys with full exchange permissions, with an eventual goal of
arbitrage and transfers between exchanges. This supersedes the earlier request
for keys restricted to reading. Credential permissions and the implemented
operation set are tracked separately: the first consumer supports account GETs.

## Implemented boundary

`src/accounts` contains four independent readers, a fixed-endpoint transport,
a strict secret-bundle parser and a metadata-only account check. The current
application, paper journals, SSO/operator API and live lock are unchanged.
MEXC and OKX account/fee reading is verified from Hyperion; a separate scheduled
[paired observer](PAIR-OBSERVER.md) is active. Bybit/HitBTC private keys remain
unverified. The application itself has no exchange-key binding.

| Venue | Implemented methods | Important interpretation |
| --- | --- | --- |
| Bybit | API key permissions, UNIFIED balances, spot maker/taker fees | Account-wide USD availability is margin data, not a transferable spot balance. Funding wallet is not implemented. |
| OKX | API key permissions, trading and funding balances, spot maker/taker fees | Preserve cash/equity/available fields separately. Fee signs mean negative fee and positive rebate; require one matching current fee group. |
| HitBTC | Spot and wallet balances, spot maker/taker fees | Preserve reservation fields. Verify exact base/USDT public metadata before fees; never alias USD to USDT. Key-right introspection is not implemented. |
| MEXC | Spot balances and spot maker/taker fees | Preserve free/locked/available separately; missing available remains null. Account capabilities are not API-key permissions. Funding and key-right introspection are not implemented. |

All fee queries are bounded to BTC/USDT, ETH/USDT and SOL/USDT. The account-reader
stage adds HitBTC public symbol metadata. A later, separate [five-venue diagnostic](EXCHANGE-PUBLIC-DATA.md)
adds HitBTC/MEXC public depth; multi-venue decimal archives and instrument-size
rules remain pending. Legacy public campaigns retain three sources
(Binance, Bybit, OKX), and Binance account integration stays excluded.

The readers accept keys that also have trading, transfer and withdrawal rights.
They do not expose methods for those operations. Bybit/OKX return a sanitized
view of observed rights; HitBTC/MEXC explicitly report them as unverified. Successful
account reads do not validate withdrawals, recipient ownership or trade execution.

Transport allows only known HTTPS origins, exact GET paths and supported query
values. It refuses redirects, cookies, arbitrary destinations, additional query
parameters, write routes and parallel requests signed at stale timestamps.
A request plus its response body has a five-second deadline and 256 KiB limit.
Rate limits share a cooldown within each reader; longer Retry-After is honored.
Reader methods never retry. The separate pair observer supplies scheduling and
persisted cooldown. Body streams are cancelled at the
deadline; late responses cannot update cooldown or turn a timeout into success.

Balances remain decimal strings; unrelated private fields and upstream
error text are removed. MEXC documents fees as JSON numbers (including 0E-18):
these become strings with `ratePrecision:json-number`, without claiming the
original decimal precision survived JSON parsing. String fee responses retain
their digits and use `ratePrecision:decimal-string`. Raw balances are available to a future authorized consumer
in memory; the first check prints only booleans, permission metadata and asset
counts. It neither writes balances to the old paper journal nor returns them to
SSO viewers. Secret fields are not enumerable or visible through JSON/inspect.

## Key vault input contract

The existing key vault is the destination. Do not place actual values in chat,
Git, ordinary memory notes, command arguments or descriptions. One encrypted
record per exchange should contain its complete JSON bundle. Description labels:
`Crypto / Bybit / mainnet`, `Crypto / OKX / mainnet`, `Crypto / HitBTC / mainnet`,
`Crypto / MEXC / mainnet`.

Templates below are placeholders to fill only inside the trusted key-vault UI.
Confirm the exchange account's region before using `region:global`. Regional
Bybit/OKX domains and testnet/demo credentials are not auto-detected or retried.

```json
{"schema":1,"venue":"bybit","environment":"mainnet","region":"global","apiKey":"REPLACE_IN_VAULT","apiSecret":"REPLACE_IN_VAULT"}
```

```json
{"schema":1,"venue":"okx","environment":"mainnet","region":"global","apiKey":"REPLACE_IN_VAULT","apiSecret":"REPLACE_IN_VAULT","passphrase":"REPLACE_IN_VAULT"}
```

```json
{"schema":1,"venue":"hitbtc","environment":"mainnet","region":"global","apiKey":"REPLACE_IN_VAULT","apiSecret":"REPLACE_IN_VAULT"}
```

```json
{"schema":1,"venue":"mexc","environment":"mainnet","region":"global","apiKey":"REPLACE_IN_VAULT","apiSecret":"REPLACE_IN_VAULT"}
```

A bare API key is insufficient: each venue also needs its secret, and OKX needs
its API passphrase. The parser requires the exact venue/environment/region shape,
limits input to 16 KiB and reports fixed errors without echoing malformed input.
The `account-check` consumer accepts only protected stdin, never key arguments,
arbitrary filenames, environment-file imports or interactive terminal entry.

## Original account-check delivery proposal

The local memory-platform runbook `WEB-SECRET-INTAKE.md` and broker intake source
were inspected read-only. The current one-field UI can preserve a JSON value as
one encrypted record and returns a `secret://inbox/web-...` reference. Its default
`webintake` / `server-password-stdin` binding is an intake path, not an exchange
account consumer. The metadata catalog does not confirm a Crypto exchange profile.
No ciphertext, plaintext, private registry or unrelated credentials were read.

Prepared consumer source: `src/scripts/account-check.ts`, built entry
`dist/scripts/account-check.js`. The reviewed deployment proposal is:

1. Bind each of the four user-selected secret references to a dedicated Crypto
   account-check destination/profile. Do not repurpose server-password deployment
   profiles or alter other consumers. References/descriptions are metadata only.
2. Pin a reviewed consumer bundle on Hyperion. Deliver exactly one bundle per
   invocation through the existing broker's protected stdin path, without
   persisting it in an application env file or forwarding it through the agent.
3. Run a separate short-lived process/container with no application/DB mounts,
   no published ports, no Docker socket mount, a bounded deadline and no restart.
   Allow only the four configured exchange domains; disable secret-bearing
   logs. Keep all keys away from browser/UI/API responses.
4. The process sequentially checks permissions when supported, account balances,
   funding balances when supported, and BTC/USDT fees. Return only the checker
   metadata. It must finish without any order, cancellation, transfer or withdrawal.
5. Verify revoked-key failure and loss of delivery authorization without echoing
   keys. Back up binding metadata before changes and provide a scoped rollback
   that removes only these new bindings/processes, preserving the encrypted keys.

MEXC reference received from the user:
`secret://inbox/public-review-record-b11569db2351`. A metadata-only `GET /secrets`
confirmed `active`, destination `webintake`, profile `server-password-stdin` on
2026-09-21. Initial discovery read only reference/binding metadata. A later model-blind
check found a labelled Access Key in this record's description and a single
encrypted Secret Key value. The one-shot helper joined them only in process
memory and stdin; no values entered tool output, argv, files, source or memory
notes. The canonical bundle above remains the contract for permanent integration.

The application-bound installation above has not been run. A separate recurring
MEXC/OKX observer now uses temporary profiles on each scheduled cycle; see the
current runbook. The earlier temporary MEXC acceptance is documented below.
Adding a key to the UI alone must not be described as a connected exchange.
The currently implemented global origins are `api.bybit.com`, `www.okx.com` and
`api.hitbtc.com`, plus `api.mexc.com`; account registration region must match before secret delivery.

## MEXC-specific boundary

Signed account and fee GETs use `https://api.mexc.com`, `X-MEXC-APIKEY`, a fixed
5000 ms receive window, and lowercase HMAC-SHA256 over the exact unsigned query.
The query contains a short-lived signature; signed URLs and headers must never
be included in logs/traces/error output. The reader itself emits no such logs.
Future deployment must verify that outbound instrumentation also redacts them.
Only `/api/v3/account` and `/api/v3/tradeFee` are allowed, with exact parameter
names, no duplicates and three explicit fee symbols. HTTP 403 is reported as
access denied because MEXC may use it for WAF rejection, not just credentials.

MEXC has a GET `/api/v3/apiKeyInfo` endpoint, but it requires `accessKey` in the
query. This initial reader deliberately does not implement it; do not describe
key permissions as verified or infer them from `/account` flags. POST to that
same path changes key settings and is outside this reader. A successful fee read
also does not prove a market is enabled for API trading on this particular key.

## Remaining monetary execution work

The user requested eventual arbitrage and transfers; the required operational
parameters are pending: total working capital, maximum trade size, daily loss
limit, eligible assets, source/target accounts, networks, recipient addresses
and tag/memo where required. No monetary limits are inferred from key powers or
from old paper defaults. The question for these parameters is pending in the task.

Before execution, implement exchange order state machines with unique client
IDs, partial-fill/timeout/duplicate handling, account reconciliation, inventory
and loss limits, and a tested stop procedure. Cross-venue execution must account
for one-leg failures and independently funded balances. Transfers require exact
network/asset matching, confirmed owned recipients, fees/minimums, idempotent
submission and settlement reconciliation. A transfer is not a prerequisite for
every arbitrage trade; future inventory/rebalancing policy must define when it
is appropriate. Test these paths before changing the running live lock.

## Protocol references checked

- [Bybit authentication](https://bybit-exchange.github.io/docs/v5/guide),
  [key information](https://bybit-exchange.github.io/docs/v5/user/apikey-info),
  [UNIFIED balances](https://bybit-exchange.github.io/docs/v5/account/wallet-balance),
  [fee rates](https://bybit-exchange.github.io/docs/v5/account/fee-rate).
- [OKX official API documentation](https://app.okx.com/docs-v5/en/) and
  [official SDK origin](https://github.com/okxapi/python-okx/blob/master/okx/consts.py).
- [HitBTC V3 API](https://api.hitbtc.com/). Its REST per-symbol commission read
  requires the exchange's Place/cancel orders right even though it is a GET.

- [MEXC signing](https://www.mexc.com/api-docs/spot-v3/introduction),
  [spot balances](https://www.mexc.com/api-docs/spot-v3/spot-account-trade/account-information),
  [symbol commission](https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-symbol-commission),
  [API key information](https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-api-key-info),
  [error codes](https://www.mexc.com/api-docs/spot-v3/error-code).

## Verification

60 MEXC/integration tests added; full suite 496 passed with 15 existing PostgreSQL integration
tests skipped (no disposable database). Typecheck and complete build passed.
Coverage includes independent signing vectors, full-permission keys, literal
GET allowlists, strict parsing/decimal preservation, output/exception redaction,
secret bundle serialization, protected stdin, cooldown, response size/deadline,
late-response cancellation and the transitive production-import boundary.
All authenticated requests in these checks use fake keys and mocked responses.
These test results use no real keys. Separately, the one-shot MEXC acceptance
below verified an actual account GET. No fund movement, persistent consumer
deployment or live unlock has occurred.

Private inventory on Mac: when the keys are imported, record the four venue
accounts, intended rights, purpose, non-secret vault references, restrictions
and actual verification status. MEXC spot account reading is verified at
2026-09-21T21:30:54Z; other operations/venues remain unverified. No credentials
were created, replaced or disclosed. System-Admin/CHAT-AGENTS.md last verified
Memory-manager — Mac (private-coordination-id-omitted) on 2026-09-10;
current routing was not reverified and no message was sent.


Private operational acceptance is omitted from this review snapshot.
