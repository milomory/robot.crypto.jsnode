# Synthetic paired-trade risk checks

Prepared locally on 26 September 2026. This module adds explicit admission limits
around the existing paired settlement model. It has no exchange transport,
account keys, market requests, timers, transfers or production wiring. Policies
and starting wallets in the fixtures are invented examples, not selected limits
for the user's funds. Every decision/report is synthetic and non-executable.

## What is checked

Each new `prepare` first goes through a dry run of the existing settlement
engine. Existing same-venue, balance/reserve, previous pending/unknown/residual,
identity, event-order and size checks remain authoritative. The risk layer then
checks an explicit policy with no monetary defaults:

| Policy field | Meaning |
| --- | --- |
| `maxBuyDebitUsdt` | Gross BUY quote ceiling plus BUY USDT fee ceiling |
| `maxSingleLegBtc` | Maximum of gross BUY BTC and SELL BTC plus SELL BTC fee cap |
| `maxSessionCashLossUsdt` | Sum of negative cash deltas of completed BTC-balanced pairs, plus the entire proposed BUY debit |
| `maxSessionFees` | Previously recorded fees plus both proposed fee caps, separately in BTC, USDT and MX |
| `minFreeAfterReserve` | Minimum free BTC, USDT and MX after preparation, separately for MEXC and OKX |

All quantities are exact strings with up to 18 decimal places; arithmetic uses
bigint. Equality with a ceiling or floor is allowed. Each venue must fund its own
leg and fees. Assets and balances on another venue do not cover a shortfall.
The engine's exact reservation calculation supplies the projected free funds.

The BTC bound covers either leg filling alone or partially. It is not the final
net BTC position, and equal gross BUY/SELL quantities are not required: a larger
gross buy may compensate a BTC fee. A quote-budget BUY has no hard maximum BTC
quantity in the current settlement contract, so risk admission rejects it with
`quote-budget-unbounded-base-exposure`. No estimated price is substituted for a
missing quantity bound. The underlying accounting engine still supports such
recorded orders independently of this preparation gate.

## Cash limit, commissions and scope

The session includes the **entire supplied journal**, not a clock-based day.
For every terminal BTC-balanced pair, accumulate `max(0, -cashDeltaUsdt)`.
Positive cash deltas do not restore this allowance. Replaying the same full
journal under the same policy reconstructs the same usage; midnight does not
reset it. Unknown or open legs and any BTC residual already prevent a new pair.

Before a new preparation, reserve its entire maximum BUY USDT debit against the
remaining cash-loss allowance. This conservative check does not rely on expected
SELL proceeds: in this model the SELL USDT fee cannot exceed that fill's received
USDT. This is a native-USDT cash constraint under the settlement assumptions,
**not a guarantee of total financial loss or profit**. BTC/MX valuation, opening
cost basis, market repricing and real exchange execution are outside it. MX and
BTC fee budgets remain separate native-asset limits, without a conversion price.
Unused fee/buy reserves become available only through validated terminal proof;
actual incurred fees and closed cash losses remain in session usage.

Risk checks only block new preparation. Already observed fill, unknown, reconcile
and settle events still go through the settlement engine even when a subsequent
preparation would fail risk checks. The original caps and exact reconciliation
rules still apply; invalid facts are not silently accepted. Exact duplicate
preparation is a no-op and does not create another reservation.

## API and reproducible scenario

`src/paper-pair/risk.ts` provides `createPaperRiskState`,
`assessPaperPairRisk`, `applyPaperRiskEvent`, `replayPaperRiskJournal` and
`viewPaperRiskState`. State must come from these constructors/replay functions
and must not be edited directly. The parsed policy is cloned and frozen. The
view records the policy and its canonical SHA256; a diagnostic decision is only
about the supplied state and must never be cached as an execution authorization.

```sh
npm run lab:pair-risk -- fixtures/pair-risk/session-cash-stop.json /tmp/pair-risk-cash
npm run lab:pair-risk -- fixtures/pair-risk/venue-depletion.json /tmp/pair-risk-wallets
npm run lab:pair-risk -- fixtures/pair-risk/quote-budget-exposure.json /tmp/pair-risk-budget
```

Use a new output directory each time. Input is at most 128 KiB, with at most
2,000 history events and 20 independent proposed preparations. One fixed policy
is replayed over the complete history: a historical violation rejects the input.
Every probe starts from the same final state; probes are comparisons, not a
sequence of executed/reserved pairs. The report is bounded at 2 MiB in a new
0700 directory with 0600 files. stdout reports only fixed metadata, counts and
hashes; arbitrary error text, amounts and identifiers are not printed.

The synthetic fixtures demonstrate:

- `session-cash-stop`: a completed cash loss of 0.01344 USDT leaves insufficient
  room for another 9 USDT BUY debit under the invented 9.01 USDT session cap.
  A separate 8.99 debit probe fits. This is an admission comparison, not evidence
  that the smaller quote ceiling can fill the requested BTC quantity.
- `venue-depletion`: two completed pairs have positive cash deltas, but another
  pair would reduce free OKX USDT below its floor. The aggregate funds across
  exchanges do not make that preparation admissible.
- `quote-budget-exposure`: even with sufficient funds, an unbounded BTC quantity
  prevents admission.

## Remaining integration boundary

The [schema 2 risk journal](PAIR-RISK-JOURNAL.md) now persists the policy in its
manifest, binds its hash in each event, replays historical admission checks and
requires an expected identity/policy/revision/head checkpoint for new publication.
The old schema 1 format is unchanged and cannot append to a risk journal.
A trusted external checkpoint is still necessary to detect suffix rollback;
a hash alone is not proof of freshness or authorization to change limits.
The standalone scenario runner remains useful for independent comparisons.

This preparation does not enable real trading. Remaining work includes completed
study acceptance, exchange contract answers, nonempty recorded execution/cash
acceptance and an explicit decision on real operating limits. A daily reset,
price-based P/L stop, corrective trades, transfers and concurrent pairs are not
implemented by this module.

## Local validation

On 26 September 2026, all 49 new risk/CLI tests passed. The complete repository
suite passed 1,664 tests, with 15 existing PostgreSQL-dependent skips. API build,
strict TypeScript for the new test files, and diff checks passed. Independent
review found no blocking issue within this explicitly offline scope.

Coverage includes 18-decimal boundary crossings, fees on both legs, venue-specific
USDT/BTC/MX depletion, partial/unknown reconciliation, duplicate delivery, later
profit across UTC midnight without loss-budget reset, fixed-policy replay,
malformed/oversized inputs, private output and no-overwrite/fixed-error behavior.
The three committed synthetic fixtures also passed separate Python Decimal
assertions; source and compiled CLI reports were byte-identical. Their report
hashes are retained in [checks](evidence/pair-risk-20260926/checks.json).

A read-only progress check during this work returned 92/1,440 day-study samples,
`appUnchanged=true` and `isolationVerified=true`. This is progress, not completed
study acceptance. No application deployment, observer change, live action,
account request, transfer or source publication was performed for this module.
Shared memory search was reachable but returned no relevant project context;
source documentation supplied the implementation context.
