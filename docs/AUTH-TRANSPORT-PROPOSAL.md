# Crypto Auth transport proposal — 2026-09-19

Prepared only; no production configuration changed. User selected existing Auth
account admin. Auth owner confirmed a unique active user and recorded its UUID
in private owner handoff commit03f71ac. Do not copy that identity into public
source or map by login at runtime. Crypto has no membership yet.

## Concrete network evidence

Existing Docker network robotcryptojsnode_default: 192.168.3.0/24,
gateway192.168.3.1, API192.168.3.2, DB192.168.3.3. Read-only HTTPS health probe from
the API to gateway192.168.3.1, preserving auth.vpn SNI and verifying the Auth CA,
returned403; socket source192.168.3.2. Gateway reachability and TLS are proven;
the source actually observed by nginx still needs verification after authorized
application. Do not infer server-observed source solely from the client socket.

Auth owner conditionally accepted the design in turn
01a0b98a-3ae0-70b3-80c9-826067c50b52: container-only mapping, pinned IP, readonly CA
and exact backchannel routes are acceptable. This ACK is not rollout permission.
Browser VPN ACL compatibility remains separate; this proposal does not resolve it.

## Proposed production diff

1. Use deploy/docker-compose.auth-transport.proposed.yml with the actual runtime
   compose after backing it up. The external network declaration reuses the
   inspected network; pin API to its current192.168.3.2. Confirm Docker version
   accepts a static address on this existing IPAM network before activation;
   do not recreate the network or DB to force it. API recreation must use
   --no-deps and preserve the original project name, source and trading settings.
2. The extra_hosts entry is a versioned container-only backchannel mapping,
   following T-Invest's pattern. It is not a repair of global/browser DNS.
   Confirm this scoped exception with the owner before applying; no host/device
   hosts files or public/VPN DNS records are modified.
3. Install the public Auth CA at runtime public-ca/auth-vpn-root-ca.crt, verify
   fingerprint8A:40:DD:77:FF:B2:F2:AB:2F:73:8D:3C:D0:BA:DA:2C:73:EE:F2:6D:52:78:57:F0:1B:95:42:46:DE:12:C0:40,
   and mount readonly. NODE_EXTRA_CA_CERTS must be set before Node starts.
4. Auth owner adds exactly `allow 192.168.3.2;` to the EXISTING HTTPS location
   matching `^/(api/sso/(exchange|introspect|revoke)|healthz)$`, before deny all.
   Preserve every existing directive and T-Invest allowance. Do not add a
   competing location, allow the subnet, or broaden the browser/root ACL.
5. SSO stays explicitly false. No client registration, membership, credential,
   UUID grant or login operation is part of this transport-only change.

## Acceptance and rollback

Before change: backups of compose/nginx, current API source/image/network identity;
check no pending migrations because existing API startup runs migration logic.
Validate merged compose without printing interpolated secrets. Auth owner runs
nginx -t before reload. After restart verify fixed source192.168.3.2, ordinary
Node fetch https://auth.vpn/healthz returns200 with CA verification enabled and
without a request-specific DNS override. Confirm Crypto health200/root401,
loopback-only5758, unchanged paper/live-lock settings. No scan/orders/auth smoke.

If pinning or transport fails, restore prior compose and recreate only API.
Remove only the added Auth source allowance after confirming no dependent change.
Keep TLS, public CA files, existing network/DB, other consumers and closed port.
Do not roll back the shared Auth image or database.

## Subsequent SSO stage — separate authorization

After transport acceptance and full logging review, provision a dedicated Crypto
client secret and admin-only membership/UUID allowlist, deploy matched consumer
and enable SSO only with explicit authority. Browser CA trust and API-only
operator usability must be accepted; test real login/logout/revoke only when
authorized. Existing offline mutation-denial cases do not require live orders.
