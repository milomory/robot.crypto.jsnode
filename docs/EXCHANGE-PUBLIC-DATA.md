# Five-venue public comparison

2026-09-22. The user is adding exchange keys to the existing key vault while
work that does not depend on credentials continues. The first completed slice
adds public MEXC and HitBTC spot books to an opt-in, one-shot depth-v2 comparison.

## Run

```sh
npm run lab:venues -- BTC/USDT 0.0001 10 5
```

Arguments: BTC/USDT, ETH/USDT or SOL/USDT; base quantity; assumed fee basis points
per leg; extra adverse slippage basis points per leg. Defaults are shown above.
Equal assumed fees are not actual account tariffs. Binance remains public-data
only under the user's account-selection policy.

The new command reads Binance, Bybit, OKX, MEXC and HitBTC. It compares both
buy/sell directions for every available pair, up to 20 comparisons. Depth walking,
fees, freshness, synchronisation and insufficient-liquidity rejection reuse
depth-v2. Failures of individual sources and rejected comparisons are separate.
The result remains indicative and uses Number arithmetic; it is not an exact
monetary ledger, an order proposal or proof of profitable execution.

Existing `lab:markets`, observation/campaign archive schemas, exact Bybit
captures, application routes and the deployed robot retain their prior scope.
This command does not install a collector, write a journal, read accounts, import
secrets or enable trading. No new service or scheduled task is installed.

## Source contracts

- MEXC: fixed `GET https://api.mexc.com/api/v3/depth`, three allowlisted symbols,
  `limit=50`. `lastUpdateId` is an update identifier, not a source timestamp;
  freshness is explicitly request/receipt-only.
- HitBTC: fixed per-symbol metadata GET, requiring exact base currency, USDT
  quote currency, `type=spot` and `status=working`, followed by a fixed public
  orderbook GET with `depth=50`. No USD-to-USDT alias. A metadata failure prevents
  the orderbook request. Depth timestamps start after the metadata request.
- Both new adapters reject malformed, empty, crossed, duplicate, unsorted,
  nonpositive and stale books. No demo prices or fallback.
- The new five-venue transport bounds each complete request/body to 5 seconds
  and 256 KiB. Fixed public GETs only, no headers/credentials, redirects or retries.
  HTTP 418/429 share a per-venue cooldown across metadata/depth and symbols;
  Retry-After dates and durations are honoured with a 60-second minimum.
  Overlapping reads on a venue are refused, and late responses cannot update
  cooldown after a timeout. Cooldown is process-local, not suitable for independent
  scheduled processes; persistent/shared throttling is required before a collector.

Protocol sources checked on 2026-09-22:
[MEXC depth](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/order-book),
[HitBTC symbols](https://api.hitbtc.com/#get-symbol),
[HitBTC orderbook](https://api.hitbtc.com/#get-order-book-by-symbol).

## Verification

- 154 additional offline tests: parsers, identity, timestamps, depth, fixed
  endpoints, error redaction, body limits, timeout cancellation, late throttles,
  per-venue exclusion/cooldown, 20-direction comparison and import isolation.
- Full suite: 650 passed; 15 existing PostgreSQL tests skipped because no
  disposable test database was configured. Typecheck and production build passed.
- One actual BTC/USDT observation from Athena at `2026-09-22T06:41:18.063Z`:
  all five sources returned valid books. Depth request durations were Binance
  1025 ms, Bybit 244 ms, OKX 341 ms, MEXC 298 ms and HitBTC 28 ms. HitBTC metadata
  is an additional request, excluded from its depth timing.
- 14 directional comparisons passed; 6 were rejected for synchronisation.
  None of the 14 was positive after the illustrative 10 bps fee + 5 bps slippage
  per leg, quantity 0.0001 BTC. Do not infer opportunity frequency from one sample.
- Temporary public evidence: `/tmp/crypto-public-venues-20260922.json` on Athena.
  This verifies neither Hyperion connectivity nor ETH/SOL live availability.
- Independent code review found no blocking issue. Suggested returned-book
  identity, clock and allowlisted error-code checks were included and tested.
- No account credential, Hyperion service, production DB, Auth, order, transfer
  or live-lock change. Existing untracked Auth request retained.

## Parallel work while keys arrive

1. **Done locally:** MEXC/HitBTC public adapters and five-venue one-shot comparison.
2. **Next:** public market rules (quantity/price increments, minimums, trading
   status), then decimal-preserving multi-venue capture and a separately versioned
   bounded observation run. Do not widen old archives or claim exact accounting
   from the current numeric diagnostic output.
3. **Then:** simulate two-leg execution, partial fills, one-leg rejection,
   timeouts, unknown outcomes, duplicate requests and restart reconciliation.
   Use explicit synthetic inventory and preserve the deployed live lock.
4. **As each vault reference arrives:** verify that venue through the isolated
   account reader and appropriate protected delivery path. Record actual fees,
   available/locked balances and only the key rights the API really reports.
   Permanent key binding and regular account reads remain a separate deployment
   step; the one-shot MEXC account read is already verified.
5. **Before actual execution:** settle working capital, per-trade and daily loss
   limits, eligible assets and failure policy. Transfers also need exact owned
   recipients, networks and memo/tag handling. Key permissions alone do not
   define these operational parameters.
