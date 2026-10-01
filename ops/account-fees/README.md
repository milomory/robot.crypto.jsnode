# Isolated account-fee capture

This workflow reads personal BTC/USDT tariffs and the MEXC MX-payment setting.
It has no exchange sender, account-setting mutation or enrollment entrypoint.
It reuses the already accepted account binding without changing its source hash.

Fixed Hyperion namespace: `/home/mil/crypto-account-fees`. The old binding and
accepted release `da4ad8a2e69855c9a49e1556287e55b2a7703e6e3aa67efe115969fb8105d7c5`
under `/home/mil/crypto-account-funds` are mounted read-only. The fee collector's
own manifest is a separate source hash. Only its private archive and the observer
cooldown directory are writable. The shared observer lock remains held through
exact-CID cleanup; there is no timer or public port.

Local preparation:

1. Run `python3 -m unittest discover -s ops/account-fees -p 'test_*.py'`.
2. After the source is final, `python3 ops/account-fees/prepare-release.py` builds
   just the static account-reader graph in a temporary directory. It creates a
   reproducible `/tmp/crypto-account-fees-<hash>.tar.gz` and this workflow's release
   pin. It does not rewrite `dist`, the funds release pin or the old binding.
3. The fixed `install-remote.py <hash>` consumes only that archive from stdin,
   verifies every member/hash and installs an exclusive immutable release. It
   never executes the release, changes credentials or activates a service.

`run-fees-once.py` is the explicit one-shot Athena controller. It requires its
reviewed release pin and the same three existing MEXC/OKX secret references. Before
any vault value is requested, it authenticates all installed release bytes and
runs the actual Node preflight with network disabled, empty stdin, and all five
mounts read-only. Its temporary broker supports only the three exact destination
bindings and is removed afterwards. Main registry/config hashes are compared.

The capture itself performs exactly MEXC UID, MEXC trade fee, MEXC MX status,
OKX account configuration and OKX trade fee GETs, sequentially. It has a fixed
45-second worker deadline and 10-second exact-CID cleanup budget. Output is a
strict receipt/status projection; private fees, identifiers and keys stay out of
stdout. Successful observation keeps `feeAdmission=false` and `executable=false`.

`verify-isolation.py` reads only non-secret configuration hashes, main app/database
container identities, observer timer state, binding-document hashes and absence
of temporary funds/fee containers. It does not hash or expose the binding key.

Rollback means stopping new invocations and cleaning only this workflow's exact
container/profile identities. Preserve private captures, original binding and
shared cooldowns. Do not overwrite the accepted funds release, enroll another
account, restart the robot/database, or reset a cooldown to make a retry pass.

Accepted on 1 October: [evidence](../../docs/evidence/account-fees-20261001/README.md).
`verify-private-capture.py RELEASE ARCHIVE_UUID ARCHIVE_SHA256` is the separate
read-only historical verifier. Execute on Hyperion as the private file owner;
its arguments/output are public hashes/statuses, never a key or UID. It does not
assert current freshness and is not included in the collector runtime graph.
