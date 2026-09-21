# Decimal-preserving public observations and paper-v2 replay

2026-09-21. Separate format `public-decimal-observations`, schema 1. The first
adapter is Bybit BTC/USDT spot; the existing three-venue depth-v2 archive and
running paper engine are unchanged. Exchange keys are unnecessary. The additional fixed 30-minute profile and causal
comparison are documented in [PAPER-STUDY.md](PAPER-STUDY.md); the default
six-sample probe below remains unchanged.

## Fixed first probe

The collector code fixes these values before any public request; the manifest
records them before the first order book is requested:

- 6 books at scheduled 30-second intervals; at most 180 seconds internally.
- One metadata request and at most six book requests, all fixed public GETs.
- Virtual starting balance 1000 USDT/0 BTC, buy 0.001 BTC at sample 0, sell
  0.0004 BTC at sample 3. Other samples mark the remaining position.
- Assumed fee 10 bps and adverse slippage 5 bps per leg, paid in USDT. The
  buy-and-hold comparison buys the same 0.001 BTC at the same first sample.
- No selecting a favourable period, tuning quantities/costs after collection,
  replacing missing books, retries, catch-up bursts or automatic restarts.

These are fixed diagnostic intents against observed prices, with synthetic
capital. They are neither actual trades nor a signal-based strategy backtest.
A short probe checks the complete data/accounting path, not sustained returns.

## Precision and public protocol

Prices, quantities and relevant instrument values retain their original decimal
strings, up to 20 integer/18 fractional digits. Numeric monetary JSON, exponents,
non-positive levels, malformed markets and invalid books are rejected. Books
are checked with scaled integers, not floating-point prices.

Bybit's documented book fields are strings; both system time `ts` and optional
matching-engine time `cts` are retained. Paper replay uses `cts` when present,
otherwise `ts`, with the declared freshness/skew checks.
[Official orderbook contract](https://bybit-exchange.github.io/docs/v5/market/orderbook).

Instrument conversion uses `basePrecision`, `maxMarketOrderQty` and
`minOrderAmt`. Deprecated `minOrderQty`, `maxOrderQty` and `maxOrderAmt` are not
used as active constraints. Minimum positive model quantity is one base increment.
`quotePrecision` and `tickSize` are retained as evidence; the paper cash/fee model
still uses its declared eight decimals and assumed quote fees. This does not
establish actual account tariffs or exchange order acceptance.
[Official spot instrument contract](https://bybit-exchange.github.io/docs/v5/market/instrument).

Conversion to paper-v2 removes only trailing fractional zeros. Any non-zero
precision beyond eight decimals fails instead of being rounded. The raw archive
keeps the original strings. Existing JSON-number depth-v2 archives cannot be
converted into this exact format by stringifying already-rounded numbers.

## Collection, storage and offline conversion

```sh
# Each destination must be NEW; its parent must exist.
npm run lab:exact-collect -- NEW_ARCHIVE_DIRECTORY
npm run lab:exact-replay -- ARCHIVE_DIRECTORY NEW_REPLAY_DIRECTORY
# The converted scenario also works through the existing independent CLI:
npm run lab:paper-v2 -- REPLAY_DIRECTORY/scenario.json ANOTHER_NEW_DIRECTORY
```

Only `lab:exact-collect` performs public network I/O. Each request/body has a
5-second deadline and 128 KiB bound; credentials are omitted and redirects are
refused. A shared client retains rate-limit cooldown. Collection has an internal
deadline; server execution adds an independent 200-second process watchdog.

A new archive directory (0700) holds `manifest.json`, `state.json` and up to six
numbered snapshots (0600, at most 128 KiB each). Immutable files are fsynced and
published exclusively; only this run's state uses atomic replacement. No old
archive is overwritten or automatically deleted. Unknown files, missing/failed
samples, symlinks, mixed run IDs, altered plan or impossible chronology prevent
complete-series replay. A hard kill leaves evidence for inspection; it is not
silently resumed. No perpetual collector or retention schedule is enabled.

Only a completed full archive of its declared profile is converted: six samples
for the default probe or 60 for the fixed 30-minute study. The full archive digest binds
its manifest, exact samples and terminal state. Schema 2 of paper-v2 records
`marketData` provenance and `funding:synthetic` separately. Schema 1 retains its
original synthetic fixture meaning and byte-identical results.

`scenario.json` and `result.json` are written to a new offline output directory.
Their separate limit is 2 MiB each; individual raw files retain the 128 KiB cap.
The standalone paper-v2 CLI can reproduce `result.json`, including provenance,
from `scenario.json`. No capture/replay module imports production configuration,
DB, Auth, credentials or the running trader. All paper-v2 balances, FIFO costs,
fees, valuation coverage and reconciliation rules still apply.

## Hyperion execution boundary

The planned collector uses the already available Node 22 image, non-root
1002:27, a read-only root filesystem, no capabilities, no-new-privileges, bounded
CPU/memory/PIDs/logs and restart policy `no`. The host does not support swap
limits, so the memory bound is not complete swap isolation. Its only mounts are the collector
bundle read-only and a separate exact-observation directory read/write. No
application/DB/secret mounts, published ports or Docker socket.

Command: `timeout --signal=TERM --kill-after=10s 200s node /lab/collect.mjs /data/capture`.
Stop procedure: stop only the named collector; retain its archive. No app restart,
Auth/database rollback, live unlock or old journal migration. The completed acceptance and source revision are recorded below.


## Completed Hyperion acceptance

Capture `0f47b8aa-4a89-4414-b4ee-3f2bb63ddd3d` completed on 2026-09-21.
The six observed books cover 06:51:15.994–06:53:45.334 UTC
(08:51:15.994–08:53:45.334 Europe/Amsterdam). All six were available and all
monetary values remained decimal strings. Request duration was 242–290 ms
(median 261 ms); longest sample start gap 30.019 seconds. The first gap is
slightly shorter because initial metadata is fetched before the first book.

`crypto-exact-btc-20260921` exited 0 at 06:53:45.559 UTC, with no OOM or restart,
before the 06:54:15.036 UTC internal deadline. Inspect confirmed the prescribed
non-root/capability/resource/mount boundaries. Source bundle revision:
`a27d31bd68d31780c9590347d17dd162b65cf817` (local commit at capture time).
Bundle SHA256: `00abd8a31ad7e448fe8761c90cd6cbf5772a2ee287aafd4243f67586789314e3`.

Source archive: `/home/mil/crypto-exact-observations/capture`.
Bundle: `/home/mil/crypto-exact-probe-a27d31b/collect.mjs`.
All eight copied JSON files matched Hyperion SHA256 hashes. The exact bridge
and the independent built paper-v2 CLI produced byte-identical result files;
the source archive was unchanged. The fixed probe had two simulated fills,
four marks, zero rejected intents and full valuation coverage (7/7 points,
including the opening balance).

| Same starting 1000 virtual USDT / same observed period | Final liquidation equity | Equity change |
| --- | --- | --- |
| Fixed buy/partial-sell probe | 999.70018598 USDT | -0.29981402 USDT |
| Cash baseline | 1000.00000000 USDT | 0.00000000 USDT |
| Buy-and-hold 0.001 BTC | 999.68868326 USDT | -0.31131674 USDT |

Probe final cash: 950.81018663 USDT; remaining BTC: 0.00060000;
remaining FIFO cost: 49.07678940 USDT; realised simulated P/L: -0.11302397 USDT;
charged simulated fees: 0.11435042 USDT. Maximum observed equity drawdown:
0.29981402 USDT. Liquidation equity also estimates exit costs for the remaining
position; those costs have not been posted as paid fees. Reconciliation passed.

These are observed quotes with virtual funding, predetermined operations and
assumed costs, not actual trading losses or a strategy-performance estimate.
Six short REST samples cannot establish sustainable returns, executable
arbitrage, account eligibility, multi-regime performance or intraperiod extremes.

Verification: 69 new tests; final full suite 246 passed, 15 existing PostgreSQL
integration tests skipped. Typecheck and complete build passed; targeted
collector tests also passed after adding the overall cancellation deadline.
The previous schema-1 fixture result retained its exact acceptance hash.

[Machine-readable acceptance, source hashes and container inspection](evidence/market-exact-20260921/acceptance.json).
Local verified copy and both results:
`/tmp/crypto-exact-acceptance-20260921-uzs7r8g8` (temporary analysis workspace).
To reproduce later, copy the eight public JSON files from the source archive
into a local directory and run the two offline commands above. The recorded
file hashes and result SHA256 permit comparison without another public request.

The original application remained running with the same start timestamp and
release `386ee2c`; its source, journal, Auth and trading controls were untouched.
There was no scan, private exchange request or real order. No continuous worker
or new dashboard deployment was enabled.

Source and acceptance were published to `milomory/robot.crypto.jsnode` on
2026-09-21 after explicit user approval of the push to `main`. The non-forced
push included source commit `a27d31b` and acceptance commit `ea95925`; remote
`main` was verified at `ea959251927f5cec3afcd088e759ba8c2b5bdf0b` immediately
after publication. The earlier approval blocker is resolved. The evidence's
`sourcePublishedAtCapture: false` remains the correct historical capture state.

Private inventory follow-up on Mac: add Hyperion's exact collector name,
bundle/data paths, read-only/public-only scope and verified stopped state.
No credentials or access methods changed. Current Mac owner routing remains
unverified via the available Athena-only coordination route; no handoff sent.
