# Public code-review snapshot

This branch contains a tracked source snapshot for review, layered on existing
public review history. It does not publish the private intervening local Git history.

- Source snapshot commit: `9425c19e79b508c49f6cba6abd1e0fce8bb39db1`.
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

The older public main predates MEXC/OKX account work. The exact spot pair ledger,
partial/unknown outcomes, reserves and offline recovery already exist. They are
not a perpetual funding/margin engine. See `docs/ARCHITECTURE.md`.

- `src/accounts`: account/Earn readers and explicit asset/fee semantics.
- `src/paper-pair`: spot pair model, settlement, journals and risk.
- `src/live`: preparation and recovery; no exchange order sender.
- `src/market-data`: exact perpetual metadata, funding, books/mark/index/OI/history.
- `docs/DERIVATIVES-PUBLIC-D0.md`: accepted eight-GET public D0a capture/replay.
- `docs/DERIVATIVES-PUBLIC-D0B.md`: new fixed 24-GET profile and archive replay.
- `docs/DERIVATIVES-OPPORTUNITY-PLAN.md`: remaining D0–D5 gates.

## D0b status — 2026-10-01

D0b implementation/offline validation is complete; full network acceptance is not.
Three public MEXC BTC schema probes succeeded. The first OKX books probe returned
403; the other four were not attempted and no full D0b capture ran afterward.
MEXC REST system/trade timestamps do not prove book/metric update freshness.
Unknown quality remains explicit, executable=false, net edge/account income unclaimed.

Source validation: 4,326 tests passed, 15 existing PostgreSQL skips, API/UI build
and strict market-data test types passed. D0b adds 370 tests. Independent review
found and closed the overall-timeout/partial-replay mismatch. The retained public
MEXC fixture has no contemporaneous metadata and is not a complete capture.
No new recurring observer or real trading was enabled.

The new code/test/fixture delta is byte-identical to the source snapshot. Previous
private reference substitutions remain stable; see PUBLIC-REVIEW-PARITY.json.

This updated export also passed all 654 market-data tests and the API/UI build.
