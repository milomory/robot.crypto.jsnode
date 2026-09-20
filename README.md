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

Public multi-exchange observation lab (separate from the running paper robot):
[plan, usage and limitations](docs/MARKET-LAB-PLAN.md). No account keys required.

```bash
npm run lab:markets -- BTC/USDT 0.0001 10 5
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
