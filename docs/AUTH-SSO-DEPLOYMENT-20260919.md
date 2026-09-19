# Crypto SSO and common login navigation

User explicitly requested completion of Crypto Auth and unauthenticated page
redirects across services. This supersedes the earlier activation hold, without
granting trading permissions or broadening viewer access beyond selected admin.

## Crypto applied state

- App release e5d7192 at /home/mil/robot.crypto.jsnode/releases/e5d7192.
  Activation procedure: ops/activate-crypto-sso.py. Existing Compose override
  merges protected .env.auth-core, selects release mount and enables Auth.
- Auth owner provisioned dedicated crypto.robot credential and a single active
  membership. Local allowlist contains exactly the selected admin UUID. Values
  remain in protected runtime files, not source/chat. Other client grants untouched.
- Issuer https://auth.vpn; callback https://crypto.robot.vpn/auth/callback.
- Signed-out root GET/HEAD303 ->/auth/login ->303 Auth. No Basic challenge on
  normal entry/API. API401 remains JSON. Revoked page session redirects;
  forbidden grants403 and outage503 do not redirect-loop.
- UI expiration sends one navigation to /auth/login even when parallel API
  requests all return401. Operator API remains separately Basic-protected and
  mutations require exact Origin+CSRF; live lock remains enforced.
- Read access covers only the reviewed shared paper journal endpoints/UI.
  Private Binance/runtime-config and all viewer mutations are denied.

## Evidence

- Offline tests70 passed, PostgreSQL integration15 skipped; lint/build passed.
  Two additional tests cover document/API separation, safe fixed redirect,
  revocation and no-loop denial/outage. Mutation denials tested offline only.
- Playwright local mocked401 test: exactly one navigation to Auth login and zero
  page errors. Browser plugin unavailable; local fixture screenshot
  /tmp/crypto-login-redirect.png is not evidence of device CA trust or password login.
- Trusted live HTTPS probes: root303, /auth/login303 with correct client/callback,
  /api/status401, /health200; no WWW-Authenticate on normal page/API.
- Synthetic invalid callback returned400. Programmatic log check found callback
  request but no synthetic query/cookie/Authorization marker. No raw logs or real
  auth codes exposed. Both nginx vhosts suppress request/error logs; Auth logger
  disabled. This tests the current chain, not an audit of historical logs.
- Operational read probe: paper, live-lock=true, database healthy, auto enabled,
  cycle2026-09-19T12:29:50.352Z errors0, SSOtrue, viewerCount1, operator role retained.
  No scan/order/unlock requests were sent.
- Auth owner acceptance PASS: root303/API401; PKCE/state/cookie viewer actor
  matched; protected document200; logout200 and remote revocation confirmed in DB;
  parent-session revoke followed by API401 without Location. Two temporary
  five-minute parent sessions/grants/tokens cleaned, membership unchanged; no
  trading/operator routes called. First harness attempt failed on old Python's
  SameSite accessor, cleaned up, then passed after raw cookie-attribute check.
  User password/physical device trust are not inferred from temporary sessions.
  Evidence: /home/mil/auth-core/backups/crypto-provision-20260919T122321Z/acceptance-v2.json.
  Acceptance code: Auth owner122f21a (with harness compatibility correction).
  Catalog now active/integration_ready=true, launch https://crypto.robot.vpn/auth/login.

## Backups and scoped rollback

Consumer backup:
/home/mil/robot.crypto.jsnode/backups/sso-20260919T122313Z
(source, base/override Compose, database dump with verified archive listing,
override.before-activation.yml). Auth owner retains separate client/DB backup.
Auth provisioning backup:/home/mil/auth-core/backups/crypto-provision-20260919T122321Z;
DB dump:/home/mil/auth-core/backups/20260919T122321Z.dump;
old Auth container:auth-core-before-crypto-20260919. Existing Auth image and all
other client env/credentials retained. Do not restore that whole container over
subsequent changes as a Crypto rollback.

Rollback only Crypto: first close SSO ingress and coordinate revocation of Crypto
service sessions, restore saved override selecting prior source and disabled
flag, recreate only API. Keep TLS, loopback5758, fixed network/CA, DB and trading
settings. Do not roll back common Auth/DB or other consumers. Basic operator
restoration is explicit rollback, never automatic fallback for Auth failure.

## Across services

Live Auth catalog contains four active consumers: crypto.robot, tinvest.robot,
skystream.monitor, xcontest. skystream.vpn remains planned, not an activated
consumer. Existing owners handle their code/deploy, preventing concurrent edits.

- Crypto: applied as above.
- XContest: owner confirms deployed source33d248c, published report3bd164b,
  image xcontest:login-navigation-33d248c. Document303 to Auth, APIs401,
  forbidden/outage403/503; four offline tests. Worker/flight queue unchanged.
  No redundant changes/smoke by this Crypto task.
- T-Invest: owner accepted deployed fe755bd, release robot-ti-sso-ux-fe755bd;
  root and /viewer redirect to Auth, APIs401, offline denial/outage403/503.
  Tests415/415 local,313/313 deployed build, build/lint pass; pause/sell-only
  retained. Published owner report10d3da5, docs/AUTH-CORE-UX-20260919.md.
- Monitor: owner confirms deployed d99efdb, healthy image
  sha256:3b8a9bd3f9f69f1b2132e92bf444a2813c50e741f1c40d82fce532bcfe38fb9d.
  https://monitor.vpn/ redirects303 via existing state/PKCE login handler; status
  API401 JSON/no Location, healthz200; denied403/outage503 without loops.
  Unexplained inactive token remains401. Owner evidence:43 tests, prior HTTPS/
  admin/revocation/browser1440/390 verification; credential/rights/collectors
  unchanged. See skystream-monitor/docs/DEPLOYMENT-20260919-ENTRY.md.

Auth owner01a06988-9983-7f83-a9b9-e0f738b73433;
T-Invest01a0b61f-f5eb-7bf0-b872-5a8d8c333a0a;
Monitor01a08e66-6d7b-7340-8c2f-a263ed739f31;
XContest01a0b5d2-de35-78b1-8023-139341b4a12d.
Trading-control was not edited. Mac inventory still needs updated SSO/client
purpose and verified status via its Mac owner; no secret values or iCloud edit.
