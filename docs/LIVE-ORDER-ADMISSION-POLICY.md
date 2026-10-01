# Policy-bound order preparation

28 September 2026. This adds enforced **local rehearsal** admission to the
[order journal](LIVE-ORDER-RECOVERY.md). It does not activate trading, choose the
user's limits, authenticate account balances, or replace the live launch gate.

## Durable admission

`createPolicyBoundLiveOrderJournal(newDirectory, policy)` creates a new schema 2
journal. The immutable manifest contains normalized limits and declared initial
BTC/USDT/MX funds on each selected main account. The existing read/append APIs
recognize this version and enforce its policy; using the old append entrypoint
cannot bypass it. Schema 1 journals remain unbound rehearsals. There is no
in-place upgrade, policy replacement, counter reset or automatic migration.

Admission is checked for both `intent-created` and `dispatch-marked`, against the
same replayed head that the exclusive next-record publication compares and swaps.
A competing write requires a new read and a new assessment. A prepared order's
own reserve is counted once during dispatch assessment. Dispatch still records
uncertainty only: there is no exchange sender in this implementation.

Every read replays the checks from the initial manifest. Policy hash binding,
record versions, checkpoints and event validation remain mandatory. An externally
retained checkpoint detects replacement or removal of the committed suffix.
The filesystem owner remains trusted; this is not account-global or tamper-proof
storage. A second newly created journal cannot establish shared account limits.

## Exact checks and their limits

Amounts use exact integer arithmetic at up to 18 fractional digits. There are no
capital or loss defaults. The strict policy has this shape:

```text
schema: 1
kind: live-order-admission-policy
source: declared-synthetic
limits: the exact live-limits-draft shape
initialBalances:
  mexc: { BTC: decimal string, USDT: decimal string, MX: decimal string }
  okx:  { BTC: decimal string, USDT: decimal string, MX: decimal string }
```

The limits draft requires total and per-venue capital, per-order USDT debit,
cumulative loss budget and maximum unhedged BTC. Earn, transfers and withdrawals
must all remain disabled. Initial funds are declarations for testing, not a
snapshot of the real user's accounts.

- Wallet availability is initial funds plus recorded native-asset movements,
  less every unresolved full reservation, including fees. It never assumes an
  opposite pending order has filled.
- Capital occupancy is the positive USDT cash deficit plus reservations, bounded
  per venue and in total. This is a cash-commitment limit, not portfolio valuation.
- Per-order USDT debit includes the USDT fee cap. Selling BTC also requires the
  native BTC reservation and the exposure checks; notional value is not called a
  USDT cash debit.
- The BTC exposure interval considers each pending direction separately. Pending
  buys and sells cannot optimistically cancel one another. Full pending amounts
  remain conservative even after partial fills until reconciliation.
- Unknown order outcomes and accounting anomalies stop new admission. They do
  not prevent recording observed fills, fees, cancellations or reconciliation.
  An over-limit observed expense must remain in the accounting history.

**The cumulative-loss check is deliberately stricter than an ordinary stop-loss.**
Without a validated inventory valuation/closed-cycle P&L contract, it uses the
lifetime gross USDT outflow plus unresolved/proposed USDT reserves as an upper
bound. Buy principal and fees consume that allowance; sale proceeds, profitable
trades, restart and midnight do not replenish it. This can block an otherwise
profitable proposed order. It does not compute realized P&L or claim to be the
final production loss model. Opening BTC inventory has no established cost basis,
and MX fees have no USDT valuation here; those cases fail closed with explicit
reasons. This limitation must be resolved before real trading readiness.

## Offline commands

A runnable example is [admission-policy.json](../fixtures/live-order-rehearsal/admission-policy.json).
Its amounts are arbitrary synthetic test inputs, not selected user limits or live
defaults. Create a separate policy explicitly; do not put real account data into Git.
The command accepts no keys and does not contact exchanges:

```bash
npm run lab:live-order-rehearsal -- init-policy POLICY_JSON NEW_JOURNAL
npm run lab:live-order-rehearsal -- append EVENT_JSON JOURNAL CHECKPOINT_JSON
npm run lab:live-order-rehearsal -- inspect JOURNAL NEW_REPORT CHECKPOINT_JSON
```

The private inspect report includes the bound policy and
`rehearsalPolicyEnforced:true`. A separate draft override is rejected for a bound
journal. `readyToStart`, production `limitsEnforced`, authenticated balances and
capture provenance remain false. The runtime live lock and simulator are
unchanged.

## Remaining execution work

The policy user values are still unselected. Protected account identity, fresh
real available funds, account-global intent/limit ownership, precise inventory
valuation, exchange/cash contracts, nonzero accounting acceptance, strategy
qualification and a separate operator activation path remain prerequisites.
A successful synthetic journal check is not a permission to send an order.


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


## Follow-through — 30 September 2026

[Protected identity/funds binding](ACCOUNT-FUNDS-OBSERVATION.md) is accepted separately.
The new [account-funds preparation workflow](ACCOUNT-FUNDS-PREPARATION.md) verifies
that capture, declared fees and fresh candidate funds, and maintains private local
reservations with CAS. It has its own kind; this historical synthetic policy journal
has not acquired real-balance provenance. New fees/current credential checks, venue
spending semantics and production account-global authority remain unaccepted.
