# Crypto HTTPS deployed — 2026-09-19

User explicitly approved HTTPS installation and closure of direct port 5758.
Production source remains e2958d9: SSO code was not deployed or enabled.

- URL: https://crypto.robot.vpn/ through VPN, existing Basic Auth retained.
- Dedicated CA constrained to crypto.robot.vpn; private keys stay root-only under
  `/etc/crypto-robot/tls/` on Hyperion. Leaf expires 2026-12-18 04:55:35 UTC.
- Public CA: [crypto-robot-vpn-root-ca.crt](certificates/crypto-robot-vpn-root-ca.crt).
  SHA256 `29:08:C3:46:B4:93:95:1E:A0:63:F4:39:1E:DA:93:23:2C:06:70:D5:E0:6F:2D:45:E1:C0:DA:58:97:DE:4D:F6`.
- `crypto-robot-tls-renew.timer` is active: daily check, 30-day threshold, 90-day
  leaf. Actual future renewal has not been exercised.
- Existing Crypto VPN ACL retained. No Auth/T-Invest configuration changed.
- Runtime compose changed only API binding to `127.0.0.1:5758:3000`;
  only API recreated. Build/migration startup completed; there were no pending
  migrations. DB container was not recreated.
- Broker profile `hyperion-crypto-robot-tls-deploy`, destination
  `hyperion.crypto-robot-tls`; authenticated successfully, audit
  `add3b4b2-d59c-4c87-8042-2524838ab571`. Credential value never returned.

## Verification

- Trusted TLS chain and hostname verified with explicit dedicated CA.
- HTTPS health 200; protected root 401; non-allowlisted source 82.146.44.70 got 403.
- HTTP redirects 308 to HTTPS without query; plaintext callback returns 400.
- Direct remote 5758 connection refused; Docker publishes only 127.0.0.1:5758.
- App and DB healthy; paper mode and live lock retained; no manual scan/order calls.
- Auth HTTPS still returns 200 with its own CA. Existing parallel T-Invest
  backchannel/logging changes observed and preserved.
- No browser/device CA trust installation claimed. Host Hyperion could not resolve
  crypto.robot.vpn; local verification used curl --resolve without hosts changes.
  Container DNS, Auth CA trust and backchannel policy remain SSO prerequisites.

## Backups / rollback

- Hyperion nginx/TLS: `/root/crypto-robot-backups/20260919T045534.547002Z`.
- Runtime compose, source archive and 20,488,660-byte PostgreSQL custom dump:
  `/home/mil/robot.crypto.jsnode/backups/https-20260919T045628Z`.
  Dump archive listing verified; restore rehearsal not performed.
- Athena broker registry:
  `/var/lib/agent-secrets-broker/backups/crypto-robot-tls-20260919T045524.033556Z`.

Restore the saved nginx config, test and reload for TLS rollback. Preserve the
loopback bind and use SSH tunnelling while repairing. Restoring the old compose
and recreating API reopens the former public port; do that only deliberately.
Do not restore/drop DB as part of a TLS rollback.

## Coordination and remaining work

Infrastructure coordination request/result is recorded in System-Admin
`areas/auth-core/crypto-https-coordination-20260919.md`. Live thread listing and
delivery tools are unavailable: owner acknowledgment is not claimed. User's
explicit deployment authorization was used for this isolated Crypto change.

Mac inventory update is pending: last documented Memory-manager — Mac task
019fa8be-cf03-7d92-adc8-3c2572443806, live route unverified. Record Hyperion domain,
TLS purpose/public fingerprint/expiry, root-only key paths, renewal timer, backups,
loopback port and verified dedicated broker profile. Never copy private keys.

Install only the public CA on approved client devices and verify browser trust.
SSO deployment/client provisioning/memberships require their separate coordinated
rollout; see AUTH-CORE-INTEGRATION-REVIEW.md.
