# One-shot OKX account verification

Purpose: check the user's existing OKX key through the model-blind secret broker,
from Hyperion. This operation is independent of the running paper robot.

Exact authorized keypair vault reference:
`secret://inbox/public-review-record-e8115fd14c14` (trailing hyphen is part of the ID).
Separate passphrase: `secret://inbox/public-review-record-1425c23b6554`.
The two independently scoped deliveries are combined only in memory using an
exact two-record frame; an existing keypair passphrase cannot be overwritten.
Metadata-only discovery on 2026-09-25 confirmed active/webintake. The original
intake binding does not itself mean the exchange account has been authenticated.

`run-okx-account-once.py` uses a dedicated temporary registry/profile, encrypted
systemd service credentials and the existing broker backend. It reads but never
rewrites the main registry/config or the encrypted record. Root/broker peer UIDs
are checked at the Unix-socket boundary. The exact secret travels through broker
stdin, a bounded socket frame and SSH stdin to a fixed Python3.6-compatible probe.
It is never a command argument, environment variable, file, log or model output.
No script is installed on Hyperion. SSH host verification remains enabled.

The probe accepts a complete canonical JSON bundle (see
[account contract](../../docs/EXCHANGE-ACCOUNTS.md)), an exact three-field
apiKey/apiSecret/passphrase JSON object, or precisely labelled three-field text.
Missing passphrase, duplicates, arbitrary prose, unrecognised fields and
non-mainnet/non-global metadata fail closed without credential output.
After a credential-format failure, the explicitly user-approved diagnostic may
report only the format category, presence of three known credential labels,
a bounded count of unknown fields, and a duplicate-field boolean. It never
returns field values, unknown field names, credential lengths or fingerprints.
Label presence alone does not prove that its value is populated or correct.

Only these sequential GETs to `https://www.okx.com` are possible:

1. `/api/v5/account/config` — observed key rights.
2. `/api/v5/account/balance` — validate trading-account balance schema/count.
3. `/api/v5/asset/balances` — validate funding-account balance schema/count.
4. `/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT` — validate spot fees.

Each request including DNS/TLS/body has a five-second deadline and 256 KiB body
limit. Public CA/hostname verification is required; proxies, redirects, retries
and automatic switches between global/regional/demo domains are disabled. A
regional/key mismatch reports a fixed code and needs clarification, not an
automatic retry with credentials at another origin.

Probe output contains counts/booleans or fixed error codes/stages only; no account
IDs, balances, fee values, upstream messages, URLs, headers or credentials. Both
bridge and runner independently validate an exact output allowlist. A later
endpoint failure preserves earlier authenticated-read evidence and completed
checks without claiming full acceptance. Trade/withdraw flags describe observed
permissions only: their operations are never called.

The transient broker has a 90-second runtime cap. Normal completion and SIGTERM
remove its unit/runtime directory/socket/helpers. The runner verifies absence
before declaring successful cleanup, preserves value-free audit metadata, and
refuses occupied paths. SIGKILL/host crashes may need manual scoped cleanup.
Original source files and the encrypted key remain; no permanent account binding,
scheduler, application deployment or live-lock change is performed.

Run only for the user-authorized check of this exact reference:

```sh
sudo -n /usr/bin/python3 -I ops/okx/run-okx-account-once.py
```

Offline checks (fake credentials/network only):

```sh
python3 -B -m unittest discover -s ops/okx -p 'test_*.py' -q
```

Protocol references:
[OKX REST authentication/account endpoints](https://www.okx.com/docs-v5/en/),
[API domain and key errors FAQ](https://www.okx.com/help/api-faq).

2026-09-25: real key+passphrase verification passed. Permanent paired observation
is a separate operation: [MEXC/OKX observer](../../docs/PAIR-OBSERVER.md).
