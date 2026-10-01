# Public code-review snapshot

This branch contains a tracked source snapshot for review, layered on existing
public review history. It does not publish the private intervening local Git history.

- Source snapshot commit: `f4b2b882eece55efc674382e2934b8f7d5886575`.
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
- `src/market-data`: exact perpetual specs, funding, books/metrics, bounded WS evidence.
- `docs/DERIVATIVES-PUBLIC-D0B.md`: accepted complete 24-GET capture and replay.
- `docs/DERIVATIVES-MEXC-DEPTH-SOURCE.md`: accepted bounded BTC WS source-time probe.
- `docs/DERIVATIVES-OPPORTUNITY-PLAN.md`: remaining D0–D5 gates.

## Current acceptance — 2026-10-01

A new diagnostic using the normal Node client on the same www.okx.com origin
returned 200/code0; the reason for the historical Python 403 remains unknown.
The full BTC/ETH D0b capture passed all 24 reads and independent replay. Both
MEXC REST books retain cts:null and are not qualified as synchronized books.

A separate MEXC public WS probe accepted 10 sequential BTC deltas with
matching-engine timestamps (114–123 ms source age in this short sample).
The stream parser, bounded transport and archive replay are implemented.
These deltas are not a reconstructed full book. A fresh bootstrap with continuous
updates and known depth boundaries, then ETH/Spot integration and the D1 budget,
remain the next step. No new recurring observer or real trading was enabled.

Source validation: 4,574 tests passed, 15 existing PostgreSQL skips; API/UI build
and strict market-data test types passed. This change adds 248 tests, including
real public archives and a regression for normalization increasing archive size.
Independent review also closed clock-error classification in stream callbacks.

The new code/test/fixture delta is byte-identical to the source snapshot. Previous
private reference substitutions remain stable; see PUBLIC-REVIEW-PARITY.json.

This exported snapshot also passed all 902 market-data tests and the API/UI build.
