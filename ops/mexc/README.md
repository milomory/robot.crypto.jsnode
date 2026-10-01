# One-shot MEXC spot balance check

Authorized purpose: authenticate the user's existing MEXC key and display spot
balances. This operator is separate from the paper robot and the generic account
checker. It performs exactly one GET `https://api.mexc.com/api/v3/account`, from
Hyperion, with public CA and hostname verification. No fee/trading/transfer calls.

`run-mexc-balance-once.py` creates a temporary isolated broker registry containing
only ref `secret://inbox/public-review-record-b11569db2351` and profile
`hyperion-crypto-mexc-balance-once`, destination `hyperion.crypto-mexc-balance`.
It uses the established broker backend and systemd encrypted-credential mechanism;
there is no raw decrypt command or value-returning interface. Main broker config,
registry, service, hardening and the encrypted vault are unchanged.

A root-owned AF_UNIX bridge accepts only the broker UID; the consumer validates
that its peer is root before sending a bounded credential frame. The bridge sends
credentials through protected SSH stdin to a fixed Python probe on Hyperion; no
helper files are deployed there. The trusted legacy parser can join the exact
reference's labelled Access Key description with its encrypted Secret Key value
only in memory. It never prints, logs or persists either value. Complete JSON and
precisely labelled pair formats also work; arbitrary prose/ambiguous input fails.

Remote stdout passes a strict allowlist projection twice: only currency, decimal
balance strings, timestamp/counts, authentication boolean or a fixed error code.
Unknown fields are rejected, including secret-bearing extras. Key rights are not
inferred. SIGTERM initiates cleanup; the broker also has a 90-second runtime cap.
The isolated unit, profile, helpers and sockets are removed on completion; only
standard value-free audit metadata remains in the protected broker audit log.
A host crash/SIGKILL can still require operator cleanup of these temporary paths;
an occupied path/unit fails closed instead of being overwritten by the next run.

Run only for an authorized check of this exact account; root scope is required
for the transient broker and encrypted service credentials:

```sh
sudo -n /usr/bin/python3 -I ops/mexc/run-mexc-balance-once.py
```

Offline validation (fake credentials and mocked network/processes only):

```sh
python3 -B -m unittest discover -s ops/mexc -p 'test_*.py' -v
```

2026-09-21 acceptance: 35 tests passed. One live signed account GET succeeded at
21:30:54 UTC, audit `private-audit-id-omitted`. Earlier two format
attempts made no exchange requests. Cleanup independently verified temporary
paths absent, unit `not-found`, original webintake binding unchanged and the main
broker active. No actual balances or credential values belong in these files.
