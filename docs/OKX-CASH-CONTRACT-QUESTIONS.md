# OKX: exact cash settlement questions

Prepared 26 September 2026. Local draft only; no support message has been sent.
Scope: main account, ordinary cash SPOT BTC-USDT taker fills, no margin, rebates,
liquidation, conversion, orders or account-setting changes.

## Paste-ready support request

We are reconciling existing BTC-USDT cash SPOT taker executions read-only through
`GET /api/v5/trade/fills-history`, order details, and
`GET /api/v5/account/bills`. We need a documented exact monetary contract rather
than an assumption based on `fillPx * fillSz`.

1. For one ordinary cash fill, what account-bill records are returned for BTC
   and USDT? Is one bill per currency guaranteed, or can a fill produce a
   combined record, separate fee record, several rows or delayed corrections?
   Which IDs link all such records to the execution?
2. Does `balChg` include the commission for that record? What is the unit of
   bill `fee` when there is no `feeCcy` field? Is it always `ccy`, or determined
   by another field or account fee setting? Please distinguish buy fees in BTC,
   buy fees in USDT and sell fees in USDT.
3. Does `sz` in each cash bill represent gross or net asset movement? Which
   endpoint/field gives exact gross quote consideration independently from the
   rounded display price? Please provide BUY and SELL examples showing the
   exact relationship among `sz`, `balChg`, `fee`, `ccy`, `tradeId` and `ordId`.
4. What decimal precision and rounding apply to quote consideration and fees?
   Is rounding applied per fill or after aggregation? Can multiplication of
   reported `fillPx` and `fillSz` differ from the actual quote balance movement?
5. What establishes that all currency and fee records for a terminal order
   have arrived? Can bill or fee corrections appear after its terminal state,
   and how should a read-only client recognize them?

Please link the applicable API contract and its effective date. Anonymized
examples are sufficient; no account credentials or real account/order IDs are
included in this request.

## Why it remains open

The [fee option notice][fees] explains economic fee directions.
The [bills contract][bills] describes signed balance change in `ccy`, but the
reviewed text does not resolve the full mapping above. An isolated-margin
example cannot establish a cash rule.

The [offline comparison](CASH-AUDIT.md) already detects differences between
supplied net movements and a clearly labelled price-times-size model. Matching
values remain diagnostic; they do not remove the existing nonzero OKX
settlement blocker. No extra keys are needed for this clarification.

[fees]: https://www.okx.com/help/okx-to-introduce-spot-fee-payment-option-in-quote-currency
[bills]: https://app.okx.com/docs-v5/en/#trading-account-rest-api-get-bills-details-last-7-days
