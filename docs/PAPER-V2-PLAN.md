# Paper-v2: offline accounting before a worker

2026-09-21. Next stage of the [market lab plan](MARKET-LAB-PLAN.md).
The first offline implementation is complete: [usage and acceptance](PAPER-V2.md).
This document records the design and remaining gates; it does not activate a
worker, request exchange keys, change the existing paper journal or authorise
live trading. Keep the old engine, positions and live lock unchanged.

## Evidence and purpose

Hyperion campaign `a43cc042-9fee-424b-87ba-b44457b16b7c` completed with 30/30
snapshots, 90/90 fresh books and 180/180 valid directional comparisons. None
was positive with assumed fees of 10 bps and adverse slippage of 5 bps per leg.
This approximately 29-minute BTC/USDT run establishes a functional collection
baseline, not a return estimate or proof of executable arbitrage. Binance
timestamps remain receipt-only. See [campaign runbook](MARKET-CAMPAIGN.md).

The next deliverable is a reproducible account ledger that can explain every
balance and valuation from its input events. Establish accounting correctness
before comparing strategies or increasing collection duration.

## Minimum first implementation

- An offline CLI/library reads immutable fixtures and writes a new, separate
  paper-v2 result directory. No network, production configuration, credentials,
  database connection, timer or automatic continuation.
- Support BTC/USDT spot only, explicit full-fill buy/sell intents on one venue
  per replay, and read-only valuation. A scenario may select a public venue;
  accounts and balances are always keyed by venue and asset.
- Version the scenario, ledger format, cost model and source inputs. Store
  fixture hashes, run ID, event IDs, timestamps and all cost assumptions with
  the result. Refuse overwriting a different result under the same run ID.
- Fixture starting balances are explicitly synthetic: 1000.00000000 USDT and
  0 BTC on the selected venue. A multi-venue test declares this separately for
  each simulated account; never treat balances as shared capital or transfer
  them implicitly. A fixture with opening BTC must declare its acquisition cost.
- Use fixed test intents, including buy, sell and rejected orders. Strategy
  selection, optimisation, scheduling and cross-venue execution are later work.

## Exact amounts and execution policy

The existing floating-point depth-v2 calculator remains diagnostic. Do not
reuse its numbers as authoritative ledger postings. First implement exact
decimal parsing and scaled-integer or rational arithmetic with documented
asset scales and instrument increments. Canonical monetary input must retain
decimal strings; JSON numbers in the first observation archive cannot recover
precision already lost during parsing. Use exact fixtures initially and add a
decimal-preserving observation format before treating market replay as exact.

Walk asks for buys and bids for sells. Validate instrument status, quantity
step, minimum/maximum size and notional, available depth and timestamps before
posting anything. Reject invalid quantities rather than rounding them into
valid orders. Reject the entire simulated fill if depth or required data is
incomplete; never extrapolate liquidity or use fallback prices.

For the first model, charge a non-negative explicit fee in USDT on each fill,
after the adverse slippage adjustment. Use 10 bps fee and 5 bps slippage only
as labelled fixture defaults, not verified exchange tariffs. Round cash debits
and fees up, cash credits down, at the declared quote precision; record any
rounding adjustment. Base amounts must satisfy exact instrument increments.
Reject unsupported fee assets, discounts, rebates and fee deductions from base
instead of silently translating them into USDT.

Buy cash debit equals executed quote plus slippage plus fee. Sell cash credit
equals executed quote minus adverse slippage minus fee. Post each fill as one
atomic ledger event: no negative asset balances, borrowing or unfunded sales.
Use FIFO acquisition lots. Capitalise buy fees/slippage in acquisition cost;
deduct sell fees/slippage from proceeds. Allocate partial-lot cost with exact
arithmetic and carry the residual to the remaining lot, so closing a lot
releases its complete original cost. Reject ambiguous opening cost basis.

## Valuation and comparison

Report cash, BTC quantity, remaining cost basis, realised P/L, unrealised P/L,
fees and rounding adjustments separately per venue. Equity includes open
positions valued by a conservative full liquidation through valid bid depth,
including the stated exit costs. Mark insufficient depth, missing books or
stale valuation as unavailable; do not silently carry forward a fresh label.

Calculate peak-to-trough drawdown from the complete equity series, including
open positions. If any required valuation is unavailable, label the period
incomplete and report valuation coverage; do not present a complete-period
drawdown by omitting missing points. Zero starting equity has no percentage
return or percentage drawdown.

Cash and buy-and-hold benchmarks must use the same explicit starting funds,
venue, interval, eligible timestamps, valuation policy and cost assumptions.
Do not compare the old last-price paper journal directly with a different
period or execution model. This stage produces accounting evidence and
labelled fixture outcomes; it does not establish sustainable profitability.

## Acceptance gate

1. Replaying identical inputs produces byte-identical canonical events and
   summary; no wall-clock-dependent IDs, ordering or calculations.
2. Duplicate event application is a no-op; an existing event ID with different
   content fails. Replaying a prefix and its remainder gives the same result
   as replaying the full sequence, including exact lot costs and rounding.
3. Balances reconcile to opening balances plus postings for every venue/asset.
   Cash, remaining cost basis and realised P/L reconcile after each fill;
   equity change equals period realised P/L plus the change in unrealised P/L
   under the declared valuation policy, with no external flows. Include opening
   unrealised P/L when fixtures start with BTC. Fees are never counted twice.
4. Fixtures cover full/partial lot sales, multiple depth levels, fees and
   rounding boundaries, insufficient cash/base/depth, lot/minimum violations,
   stale or missing books, mismatched symbols and duplicate/out-of-order events.
   Every rejection leaves all balances and lots unchanged.
5. Open-position drawdown and stale-valuation cases produce the specified
   coverage labels. Benchmarks use an identical start and comparison window.
6. Existing paper tests still pass. The offline command has no production DB,
   Auth, private exchange or trading-service imports and makes no network calls.

Passing this gate permits review of the offline ledger. A later worker requires
a concrete deployment proposal: separate paper-v2 database or isolated schema
and least-privilege role, explicit namespace and storage limits, migration and
backup plan, bounded runtime, stop procedure and tested rollback. Rollback must
stop only that worker and preserve its evidence without altering the old paper
journal, shared Auth or live lock. No worker is deployed by this plan.

Cross-venue arbitrage remains a separate stage. Two independently simulated
single-venue fills are not an atomic arbitrage transaction. Funding on both
venues, latency, one-leg failures, partial fills, residual exposure, settlement
and rebalancing require their own model and acceptance before execution claims.
