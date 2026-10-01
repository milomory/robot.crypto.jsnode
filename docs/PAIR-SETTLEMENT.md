# Exact paired settlement accounting

This is a separate **offline synthetic ledger**, not an exchange order adapter.
It records supplied executions and their final fees for the MEXC/OKX BTC/USDT
pair. It does not place orders, observe accounts, decide whether a trade is
profitable, prove exchange admission, or change the running paper robot.

The historical quote-based engine and its accepted/diagnostic reports are
unchanged. Their tariff and rounding assumptions are not silently promoted to
facts. The new ledger deliberately permits synthetic losing/failure cases so
accounting can be checked independently from a future strategy decision.

## Run locally

```bash
mkdir -p output/pair-settlement-20260926
npm run lab:pair-settlement -- fixtures/pair-settlement/btc-fee-reconciliation.json output/pair-settlement-20260926/btc-fee-reconciliation
npm run lab:pair-settlement -- fixtures/pair-settlement/quote-budget-partial-cancel.json output/pair-settlement-20260926/quote-budget-partial-cancel
npm run lab:pair-settlement -- fixtures/pair-settlement/equal-gross-residual.json output/pair-settlement-20260926/equal-gross-residual
```

Every output directory must be new; existing reports are preserved. The input
is a regular non-symlink JSON file, at most 128 KiB. Output is a private directory
and an exclusive `report.json` containing the input hash, normalized journal,
final wallets and deterministic replay result. No credentials or network access
are needed. Repeating a run requires a different output directory.

## Explicit execution facts

`src/paper-pair/settlement.ts` exports `createSettlementState`,
`applySettlementEvent`, `replaySettlementJournal` and `viewSettlementState`.
Amounts are nonnegative decimal strings, up to 20 integer and 18 fractional
digits. Internal arithmetic uses scaled integers; there is no floating-point
fee calculation or implicit rounding.

Each opening wallet, fee cap and fill fee contains all three fields
`{ BTC, USDT, MX }`, including explicit zeroes. Each fill includes `fillId`,
`executedAt`, gross `baseQuantity`, gross `quoteQuantity` and the **final exact
fee amount in each asset**. The ledger never infers a fee from a tariff, never
values MX as USDT and rejects missing/unknown fee fields.

A future exchange decoder must bind the venue/order, normalize identifiers and
decimal representations consistently, prove the fill list is complete, and
supply final fees. The separate [recorded-order audit](EXECUTION-AUDIT.md) now handles a narrow
MEXC/OKX response contract; the first [protected capture](EXECUTION-HISTORY.md)
was empty, so real nonzero execution acceptance remains pending. Payload-aware
deduplication treats different representations as different payloads, even if
their decimal values are equal. Negative fees/rebates and corrections after a
terminal result are unsupported and must be investigated rather than dropped.

## Wallets and reserves

The buy and sell legs have distinct venues and separately funded wallets.
There is no automatic borrowing, conversion or transfer between venues.

| Leg | Preparation reserve | Recorded fill movement |
| --- | --- | --- |
| BUY | Gross USDT cap + USDT fee cap; MX fee cap | BTC increases by gross base minus BTC fee; USDT decreases by gross quote plus USDT fee; MX fee is debited |
| SELL | Gross BTC cap + BTC fee cap; MX fee cap | BTC decreases by gross base plus BTC fee; USDT increases by gross quote minus USDT fee; MX fee is debited |

Fees deducted from a received asset must not exceed that fill's received
amount. Other fee currencies need funds in that venue's wallet. A partial fill
reduces the remaining reserve by the exact amount consumed; a timeout does not
release it. Caps cannot be exceeded and balances/free funds cannot be negative.

A BUY plan can specify a base target with a gross quote ceiling, or a gross
quote budget. SELL specifies a base target. These are **internal accounting
limits**, not a claim that MEXC `quoteOrderQty` excludes or includes fees. A
quote-budget terminal fill may leave unused budget only when the supplied
terminal result and all totals agree; spending the entire cap is not inferred.

## Event lifecycle

1. `prepare` records the two plans and reserves funds. It is an accounting
   event, not permission to submit an order.
2. `fill` records a final-fee execution. Quantity reaching its target alone does
   not prove terminal status or release the remaining reserve.
3. `unknown` preserves the remaining reserve and prevents ordinary settlement
   or new fills until an explicit reconciliation.
4. `reconcile` is accepted only for an unknown leg. It atomically adds any
   missing fills, compares cumulative base/quote/fees, then records an open or
   terminal result. A failed comparison leaves the prior state untouched.
5. `settle` records `filled`, `cancelled` or `rejected` only when supplied totals
   equal all recorded fills and fees. Rejected orders cannot contain fills.
   Base-sized filled orders must reach the full base target. Partial cancelled
   orders retain their actual executions and release only unused reserves.

Observed event times cannot move backwards. Execution times must lie between
preparation and observation; reconciliation may supply a late report of an
older execution. Event IDs bind the entire payload. Repeating an identical
event is a no-op; repeating a fill under another event ID adds an audit event
without posting money again, including after terminal settlement. Conflicting
payloads fail. Fill IDs are scoped to a leg/order; order IDs to a venue.

The journal is bounded by 2,000 events, 2,000 distinct fills and 1 MiB of
canonical journal JSON; each reconciliation contains at most 200 fills. State
is changed by immutable transitions and is reconstructed from opening balances
plus the journal. Callers must not directly edit returned state internals.

## Residual exposure and displayed results

The BTC residual is bought gross BTC minus sold gross BTC minus **all BTC
fees on both legs**. Equal gross quantities can therefore leave a shortage.
A new pair is blocked until both previous legs are terminal and this residual
is zero. The current version does not implement a corrective trade or transfer.

`cashDeltaUsdt` is sale quote less buy quote and USDT fees. It is **not P/L**:
BTC/MX fees are reported separately, initial cost basis is absent, and a
residual may remain. `balanced` means both legs are terminal with zero net BTC
change; it says nothing about profitability or restoring each venue's starting
inventory. Rejecting both legs with no fills can also be balanced.

## Synthetic acceptance cases

| Fixture | Expected result |
| --- | --- |
| `btc-fee-reconciliation` | Partial OKX BUY, unknown outcome, delayed reconciliation and duplicate delivery; net BTC balanced after explicit BTC fee; USDT cash delta −0.01344 |
| `quote-budget-partial-cancel` | Two MEXC BUY fills with USDT/MX fees, partial cancellation on both legs; BTC balanced; USDT cash delta −0.01545 and MX fee 0.0007 remain separate |
| `equal-gross-residual` | Equal gross BTC on both legs leaves BTC −0.0000001 after the buy fee; next pair blocked despite zero USDT cash delta |

These amounts are invented test inputs, not account balances or observed
trading results. Acceptance evidence is stored in
[evidence/pair-settlement-20260926](evidence/pair-settlement-20260926).

Validation on 26 September: 52 new tests; full suite **1,135 passed, 15 existing
PostgreSQL-dependent tests skipped**. API TypeScript compilation passed. A
separate Python Decimal check (100-digit precision) verified every final wallet,
per-asset conservation and reserve release for the three fixtures. An independent
review exercised mixed-asset fees and atomic reconciliation. Historical five-
and thirty-minute diagnostic reports reproduced byte-identically; see
[check results](evidence/pair-settlement-20260926/checks.json) and
[historical hashes](evidence/pair-settlement-20260926/historical-regression.json).

## Local persistence

The [durable offline journal](PAIR-SETTLEMENT-JOURNAL.md) now persists validated
events individually and reconstructs state after a process interruption.
It remains separate from production execution and the running public study.

## Remaining boundary

The [MEXC contract review](MEXC-EXECUTION-CONTRACT-QUESTIONS.md) now has primary
source support for ordinary BUY fees in quote currency and a separate fee
reserve. The numeric BTCUSDT quantity increment, API quote-budget treatment and
fee rounding remain on clarification. The local support draft has not been sent.

The [offline decoder/reconciliation boundary](EXECUTION-AUDIT.md) is implemented
with synthetic acceptance. A separate protected capture is implemented but its
first window was empty. Next are nonzero order-record acceptance, independent
OKX quote evidence, and sizing against confirmed exchange rules. Connecting
this journal to an execution decision requires those contracts; it does not
follow from passing the synthetic tests. The earlier 30-minute capture remains
diagnostic, with no positive cost-adjusted comparisons in its eligible samples.
