# Crypto Auth transport applied — 2026-09-19

User explicitly approved the concrete network-only proposal with «даю, делай».
SSO remains false. No client credential, registration, membership, UUID grant,
live login/revocation or manual trading action was performed.

## Applied changes

- Runtime `/home/mil/robot.crypto.jsnode/docker-compose.override.yml` uses the
  reviewed deploy/docker-compose.auth-transport.proposed.yml. Compose automatically
  merges this file during ordinary operations; do not omit it by supplying only
  `-f docker-compose.yml` during future recreations.
- Existing external network robotcryptojsnode_default reused without recreation;
  API IPv4 explicitly pinned to192.168.3.2. DB remains192.168.3.3; gateway192.168.3.1.
- Container-only mapping auth.vpn:192.168.3.1; host/device DNS unchanged.
- Public Auth CA mounted readonly; NODE_EXTRA_CA_CERTS configured before startup.
  Fingerprint verified against existing Auth CA; TLS verification not disabled.
- SSO explicitly false. Existing environment, image, command, loopback ports and
  DB service configuration compared before applying; no changes to those values.
- Only API recreated. No pending migrations before startup; source e2958d9 retained.
- Auth nginx gained exactly one line `allow 192.168.3.2;` in its existing exact
  SSO exchange/introspect/revoke/healthz location. Browser ACL and T-Invest rules
  preserved. Auth owner confirmed old helper was unsuitable; this task installed
  a new fixed scoped helper rather than replacing/reusing it.

## Verification

- Merged Compose validated on the actual host. Docker inspect confirms static
  IPAM IPv4Address192.168.3.2 and port127.0.0.1:5758.
- Ordinary container DNS lookup auth.vpn ->192.168.3.1; ordinary Node fetch of
  https://auth.vpn/healthz returns200 using configured CA (no per-request override).
- Server socket observed with ss:192.168.3.1:443 <-192.168.3.2:44052 during a
  synthetic keepalive health request. TLS authorized=true. No request payload,
  credentials, cookies or auth codes captured/logged for this verification.
- Container request to Auth browser root remains403; backchannel did not grant
  broad browser access. Auth from the previously allowed Athena route remains200.
- Crypto health200, protected HTTPS root401 with trusted TLS. Database healthy,
  paper mode, live lock true. Automatic cycle2026-09-19T12:10:24.622Z, errors0.
- Fixed patch unit checks: exact one-line delta; already-applied, ambiguous,
  altered deny and altered logging configurations rejected. Server nginx-t/reload
  succeeded. General app tests not repeated because app code was not changed.

## Backups and audit

- Runtime base compose/source and PostgreSQL dump20,558,002 bytes:
  `/home/mil/robot.crypto.jsnode/backups/auth-transport-20260919T120643Z`.
  Dump listing verified; no restore rehearsal performed.
- Auth vhost backup:
  `/root/crypto-auth-transport-backups/20260919T120958.896521Z/auth.vpn.before`.
- Auth vhost before SHA256:
  f2f844620afcfc92244fc02b055def4a24daafd7e0a2e90a0200f9fef46e33a7;
  after:a7c9cc10c3bcf93352ba70ee53e38b95ed2a180071625722fa2be4bfa5163a95.
- Athena broker registry backup:
  `/var/lib/agent-secrets-broker/backups/crypto-auth-transport-20260919T120944.738924Z`.
- New destination hyperion.crypto-auth-transport, profile
  hyperion-crypto-auth-transport-deploy; audit128dc6b7-5602-48aa-b0e2-ccd84d233cc2.
  Existing Hyperion sudo credential authenticated model-blind; no value exposed.

## Rollback / remaining work

Move the new override to a protected backup outside Compose's automatic name,
restore base compose only if changed, and recreate API only. Preserve existing
Docker network, DB, Crypto HTTPS and loopback5758. Removing override loses the
fixed IP/name/CA configuration, so restore the old transport state deliberately.
Remove only the Crypto allow line from the latest Auth vhost, check/reload;
do not restore a whole old vhost over another owner's newer edits. No Auth/DB
rollback or change to other consumers. Public CA file can remain inert.

Remaining gates: browser CA trust and common allowed VPN path, full-chain log
acceptance, operator API-only acceptance, explicit client/member provisioning
and SSO activation authority. admin UUID is confirmed privately by Auth owner;
no grant has been applied. Transport acceptance does not close these gates.

Owner transport result queued as01a0b993-bb56-7471-ba3c-bde57a4396e6; queue receipt
alone is not acknowledgment. Trading-control was not edited.
Mac private inventory update pending: new scoped profile purpose/verified status,
protected paths/backups and fixed Crypto-to-Auth route. Last documented
Memory-manager — Mac019fa8be-cf03-7d92-adc8-3c2572443806; live Mac route unverified.
