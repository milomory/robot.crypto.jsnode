# Fixed observed-period paper comparison

2026-09-21. The previous six-book exact probe completed successfully and stopped;
it is not a continuous data feed. This stage adds a separately bounded public
capture and an offline causal comparison. No exchange keys are required.

## Declared protocol

Profile `fixed-study-30m-v1` is fixed in code before collection: Bybit BTC/USDT
spot, 60 scheduled observations 30 seconds apart, internal deadline 1800 seconds.
One instrument request and at most 60 book requests use the existing fixed
public adapter. The last scheduled book is at +1770 seconds. No retries,
catch-up, restart, continuation or selection of successful subsets.

The manifest records `comparisonPolicy: lagged-sma-3-6-v1`, synthetic opening
1000 USDT / 0 BTC, fixed size 0.001 BTC, fee 10 bps and adverse slippage 5 bps.
These are assumed costs, not verified account tariffs. The diagnostic replay
also keeps its predetermined buy at sample 0 and partial sale at sample 30;
the study command replaces those diagnostic intents with causal decisions.

The study policy is deliberately simple and fixed before the new capture. It
is a pipeline and comparison baseline, not a recommendation or optimized rule:

- Keep at most one fixed 0.001 BTC position; no borrowing or short sales.
- At sample i, use only completed books 0 through i-1. Six previous samples
  are required; the first possible simulated fill is at sample 6 (zero-based).
- Signal price is the best bid/ask midpoint. With F the sum of the last three
  `bid + ask` values and S the last six, compare `(2*F - S)*10000` with
  `+S*10` and `-S*10`. Integer arithmetic avoids rounded midpoints or averages.
- Above the upper boundary, buy if flat. Below the lower boundary, sell if
  holding. Equality and the deadband retain the current position.
- Execute through the current book with the exact ledger's costs and depth
  checks. Rejected fills never change position state. A later decision is
  recomputed from the latest past books and actual simulated holdings.
- There is no forced final sale. End equity values liquidation with hypothetical
  exit costs, while the ledger retains any open position.

Current/future books may affect fill and valuation at their own timestamps;
they cannot affect the signal already formed from previous books. Every
snapshot has a decision record with the last observed index, execution index,
exact signal inputs, and outcome. No parameter grid, best-run selection,
annualization or profitability gate is implemented.

## Commands and artifacts

```sh
# All destinations must be new, with existing real parent directories.
npm run lab:exact-collect -- --study-30m NEW_ARCHIVE
npm run lab:paper-study -- COMPLETE_ARCHIVE NEW_STUDY_DIRECTORY
# Independent replay of the exact generated intents:
npm run lab:paper-v2 -- NEW_STUDY_DIRECTORY/scenario.json ANOTHER_NEW_DIRECTORY
```

The study reads all 60 books or refuses the archive. Missing/unavailable books,
extra files, changed profile, impossible chronology or non-completed state
cannot be silently skipped. Decimal strings, freshness and instrument rules
retain the exact-probe checks. The metadata age is below the one-hour model
limit for this bounded profile. A future longer profile must address metadata
refresh explicitly.

`scenario.json` includes all timestamps, original books, market provenance and
`executionPolicy`. `result.json` contains the ledger, full valuation series,
reconciliation and both benchmarks. `study.json` adds decisions, protocol
eligibility, summary and the result SHA256. Files are private, fsynced and
exclusively published into a new directory. Raw files remain capped at 128 KiB;
replay artifacts are capped at 2 MiB. Output contains no wall-clock-dependent IDs.
The source archive is unchanged. The independent CLI must produce exactly the
same result bytes. A six-book legacy archive is a labelled smoke check with no
eligible study claim; synthetic fixtures are labelled separately.

Cash and buy-and-hold use the same capital, venue, timestamps and costs.
Buy-and-hold attempts 0.001 BTC once at the first snapshot. Any missing valuation
or failed benchmark entry makes the comparison incomplete. Protocol eligibility
means the declared window and assumptions match; it does not establish statistical
significance or account eligibility. Sixty snapshots cover roughly 29.5 minutes
and cannot establish sustainable returns or capture all intraperiod extremes.

## Bounded Hyperion execution and stop procedure

Use a new named collector and archive, an already available Node 22 image,
non-root 1002:27, read-only root filesystem, dropped capabilities,
no-new-privileges, memory 128 MiB, CPU 0.5, PIDs 64, restart=no and bounded logs.
Only the source bundle (read-only) and separate observation namespace (writable)
are mounted. No credentials, application/DB mounts, ports or Docker socket.
Keep at least 64 MiB free before launch; raw files are bounded by 62*128 KiB.
The host lacks swap-limit support, so memory isolation excludes swap limits.

An external watchdog is `timeout --signal=TERM --kill-after=10s 1820s`.
Stopping means `docker stop --time 10 <this-collector-only>`; retain evidence.
Do not resume or overwrite a partial archive, roll back the main application,
change Auth or unlock trading. No service, cron or automatic collector is added.

## Verification and execution evidence

Local verification passed: 307 tests passed, 15 existing PostgreSQL integration
tests skipped; typecheck and complete build passed. The 61 added tests cover
causal decisions, rejected fills, profile boundaries and output safety. A
60-snapshot/50-level synthetic archive exceeds the old 128 KiB limit and
reproduces byte-identically through the independent CLI. On the real six-book
archive, the old result SHA256 is unchanged; the new study is correctly a
smoke-only result and independently reproduces its generated scenario.

The bounded campaign was launched at 2026-09-21 07:41:07 UTC (09:41 Amsterdam)
from local source commit `4b2dedea5958e62f594945214a1154d0f8f4eff2`.
Container: `crypto-study-30m-20260921`; capture:
`46c37b0f-2fa7-41ce-8e11-6c5c2d9e1bed`.
Archive: `/home/mil/crypto-study-30m-20260921/data/capture`.
Bundle SHA256: `4a7bce29a715ff5ea6ce7ee6ba14ce2516a9523c25bd1d111621e8aa9e16dbf5`.
[Launch evidence](evidence/paper-study-20260921/launch.json) confirms the pinned
image, resources, mounts, first available sample and unchanged application.
The internal deadline is 08:11:07.816 UTC (10:11 Amsterdam); the final scheduled
sample is 30 seconds earlier. At 07:45:47 UTC, 10/60 samples were recorded and
all 10 were available. This is progress, not a completed study or return estimate.

The [read-only acceptance helper](../ops/verify-paper-study-20260921.py) is ready:

```sh
python3 ops/verify-paper-study-20260921.py NEW_LOCAL_ACCEPTANCE_DIRECTORY
```

While collecting, it returns exit 75 without creating the output directory; this
path was verified against the live collector. After clean completion it verifies
the pinned container/capture/bundle, copies exactly 62 public files, checks hashes,
rebuilds the declared source, runs the study and independent replay, and checks
both local and remote raw archives again. It writes `acceptance.json` only after
all checks. Non-comparable findings remain explicit and are not discarded.
Source and build configuration must match `4b2dede`; later documentation-only
commits are allowed. Python optimization is refused locally and remotely so
assertion checks cannot disappear. Syntax, both optimization guards and the
running-state exit were checked; the completed path is NOT RUN yet.

Source publication remains pending. Automatic approval rejected pushing the
new commit to default `main`, judging the previous user approval specific to the
earlier commits. No retry or alternative publication route was used. The
separate bounded collection was authorized and launch evidence records
`sourcePublishedAtLaunch:false` accurately.

Private inventory follow-up on Mac: add Hyperion's named bounded collector,
archive/bundle paths and lifecycle above. Credentials and access methods did not
change. `System-Admin/CHAT-AGENTS.md` does not establish a currently verified Mac
recipient for this task; no handoff was sent. Keep this route unverified.

The previous collector is `crypto-exact-btc-20260921`, exited 0 at 06:53:45 UTC.
The running application's verified start remains 2026-09-20T07:06:47.864812714Z.
A running collection is not a completed study; only a complete validated archive
may produce a period comparison. Future collection/research remains separate
from the existing paper engine and historical journal.
