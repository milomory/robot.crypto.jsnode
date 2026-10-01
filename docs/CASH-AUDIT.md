# Selected-order cash comparison

This offline check compares a selected order's execution amounts with supplied
OKX cash bills. It does not fetch accounts, place orders, change the observer or
post money to the paper journal. The protected history collector now invokes this check for supported selected
orders; see the later [integration acceptance](EXECUTION-HISTORY.md#cash-comparison-integration--26-september-2026).
The standalone CLI remains offline.

## What the source review established

OKX's [spot fee option announcement][okx-fees] distinguishes two ordinary taker
BUY cases: commission in received BTC, or additional commission in spent USDT.
SELL commission is deducted from received USDT. The implementation now rejects
other nonzero fee currencies for this narrow contract, both in order snapshots
and individual fills. Zero fees retain compatibility. Historical fee currency
comes from the execution, never today's account setting.

The [fills API][okx-fills] gives signed `fee` and `feeCcy`. The protected
projection now preserves optional `tradeQuoteCcy`; if supplied, the order audit
requires USDT. The field participates in duplicate conflict detection.

The [bills API][okx-bills] defines `balChg` as signed balance change in `ccy`.
However, the reviewed contract does not establish a general gross-quote formula,
the currency of bill `fee` independently, a fixed number of cash rows per fill,
or cash rounding. `sz` is not promoted to reported gross quote. A bill's `fee`
is not added to or subtracted from `balChg` again.

MEXC's [exchange information][mexc-info] still distinguishes minimum quantity
from asset precision without supplying a documented quantity increment in the
reviewed BTCUSDT response. The [new-order contract][mexc-order] does not resolve
fee inclusion in `quoteOrderQty` or rounding. Existing guards remain; see the
[precise outstanding questions](MEXC-EXECUTION-CONTRACT-QUESTIONS.md). No exchange
support message or order validation request was sent.

## Run locally

```bash
npm run lab:cash-audit -- fixtures/cash-audit/okx-cash-illustrative.json output/cash-audit-example
```

The source file must be a regular non-symlink JSON file, at most 128 KiB; the
output directory must be new. The directory is private and its `report.json`
is written exclusively. Stdout contains counts, fixed status/blocker codes and
a normalized report hash, not monetary amounts, raw IDs, input paths or upstream
extra fields. Existing files are never overwritten. Actual financial reports
must stay outside Git; repository fixtures and acceptance reports are synthetic.

`auditOrderCash(input)` accepts `schema:1`, `kind:order-cash-audit`, and `order`
containing the existing [recorded-order audit](EXECUTION-AUDIT.md) envelope.
OKX may also supply `bills:{window:{from,to},limit,rows}` for that selected order.
MEXC must not supply OKX bills. Unsupported records fail with fixed error codes.

## Arithmetic and evidence

All calculations use integers scaled to 36 fractional places; no floating-point
money or rounding is used. Inputs retain the underlying order audit's 18-place
limit; multiplying two such values preserves up to 36 places exactly. Bill
amounts support up to 18 fractional places and reject greater precision.

For each asset, expected movement is the execution's gross movement minus its
reported positive commission cost. Thus a BUY adds gross BTC and subtracts
quote; a SELL subtracts gross BTC and adds quote. The fee is deducted in its
reported asset. MEXC gross quote comes from each `quoteQty`; OKX quote remains
a separately labelled `fillPx × fillSz` calculation. Neither venue uses a
current tariff to reconstruct past fees. If the underlying order evidence is
incomplete or inconsistent, `expectedNet` is null with an explicit cash blocker;
missing fills are not displayed as a zero movement.

For OKX, the comparison accepts only BTC-USDT cash SPOT taker trade bills:
`type=2`, matching buy/sell subtype, `mgnMode=cash`, `execType=T`, BTC/USDT
currency, and exact order/trade binding. Every bill must lie within its stated
window and after its execution. A supplied `fillTime` must match the execution.
If a bill ID also appears in fills, its trade binding must agree.

Normalized identical bill IDs count once. A changed amount, fee, timestamp or
other supported field under that ID fails. A different ID is retained as a
different bill; matching financial values never justify deleting a real record.
Optional `sz`/`bal` are checked for duplicate conflicts but are not used in the
cash formula. Unknown upstream fields and raw identities do not enter output.

The diagnostic comparison requires an uncapped page, a window covering the
order, structurally consistent terminal order evidence, and BTC plus USDT bill
coverage for every supplied execution. This coverage rule is a requirement of
our comparison, **not a claim that OKX emits two bills per fill**. Missing rows
or assets leave `reportedNet` and `difference` null. An empty history never
becomes affirmative corroboration. The current check supports one page up to
100 rows; a full page remains incomplete.

When prerequisites hold:

- `reportedNet` sums the supplied unique bills' `balChg` by currency.
- `difference = reportedNet − expectedNet` retains the exact signed residual.
- `matches-model` means the supplied amounts agree with the economic model.
- `differs-from-model` exposes a discrepancy for investigation.

Even zero residual does not prove complete history, authenticated provenance,
fee interpretation, or exchange-reported gross quote. The OKX blockers
`cash-bill-contract-unconfirmed`, `bill-fee-currency-unconfirmed` and existing
`quote-amount-not-reported` remain. `settlementReady` is inherited unchanged from
the order audit; the cash comparison cannot authorize reconciliation. Zero-fill
terminal cancellations retain the existing order-audit behavior but have no
cash movement to corroborate. MEXC's reported amount projection has no independent
bill comparison in this version.

## Acceptance

The full suite passed **1,549 tests**, with 15 existing PostgreSQL-dependent
cases skipped and no failures. This change adds 99 cash-audit cases and 37
quote/fee-contract cases. API compilation and separate strict test typing passed.
Independent Python Decimal arithmetic matched both synthetic reports, including
signed movements and exact residuals. File and CLI tests verify private modes,
non-overwrite behavior, safe errors and absence of raw identities or amounts in
stdout. Review caught a misleading expected zero for missing fills; it now
returns null with an explicit blocker.

[Acceptance evidence](evidence/cash-audit-20260926) contains only synthetic
financial data and public/source-check metadata. The original offline step read no real archives and made no private exchange
call, deployment or trade. The later protected integration is documented separately.

## Remaining boundary

The previous protected six-day BTC/USDT capture had no executions. Current
acceptance therefore uses invented fills and bills, with explicit fixture
provenance. No trade is created to manufacture evidence.

Before nonzero OKX settlement, resolve the cash-bill gross/net/fee contract and
verify it against applicable captured records. The [specific support questions](OKX-CASH-CONTRACT-QUESTIONS.md)
are prepared locally and have not been sent. MEXC future-order sizing still
needs its documented quantity step, API quote-budget semantics and fee rounding.
These unknowns do not prevent collecting existing account data; they prevent
presenting assumed execution rules as confirmed ones.

[okx-fees]: https://www.okx.com/help/okx-to-introduce-spot-fee-payment-option-in-quote-currency
[okx-fills]: https://app.okx.com/docs-v5/en/#order-book-trading-trade-get-transaction-details-last-3-months
[okx-bills]: https://app.okx.com/docs-v5/en/#trading-account-rest-api-get-bills-details-last-7-days
[mexc-info]: https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/exchange-information
[mexc-order]: https://www.mexc.com/api-docs/spot-v3/spot-account-trade/new-order
