# Bounded MEXC / OKX day study

Protocol `mexc-okx-paired-study-24h-v1`, predefined 26 September 2026.
This is a public quote and cost-sensitivity observation on Hyperion. It does not
submit orders or transfer funds. It is independent of the robot and account observer.

## Fixed collection policy

- BTC/USDT only, 1,440 scheduled pairs at 60-second intervals. First-to-last
  scheduled snapshot spans 23h59m; the nominal observation window is 24 hours.
- Two depth reads and one subsequent OKX BTC-USD public index per slot.
  Both instruments are read at the start and every 30 slots: 48 rule snapshots
  per venue, at most **4,416 public GET requests** in total.
- Metadata refreshes happen before that slot's books. A failed or missed refresh
  replaces the old result until the next scheduled refresh; no stale fallback.
- No automatic retries, catch-up requests, replacement slots, restart or
  retrospective parameter tuning. Missed slots and request failures are retained.
  A venue rate limit stops further requests to that venue for this run.
- Requests have five-second deadlines. Books/index must satisfy the existing
  five-second freshness bounds; receipt skew is at most one second. Instrument
  evidence older than one hour is blocked. MEXC lacks source timestamps, so
  source synchronization is not proven.
- Collector deadline: 86,430 seconds from its start. Independent container
  watchdog: 86,450 seconds, followed by a ten-second kill grace.
- Immutable archive: 1,443 files when complete, maximum 32 KiB per file and
  48 MiB total. Report: separate maximum 16 MiB. Launch needs 256 MiB free disk.
  No deletion or overwrite of previous archives. Container: 128 MiB RAM,
  0.5 CPU, 64 processes, read-only root, no capabilities/ports/restart/log driver.

## Cost assumptions and interpretation

At launch, copy only verified fee rates and payment modes from the existing
protected account observer. Its snapshot must be no older than ten minutes;
its component timestamps retain the original two-minute coherence requirement.
The study container receives that fee projection and public-reader code, not
exchange keys, private account state or the main application environment.

Initial fees and payment modes remain frozen for the entire run. The report
labels them `initial-observed-fees-frozen-sensitivity-only`, reports their maximum
age and keeps `feeRatesContinuouslyVerified=false`. This experiment measures
price gaps under those initial costs, not continuously verified executable profit.

Use the existing fixed size 0.0001 BTC and adverse slippage 5 bps per leg.
Keep quote-fee and OKX received-base scenarios separate. A fee-bearing BTC buy
must be grossed up and re-walk the captured depth; the 8-decimal upward-rounded
fee quantum is an explicit model assumption, not a verified exchange contract.
The BTC/USD index plus 1% remains a proxy for OKX limits, not its admission formula.

Every day-study direction is blocked by `frozen-fees-sensitivity-only` in addition
to unresolved exchange rules. The virtual starting wallets (1,000 USDT + 0.01 BTC
per venue) therefore generate no fills or profit claims. Residual-BTC sensitivities
remain visible; separate synthetic settlement tests cover partial fills and
unknown-order recovery. This capture does not measure actual latency, fill
probability, short-lived opportunities between minute samples or real P/L.

Report coverage distinguishes books/index from instrument refresh completeness.
Report both directions' evaluated/positive samples, net ranges under each fee
scenario, consecutive sampled positives, missing slots, skew and fee age. A
negative result is retained unchanged. Previous 5/30-minute protocols and reports
remain unchanged, including the original 30-minute schedule failure.

## Run and accept

Commit source, build the API, and bundle `src/scripts/pair-paper.ts` for Node 22
ESM. Keep the resulting `pair-paper.mjs` beside a new evidence directory:

```sh
python3 ops/run-pair-paper-probe.py --study-24h BUNDLE NEW_EVIDENCE_DIRECTORY
python3 ops/verify-pair-paper-probe.py NEW_EVIDENCE_DIRECTORY
```

The verifier returns status 75 while collecting, with metadata-only progress.
After completion it verifies archive permissions/hashes, container constraints,
zero restarts, successful exit and unchanged main application identity. It copies
one bounded allowlisted tar stream and requires byte-identical reports from the
compiled CLI and captured bundle. It never rewrites the original archive.
Final analysis is run by this verifier after completion, not by an unattended
trading or reporting service. No automatic user notification is configured.

If the launch prerequisite fails, preserve the failure and do not substitute old
fees. A later fresh observer snapshot may permit a first launch. A failed capture
remains failed; another capture needs a separately recorded decision.

Stop only this run's named container if necessary; retain its archive as incomplete.
No main robot, account observer, Auth, database, key registry or trading locks need
to be changed or rolled back. Runtime start/acceptance evidence is recorded below
only after actual verification.

## Runtime status

Started on Hyperion: **2026-09-26T13:24:42.769+00:00**.
Last scheduled snapshot: **2026-09-27T13:23:42.769+00:00**.
Collector deadline: **2026-09-27T13:25:11.783+00:00**.
Status: **completed and accepted in strict mode on 28 September 2026**.
The collector exited successfully on 27 September at 13:23:43.759 UTC.
All 1,440 scheduled slots are archived; 1,419 book pairs are usable.
[Final result and limitations](PAIR-DAY-RESULT-20260928.md).

- Capture `7a976c9c-27a1-4fc0-8aff-9631aa69dd35`; container `crypto-pair-paper-20260926T132434Z-41096fa8`.
- Source `3a6dd03715ef4570b406cc8ddff33e851faace4c`; bundle `41096fa8e5c08cface7d01102860699777dfa2ccc3ea5463759ef7e71af25402`.
- Archive `/home/mil/crypto-pair-paper-20260926T132434Z-41096fa8/data/archive`.
- Initial books, instruments and USD index available; starting fee evidence
  87619 ms old. The earlier temporary MEXC observer
  failure recovered on its normal schedule; no private retry was made for this study.
- Startup verifier confirmed container isolation and unchanged main application.
  This is startup evidence, not acceptance of the complete 24-hour run.
- [Startup evidence](evidence/pair-day-20260926/startup.json),
  [safe progress](evidence/pair-day-20260926/progress.json),
  [test/build evidence](evidence/pair-day-20260926/checks.json).

Final verifier accepted `output/pair-day-20260926/hyperion` with byte-identical
replay, all 1,443 file hashes matched, zero restarts, intact isolation and unchanged
main application. The archive and the original startup evidence remain unchanged.
See [acceptance](evidence/pair-day-20260926/acceptance-20260928.json) and
[independent Decimal audit](evidence/pair-day-20260926/independent-audit-20260928.json).
Protocol acceptance does not mean complete usable market coverage or executable
profit. No support message was sent; the existing choice of sender remains pending.
