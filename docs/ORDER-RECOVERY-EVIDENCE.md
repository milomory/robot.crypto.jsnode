# Read-only order recovery evidence

28 September 2026. This connects MEXC/OKX response formats to the isolated
[order recovery rehearsal](LIVE-ORDER-RECOVERY.md). It adds a scoped signed GET
reader, a bounded three-read collector, strict response binding and resumable
journal import. It does not add an order sender, production worker or trading
permission. Tests use synthetic responses; no real account request or production
deployment is implied by this delivery.

## Read boundary

`src/accounts/order-recovery-reader.ts` provides `OrderRecoveryReader(venue,
AccountOptions)`, `getOrder(selector)` and `getFills(orderId, range)`.
Credentials are injected by a future protected composition; the module reads no
environment, vault or credential file. The venue is fixed in a private runtime
field and the reader instance is frozen. Both a known exchange order ID and a
client ID cannot be supplied together.

The new `order-recovery` transport scope permits only:

| Venue | GET endpoint | Exact selection |
| --- | --- | --- |
| MEXC | `/api/v3/order` | BTCUSDT and one of `orderId` / `origClientOrderId` |
| MEXC | `/api/v3/myTrades` | BTCUSDT, one `orderId`, limit 1000 |
| OKX | `/api/v5/trade/order` | BTC-USDT and one of `ordId` / `clOrdId` |
| OKX | `/api/v5/trade/fills-history` | SPOT BTC-USDT, one `ordId`, bounded begin/end, limit 100 |

Fixed HTTPS origins, exact query allowlists, GET-only requests, redirect rejection,
cookie omission, request/body timeouts and response-size limits remain enforced.
Existing account and history scopes do not gain client-ID lookup or other routes.
No retry, cursor pagination, broad history scan, account operation or mutation is
available through this reader. HTTP/API failures, including absent results, remain
unavailable evidence; they cannot authorize another submission.

Returned projections retain only necessary order/fill identity, exact decimal
strings and timestamps. They are deeply frozen. No URL signatures, headers,
cookies, credentials or upstream error text are returned or logged. Captures
still contain private order/fill information and belong outside Git.

## Collection and binding

`collectLiveOrderRecovery(state, orderIntentId, reader)` reads only a persisted,
dispatched and unreconciled intent. It checks reader venue, requires a recent
order, and allows one in-flight capture per reader. The bounded sequence is:

1. Look up the saved exchange ID when known; otherwise use the saved client ID.
2. Read a single bounded page of fills for the returned exchange ID.
3. Look up that exchange ID again and compare its state.

Reads are separated by 250 ms, individually bounded at five seconds, with a
30-second capture budget. A failed step stops the sequence without retry or
journal mutation. The MEXC seven-day lookup horizon is respected; the collector
also uses a conservative seven-day bound for OKX, not a claim about OKX's full
retention. Returned snapshots are cloned immediately, then frozen.

`buildLiveOrderRecoveryEvidence` binds the envelope to the persisted intent:
venue/main-account scope, BTC/USDT, side, LIMIT/base sizing, limit price, client
and exchange identities, creation time, requested query and order totals.
The outer capture must contain the individual HTTP read intervals; their clocks
need not match to the millisecond. Before/after snapshots must agree. A changed
order, malformed identity, future/stale capture or contradictory data cannot
complete reconciliation.

The default evidence policy allows at most 60 seconds of capture age, 30 seconds
of duration and two seconds of clock skew. These limits can only be tightened.
Creation must be near the persisted dispatch marker, with a conservative 30-second
creation-delay bound. Fill times are preserved, never shifted to make evidence
fit. A fill preceding the local dispatch remains unsupported and requires review.
The 128 KiB capture limit can reject a large page even before its row limit.

The lifecycle now retains optional paired `sourceCreatedAt` / `sourceUpdatedAt`
on an order observation. Once recorded, creation must stay identical and update
time cannot regress or disappear, including after journal replay. Old rehearsal
journals without these fields remain readable; no timestamp is invented for them.

MEXC reported quantities/quote amounts and per-asset commissions are kept exact.
Fill identities deduplicate repeated rows and repeated captures; changed records
with the same ID fail. Unknown source fields are discarded. Price evidence that
contradicts its reported economics blocks the capture. Consistent but unexpected
costs can enter the existing sticky quarantine without losing the exact expense.
A full response page, mismatch or incomplete evidence keeps reconciliation blocked.

OKX `fillPx × fillSz` and `avgPx × accFillSz` remain explicitly derived; nonzero
money is not posted as reported cash. A useful order observation may still be
imported, retaining the reservation. A zero-execution cancellation requires zero
order fee/rebate and an empty uncapped fill result before local reconciliation.
This is not a shortcut around the outstanding OKX cash contract.

## Durable import and interrupted recovery

`applyCapturedOrderRecovery(directory, baseCheckpoint, orderIntentId, capture)`
rebuilds the state at the supplied trusted base checkpoint and validates the whole
proposed sequence before writing anything. It derives deterministic event IDs from
normalized evidence and identity, without using the current evaluation time.

If part of the import is already present, the entire suffix after that base must
match an exact prefix of the same recomputed plan. Only the remaining events are
appended, each with the journal's compare-and-swap checkpoint. An unrelated write
blocks continuation. A failed append retains published records; there is no
rollback, deletion or claim that a multi-event import is one atomic transaction.

Persist the original capture and base checkpoint outside the journal before
import. A fresh import needs current evidence. An exact previously admitted prefix
may resume after the freshness window; its result says `resumed-historical`.
This resumes an already accepted local accounting plan, not a fresh exchange check.
A stale capture without a published matching prefix remains blocked.

## Offline command

```sh
npm run lab:order-recovery -- inspect CAPTURE_JSON JOURNAL BASE_CHECKPOINT_JSON INTENT_UUID NEW_REPORT
npm run lab:order-recovery -- import CAPTURE_JSON JOURNAL BASE_CHECKPOINT_JSON INTENT_UUID
```

The command consumes already captured JSON. It never loads credentials, contacts
an exchange or starts the robot. `inspect` leaves the journal unchanged and creates
a new 0700 directory with a 0600 report; existing reports are preserved. `import`
uses the resumable local protocol above. Stdout contains only fixed status codes,
counts and checkpoint metadata. Errors do not reveal input values, IDs or paths.
Input files are bounded regular non-symlink JSON files. Inspect reports are capped
at 2 MiB; interrupted report creation may leave an incomplete new folder.

## Credential-injected capture and private archive — next local slice

`captureLiveOrderRecoverySession` now composes the real scoped reader, journal
checkpoint and three-read collector. Its caller supplies credentials in memory;
it has no vault/env lookup or installed runner. The persisted intent alone selects
the venue. Inputs are copied before asynchronous work, a per-journal in-process
lock rejects overlapping calls, and exact checkpoints are checked before HTTP and
before archive publication. Shared cross-process locking remains the future
protected runner's responsibility.

A shared opaque session context retains per-venue cooldown across repeated calls.
HTTP 418/429 preserves the full `Retry-After`; exchange rate errors carried in
HTTP 200 add at least 60 seconds. `createOrderRecoverySessionContext` accepts an
explicit previously persisted cooldown snapshot and a serialized persistence
callback receiving only frozen venue timestamps. A persistence failure latches
that context closed. The default context persists only within this process: an
installed runner must restore/save the shared observer cooldown under its outer
flock. Restart must not silently substitute a fresh empty context. Credentials
are never retained by the context. There are no automatic retries.

A successful capture writes the original capture, original base checkpoint and
intent identity into an exclusive private archive before any journal import.
The new directory is 0700 under a verified private parent; its sole `capture.json`
is 0600, bounded, canonical, hashed and fsynced. The response contains a safe
receipt, not credentials or private orders. Secret-value/escaped-value checks run
before publication. Unsafe paths, existing archives and stale initial heads fail
before HTTP. A changed head after capture blocks publication. The head check and
archive write are not a single transaction: the later import still performs CAS.

Failures retain incomplete new archives for inspection and never overwrite old
ones. `readLiveOrderRecoveryArchive` rejects incomplete, unsafe, oversized or
altered files and can verify an independently retained receipt. A hash proves
internal integrity, not exchange/account authenticity. The archive deliberately
retains the existing false provenance/account identity flags.

The offline CLI can consume the complete archive without copying private fields:

```bash
npm run lab:order-recovery -- inspect-archive ARCHIVE JOURNAL NEW_REPORT [TRUSTED_RECEIPT_JSON]
npm run lab:order-recovery -- import-archive ARCHIVE JOURNAL [TRUSTED_RECEIPT_JSON]
```

First import still requires fresh evidence. An exact already-published import
prefix can resume later with the original archive/checkpoint. Capture itself never
imports events. These commands also support the policy-bound schema 2 journal;
reconciliation facts remain recordable when new order admission is blocked.

The [protected deployment contract](ORDER-RECOVERY-PROTECTED-CONTRACT.md) records
actual broker/profile metadata and the fixed helper/identity/acceptance work still
needed. No recovery profile/container has been installed, no fabricated intent was
sent to a real exchange, and no authenticated recovery acceptance is claimed.

## Evidence and remaining limitations

Every result remains `nonExecutable`/`executable:false`. Both
`captureProvenanceVerified` and `accountIdentityVerified` stay false. These pure
functions cannot prove the main account behind a supplied key or authenticate an
arbitrary JSON capture. Matching client identity alone does not establish that.
No capture is automatically relabelled as verified live evidence.

Before live use, a protected pinned composition must bind the reader's credential
profile and capture archive to the intended account and journal. Real authenticated
lookup acceptance, account-global intent identity, actual trading-balance/risk
admission, clock policy, late corrections, backup/recovery and the disabled sender
remain separate work. Existing archived nonzero cash evidence is also still needed.
The negative BTC day-study result and unselected capital/loss limits are unchanged.

Official references checked on 28 September 2026:

- [MEXC query order](https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-order):
  client/order lookup and seven-day scope.
- [MEXC account trade list](https://www.mexc.com/api-docs/spot-v3/spot-account-trade/account-trade-list):
  selected-order fills, last-month scope and 1000-row maximum.
- [OKX order details](https://my.okx.com/docs-v5/en/#order-book-trading-trade-get-order-details):
  order-ID selection and latest-match client-ID behavior.
- [OKX transaction details](https://my.okx.com/docs-v5/en/#order-book-trading-trade-get-transaction-details-last-3-months):
  capped fill history; system `ts` and execution `fillTime` are different fields.

No production service, account state, secret profile, migration, paper scheduler,
Auth configuration, live lock or shared trading-control document is changed.


## Local validation

Full suite: **2,059 passed**, 15 existing PostgreSQL skips. New tests comprise
107 reader/transport cases, 52 response-binding cases, seven integrated/CLI cases,
eight independent boundary cases and two source-time persistence cases. API/UI
builds and strict typing of all new tests passed.

The integrated path uses the real reader and signing implementation with mock
HTTP responses, independent clock reads advancing by milliseconds, the real
private journal and fresh CLI processes. Offline command tests trap network
entrypoints even when environment flags look like live mode. Prefix interruption,
late historical resume, stale first imports, concurrent journal changes and
unchanged report destinations are covered. This is code acceptance, not
authenticated account or operational trading acceptance.

Independent review caught and verified fixes for mutable venue routing, overly
strict capture-clock equality and contradictory client identity. Additional checks
block a zero-execution OKX order with nonzero fees and retain source timestamp
monotonicity across captures. [Check metadata and source hashes](evidence/order-recovery-evidence-20260928/checks.json)
contain no keys, real balances or account identifiers. Shared memory was reachable
but its search returned unrelated content; source documents supplied the context.
Source publication and production deployment were not performed.


## Policy/session local acceptance — 28 September 2026

Final repository suite: **2,139 passed**, 15 existing PostgreSQL skips. API/UI
build and strict typing of the four new test files passed. The 80 new tests cover
32 admission-policy cases, eight journal/CLI cases, seven independent policy
boundaries and 33 capture/archive/cooldown cases. SIGKILL, fsync failure, two-process
CAS, partial import, separate offline CLI and credential non-disclosure use only
synthetic responses and private temporary data.

Independent review identified the per-reader cooldown reset; repeated captures
now retain full Retry-After and fail closed on persistence failure, including
concurrent captures of another journal. The full suite also caught the legacy
CLI metadata compatibility regression; schema 1 output was preserved and the
final full run passed. No real exchange request or production deployment occurred.

[Acceptance metadata and source hashes](evidence/order-policy-session-20260928/checks.json).
Shared memory was reachable but its search returned unrelated content; source
documents and read-only metadata supplied the working context. The shared
trading-control repository and user-owned Auth integration request remain untouched.
