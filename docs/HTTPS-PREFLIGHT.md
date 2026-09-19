# HTTPS preflight — 2026-09-19

Historical preflight; the approved TLS-only deployment is now recorded in
[HTTPS-DEPLOYMENT.md](HTTPS-DEPLOYMENT.md).

Scope: read-only inspection and a concrete deployment proposal. No runtime,
DNS, certificate, firewall, membership, credential or production DB changes.

## Verified from Athena

| Check | Result |
| --- | --- |
| Local resolver, auth.vpn and crypto.robot.vpn | Both resolve to Hyperion 82.146.44.70 |
| Auth HTTPS with dedicated public CA from contract Git commit 9003f5f | HTTP 200, certificate verification 0; no login performed |
| Auth certificate | SAN auth.vpn, valid 2026-09-08 through 2026-12-07 |
| Auth renewal timer | active; future renewal not exercised |
| Crypto HTTP through nginx | 401 Basic Auth challenge |
| Crypto HTTPS | Certificate hostname mismatch; no crypto TLS vhost installed |
| Crypto direct health on Hyperion | HTTP 200 |
| Docker API port | 0.0.0.0:5758 and [::]:5758; direct ingress bypasses nginx |

Auth public CA SHA256:
`8A:40:DD:77:FF:B2:F2:AB:2F:73:8D:3C:D0:BA:DA:2C:73:EE:F2:6D:52:78:57:F0:1B:95:42:46:DE:12:C0:40`.
Device/browser trust and container-side resolution/reachability remain unverified.
No `-k` or disabled TLS verification was used.

## Prepared change

`deploy/nginx-crypto.robot.vpn.conf` is a root-origin vhost for
`https://crypto.robot.vpn`, proxying to 127.0.0.1:5758. HTTP redirects to the fixed
HTTPS host without preserving query parameters; plaintext callbacks are rejected.
HTTPS preserves callback parameters to the application, with access and error
request logs disabled to avoid recording codes. HTTP redirect is public but
contains no application content; HTTPS retains the current Crypto VPN allowlist.

Before installing it, issue a dedicated crypto.robot.vpn leaf using a dedicated
name-constrained private CA, following the existing XContest pattern. Store private
keys root-only under `/etc/crypto-robot/tls/`; configure daily renewal checks at
30 days remaining for a 90-day leaf. Distribute only the public CA to approved
devices. No certificate/key has been generated in production by this task.

Patch the **actual current** runtime compose file (after backup), changing only
`5758:3000` to `127.0.0.1:5758:3000`. Do not layer a ports override: Compose may
merge it with the public binding. Do not apply the old `docker-compose.https.server.yml`:
it sets `/crypto/` and `/crypto-api`, incompatible with the root-origin SSO callback.
Keep `VITE_BASE_PATH=/` and the default same-origin `/api` path.

Keep the current production build and SSO disabled during this TLS-only stage.
Recreating the API container briefly interrupts the dashboard/paper scheduler;
its existing startup command builds and runs migrations, so preserve the deployed
source and verify no pending migration before recreation. Do not recreate DB or
T-Invest. Take a database backup before any container startup that can migrate.

## SSO prerequisites discovered

- Crypto allows VPN egress 38.54.13.221; Auth currently does not. Auth allows
  77.238.234.74; Crypto currently does not. Reconcile with the current VPN inventory
  before expanding either list; this draft preserves Crypto's existing policy.
- Browser trust in both public CAs must be verified independently of Athena curl.
- The Node consumer must trust the Auth CA, e.g. a read-only public CA mount and
  `NODE_EXTRA_CA_CERTS` set before Node startup. Do not disable verification or
  reuse Auth's private CA key. Verify container DNS and Auth's allowed source IP;
  host-to-own-public-IP/container egress may differ from Athena's VPN source.
- Auth's HTTPS vhost currently inherits logging. Review its query-bearing login
  requests and all proxy/CDN logs with the Auth owner; consumer log suppression
  alone does not cover the complete SSO chain.
- Multi-service Auth deployment, crypto client provisioning and viewer UUIDs
  remain a separate coordinated rollout per AUTH-CORE-INTEGRATION-REVIEW.md.

## Application and rollback procedure

1. Back up current nginx vhost, runtime compose, deployed source and DB; record
   permissions, active image/source and certificate public fingerprints.
2. Provision dedicated TLS/renewal through the approved fixed privileged workflow.
3. Install vhost, run server `nginx -t`, then reload nginx. Verify trusted HTTPS
   returns 401 with SSO disabled and 403 from an outside-VPN source. Check HTTP
   redirect and plaintext callback rejection. Do not send real auth codes.
4. Apply the single loopback bind change and recreate only API in a maintenance
   window. Verify loopback health 200, HTTPS 401, and direct remote 5758 closed.
5. Verify daily renewal timer and a renewal rehearsal, and ensure other vhosts
   still respond. No manual scan, order or exchange calls are part of acceptance.
6. If TLS fails, restore backed-up nginx config and test/reload. If the API
   recreation fails, restore the exact prior compose/source and recreate only API.
   Restoring the public port reopens the former exposure; prefer leaving it closed
   and using an SSH tunnel while repairing. Do not drop or restore DB automatically.

Local `nginx -t` passed using an isolated temporary prefix, unprivileged ports
18081/18444 and a synthetic certificate, with production paths substituted.
The first check on ports 80/443 failed due to local bind permissions. This does not validate the final
host certificate or reload production nginx. Final host `nginx -t` is mandatory.

## Inventory follow-up

Mac private inventory needs Hyperion Crypto TLS absent/hostname mismatch, current
public 5758 binding, and Auth TLS verification/expiry above. After deployment add
Crypto certificate purpose, paths, public fingerprint, renewal and verification.
Last documented route: Memory-manager — Mac, 019fa8be-cf03-7d92-adc8-3c2572443806;
current live route unverified because no thread listing/delivery tool is available.
No Mac inventory update or handoff delivery is claimed.
