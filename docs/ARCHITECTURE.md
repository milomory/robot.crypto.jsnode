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
