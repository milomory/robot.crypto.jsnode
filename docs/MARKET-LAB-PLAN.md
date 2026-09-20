# Market data and paper lab plan

Updated 2026-09-20. User requested a plan and implementation, with notification
when keys are needed. Binance account integration is excluded by user choice;
Binance remains a public-data source. No keys are needed for stages 1–3.

## Delivery sequence

1. **Done: isolated depth-v2 execution calculations.** Buy through asks, sell
   through bids, walk available depth, add explicit assumed fees and adverse
   slippage. Reject incomplete liquidity, invalid books and stale data. Keep the
   existing strategy and historical paper journal unchanged.
2. **Done: public spot snapshot adapters and one-shot comparison.** Binance,
   Bybit and OKX; BTC/USDT, ETH/USDT and SOL/USDT. Fixed public endpoints only,
   5-second timeout, no credentials, redirects, retries or synthetic fallback.
   Separate unavailable-source and rejected-comparison results.
3. **Next: durable observation and report.** Store timestamped snapshots and
   assumptions outside the old trading journal, with run/model IDs, bounded
   retention, gap/coverage reporting and instrument metadata (lot size, minimum
   notional, trading status). Assess source synchronisation and REST limitations
   before a continuous collector or WebSocket implementation. Add a viewer report
   of indicative spreads after costs, not an execution control.
4. **Then: separate paper-v2 account/ledger and strategy comparison.** Explicit
   starting cash, position and fee accounting, daily equity, drawdown including
   open positions, benchmark and reconciliation. Use the depth-v2 calculator;
   do not silently switch old positions to new execution assumptions. Compare
   identical periods before assessing strategy improvements. Deployment must
   specify the separate data namespace and rollback before activating a worker.
5. **Only if needed: private account reads.** Ask the user for selected venues
   and dedicated read-only keys through the existing key vault/secret workflow.
   Verify the available vault-to-consumer delivery contract before using it;
   no new secret store and no secrets in chat, Git or reports. Actual tariffs
   and balances can then replace assumptions. Binance private access stays off.
6. **Separate future decision: execution.** Funding on both venues, market
   precision, execution failures/partial fills, reconciliation and rebalancing
   costs must be addressed before any live arbitrage. No live authority is
   granted by this plan; existing live lock and trading restrictions remain.

## Run the completed lab

```sh
npm run lab:markets -- BTC/USDT 0.0001 10 5
```

Arguments: supported symbol, base quantity, assumed fee basis points per leg,
additional adverse slippage basis points per leg. One basis point is 0.01%.
Defaults are BTC/USDT, 0.0001 BTC, 10 bps fee and 5 bps slippage. These costs are
illustrative, **not verified account tariffs**. The library accepts per-venue
assumptions; this initial CLI uses equal assumptions for all venues.

The command issues three concurrent GETs and outputs one JSON report. It imports
neither dotenv nor production configuration, database, Auth or trading modules.
It does not write files, create orders, start a scan or run a background loop.
Exit 1 means invalid arguments; exit 2 means no valid pairwise comparison.
Rate-limit cooldown is per client process; do not schedule repeated CLI calls to
bypass it. A future worker needs persistent/shared rate-limit handling.

## Interpretation and limitations

- Model ID `depth-v2` labels standalone calculations; this is not yet a running
  paper-v2 portfolio or a replacement for the deployed paper engine.
- Quantity must fit both snapshots. No fabricated partial fills.
- Freshness limit: 5 seconds from request start and source timestamp when
  present. Future source time beyond 1 second is rejected. Pair comparison
  rejects a combined source/request-to-receipt window above 2 seconds.
- Binance REST depth has no source timestamp. Its time quality is explicitly
  receipt-only (`sourceTimeVerified=false` for comparisons involving Binance).
  This does not prove matching-engine freshness. Bybit/OKX timestamps improve
  evidence but do not prove that two legs could execute simultaneously.
- Displayed depth can change before execution. All comparisons are indicative,
  including positive results. No account eligibility or exchange recommendation
  is implied by successful access to a public endpoint.
- Fees are modeled in quote currency. Actual fee assets, rebates, lot sizes,
  minimum order amounts, transfer/rebalancing costs and funding inventory are
  not modeled yet. Number arithmetic is adequate for this diagnostic estimate,
  not an authoritative monetary ledger or signed order quantity.
- HTTP/application errors and malformed payloads never echo response bodies.
  Public-data failures do not fall back to demo prices.

## Verification on Athena, 2026-09-20

- 31 new offline tests: depth walking, both costs, negative net spread despite
  positive raw spread, liquidity, timestamps, invalid prices/quantities,
  cross-asset rejection, venue schemas, redaction and cooldown.
- Full suite: 101 passed, 15 PostgreSQL integration tests skipped (no disposable
  test DB configured). No database code changed in this stage.
- Typecheck and production build passed.
- Public BTC/USDT probe at 05:01:01 UTC: all three sources returned valid books.
  Request durations: Binance 1028 ms, Bybit 238 ms, OKX 326 ms. All six directional
  comparisons were valid and negative after the stated illustrative costs
  (approximately -29.26 to -30.67 bps). This single observation establishes
  connectivity on Athena only, not profitability or Hyperion availability.
- No production deployment, restart, scan, order, private API request, Auth or
  shared trading-control modification. Existing untracked Auth request preserved.

## Historical baseline (read-only, before depth-v2)

Journal read on 2026-09-20: first fill 2026-06-24; 342 buys and 341 sells,
159 winning/182 losing sells, net realised +0.930821572034 USDT. All fills marked
`binance`; 333 fallback decisions blocked. Realised-only peak-to-trough drawdown
4.037845807032 USDT; this excludes unrealised position drawdown. All buys had
10 USDT notional. Per-symbol realised net: BTC +0.115106, ETH +0.629730,
SOL +0.185985 USDT. Existing engine fills at lastPrice, with fees but without
bid/ask execution or slippage. Preserve this baseline rather than rewriting it.

## Protocol references checked for this implementation

- [Binance public market-data host](https://developers.binance.com/en/docs/products/spot/rest-api)
- [Binance spot depth](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints)
- [Bybit spot order book](https://bybit-exchange.github.io/docs/v5/market/orderbook)
- [OKX market books](https://app.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book)
