# First Hyperion market campaign: result and next step

Verified 2026-09-21. **The bounded collection and report acceptance passed.**
The next useful implementation is an isolated offline paper-v2 ledger, not
additional exchange accounts. No account keys are needed for that stage.

## Source and scope

Run `a43cc042-9fee-424b-87ba-b44457b16b7c`, deployed code `386ee2c`, Hyperion.
BTC/USDT, 0.0001 BTC, 30 scheduled observations one minute apart.
Period: 2026-09-20 07:05:59.214–07:35:00.152 UTC
(09:05:59.214–09:35:00.152 Europe/Amsterdam). The collector stopped itself,
exit 0, before its 30-minute deadline; no restart or writer lock remains.

Raw evidence: `/home/mil/crypto-market-observations/store/runs/a43cc042-9fee-424b-87ba-b44457b16b7c`.
Grain: one run/sequence/venue book; each sequence yields six directional
comparisons. These comparisons share snapshots and are not independent trades.

## Measured quality

| Check | Result |
| --- | --- |
| Saved snapshots / planned | 30 / 30 |
| Missing sequences / duplicate book keys | 0 / 0 |
| Fresh books at comparison / expected books | 90 / 90 |
| Source failures | 0 |
| Valid directional comparisons / possible comparisons | 180 / 180 |
| Comparisons passing public instrument-size checks | 180 / 180 |
| Rejected comparisons | 0 |
| Positive comparisons after assumed costs | 0 / 180 |
| Longest start-to-start gap | 60.086 seconds |
| Largest pair observation window | 1.753 seconds, within the 2-second limit |

All 32 copied files (manifest, collection state, 30 samples) matched their
Hyperion SHA256 hashes. The existing validators accepted the saved books and
instrument rules; offline reconstruction matched the deployed API report exactly.

| Venue | Fresh books | Request duration median / p95 / max | Source timestamp |
| --- | --- | --- | --- |
| Binance | 30 / 30 | 914.5 / 1722 / 1753 ms | Absent in all 30 |
| Bybit | 30 / 30 | 273.5 / 387 / 407 ms | Present in all 30 |
| OKX | 30 / 30 | 397 / 505 / 527 ms | Present in all 30 |

P95 uses nearest rank over 30 observations. The first interval is 58.326 seconds
because metadata retrieval precedes the first sample while subsequent starts
follow the original schedule. There is no missing minute or catch-up burst.

## Interpretation and limits

All comparisons were negative after the declared illustrative costs:
10 bps fee plus 5 bps adverse slippage **per leg**. Best: -28.0463 bps
(-0.280463%); worst: -31.8771 bps (-0.318771%). These are estimates for the
sampled quantity, not incurred losses or a measured trading P/L.

- **High confidence, functional pass:** complete, unique, schema-valid evidence
  with deterministic reconstruction. Suitable for testing collection and reports.
- **High limitation for execution claims:** Binance is receipt-only; the source
  freshness of its matching engine cannot be checked. Bybit/OKX source timestamps
  also depend on unverified cross-host clock differences. No simultaneous fills
  are established. Keep these distinctions visible; do not weaken freshness rules.
- **High limitation for return estimates:** one short BTC period has no multi-day,
  market-regime or other-symbol coverage. Costs are assumptions; actual tariffs,
  balances, funding and rebalancing are unverified. Do not infer sustainable
  profitability or general unprofitability from this series.
- **Next accounting constraint:** archived prices/quantities are JSON numbers.
  Exact ledger work must begin with decimal-string fixtures and preserve source
  decimals in a future observation format. Floating-point diagnostic output is
  not authoritative account posting input.

Proceed with [the offline paper-v2 plan](PAPER-V2-PLAN.md): exact amounts,
explicit synthetic starting funds, fees, positions, equity including open
positions and reconciliation. Compare strategies only after accounting checks
pass. A worker and its separate data namespace/rollback remain a later gate.

## Evidence and reproduction

- [Server acceptance and source file hashes](evidence/market-campaign-20260920/acceptance.json).
- [Derived quality measurements](evidence/market-campaign-20260920/quality.json).
- [Executed analysis notebook](evidence/market-campaign-20260920/quality.ipynb):
  three code cells passed; Python standard library plus existing Node dependencies.
  Set `CRYPTO_OBSERVATION_RUN_DIR` to a copy of the raw run, then execute from
  this checkout. It reads evidence and runs the existing offline report command;
  it performs no public/private network requests or trading actions.
- [Rollout, storage policy and rollback](MARKET-CAMPAIGN.md).

The raw run remains in the managed store under its documented retention policy;
no raw order books or credentials were added to Git. The existing paper worker,
live lock, Auth and shared trading-control were not changed during this review.
No application redeployment is needed for these documentation/evidence changes.

Private inventory follow-up: Hyperion's public-only collector location, managed
data directory and verified stopped state should be reflected in the Mac-side
server inventory. No credentials/access methods changed. The current Mac owner
route is unverified here: `System-Admin/CHAT-AGENTS.md` requires live Mac task
verification, and the Athena fallback cannot supply it. No handoff was sent.
