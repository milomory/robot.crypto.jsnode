# Public code-review snapshot

This branch contains a tracked source snapshot for review, layered on existing
public review history. It does not publish the private intervening local Git history.

- Source snapshot commit: `7a54547ba5f484a54473fb9496b51427ecd20ddc`.
- Public history base commit: `4345d0c9f868e830bb2b2034d0b78864c4309575`.
- Mathematical, strategy, reader and test source is preserved. The only source
  substitutions are stable placeholders for private environment references.
- Private account captures, deployment receipts and mixed operational notes are
  omitted. Where useful, Markdown links lead to an explicit omission notice.
- See `PUBLIC-REVIEW-PARITY.json` for the complete omitted-path list, changed
  reference paths and source/tests/fixtures parity counts.

This is **not a deployment release**. Private key-vault reference placeholders
and receipt/profile pins are intentionally nonfunctional. Passing tests does not
make this snapshot suitable for production deployment or authorize trading.
The original protected deployment remains separate and unchanged.

The export uses only tracked Git objects. It does not copy untracked files,
private configuration or environment files. A redacted pattern scan found no
known private vault references, extracted private receipt identifiers or supported
high-confidence credential patterns. Gitleaks/trufflehog were not available;
this scan is not a complete proof that all sensitive prose is absent.

Unit tests/build results must be reported separately for this exported snapshot.
Synthetic fixtures and public market evidence are review materials; they do not
prove actual profitability, real account fills or execution readiness.

## Current review starting points

- `src/accounts`: account/Earn readers and explicit asset/fee semantics.
- `src/paper-pair`: exact spot pair model, settlement, journals and risk.
- `src/live`: preparation and recovery; no exchange order sender.
- `src/market-data`: exact perpetual specs, funding, books/metrics, bounded WS evidence and verified top50 reconstruction.
- `docs/DERIVATIVES-MEXC-BOOK.md`: new BTC/ETH bootstrap/stream acceptance and limits.
- `docs/DERIVATIVES-OPPORTUNITY-PLAN.md`: remaining D0–D5 gates.

## Current acceptance — 2026-10-01

The full BTC/ETH D0b 24-read capture remains accepted. Its historical REST MEXC
quality flags are unchanged; this new work uses separate fresh metadata, snapshots
and continuous WS updates to reconstruct verified top50 within immutable known
depth boundaries. It never claims the entire exchange book is known.

Real BTC and ETH captures each used 2 GETs and 1 public WS connection, followed
by independent replay and a separate raw-to-Map reconstruction. BTC applied 52
buffered updates after the snapshot; ETH applied 10. Final source ages were 770
and 169 ms respectively. These are short samples, not steady-state performance
or pure network-latency claims. Credentials/runtime/trades were not modified.

Source validation: 4,910 passed, 15 existing PostgreSQL skips with maxWorkers=2;
API/UI build and strict market-data types passed. An initial default-concurrency
run had one 5-second timeout in an existing study case; isolated and full reruns
passed without changing assertions or timeouts. One SIGTERM-interrupted retry was
not counted. This change adds 336 tests, including real BTC/ETH archives.

Independent review strengthened covered-version continuity, explicit socket-start
time and replay validation of impossible incomplete-failure stages. All new
source/tests/fixtures match the source snapshot byte-for-byte; only previously
approved private environment reference placeholders differ elsewhere.

Next: align MEXC perpetual books with OKX/Spot observations, resolve required
metric timestamps and accept the D1 request/storage budget before a campaign.
Net advantage, executable capital, derivatives fees and real execution remain
unverified. No new recurring observer or real trading was enabled.

The exported snapshot passed all 1,238 market-data tests and the API/UI build.
