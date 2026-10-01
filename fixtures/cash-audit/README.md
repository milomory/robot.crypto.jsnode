# Synthetic cash comparison examples

These records are invented test data, not captured exchange responses.

`okx-cash-illustrative.json` wraps the existing synthetic execution-audit example and invents two currency bill rows for each fill. This is an illustrative comparison case, **not evidence that OKX emits two bills per trade**, nor a verified definition of how spot `balChg`, `fee`, and `ccy` relate. Matching the derived model must never prove gross quote or remove the existing settlement blocker. The fixture uses visibly synthetic order, trade, and bill IDs.

`mexc-reported-partial-cancel.json` wraps the existing synthetic partial cancellation with duplicate fill delivery and costs in USDT and MX. Its expected deltas use reported `quoteQty`; no balance bills are supplied.
