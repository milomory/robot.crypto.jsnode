# Crypto Robot Architecture

This project is independent from the T-Invest robot. It has no T-Invest SDK, no FIGI model, and no broker account logic.

## Legacy simulator runtime

```text
MarketDataAdapter -> SignalEngine -> RiskBudget -> PaperExchange
                                      |
                                      v
                         TradeJournal + Accounting + Dashboard
```

## Current research and account modules — 2026-10-01

The diagram above describes the legacy directional simulator, not the full project.
It is not the strategy foundation for the new funding/basis research.

| Layer | Implemented scope | Important boundary |
| --- | --- | --- |
| `src/accounts` | Read-only balances, account coverage and Earn projections | Account history is distinct from simulated fills; no transfers |
| `src/lab` | Public spot books, depth traversal, freshness and directed comparisons | Price spread alone is not net profit |
| `src/paper-v2` | Exact single-venue ledger and deterministic replay | Retains its original scenario boundary |
| `src/paper-pair` | Independently funded MEXC/OKX spot legs, partial/unknown outcomes, explicit-fill BTC/USDT/MX settlement and reserves | Spot pair accounting already exists; it is not a perpetual margin/funding engine |
| `src/live` | Preparation, admission, journals and offline recovery | No exchange order sender; dispatch markers do not send orders |
| `src/market-data` | Shared exchange/market identity, exact specs/grids, funding estimates/history, books/mark/index/OI and archive replay | D0a and full D0b capture accepted; MEXC WS source-time probe accepted separately. MEXC BTC/ETH top50 reconstruction accepted; joint BTC/ETH books accepted with four time-compatible directions per base (MEXC Spot excluded). Account eligibility, fees and net edge remain unverified |

`lab:derivatives-capabilities` is an explicit standalone command. Importing the
application does not start it. Existing private account readers and server timers
are not dependencies of the new module. Narrow venue unions in protected APIs
remain intentional; they are not widened by the new shared research identity.

MEXC BTC/ETH [top50 reconstruction](DERIVATIVES-MEXC-BOOK.md) is now accepted:
fresh metadata, REST bootstrap and continuous WS deltas with immutable depth
boundaries. This is not proof of the entire exchange book or execution readiness.
Joint alignment with OKX perpetual/Spot is also accepted on two short captures.
Next: resolve the remaining metric/funding-time contracts and persistent observation
storage protocol, then accept the D1 budget. Perpetual simulation still needs event funding,
separate-wallet margin/liquidation, four execution costs and broken-hedge recovery.
See [D0–D5](DERIVATIVES-OPPORTUNITY-PLAN.md).

## Safety Invariants

- MVP mode is `paper`.
- `LIVE_TRADING_LOCKED=true` by default.
- There is no live order execution path in the current codebase.
- Exchange private keys must not be committed, printed, or pasted into chat.
- First private exchange step should use read-only keys without withdrawal or trading permissions.

## Main Modules

- `src/exchange`: exchange adapter contracts, public Binance market data, paper exchange execution.
- `src/risk`: risk budget and gates.
- `src/journal`: Postgres-backed journal, orders, trades, positions, risk events.
- `src/http`: Fastify API for status, market data, risk, journal, positions, and paper orders.
- `ui`: React/Vite operator dashboard.

## Database

Production-like Postgres is on `igorjan94.ru` in container `pg-crypto-robot`.
It is intentionally bound to `127.0.0.1:3580` on the server, so local access uses an SSH tunnel.

## Paper execution and accounting

- Every fill rechecks risk inside a `READ COMMITTED` transaction using the same
  database connection as the writes. An account-wide advisory lock serializes
  fills across symbols and application instances; preliminary API/scan checks
  are not authoritative. All writers must use this path.
- Failed risk reads abort execution. Daily buy usage includes the new order's fee.
- The daily loss guard uses per-trade realized P/L for the UTC calendar day.
  Buy fees enter the position's average cost and are realized on sale; sell fees
  reduce that sale's P/L. The dashboard's total realized P/L remains cumulative.
- `INSERT ... RETURNING` supplies the response before commit; no follow-up reads
  can turn a successfully committed fill into a read error.


## Joint public observation

`market-data/spot-observations.ts` parses exact BTC/ETH Spot metadata/books.
`joint-client.ts` composes one explicit public capture with the separate MEXC
`joint-recovery-v1` frame profile and two concurrent final OKX books.
The profile allows one initial depth-commits bridge; later gaps still stop capture. `joint-replay.ts`
reparses raw evidence and checks budgets/causality; `joint-quality.ts` evaluates
all four markets at the same time. Missing MEXC Spot timestamp/grid excludes its
pairs, without turning receipt time into source evidence.

`joint-cost-scenario.ts` is a pure four-fill calculator with explicit exit books,
fees, funding and extra costs. It does not supply hypothetical defaults to the
capture, whose net edge stays unknown. See [contract and acceptance](DERIVATIVES-JOINT-BOOKS.md).
No server, account reader or live sender is imported by the new CLI.
