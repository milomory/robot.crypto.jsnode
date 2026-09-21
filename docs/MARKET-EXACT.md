# Decimal-preserving public observations and paper-v2 replay

2026-09-21. Separate format `public-decimal-observations`, schema 1. The first
adapter is Bybit BTC/USDT spot; the existing three-venue depth-v2 archive and
running paper engine are unchanged. Exchange keys are unnecessary.

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

Only a completed six-sample archive is converted. The full archive digest binds
its manifest, exact samples and terminal state. Schema 2 of paper-v2 records
`marketData` provenance and `funding:synthetic` separately. Schema 1 retains its
original synthetic fixture meaning and byte-identical results.

`scenario.json` and `result.json` are written to a new offline output directory.
The standalone paper-v2 CLI can reproduce `result.json`, including provenance,
from `scenario.json`. No capture/replay module imports production configuration,
DB, Auth, credentials or the running trader. All paper-v2 balances, FIFO costs,
fees, valuation coverage and reconciliation rules still apply.

## Hyperion execution boundary

The planned collector uses the already available Node 22 image, non-root
1002:27, a read-only root filesystem, no capabilities, no-new-privileges, bounded
CPU/memory/PIDs/logs and restart policy `no`. Its only mounts are the collector
bundle read-only and a separate exact-observation directory read/write. No
application/DB/secret mounts, published ports or Docker socket.

Command: `timeout --signal=TERM --kill-after=10s 200s node /lab/collect.mjs /data/capture`.
Stop procedure: stop only the named collector; retain its archive. No app restart,
Auth/database rollback, live unlock or old journal migration. Runtime evidence
and exact source revision will be recorded after the one bounded acceptance run.
