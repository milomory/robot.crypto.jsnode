# Order lifecycle and restart preparation

28 September 2026. Local preparation for future MEXC/OKX execution. This is an
**offline rehearsal**, not exchange testnet, real execution, accepted real
accounting, or a deployed live robot. No exchange transport is present and the
existing `LiveExchangeDisabled` adapter remains unchanged.

## Delivered boundary

`src/live/order-lifecycle.ts` defines a strict event model for one main account
per venue and BTC/USDT cash LIMIT orders sized in base currency. A future sender
must first durably save the immutable intent and then a separate dispatch marker.
A marker immediately makes the outcome uncertain, including a crash before the
network call. It can never be emitted again for that intent. Recovery only plans
inspection/reconciliation; it does not submit or cancel anything.

- Client identity is derived once from the intent and venue; persisted identity
  and request details cannot be replaced after a timeout.
- `not-found`, transport errors and cancellation acknowledgements do not prove
  the order never executed. Reservations remain until explicit reconciliation.
- Fills, fees, cumulative quantities and order identity are validated exactly.
  A partial execution is retained even when the remaining order is cancelled.
- Terminal state alone is insufficient: local reconciliation requires complete,
  consistent reported base/quote amounts and fills. Derived OKX quote amounts
  must not be relabelled as reported cash evidence.
- Orders and their native-asset cash deltas are separate from the running
  simulator's PostgreSQL orders, positions and P/L. No real portfolio balance,
  available funds or profit is inferred from this local log.

The model permanently reports `nonExecutable:true`,
`captureProvenanceVerified:false` and `source:local-rehearsal`. A caller labelling
an observation `declared-recorded` does not authenticate it or enable trading.
Pure lifecycle transitions are not a sender, account reader or admission service.

An explicit `fill-quarantined` event preserves an identity-bound unexpected
execution: excess quantity/quote, fee overruns, an outside-limit price or a fill
beyond terminal totals. Computed fixed anomaly codes and exact cash deltas are
retained once. Subsequent fills may still be recorded, while later observations,
not-found and timeouts cannot clear quarantine. No reconciliation event can
release its reserve. Invalid identities, negative/derived amounts and conflicting
fill IDs remain rejected. Quarantine is a review path, not permission to trade.

This version has no corrections workflow after an order is already reconciled;
late contradictory fills are rejected. Aggregate order observations above the
original caps also reject, even when separate quarantined fills preserve costs.
Fill timestamps assume agreement with the local dispatch clock; an authenticated
importer will need an explicit clock-skew and stale-observation policy.

## Persistence and recovery

`src/live/order-journal.ts` offers:

- `createLiveOrderJournal(newDirectory)`;
- `appendLiveOrderJournal(directory, event, expectedCheckpoint)`;
- `readLiveOrderJournal(directory, minimumCheckpoint?)`.

The new namespace cannot be opened as a paper settlement journal. Private local
files contain the immutable manifest and hash-linked events. The whole committed
prefix is validated and replayed on read. An event with an already recorded ID
and identical normalized payload is a no-op; a changed payload is rejected.
A new event requires the current full checkpoint. Competing writers cannot both
publish the same next sequence. There is no automatic retry of a stale decision.

File publication writes and syncs a staging file, exclusively hardlinks it as
the next record, then syncs the directory. Crash staging is never promoted on
read; committed dispatch markers stay unresolved. Interrupted staging slots are
retained for inspection rather than silently reclaimed. Missing/corrupt records,
wrong checkpoints, unexpected files and non-private files fail closed.

Limits: 200 lifetime order intents, 2,000 events/fills, 1 MiB normalized event
data, 64 KiB per journal file, 4 MiB directory budget including
eight bounded staging slots. No compaction, automatic reset or storage migration.
Local POSIX hardlinks/fsync are required; this is not distributed storage or a
hardware power-loss guarantee. Hashes are not signatures or protection against a
writer able to rewrite the entire chain. An independently retained checkpoint
is required to detect a removed trailing suffix. Rolling back both it and the
journal defeats that check. A new journal is a different rehearsal, not a safe
way to reset an unresolved real order or reuse its client ID.

## Runnable local tool

```sh
npm run lab:live-order-rehearsal -- init NEW_JOURNAL
npm run lab:live-order-rehearsal -- append EVENT_JSON JOURNAL CHECKPOINT_JSON
npm run lab:live-order-rehearsal -- inspect JOURNAL NEW_REPORT
npm run lab:live-order-rehearsal -- inspect JOURNAL NEW_REPORT MINIMUM_CHECKPOINT_JSON LIMITS_DRAFT_JSON
```

The command imports neither the server nor an account reader. No keys are needed.
Stdout is limited to checkpoint metadata and fixed booleans; errors never print
input values or paths. `inspect` creates a new 0700 folder with 0600 `report.json`
and `checkpoint.json`; it never overwrites an existing report. Keep these reports
private. Input JSON is bounded at 128 KiB and each report at 2 MiB. A failed report
may leave a partial new folder; it is not an accepted report and is not deleted
or overwritten automatically.

The launch report validates an optional limits draft without inventing capital,
loss tolerance or residual-position limits. A draft requires explicit total and
per-venue capital, maximum per-order USDT debit, cumulative USDT loss and unhedged
BTC limit. Earn, transfers and withdrawals must remain excluded. Venue allocations
must sum exactly to the total and order/loss caps cannot exceed allocated capital.
Decimal strings preserve up to 18 fractional digits; numeric floats are rejected.

In the original schema 1 rehearsal described here, a valid draft is **not** approval or enforced risk policy. These limits are not yet
bound to journal admission, actual balances, fees, mark valuation, paired execution
or loss measurement. The report always returns `readyToStart:false`,
`executable:false`, `limitsEnforced:false` and `liveAccountingVerified:false`.
The existing UI launch button remains disabled; no new production route is added.

## Why retries and cancellations stay conservative

The official [OKX order-management guide](https://www.okx.com/docs-v5/trick_en/#order-management)
distinguishes request acknowledgement from exchange order state, and a cancel
acknowledgement does not establish terminal cancellation. Its orders WebSocket
has no initial order snapshot. The [place-order contract](https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-place-order)
allows historical client-ID reuse after terminal orders; historical lookup can
return the latest match. We therefore infer no permanent idempotency guarantee
from sending the same client ID again.

[MEXC query-order](https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-order)
accepts client-order lookup and documents a seven-day scope.
[MEXC errors](https://www.mexc.com/api-docs/spot-v3/error-code) require checking an
uncertain outcome; a timeout can coexist with a completed operation. The
[new-order contract](https://www.mexc.com/api-docs/spot-v3/spot-account-trade/new-order)
does not establish lifetime client-ID uniqueness. An absent result is therefore
not accepted as permission to repeat a potentially successful order.

These references were checked on 28 September 2026. They inform conservative
local behavior; they are not proof of tested authenticated order transport.

## Read-only response binding follow-up

The [response-binding slice](ORDER-RECOVERY-EVIDENCE.md) now supplies a narrow
signed GET reader, bounded collector, exact identity/time checks and resumable
local import. Paired source creation/update timestamps persist in observations;
once bound, they cannot disappear, change creation or regress update time.
No old source timestamp is fabricated. This addresses the local format/replay
boundary; protected real account provenance and runtime acceptance remain pending.

## Remaining work before a real launch

1. Bind authenticated read-only order/fill evidence to persisted identity,
   including account identity, order timestamps, retention and incomplete pages.
   Current manually supplied observations are not trusted live evidence.
2. Complete the unresolved [exchange execution/cash contracts](PAIR-NEXT-STEPS.md)
   and accept nonzero historical accounting without placing fixture trades.
3. Bind an explicit approved risk policy to durable admission and actual available
   trading balances, fees and one-sided inventory. Separate account-global order
   uniqueness, operational loss accounting, backups and journal lifecycle are needed.
4. Build and independently verify a disabled-by-default sender and its process
   fencing, idempotency/recovery composition, then operator activation/stop controls.
   A persisted marker by itself cannot fence two network-sending processes.
5. Select capital/loss/residual limits and qualify a strategy after costs. The
   completed BTC day study found no positive selected-scenario opportunities;
   this preparation does not override that evidence.

Production API/UI, observer, Auth, scheduler, PostgreSQL schema, credentials and
live lock are outside this local change. No submission, cancellation, transfer,
withdrawal or Earn movement is performed. Shared trading-control is untouched.


## Local acceptance — 28 September 2026

- Full repository suite: **1,883 passed**, 15 existing PostgreSQL skips.
- New coverage: 59 lifecycle, 20 journal, 19 limits/readiness, three cross-process
  CLI and four independent input/network boundary tests.
- API/UI production builds and separate strict TypeScript compilation of the
  new tests passed. Independent review found no blocking defect.
- Real child-process SIGKILL was injected during write and before/after
  publication. File/directory sync failures, competing writers, bounded staging,
  corruption, missing suffixes and separate-process recovery were exercised.
- Quarantined fee overruns survived restart, preserved the exact cost and stayed
  blocked after a terminal observation. Live-looking environment variables did
  not activate execution.
- The compiled CLI passed 12 additional checks with network entrypoints disabled;
  Python Decimal independently matched partial-fill cash/base deltas. Fixtures
  were synthetic. This is not a trading or device/browser acceptance.

[Check metadata](evidence/live-order-recovery-20260928/checks.json) and
[compiled acceptance with source hashes](evidence/live-order-recovery-20260928/acceptance.json)
contain no credentials, account IDs or real balances. One initial new test had an
extra forbidden field in its fixture; the fixture was corrected without relaxing
the strict schema. The final full run passed.

Shared memory search was reachable but returned no relevant project context;
repository documents supplied the working context. Source publication and
production deployment were not performed. The next implementation boundary is
authenticated read-only evidence/recovery and a durable account-wide risk policy,
not activation of this rehearsal as a real executor.


## Follow-up: bound rehearsal policy and private captures

The [schema 2 order journal](LIVE-ORDER-ADMISSION-POLICY.md) now binds an explicit
declared synthetic policy to replay, intent admission and dispatch markers. The
legacy schema 1 remains unchanged and is never silently promoted. The live-launch
report still reports production limits unverified.

[Read-only evidence composition](ORDER-RECOVERY-EVIDENCE.md) now provides an
injected-credential three-read capture, a private durable original archive and
separate offline inspect/import commands with exact-prefix resume. Its
[protected runtime contract](ORDER-RECOVERY-PROTECTED-CONTRACT.md) distinguishes
completed code from the fixed broker runner, account binding and authenticated
acceptance still required. No order sender or runtime trading authority is added.
