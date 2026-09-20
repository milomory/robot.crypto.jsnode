# Bounded public-market observations

Delivered 2026-09-20 as the next slice of [the lab plan](MARKET-LAB-PLAN.md).
This is a separate observation tool, not a service or a trading worker.

## Commands

```sh
# Parent directory must exist; the run directory must not exist.
npm run lab:observe -- collect /path/to/new-run BTC/USDT 0.0001 3 10000 10 5
npm run lab:observe -- report /path/to/new-run
```

Arguments after the directory: symbol, base quantity, sample count, pause in
milliseconds between completed samples, fee bps per leg, adverse slippage bps
per leg. Defaults: BTC/USDT, 0.0001 BTC, 3 samples, 10000 ms, 10 bps, 5 bps.
Use a separate run per asset or changed assumptions. Only the lab's three
configured symbols/venues are supported. Costs are assumptions, not tariffs.

Bounds: 1–60 samples, 10–60 second pauses; 50 levels/side/source. The same
PublicBookClient is reused within a run, preserving its per-venue throttle
cooldown. There is no automatic restart, cron, infinite loop or retry. Report
reconstruction performs no network requests. A subsequent run is an explicit
new command; do not use repeated runs to bypass upstream throttling.

## Evidence integrity

- `run.json`: UUID, model `depth-v2`, host label, start time, asset, quantity,
  planned count/interval and all cost assumptions.
- `000.json`, etc.: sequence/run ID, start/end timestamps, normalized public
  depth snapshots and timestamps, or an allowlisted failure reason per venue.
- Existing directories and samples are never overwritten. Each file is opened
  exclusively, written and fsynced, with mode 0600; new run directory is 0700.
- The reader validates schemas, run IDs, source/symbol attribution, timestamps,
  sequence uniqueness/order and file names; refuses symlinked evidence files
  and files over 100 KB. Corrupt or truncated files fail the report rather than
  silently reducing its denominator. No arbitrary file/error contents printed.
- Missing sequence files are shown explicitly. Successfully received books are
  counted separately from books still fresh at comparison time. Per-source
  timestamps are distinguished from Binance's receipt-only evidence.
- All six directed pairs have valid/rejected/positive observation counts and
  best/worst net bps. Unavailable sources are rejected comparisons, not zero
  spreads. Comparisons are recomputed from snapshots using saved assumptions.
- These are repeated snapshots, **not trades**. No sum of hypothetical profits,
  win rate, earned P/L or continuous uptime claim is derived from them.

Each run is bounded, but automatic retention across runs is not implemented.
Do not activate continuous collection until disk quotas/retention and durable
rate-limit state are designed. Never place this output in the paper trading DB.

## Hyperion acceptance

At approximately 05:16 UTC on 2026-09-20, executed three BTC/USDT observations
on Hyperion in a temporary standalone container, removed automatically on exit.
No production application/DB mounts, credentials or env files were supplied.
The image already existed locally: `node:22-slim`, ID `404c49b93e47`.
Non-root UID/GID 1002:27, read-only rootfs, dropped capabilities, no-new-privileges,
CPU/PID/memory limits. The host warned that swap-limit support is absent; this
is not represented as complete memory+swap isolation.

Artifacts are outside the robot runtime directory:

```text
/home/mil/crypto-market-lab-acceptance-20260920-0516/observe.mjs
/home/mil/crypto-market-lab-acceptance-20260920-0516/evidence/btc-3/
/home/mil/crypto-market-lab-acceptance-20260920-0516/report.json
```

Bundle SHA-256:
`5f7fa395ae98955c6e76cf6d862e1b2167243dd294a5e48b901b35eb5177fcb9`.
Produced with the existing esbuild dependency:

```sh
node_modules/.bin/esbuild src/scripts/market-observe.ts --bundle --platform=node --target=node22 --format=esm --outfile=/tmp/crypto-market-observe-20260920.mjs
```

Run ID `fd6a109a-85db-4e32-bfc6-0b2025af6155`. All 3 planned samples saved;
Binance, Bybit and OKX each returned 3 valid books, fresh at comparison time.
Longest start-to-start gap 12444 ms (pause plus request/persistence time).
14 of 18 directed comparisons valid; 4 rejected for a >2-second combined
snapshot window. Zero positive net observations under the configured 10 bps
fee + 5 bps slippage on each leg. Valid net spreads approximately -28.64 to
-31.29 bps. This tiny sample is acceptance evidence, not strategy evaluation.

**Correction to earlier connectivity finding:** Hyperion's Python urllib probe
at 05:08 UTC received OKX HTTP403; the later Node-container probe succeeded
3/3 times. The cause of the difference is not established. Do not label OKX
permanently unavailable on Hyperion or infer a country restriction from this.

Report also reconstructed in a second temporary container with `--network none`
and read-only evidence mounts. No production deployment, restart, scan, trade,
Auth change or trading-control edit. No continuous process remains.

## Validation and next step

Full local suite: 109 passed, 15 PostgreSQL integration tests skipped. Typecheck
and production build passed. Eight new tests cover persistence/replay, interrupted
runs, exclusive writes, corruption/oversize/symlinks, source/run mixing, stale
batch data, bounds and failure redaction. Existing depth tests remain passing.

Next: instrument metadata and order-size validity, retention/coverage policy,
then a read-only dashboard view and an explicitly bounded observation campaign.
Real keys are not needed. The current paper strategy/journal is unchanged;
depth-v2 still needs a separate virtual-account ledger before any portfolio claims.
