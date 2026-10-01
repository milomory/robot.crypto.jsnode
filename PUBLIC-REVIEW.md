# Public code-review snapshot

This branch contains a tracked source snapshot for review, with a single commit
parented by the existing public base. It does not publish the private intervening
local Git history.

- Source snapshot commit: `34758c4960cbaa76e564ea641731a55014f5e5f3`.
- Public parent commit: `4345d0c9f868e830bb2b2034d0b78864c4309575`.
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

## Review starting points

The older public `main` described the project before the MEXC/OKX account work.
This snapshot also includes the exact spot pair ledger, partial/unknown outcomes,
reserves, offline recovery, account/fund/fee bindings and the account dashboard.
`src/paper-v2` remains single-venue by design; `src/paper-pair` is the later pair layer.

- `docs/ARCHITECTURE.md`: current module boundaries and what remains unimplemented.
- `src/accounts`: independent account readers and explicit asset/fee semantics.
- `src/paper-pair`: spot pair execution model, settlement, journals and risk.
- `src/live`: preparation and recovery; there is no exchange order sender.
- `src/market-data`: new exact BTC/ETH perpetual metadata and forecast funding.
- `docs/DERIVATIVES-PUBLIC-D0.md`: bounded eight-GET public acceptance and replay.
- `docs/DERIVATIVES-OPPORTUNITY-PLAN.md`: D0–D5, including unimplemented books/OI,
  historical funding events, margin/liquidation and private derivatives readiness.

Funding estimates are not account income; contract quantity grids do not establish
executable notional or net edge. The legacy directional simulator is separate.
No real trading or new recurring derivatives observer was enabled by this work.

## Validation of this review snapshot

On 2026-10-01, the exported branch passed **3,956 tests**; the same 15 existing
PostgreSQL integration tests were skipped without a disposable database. API and
UI builds passed. The replaced account-selection wiring also passed 10 Python
unit tests. New public derivatives code has 284 tests, including replay of the
recorded eight-response public capture. No private API calls were used for these
checks. The public D0a observation is documented separately.

These checks do not verify a private deployment or authorize live execution.
