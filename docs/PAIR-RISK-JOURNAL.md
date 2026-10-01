# Durable journal with a fixed synthetic risk policy

Schema 2 adds the [synthetic risk gate](PAIR-RISK.md) to the
[durable settlement journal](PAIR-SETTLEMENT-JOURNAL.md). A new paper preparation
is checked against the stored policy and the same committed prefix used for its
exclusive next-record publication. This is local accounting/admission only;
there is no exchange submission, production integration or migration.

## Persisted policy and recovery

The immutable manifest contains opening synthetic wallets, the full strict policy,
its canonical SHA256 (`policyHash`), a new journal UUID and the manifest hash.
Every event record binds schema 2, that UUID, sequence, previous hash, policy hash
and the exact canonical event. On recovery, the entire prefix is revalidated and
replayed through the risk wrapper, including every historical preparation.
Correct file hashes alone do not make an event admissible under the policy.

Cash-loss usage, native-asset fee usage, balances, pending/unknown statuses and
reservations are reconstructed. They are not separate mutable counters. Reopening
the journal never selects another policy, resets the session or clears reserves.
There is no API for changing policy inside a journal. Removing or rewriting a
policy is not a supported reset or migration.

Legacy schema 1 journals retain their existing files and behavior. The old read/
append API and CLI reject schema 2, and risk-specific APIs reject schema 1.
An absent policy cannot silently initialize a legacy journal. Existing journals
are not upgraded in place; copying only selected old events into a new session
would be a different experiment, not continuation of the original risk budget.

## Atomic admission and expected checkpoint

Use these functions from `src/paper-pair/settlement-journal.ts`:

- `createRiskSettlementJournal(newDirectory, initialBalances, policy)`.
- `readRiskSettlementJournal(directory, minimumCheckpoint?)`.
- `appendRiskSettlementJournal(directory, event, expectedCheckpoint)`.

The returned snapshot includes `schema: 2`, `policy`, `policyHash`, the existing
settlement state and `checkpoint`:

```ts
{ schema: 2, journalId, revision, headHash, policyHash }
```

For a new event, this checkpoint must match the current committed head, journal
identity and policy. The append operation reads and validates the whole prefix,
recomputes risk under the manifest policy, then uses the existing exclusive
hardlink publication for the next sequence number. Two writers using the same
head cannot both publish different next events. A loser receives a head conflict
and must read again before deciding whether to submit a new event. There is no
automatic retry that reuses a stale admission decision.

An exact duplicate event is the explicit no-op exception. Its original checkpoint
may now be an ancestor, but identity, policy and ancestor hash must still match.
The same checks run again when a competing writer has already published that
event. A duplicate is not a fresh admission or another reservation. A changed
payload with the same event ID, an unrelated journal, or a policy mismatch fails.

Risk gates only new preparations. Already observed fills, unknown outcomes,
reconciliation and terminal facts are still subject to normal settlement
validation and current-head publication, not a fresh preparation allowance.
This preserves accounting when no new pair may start.

## CLI

```sh
npm run lab:risk-journal -- init INITIALIZATION_JSON NEW_JOURNAL
npm run lab:risk-journal -- append EVENT_JSON JOURNAL CHECKPOINT_JSON
npm run lab:risk-journal -- inspect JOURNAL NEW_REPORT
npm run lab:risk-journal -- inspect JOURNAL NEW_REPORT MINIMUM_CHECKPOINT_JSON
```

Initialization is a strict JSON object with `schema: 1`,
`kind: "synthetic-risk-journal-input"`, `initialBalances` and `policy`. The wallets
and full policy can be taken from a committed `fixtures/pair-risk/` scenario for
synthetic local checks. An event file is one settlement event, not a whole scenario.
No credentials or real account snapshots are needed.

`init` and `append` return the resulting checkpoint in metadata-only stdout.
`inspect` creates a new 0700 report directory with 0600 `report.json` and
`checkpoint.json`; existing destinations are preserved. Save the checkpoint
outside the journal and supply it for the next append. Amounts, policy limits,
events and order IDs appear only in the private report, not stdout or error text.
Inputs remain bounded at 128 KiB and the report at 2 MiB.

An inspect checkpoint is a minimum trusted ancestor: newer valid records are
accepted. An append checkpoint is the exact expected head for a new event.
Supplying only a head hash, a legacy checkpoint, or extra bypass/reset fields is
rejected. Keep the external checkpoint if suffix rollback detection is needed.

## Failure handling and limits

The shared publication mechanism is unchanged: occupy one of 16 exclusive staging
slots, write/fsync the complete record, publish its immutable sequence with an
exclusive hardlink, fsync the directory, remove only the writer's staging link,
then fsync before acknowledgement. A process killed before publication leaves
only uncommitted staging; it is never promoted. A kill after publication leaves
a record that recovery validates under the same stored policy. Unknown execution
still retains its reservation after recovery.

`journal-risk-rejected` means a new event failed the risk wrapper and was not
published. `journal-kind-mismatch` rejects the wrong API/journal schema.
`journal-head-conflict` requires checking the current checkpoint. Existing
`journal-invalid`, `journal-limit`, `journal-event-invalid`,
`journal-write-failed` and `journal-publish-uncertain` meanings are retained.
After uncertain publication, preserve files and recover before another decision.
A failed restore is not permission to silently start with empty counters.

The bounded filesystem journal is still synthetic: at most 2,000 events, 1 MiB
canonical event data in the engine, 128 KiB per file, 4 MiB directory accounting
and 16 staging slots. No automatic reclaim, backup, remote replication, encryption
or signing is added. Local POSIX hardlink/fsync assumptions and the previously
documented storage limits still apply.

Hash binding is not protection against a writer able to rewrite the entire
journal consistently. Without an independently retained checkpoint, a complete
suffix removal cannot be distinguished from an older prefix. Rewriting or rolling
back both the journal and its trusted checkpoint defeats this freshness check.
The atomicity described here covers journal admission/publication, not exchange
execution or an order transport. Sudden hardware power loss is not tested.

## Validation on 26 September 2026

All 32 new tests passed: 28 core cases and four multi-process CLI cases.
The existing 19 schema 1 journal tests also passed. The full repository suite
passed **1,696 tests with 15 existing PostgreSQL skips** (62 passed files, one
skipped). API compilation, strict TypeScript checks for both new test files and
diff checks passed. Independent read-only review found no blocking issue.

A directed CAS test holds two independent Node processes immediately before
`fs.link`, then releases both. Exactly one distinct preparation is published;
the other receives `journal-head-conflict`, with one reserve and no leftover
staging file. Real SIGKILL tests immediately before/after publication recover the
same policy and correct partial/unknown reserve without promoting staged bytes.
Other cases cover rehashed-but-risk-invalid history, policy/schema mismatch,
checkpoint identity and ancestry, duplicates, rollback detection, input/output
bounds, private files, fixed errors and preserved existing destinations.

An independent acceptance run alternated fresh source/compiled CLI processes
through the seven-event synthetic fee/reconciliation fixture. Its two final
reports were byte-identical, a Python Decimal calculation confirmed cash-loss
usage, an over-budget preparation left journal files unchanged and a smaller
preparation used the same policy successfully. Safe check metadata is retained
in [evidence](evidence/pair-risk-journal-20260926/checks.json).

The last read-only day-study status during this work was running with 336 of
1,440 scheduled samples, unchanged main app and verified isolation. Final study
acceptance remains pending. No deployment, source publication, account API call,
order, transfer, observer/Auth/credential change or trading-lock change occurred.
Shared memory search was reachable but returned no relevant project context;
source documentation supplied the implementation context.
