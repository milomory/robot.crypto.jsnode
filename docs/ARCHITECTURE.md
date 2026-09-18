# Crypto Robot MVP Architecture

This project is independent from the T-Invest robot. It has no T-Invest SDK, no FIGI model, and no broker account logic.

## Runtime Shape

```text
MarketDataAdapter -> SignalEngine -> RiskBudget -> PaperExchange
                                      |
                                      v
                         TradeJournal + Accounting + Dashboard
```

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
