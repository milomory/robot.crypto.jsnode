# MEXC ↔ OKX: exact paired public probe and offline paper model

2026-09-26. This page describes the initial separate, bounded lab. That probe
left the account observer, application, existing paper journal, credentials and
live lock unchanged. The subsequent [thirty-minute study](PAIR-STUDY-20260926.md)
adds observed fee settings through a separately verified read-only observer release.
The first bounded Hyperion run is complete: [results and acceptance](PAIR-PAPER-RESULT-20260926.md).

## Fixed protocol

Before requesting books, the collector archives a fixed `mexc-okx-paired-probe-v1`
plan and a narrowly projected fee observation from the existing account observer.
It performs two public metadata GETs, then 60 concurrent pairs of BTC/USDT book
GETs at five-second intervals. The sampling clock starts after metadata reads.
There are at most 122 public requests, no request retries, catch-up requests,
automatic restart, keys, private exchange calls, orders or transfers.
A venue returning HTTP 429/418 or a documented API rate-limit code (including
OKX 50011/50040 inside HTTP 200) is halted for the remainder of the run.
Each request including its body is limited to five seconds and 128 KiB; the
capture has a 330-second deadline and server execution a 350-second watchdog.

Both directions compare 0.0001 BTC. All prices, quantities and rules remain
ordinary decimal strings, up to 18 fractional digits; arithmetic uses BigInt.
Cash postings use eight decimal places: buy cash and fees round up, sell cash
rounds down. Fees support fractional basis points. Five basis points of adverse
slippage are added per leg. Fee evidence is frozen before collection, at most ten
minutes old. It includes only the taker rate, convention, precision and read times.
MEXC JSON-number fee provenance is disclosed; it is not a claim of preserved raw
fee precision. OKX's negative fee becomes a positive cost; rebates are not credited.
USDT fee currency remains a model assumption, and tariff promotions may differ.

Source data: MEXC `/api/v3/depth?symbol=BTCUSDT&limit=50` and
`/api/v3/exchangeInfo?symbol=BTCUSDT`; OKX
`/api/v5/market/books?instId=BTC-USDT&sz=50` and
`/api/v5/public/instruments?instType=SPOT&instId=BTC-USDT`.
HTTP hosts and paths are fixed, GET only, no credentials, redirects refused.

## Rules and limits that must not be guessed

MEXC documents `baseSizePrecision` as minimum quantity, and
`quoteAmountPrecisionMarket` / `maxQuoteAmountMarket` as market notional limits.
Asset precision is retained as evidence; it is not silently equated to an order
quantity step. This adapter records `quantity-step-unconfirmed` and blocks paper
order admission while still producing price-only comparisons.
[MEXC exchange information](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/exchange-information).

OKX `lotSz` and `minSz` are base quantity rules; spot `maxMktSz` is USDT, not BTC.
`maxMktAmt` is USD and is not relabelled USDT. A nonempty USD cap blocks admission
until its separate valuation is supported. Upcoming rule changes also block it.
The adapter verifies these documented size constraints, not every possible
account, price-band or exchange admission rule.
[OKX instruments](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments).

MEXC depth supplies an update sequence but no documented source timestamp.
Only receipt timing is known. OKX supplies a generation timestamp. Both receipt
windows must be fresh within five seconds, and receipts within one second of each
other. This proves neither synchronized source books nor an executable arbitrage
window. Books must be strictly sorted, noncrossed and deep enough.
[MEXC order book](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/order-book),
[OKX order book](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book).

## Independent paper accounts and failures

The offline engine has separate synthetic MEXC and OKX accounts, each with
1000 USDT and 0.01 BTC for the observed probe. There is no pooling, borrowing or
implicit transfer. Since opening BTC acquisition cost is unspecified, this model
reports cash deltas and residual BTC, **not realised P/L, equity return or drawdown**.

A prepare event validates both legs and atomically reserves USDT on the buy venue
and BTC on the sell venue. Only strictly positive net comparisons with known rules,
sufficient depth and inventory can prepare. A new pair is blocked while any earlier
pair is unfinished or has residual exposure. Cumulative partial fills debit only
the increment, so splitting reports does not repeatedly charge the original fill.
An execution fragment may be smaller than the original order minimum.

An unknown outcome retains its reservation. No ordinary retry is allowed; an
explicit reconciliation records the already occurred result on the archived depth
curve. Ordinary new fills require fresh original book evidence at event time;
late reconciliation is an accounting observation, not a new fill on old liquidity.
A rejection releases the unfilled reserve but preserves actual paper fills and
residual exposure. There is no automatic hedge, transfer or loss-hiding reset.
Recovery is deterministic replay of the bounded journal: exact duplicate IDs are
no-ops, changed payloads and backward event time fail, failed events leave state
unchanged. This is a simulation contract, not an adapter for real fill reports.

The fixed observed policy chooses at most one positive, rule-eligible direction
per sample (largest net, deterministic venue tie-break), then simulates both full
fills at that sample. This is an optimistic same-snapshot assumption. Synthetic
partial/rejection/unknown tests separately verify failure mechanics; they are not
market-profit evidence. Zero eligible opportunities means zero paper transactions.

## Archive and commands

```sh
# FEES_JSON is a safe projection, never an env file or a secret record.
npm run lab:pair-paper -- collect FEES_JSON NEW_ARCHIVE
# Offline: no exchange calls or production imports.
npm run lab:pair-paper -- report ARCHIVE NEW_REPORT_DIRECTORY
```

Archive directories are new/private (0700), files exclusive/fsynced (0600).
The fixed file set is manifest, instruments, 60 numbered samples and terminal
state (63 files, each at most 128 KiB). No old run is replaced or resumed.
Every scheduled outcome is retained, including unavailable legs and missed slots.
Report output is limited to 2 MiB. Missing files, symlinks, unknown files, altered
plan/costs/rules or impossible chronology are refused. Valid unavailable samples
remain in the report and mark whole-period coverage incomplete. They are never
silently dropped to produce a complete-period success claim.

The report includes an archive digest, fee/rule evidence, both directional spreads
and net costs, coverage, positive/eligible/paper counts, all decisions and the
paper journal. Replay verifies the journal result independently. Hashes bind the
collected inputs; they do not authenticate the exchange itself.

## Server boundary and stop procedure

A one-shot Hyperion container uses the existing pinned Node22 image, non-root
1002:27, read-only rootfs, caps dropped, no-new-privileges, restart=no, no ports,
128 MiB memory, 0.5 CPU, 64 PIDs, and disabled Docker logs. The host lacks swap
limit support. Only its bundle and sanitized fee file are mounted read-only,
and its new public archive directory writable. No app/env/database/socket mounts.
Stop only that named lab container and keep its archive. No app/Auth/DB rollback
or live-lock changes are part of this procedure.

## Remaining before any real-execution proposal

Confirm MEXC quantity-step semantics and any USD-denominated limits; model actual
fee asset/discounts, execution latency and changing liquidity. Observe longer
predeclared periods, measure signal persistence and inventory exhaustion, then
review controlled execution and reconciliation against explicit monetary limits.
A five-minute public probe does not establish profitable or executable arbitrage.
