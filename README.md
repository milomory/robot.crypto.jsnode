# robot.crypto.jsnode

Standalone crypto trading robot MVP.

The [longer delivery roadmap](docs/ROADMAP.md) records completed work, the current
protected recovery/identity stage and the gates before a limited real launch.

The dashboard separates real account history from the simulator;
[Earn accounting and live preparation](docs/EARN-ACCOUNTING.md) describe their limits.

Private Bybit/OKX/HitBTC/MEXC account readers and key-vault preparation:
[account integration status](docs/EXCHANGE-ACCOUNTS.md).
MEXC/OKX recurring read-only observation is active on Hyperion:
[scope, acceptance and rollback](docs/PAIR-OBSERVER.md).

The current implementation is intentionally paper-only:

- Node.js + TypeScript
- Fastify API
- React/Vite operator dashboard
- Postgres journal/accounting
- public Binance spot market data with seed fallback
- optional Binance read-only account connector (disabled by default; see `docs/BINANCE-READONLY.md`)
- paper exchange execution
- risk budget and risk-event log
- live trading locked by default
- optional Auth Core read-only SSO (disabled by default; local review and rollout gates in [docs/AUTH-CORE-INTEGRATION-REVIEW.md](docs/AUTH-CORE-INTEGRATION-REVIEW.md))

No T-Invest SDK, FIGI model, or broker account logic is used here.

## Current research architecture

The legacy directional simulator remains separate from the newer exact spot pair
ledger and recovery workflow. The [current module map](docs/ARCHITECTURE.md)
identifies their boundaries; the spot pair layer is already implemented.
A new [public derivatives D0a capture](docs/DERIVATIVES-PUBLIC-D0.md) reads BTC/ETH
contract specifications and funding forecasts on MEXC/OKX without keys. The
[funding/basis roadmap](docs/DERIVATIVES-OPPORTUNITY-PLAN.md) keeps public observation,
funding event accounting, hedged simulation and private readiness separate.
The [D0b observation/replay profile](docs/DERIVATIVES-PUBLIC-D0B.md) adds books,
mark/index/OI and historical funding. The full 24-read capture and replay passed.
A separate [MEXC WS source-time probe](docs/DERIVATIVES-MEXC-DEPTH-SOURCE.md) verifies
matching-engine timestamps. [BTC/ETH book reconstruction](docs/DERIVATIVES-MEXC-BOOK.md)
now joins fresh snapshots and continuous deltas into verified top50. A separate
[joint Spot/perpetual capture](docs/DERIVATIVES-JOINT-BOOKS.md) adds common-time
quality and an explicit four-fill offline cost calculator. The D1 storage/stream
protocol and funding event accounting remain separate next steps.

## Local Checks

Public multi-exchange observation lab (separate from the running paper robot):
[plan, usage and limitations](docs/MARKET-LAB-PLAN.md). No account keys required.
An opt-in [five-venue comparison](docs/EXCHANGE-PUBLIC-DATA.md) now adds public
MEXC and HitBTC books: `npm run lab:venues -- BTC/USDT 0.0001 10 5`.

```bash
npm run lab:markets -- BTC/USDT 0.0001 10 5
```

For bounded snapshot storage and offline reports, see
[observation commands and Hyperion acceptance](docs/MARKET-OBSERVATIONS.md).
For the 30-minute campaign and storage policy, see [campaign runbook](docs/MARKET-CAMPAIGN.md).
The first Hyperion campaign is complete: [results and evidence](docs/MARKET-CAMPAIGN-RESULT-20260920.md).
Offline paper-v2 accounting is implemented: [usage, exact rules and limits](docs/PAPER-V2.md).
For decimal-preserving public Bybit data and observed-period replay, see
[exact observation workflow](docs/MARKET-EXACT.md).
A bounded 30-minute capture and causal offline comparison are described in
[the fixed study protocol](docs/PAPER-STUDY.md).
The separate MEXC/OKX paired probe and failure-aware paper model are documented
in [the paired paper protocol](docs/PAIR-PAPER.md).
The follow-up [thirty-minute study](docs/PAIR-STUDY-20260926.md) adds observed
fee-payment settings and a separately labelled USD-limit proxy.
An independent [explicit-fill settlement ledger](docs/PAIR-SETTLEMENT.md) checks
BTC/USDT/MX fees, quote budgets and unknown outcomes using synthetic scenarios.
Its [durable local journal](docs/PAIR-SETTLEMENT-JOURNAL.md) preserves events and
reservations across process restarts, with an optional external checkpoint.
A separate [synthetic risk gate](docs/PAIR-RISK.md) adds per-pair debit/exposure,
whole-session cash/fee budgets and minimum free funds on each venue.
The [policy-bound journal](docs/PAIR-RISK-JOURNAL.md) persists that policy and
checks admission against the same journal head used for atomic publication.
The [recorded-order audit boundary](docs/EXECUTION-AUDIT.md) validates MEXC/OKX
response formats and blocks incomplete or only-derived settlement evidence.
A separate [protected history capture](docs/EXECUTION-HISTORY.md) now reads
execution records and OKX bills into a private Hyperion archive.
The [offline cash comparison](docs/CASH-AUDIT.md) checks recorded net movements
against explicit execution amounts while retaining unresolved exchange contracts.
For the completed integration and remaining milestones, see
[the MEXC/OKX next steps](docs/PAIR-NEXT-STEPS.md).
An isolated [order lifecycle and recovery rehearsal](docs/LIVE-ORDER-RECOVERY.md)
now prepares durable intents, unknown-outcome recovery and exact fill accounting;
it has no exchange sender and cannot enable the real launch.
The [read-only response binding](docs/ORDER-RECOVERY-EVIDENCE.md) adds narrowly
scoped lookup, three-read evidence capture and resumable local reconciliation.
A [policy-bound order journal](docs/LIVE-ORDER-ADMISSION-POLICY.md) now enforces
explicit synthetic capital/reservation/exposure bounds on preparation and dispatch
markers; its conservative outflow ceiling is not production P&L.
A separate [account-funds preparation workflow](docs/ACCOUNT-FUNDS-PREPARATION.md)
now connects a verified private capture, declared fee math, draft limits and durable
local reservations. `npm run lab:account-funds -- ...` is offline and preparation-only;
it cannot dispatch orders or certify live readiness. A separate
[fee-bound capture and journal](docs/ACCOUNT-FEES-OBSERVATION.md) now derives rates
from the selected accounts and forbids caller-supplied tariffs. Production ownership
and actual fill currency/rounding remain unaccepted.
The [recorded fee summary](docs/RECORDED-FEES.md) now keeps observed charges/rebates
separate, detects duplicate conflicts and distinguishes empty from incomplete history.
Documented OKX Spot isoLiab N/A is explicit and never synthesized as a zero debt.
The [bounded day study](docs/PAIR-DAY-STUDY-20260926.md) samples public books once a minute,
refreshes rules every half hour and labels frozen initial fees as sensitivity assumptions.
Its [accepted day result](docs/PAIR-DAY-RESULT-20260928.md) retains all 1,440 slots,
1,419 usable book pairs and zero positive selected-scenario comparisons.

```bash
mkdir -p output
npm run lab:paper-v2 -- fixtures/paper-v2/basic.json output/paper-v2-first
```

```bash
npm test
npm run lint
npm run build
npm audit
```

## Server

The server deployment lives at:

```bash
/home/mil/robot.crypto.jsnode
```

Containers:

- `pg-crypto-robot`
- `robot_crypto_jsnode`

The dashboard is exposed through VPN with Auth Core login and a dedicated private CA:

```text
https://crypto.robot.vpn/
```

Direct port 5758 is loopback-only. Certificate, verification and rollback details:
[HTTPS deployment](docs/HTTPS-DEPLOYMENT.md). Client-device CA trust still needs verification.
Signed-out pages redirect to Auth; API requests return 401. Basic Auth is retained
only for the separate operator API. See [SSO deployment](docs/AUTH-SSO-DEPLOYMENT-20260919.md).

Database access is also localhost-only on the server:

```bash
ssh -N -L 3580:127.0.0.1:3580 igorjan94.ru
```
