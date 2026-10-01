# Isolated OKX cash capacity observation

This workflow reads the selected OKX account's configuration and BTC/USDT cash
capacity. It performs exactly three sequential HTTPS GETs:

1. `/api/v5/account/config`, with the selected UID/mainUid/type checked first.
2. `/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDT`.
3. `/api/v5/account/config`, requiring matching identity and relevant configuration.

It sends no MEXC request. The same three existing MEXC/OKX secret references are
still delivered model-blind to check the existing whole-bundle fingerprint;
`credentialBundleMatched` does not claim a fresh MEXC identity observation.
`configurationStable` means equality at the two observations, not an atomic
exchange snapshot or proof of no intervening/manual activity.

The private namespace is `/home/mil/crypto-okx-capacity`. Existing binding and
source `da4ad8a2e69855c9a49e1556287e55b2a7703e6e3aa67efe115969fb8105d7c5`
under `/home/mil/crypto-account-funds` remain read-only. The collector's manifest
hash is separate from the accepted binding source hash. There is no enrollment,
trading sender, timer or public port. Observation keeps `capacityAdmission=false`
and `executable=false`; it does not replace fresh balance or fee evidence.

Prepare locally with `python3 -m unittest discover -s ops/okx-capacity -p 'test_*.py'`.
Once source is final, `python3 ops/okx-capacity/prepare-release.py` creates the
isolated artifact and this workflow's release pin. It never rewrites `dist` or
an existing funds/fees release. The fixed installer takes only that exact hash
and archive, verifies all members and publishes an exclusive immutable release.
It does not run anything or activate a service.

`run-capacity-once.py` is the one-shot protected Athena controller. It authenticates
the installed artifact and executes a real Node preflight with network disabled,
empty stdin and five read-only mounts before requesting any vault value. Its
broker unit, socket and three exact-ref profiles are temporary; main registry
and broker configuration are read-only and compared afterwards.

For actual execution, redirect controller stdout into a newly created private
local file (umask 077). Inspect the complete receipt privately; expose only the
agreed boolean projection in tool/chat output. Never print the private capture,
credentials, UIDs, request headers or signed URLs. `capacity-UUID.json` remains
on Hyperion in the private state directory.

The worker retains the shared observer lock through exact-CID cleanup. Its
45-second runtime and 10-second cleanup budget match the accepted fee workflow.
Only the private archive and shared cooldown directory are writable. Existing
MEXC cooldown is preserved; the reused preflight conservatively refuses either
venue's active cooldown. The worker does not reset a cooldown to enable retry.

Rollback stops further invocations and cleans only this workflow's exact
container/profile identities. Preserve private observations, original binding,
accepted releases and cooldowns. No app/database/Auth restart or registry rewrite
is involved. Failed or uncertain cleanup must remain visible as failure.
