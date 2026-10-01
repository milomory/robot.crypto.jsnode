# Recorded-order audit boundary

The offline decoder now checks the MEXC/OKX BTC/USDT order and fill formats
before a selected paper leg can be reconciled. All acceptance fixtures in this
decoder acceptance are **synthetic**. The later separate
[protected capture](EXECUTION-HISTORY.md) has now run on Hyperion; its selected
window had no executions, so nonzero live-order reconciliation remains pending.

The existing dashboard operations feed is a bounded presentation projection.
It drops source order/trade identity, and OKX quote amounts are computed from
price and size. A feed with fewer than 100 rows does not prove complete history.
The new audit therefore consumes separate order/fill records instead.

## Run locally

```bash
mkdir -p output/execution-audit-demo
npm run lab:order-audit -- fixtures/execution-audit/mexc-partial-cancel.json output/execution-audit-demo/mexc
npm run lab:order-audit -- fixtures/execution-audit/okx-derived-quote.json output/execution-audit-demo/okx
```

Input must be a regular, non-symlink JSON file of at most 128 KiB. Each output
directory must be new. The report is created exclusively in a private directory;
existing files are preserved. CLI stdout contains only venue, declared source,
counts, blocker codes and a normalized-content hash. Raw order/trade IDs and
upstream extra fields are removed from the report. Reports still contain private
financial facts if a future producer supplies real records, so they must remain
outside Git. Only synthetic evidence is committed here.

The input envelope is `schema:1`, `kind:recorded-order-audit`,
`source:synthetic|recorded`, `account:main`, `venue:mexc|okx`, `observedAt`,
`expected:{orderId,side}`, requested `limit`, `orderBefore`, `orderAfter`, `fills`.
MEXC responses are an order object and trade array; OKX responses preserve the
`code:"0"` / `data` envelope. Before/after snapshots bracket fill collection in
the future trusted producer. This offline file reader cannot verify their
provenance or collection sequence. `source:recorded` is a declaration, not proof
of an authenticated capture; `captureProvenanceVerified` is always false.

## Shared validation

- Bind every record to BTC/USDT, the selected venue/main account, expected order
  ID and side. IDs are strings or exactly representable safe integers; unsafe
  numeric IDs are rejected. Stable hashed keys include venue, main-account scope,
  symbol and upstream identity. Separate subaccounts are unsupported.
- Preserve decimal strings exactly and normalize equivalent representations.
  Numeric monetary values, unsupported fee assets, negative MEXC fees, rebates
  and more than 18 fractional digits are rejected without rounding. The latter
  is a real supported-precision boundary, not a claim about exchange precision.
- Validate order/fill times and compare the relevant order fields before/after.
  An order change, nonterminal state, capped response or total mismatch blocks
  settlement. Only one bounded response is accepted (MEXC at most 1,000 rows,
  OKX 100); pagination is not implemented. A full page stays blocked even if
  its totals happen to match. File-size limits may be reached earlier.
- Deduplicate normalized records by order/trade identity; changed price, amount,
  fee or timestamp is a conflict. OKX bill/trade identity must also be consistent.
  Raw extra fields are discarded and cannot be echoed in errors.
- Compare the sum of unique fills with order totals. An uncapped response alone
  is insufficient. These checks establish consistency of supplied records,
  not exchange-authenticated completeness of the entire account history.

## MEXC: reported quote amounts

The [current query-order contract][mexc-order] reports `Qty`, `executedQty` and
`cumulativeQuoteQty`. [All Orders][mexc-all] and older official formats differ:
the adapter explicitly accepts `origQty` and `cummulativeQuoteQty` aliases too.
If both forms appear, their values must agree. LIMIT and MARKET SELL quantities
must be positive and bound executed base; a FILLED order must reach its target.
MARKET BUY base sizing is not inferred from its quote budget.

Each [trade][mexc-trades] supplies its own `qty`, `quoteQty`, `commission` and
`commissionAsset`. The audit sums reported quote, without replacing it by
price times quantity, and compares both base and quote order totals. Positive
commissions are preserved by asset. Query-order has no aggregate fee total;
`feeTotalMatches:null` reflects that missing independent check.

`NEW` and `PARTIALLY_FILLED` remain pending. `FILLED`, `CANCELED` and
`PARTIALLY_CANCELED` map to terminal accounting outcomes, preserving partial
fills. Unsupported status values fail instead of borrowing Binance semantics.
Order lookup is documented for seven days; trade history for the last month.
The trade endpoint has an optional orderId but no documented cursor. A future
collector must preserve scope/retention evidence and must not silently stitch
an incomplete window into a complete result.

The official [account-deals example][mexc-deals] even contains a fee with 19
fractional digits. This version rejects such a record explicitly. Supporting
higher precision requires extending the settlement contract, not trimming it.
Fee corrections and rebates after a terminal record are also unsupported.

## OKX: derived quote remains blocked

The [order][okx-order] supplies `accFillSz` and `avgPx`;
[fills][okx-fills] / [fills-history][okx-history] supply `fillSz`, `fillPx` and
signed `fee`/`feeCcy`. These responses do not report a separate gross quote
amount. The audit shows exact decimal `fillSz × fillPx` as
`quoteSource:derived-price-times-size`; it does not substitute an average-price
calculation or present this as a reported monetary debit.

This version accepts ordinary cash SPOT BTC-USDT taker fills only. It checks
`category:normal`, `execType:T`, side/subType, order size/target-currency snapshot
stability and an explicit USDT trade quote when supplied. Negative fees become
positive ledger costs; a positive fee/rebate is unsupported. A documented empty
order rebate means no rebate. Fees are compared by asset with the order total.
Nonzero taker BUY fees must be BTC or USDT; SELL fees must be USDT. The same
check applies to order snapshots and fills. Optional fill `tradeQuoteCcy` must
be USDT and is preserved through the private projection. Different maker/rebate
currencies and system/margin/block/conversion flows are outside this contract.
The later [cash comparison](CASH-AUDIT.md) can expose net-movement discrepancies
but cannot replace the missing reported gross quote.

Every nonzero OKX execution retains `quote-amount-not-reported`, even when base
and fee totals agree. Only a zero-execution terminal cancellation can be ready
without an additional quote source. `avgPx × accFillSz` is not used to bypass
this requirement. OKX cursor pagination uses billId and its time filter uses
ts, not fillTime; the current offline boundary does not claim to paginate it.

## Paper integration and evidence

`executionOrderKey(venue, orderId)` gives the stable key for an explicitly
selected paper plan. `reconcileRecordedOrder(state, pairId, eventId, input)`
audits first, then verifies venue/side/order binding and submits one atomic
reconciliation event. The target leg must already be unknown; the decoder never
creates a plan or chooses which manual activity belongs to the robot. Existing
fee/quantity caps, balances, monotonic event time and the 200-fill reconcile
limit still apply. A failed audit or ledger transition leaves state unchanged.
`settlementReady` means the audit checks passed, not that every paper-plan
constraint has passed or that a live order is authorized.

[Acceptance evidence](evidence/execution-audit-20260926/acceptance.json) covers:
MEXC partial cancellation with mixed USDT/MX fees and a duplicate; missing-fill
rejection; OKX computed-quote quarantine; and zero-execution cancellation.
None of these cases is a real trade, balance or profitability result.

Validation: **70 new tests**, full suite **1,205 passed / 15 existing PostgreSQL
tests skipped**. API compilation and separate strict typing of the new test file
passed. Independent review findings on original quantity, duplicate price and
OKX snapshot fields were fixed and covered. CLI checks confirm extra/private
fields and raw IDs are removed and existing reports are preserved; see
[check results](evidence/execution-audit-20260926/checks.json) and
[report safety](evidence/execution-audit-20260926/report-safety.json).

Private operational acceptance is omitted from this review snapshot.

## Next integration boundary

A separate [protected GET producer](EXECUTION-HISTORY.md) now captures request
and receipt metadata, preserves decimals, brackets order fills and enforces
retention/pagination bounds. Its first window was empty. The regular observer
and its dashboard projection remain separate from this capture.
The official [account bills contract][okx-bills] was also reviewed. It supplies
order/trade/currency linkage and signed balance changes, but the reviewed text
does not establish a universal gross-quote formula or the number of currency
bills per cash fill. Its request has no orderId/tradeId filter; page results
would need local binding. No formula from its isolated-margin example is
promoted to a cash-account rule. The missing evidence must be resolved through
a documented cash contract and/or an explicitly scoped comparison with original
account records before this blocker can be removed. The separate MEXC quantity-step,
quote-budget and rounding questions remain [on clarification](MEXC-EXECUTION-CONTRACT-QUESTIONS.md).

[mexc-order]: https://www.mexc.com/api-docs/spot-v3/spot-account-trade/query-order
[mexc-all]: https://www.mexc.com/api-docs/spot-v3/spot-account-trade/all-orders
[mexc-trades]: https://www.mexc.com/api-docs/spot-v3/spot-account-trade/account-trade-list
[mexc-deals]: https://www.mexc.com/api-docs/spot-v3/websocket-user-data-streams/spot-account-deals
[okx-order]: https://www.okx.com/docs-v5/en/#order-book-trading-trade-get-order-details
[okx-fills]: https://www.okx.com/docs-v5/en/#order-book-trading-trade-get-transaction-details-last-3-days
[okx-history]: https://www.okx.com/docs-v5/en/#order-book-trading-trade-get-transaction-details-last-3-months

[okx-bills]: https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-bills-details-last-7-days
