# Bounded observation campaign and retention

2026-09-20. User authorised proceeding with bounded collection and history
retention. This runs independently on Hyperion, with public GETs only and no
credentials, application DB, order routes or paper-ledger writes.

## Fixed first campaign

- BTC/USDT, 0.0001 BTC; Binance, Bybit, OKX.
- Up to 30 snapshots, one scheduled start every 60 seconds.
- At most 30 minutes; no restart, retries or catch-up burst. Successful runs
  normally finish shortly after the 29th minute because the first sample is
  taken at the start. External `timeout` adds a separate wall-clock watchdog.
- Same client throughout: existing per-venue rate-limit cooldown retained.
  Public instrument metadata fetched once before sampling; a failed metadata
  request disables that source for this run rather than retrying it.
- Illustrative fees10bps and slippage5bps per leg. No change in assumptions
  compared with previous acceptance. Positive spreads are observations, not P/L.

## Storage and retention rules

Managed root on Hyperion:
`/home/mil/crypto-market-observations/store`.

`store.json` contains the fixed policy. `runs/<uuid>/` contains immutable
manifest and numbered snapshots plus an atomically updated `collection.json`.
`current.json` atomically selects the run shown in the dashboard. The API mount
is read-only; only the independent collector can write snapshots.

- Keep at most20 runs and100MB logical managed data. Each file is capped at
  100KB. Before accepting a new run, reserve6.2MB (more than the maximum for
  60 snapshots plus manifest/control files). This is an application quota, not
  an OS filesystem quota; unrelated processes are not governed by it.
- At the start of a campaign, remove only non-current, terminal runs whose
  completion time is older than7days. Current and running runs are protected
  even beyond7days. No daily deletion daemon is installed: seven days is the
  eligibility threshold, not a promise that idle storage is cleaned that day.
- Never evict recent runs to make room. If count/space is insufficient after
  eligible cleanup, refuse collection. The previous report stays selected.
- Validate every candidate before deleting anything. Unknown files, symlinks,
  foreign manifests or damaged control files stop cleanup. This never traverses
  existing paper/acceptance evidence or other user directories.
- A single-writer exclusive lock guards the entire campaign and retention.
  No automatic stale-lock break. After a hard kill, verify the collector is
  stopped before manually recovering the lock; do not launch another writer.
- Snapshot files are fsynced and published by exclusive hard link; JSON control
  files use atomic rename. The reader does not see partially written snapshots.
  Unexpected temporary files left by abrupt failure cause retention to stop,
  preserving evidence for inspection.

## Commands

```sh
# Parent directory must already exist; NEW_STORE must not exist.
npm run lab:campaign -- init NEW_STORE
npm run lab:campaign -- run STORE
npm run lab:campaign -- report STORE
```

There are no CLI options for lifting sample/duration limits or selecting private
endpoints. The run command exits after collection; report is offline. The
existing one-shot and bounded manual `lab:observe` commands still work.

Build the standalone collector without production dependencies/config imports:

```sh
node_modules/.bin/esbuild src/scripts/market-campaign.ts --bundle --platform=node --target=node22 --format=esm --outfile=/tmp/crypto-market-campaign-20260920.mjs
```

Run it in the already available `node:22-slim` image `404c49b93e47`, non-root
1002:27, read-only rootfs, dropped capabilities, no-new-privileges, limited
memory/CPU/PIDs and bounded Docker logs. Mount only its bundle read-only and its
managed data directory read/write. No secrets/env files or robot mounts.
Use `timeout --signal=TERM --kill-after=10s 1800s node /lab/campaign.mjs run /data/store`
as the container command and `--restart=no`. Metadata/book requests retain
their5second timeout. Do not expose the Docker socket to this container.

## UI and recovery

The **Наблюдения** tab follows the selected run, but still fetches only on tab
entry/manual refresh. During collection it shows the stopping deadline and
not-yet-recorded count. Terminal states show complete, stopped or failed;
an expired deadline or heartbeat older than interval+20seconds labels the run
interrupted. This is a report observation, not proof that a process was killed.
Docker/timeout provides the actual runtime bound.

Each prior run remains immutable except for collection status, until eligible
cleanup. Historical single-run directories still work without `collection.json`.
Changing the selected run does not mix costs, metadata or snapshots across runs.

Stop: `docker stop --time 10 crypto-market-campaign-20260920`. SIGTERM interrupts
waiting and preserves partial evidence. Normal/handled failure releases the
writer lock. Hard-killed processes may leave a lock or temporary file; preserve
those until a read-only inspection confirms safe recovery. Do not automatically
resume an interrupted campaign or reset rate-limit cooldown by restarting it.

Dashboard rollback uses the scoped API override backup from deployment; restore
the previous code/report mount and recreate API only. Stop the collector first
if rolling back the campaign. No shared Auth/database rollback or live unlock.

## Verification

127 tests passed;15 PostgreSQL tests skipped. Build, backend and strict UI
typechecks passed. Nine new offline tests cover all30 samples, cancellation,
deadline/clock jumps, failures and single-writer exclusion, protected retention,
unknown files/symlinks, quotas, atomic writes and pointer traversal/interruption.
Existing authentication and report tests remain passing.

Playwright390/1440 checks running/completed/interrupted, populated/empty/error
states, lazy loading, no horizontal page overflow and no page errors. Browser
plugin unavailable; local Playwright with mocked HTTP is UI evidence, not a
fresh physical-device SSO acceptance. Runtime acceptance is recorded below.
