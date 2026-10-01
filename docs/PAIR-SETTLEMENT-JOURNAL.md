# Durable offline paired settlement journal

This adds local persistence to the existing explicit-fill paper settlement model.
It is not connected to the robot, account observer, study collector, exchange order
transport or an automatic execution decision. Initial wallets and supplied events
remain synthetic. No production deployment or database migration is involved.

Schema 1 below retains the original accounting-only contract. For persistent
risk policy and admission checks, use the separate
[schema 2 interface](PAIR-RISK-JOURNAL.md); neither API silently switches formats.

## Interface

`src/paper-pair/settlement-journal.ts` provides:

- `createSettlementJournal(newDirectory, initialBalances)` — initialize a new
  private journal; never reuse or overwrite an existing directory.
- `readSettlementJournal(directory, minimumCheckpoint?)` — verify the entire
  committed prefix and reconstruct balances, reserves, fills and statuses.
- `appendSettlementJournal(directory, event, expectedHeadHash)` — validate the
  event with the existing settlement engine and publish one immutable record.

The snapshot contains `journalId`, `revision`, `headHash`, `pendingFiles` and the
reconstructed `state`. New events require the caller's current head. Concurrent
writers compete for the same next filename; only one can publish it. Re-reading
is required after a conflict before deciding whether a new event still applies.
An exact duplicate event is the explicit exception: it returns `appended:false`,
including with an older valid head, because its effect is already in the journal.
A conflicting payload using the same event ID is rejected. A repeated economic
fill under a new event ID stays an audit record without posting funds twice.

## CLI

```sh
npm run lab:settlement-journal -- init OPENING_JSON NEW_JOURNAL
npm run lab:settlement-journal -- append EVENT_JSON JOURNAL EXPECTED_HEAD
npm run lab:settlement-journal -- inspect JOURNAL NEW_REPORT
npm run lab:settlement-journal -- inspect JOURNAL NEW_REPORT CHECKPOINT_JSON
```

Inputs use the balances/events in [the settlement contract](PAIR-SETTLEMENT.md).
Every input file is bounded at 128 KiB. `inspect` creates a new private report
folder containing `report.json` and `checkpoint.json`; it never overwrites an
existing report. The report has a separate 2 MiB limit. stdout contains only
journal ID, revision, hash, pending count and synthetic/non-executable markers.
Amounts, events, order IDs and arbitrary filesystem errors are not printed.

The checkpoint contains only `{journalId, revision, headHash}`. Retain it outside
the journal. A checked read requires that exact checkpoint to exist in the
recovered prefix; newer valid events are allowed. Revision zero is the manifest.
A removed suffix or different journal is rejected against that anchor.

## Publication and recovery

The journal contains one immutable manifest and contiguous `000001.json`,
`000002.json`, … event records. Each record binds its journal ID, sequence,
previous hash and canonical event. Files are 0600 in a 0700 directory; symlinks,
foreign hardlinks, wrong permissions/owner, unexpected files, invalid schemas,
broken hashes and missing middle records are rejected.

Publication follows these steps:

1. Exclusively occupy one of 16 fixed `.pending-00` through `.pending-15` slots.
2. Write and fsync the complete record, then close it.
3. Create the next sequence filename with an exclusive hardlink, then fsync the
   journal directory. Existing committed files are never replaced.
4. Remove only this writer's staging link, fsync the directory, then acknowledge.

A process killed before publication leaves a visible pending file and the prior
committed state. A process killed after publication leaves the new record, with
or without its staging link. A recovery read validates and replays that record
and fsyncs its directory entry. An interrupted unpublished file is never promoted
or interpreted as an executed event. Unknown legs keep their reservations until
an explicit validated reconciliation; a restart does not release them.

An I/O error at publication or later yields `journal-publish-uncertain`. Preserve
the evidence and re-read before another decision. A known event can be submitted
again idempotently. No automatic trading retry is attached to this operation.

Retained pending files are reported and preserved. Other writers do not delete
or reclaim them. All 16 slots occupied prevents new writes, while the valid
committed prefix remains readable. Operator recovery must first stop writers,
inspect the committed record/checkpoint and preserve the interrupted evidence;
there is intentionally no blind stale-lock cleanup command.

## Bounds and limits of the guarantee

The existing engine permits at most 2,000 events, 2,000 distinct fills and 1 MiB
of canonical event data. A stored file is at most 128 KiB. The reader bounds the
whole journal directory at 4 MiB, including at most 16 staged records. Fixed
exclusive slots also bound simultaneous writers. Rejected events do not mutate
the committed chain. Initialization interrupted before its manifest is complete
remains invalid; it is not silently initialized again.

This targets a private local POSIX filesystem with hardlink and fsync support.
Actual process termination and injected I/O failure are tested; sudden power
loss, hardware/controller guarantees and network filesystems are not verified.
Directory fsync during read is intentional recovery work; no record is rewritten.
The journal is bounded per experiment and is not an unbounded production ledger.

The hash chain detects inconsistent content, not an authorized writer's ability
to rewrite files. It is not a signature, encryption or a backup. Without a trusted
external checkpoint, deleting a complete trailing suffix cannot be distinguished
from an earlier valid prefix. If both the journal and its external checkpoint are
rolled back together, this layer cannot prove freshness. Backup and production
execution integration remain separate work.

## Validation

The test suite includes actual child-process SIGKILL immediately before/after
record publication, seven events replayed across separate Node processes,
partial-fill and unknown-reserve recovery, duplicate delivery, concurrent writers,
20 simultaneous interrupted submissions bounded to 16 staging slots, fsync
failures, malformed records, permissions/links, disk bounds, external checkpoint
rollback detection and the complete CLI round trip. No exchange or runtime calls
are made by these tests.

```sh
npm test -- --maxWorkers=1 tests/paper-pair-settlement-journal.test.ts
```

The initially discovered unbounded UUID staging race was corrected before release.
The SIGKILL harness explicitly keeps its process alive while waiting for the kill;
an unsettled top-level await is not accepted as proof of a killed process.

Local validation on 26 September 2026: all 19 journal tests passed, including the
CLI and real child-process termination cases. The full repository suite passed
1,615 tests with 15 existing PostgreSQL skips. API/UI builds and the strict
typecheck of the new test file passed. This is local preparation; no production
execution or persistence integration was deployed.
