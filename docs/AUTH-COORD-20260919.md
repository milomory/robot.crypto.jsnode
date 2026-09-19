# AUTH-COORD-20260919 — Crypto consumer handoff

Accepted user-authorized coordination only. No new authorization for production,
credentials, membership or trading. HTTPS and publication are completed; do not
repeat them. No trading-control edits in this task.

## Evidence and current status

- Published source 9d65fad; local SSO implementation 5ddd8e2 targets Auth contract
  9003f5f. Control independently reports 28/28 offline consumer tests passed.
- Hyperion Crypto SSO remains disabled; deployed code has no registerAuthCore
  or logSafeRequest request serializer. TLS healthy, Docker binding still only
  127.0.0.1:5758. Paper/live-lock policy unchanged.
- Live Auth image inspected: auth-core:multi-service-sso-9003f5f-20260919.
  Its /app/server/app.mjs has Fastify logger:false.
- Live Auth and Crypto nginx vhosts disable access logs and route error logs
  to /dev/null. No raw logs, cookies, credentials or real auth codes were read.
- Container DNS lookup auth.vpn and crypto.robot.vpn: ENOTFOUND. Ordinary Node
  fetch https://auth.vpn/healthz also fails ENOTFOUND.
- Isolated probe with in-process DNS override to 82.146.44.70 (no configuration
  change): default Node trust fails UNABLE_TO_VERIFY_LEAF_SIGNATURE. With explicit
  public Auth CA, TLS validates but /healthz returns 403; container local address
  192.168.3.2. Remote observed source after NAT remains for infrastructure review.
  NODE_EXTRA_CA_CERTS is not configured. No exchange/introspect/revoke was called.
- Browser/device trust is **unverified**: Athena curl with explicit public CA is
  not proof that the user's browser trusts Auth and Crypto CAs.
- Crypto browser ACL includes 38.54.13.221 but not 77.238.234.74; Auth's browser
  ACL includes 77.238.234.74 but not 38.54.13.221. Common public egresses:
  157.22.184.131 and 185.9.27.65. Auth backchannel's T-Invest-specific allowance
  does not currently admit the verified Crypto probe. Do not broaden it blindly.
- End-to-end logging acceptance is **not complete**: current Crypto build lacks
  query redaction, despite nginx suppression. Deploying the reviewed serializer
  is a prerequisite; inspect error logging and any additional intermediary with
  synthetic markers before authorizing real SSO traffic.

## Contract to confirm with Auth owner

- client_id/service crypto.robot; exact callback
  https://crypto.robot.vpn/auth/callback; proposed final issuer https://auth.vpn.
- Catalog target https://crypto.robot.vpn/auth/login, new tab with noopener.
- Active membership AND separate local AUTH_CORE_VIEWER_IDS UUID allowlist.
  Trusted actor is (configured issuer, immutable user.id), never name/email/header.
- Viewer: seven reviewed GET/HEAD endpoints and UI, shared paper journal only.
  No private Binance/runtime-config, orders, scan or live-unlock. Membership is
  not a trading/admin grant. Owner must approve shared-journal scope and exact
  intended UUIDs before any provisioning.
- Separate Basic /operator API with exact Origin and CSRF for mutations; no
  operator UI under SSO yet. No automatic Basic fallback on Auth failure.
- App session: opaque server-only service token, separate browser cookie, no
  cached introspection, revoke/local logout semantics as documented in
  AUTH-CORE-INTEGRATION-REVIEW.md. No promise to cancel requests already running.

## Joint rollout proposal (not permission to execute)

1. Auth owner confirms final origin/contract, callback, catalog target, membership
   ownership and UUID mapping; product/operator owner accepts shared-journal
   visibility and API-only operator access. Browser trust verification is required.
2. Infrastructure owner proposes managed container DNS, read-only Auth public CA
   mount plus NODE_EXTRA_CA_CERTS, and narrowly scoped backchannel source policy.
   Reconcile VPN browser ACLs from the current inventory. Obtain explicit authority
   for these concrete production changes; preserve T-Invest's parallel setup.
3. Inspect full request/error logging path with synthetic markers. Prove no query,
   Cookie or Authorization values persist in app, proxy or intermediate logs.
4. Under separate provisioning/deploy authorization: back up consumer source,
   compose/config and Auth client metadata; provision a dedicated crypto client
   secret through the approved secret plane and only approved membership/UUIDs.
   Deploy compatible consumer with flag initially off. Preserve current paper
   settings, live-lock, HTTPS and loopback port. Validate network/TLS before enable.
5. Enable in a coordinated window only after explicit activation authorization;
   perform separately approved read-only authentication smoke below. No manual
   scan, orders, exchange activity or change to scheduled trading policy.

## Safe acceptance

- Offline fixtures: state/cookie/PKCE mismatch, code expiry/replay, wrong client,
  callback, issuer/service/subject, malformed response, outage, local grant absent,
  cross-client isolation, cookie attributes and session rotation.
- Offline/inject only: viewer POST paper/orders, scan and live-unlock denied;
  operator CSRF rejection and unchanged live-lock. Never exercise trading handlers
  as a live test harness, including negative tests that could fail open.
- After separate live-auth authorization: approved viewer can log in and read;
  unauthenticated read denied; local logout clears cookie and revokes service
  token; parent-session/membership revocation blocks next protected read.
  Use only explicitly approved temporary identities/grants for revocation tests.
- Browser CA trust for both origins, correct new-tab/noopener behavior, no token
  in browser storage/URL after callback; synthetic log probes for whole chain.
- Record limits: revocation checked per request, no cancellation of in-flight
  work; local logout may succeed while remote revoke fails; no cached fallback.

## Rollback proposal

Close consumer SSO ingress first; revoke Crypto service tokens/client access via
the separately approved Auth operation. Restore saved consumer build/config and
explicit Basic operator surface behind existing HTTPS and loopback binding.
Verify health/auth challenge and unchanged paper/live-lock policy. Never reopen
5758, silently switch viewers to Basic, drop DB, or roll Auth back over other
consumers. Auth client rollback is scoped to Crypto; preserve T-Invest/XContest.

## Delivery state

Target verified via live task list: Auth Core — Athena,
01a06988-9983-7f83-a9b9-e0f738b73433, cwd
/home/anton/.codex/worktrees/a904/auth-core.
Initial queue entry 01a0b89e-bc30-73b0-9c95-462038dee9e7 accepted while recipient
active. Queue acceptance alone is not owner acknowledgment; receipt/decisions
will be recorded after reading the recipient's response.

Owner response read from completed turn 01a0b89e-387f-7bb2-be6e-bf5ce85fcc37:
AUTH-COORD-20260919 accepted; production Auth's three SSO module hashes match
9003f5f; final origin https://auth.vpn; Crypto client absent in production.
Owner accepts Crypto 9d65fad, the contract and viewer-only plan, and Crypto-scoped
rollback preserving TLS/closed port/live-lock. Remaining owner decisions are
exact subjects, container DNS/CA/ACL/logging acceptance, and explicit provisioning/
activation authority. This acknowledgment does not authorize those changes.

Our direct initial request is visible as recipient userMessage in active turn
01a0b89f-dc08-7303-ba56-ce4d8dcff414 (delivery verified). Follow-up evidence queue
01a0b8a0-989f-7280-a8ed-20541ba18764 contains the DNS/TLS/403 results and this
document path; its detailed acceptance is pending. No duplicate sends or forced
starts of the active recipient were performed.

Direct request ACK received in completed turn 01a0b89f-dc08-7303-ba56-ce4d8dcff414.
Auth owner published f9924a0, docs/crypto-owner-handoff-20260919.md: final issuer,
client/callback, membership AND independent UUID grant, seven read APIs and
separate operator API confirmed; conditional joint rollout/rollback accepted.
Catalog should use noopener noreferrer. User selects Crypto accounts; Auth owner
confirms UUID/membership and Crypto owner maps the allowlist. T-Invest grants do
not transfer. API-only operator usability still needs acceptance. ACK explicitly
does not authorize activation; follow-up DNS/TLS/403 evidence has been queued.
