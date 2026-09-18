# robot.crypto.jsnode

Standalone crypto trading robot MVP.

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

## Local Checks

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

The dashboard is exposed with Basic Auth:

```text
http://crypto.igorjan94.ru:5758
```

Prepared HTTPS target after the nginx handoff is activated:

```text
https://igorjan94.ru/crypto/
```

Database access is also localhost-only on the server:

```bash
ssh -N -L 3580:127.0.0.1:3580 igorjan94.ru
```
