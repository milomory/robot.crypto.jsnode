# Public code-review snapshot

Source: `efb413723de6ff887ae0ec02e1996c4285cae3b8`.
Publication parent: `6a1498c3dfe44032b0ef6ce349fea81dc2f267e4` on `codex/mexc-okx`.
The public main/base remains `4345d0c9f868e830bb2b2034d0b78864c4309575`.
Private intervening source history is not published.

## Current milestone

Joint BTC/ETH MEXC perpetual + OKX perpetual/Spot public captures are accepted:
8 GET / 1 WS per base, four time-compatible directed pairs per base. MEXC Spot
REST stays diagnostic because its update timestamp and exact grid are unconfirmed.
Two independent raw reconstructions/replays match. No net profit is asserted.

- `src/market-data/joint-*`: bounded acquisition, exact raw replay, quality and
  an offline four-fill cost scenario with explicit exit books/fees/funding/costs.
  Unknown costs or missing exit evidence keep net unknown.
- `mexc-depth-recovery.ts` and book session/client/replay: one initial commits
  bridge under an explicit profile. Version gaps and REST/WS conflicts fail closed.
  The two successful captures did not need that GET; recovery is synthetic/replay
  verified, not claimed as a successful live recovery acceptance.
- `mexc-depth-book.ts`: exact-price WeakMap cache; full sorts and all checks retained.
  The preserved 1904-update burst now merges in about1.44s offline; raw/old-new parity passed.
- `fixtures/market-data/joint-*`: two successful and five incomplete public captures,
  kept separately. These are historical public data, not account evidence.
- [Contract, evidence and limits](docs/DERIVATIVES-JOINT-BOOKS.md),
  [research roadmap](docs/DERIVATIVES-OPPORTUNITY-PLAN.md).

Source validation: 5470 PASS,15 existing PostgreSQL skips; API/UI build and strict
market-data test types PASS. Review-copy validation is recorded below separately.
D1 recurring collection is not started: repeated bootstraps exceed the provisional
storage budget. Funding event timing and a bounded persistent observation protocol
come next. No account requests, exchange orders or runtime deployment occurred.

## Publication boundaries

This is **not a deployment release**. Stable placeholders replace private environment
references. Private account captures, deployment receipts and mixed operational notes
are omitted or explicitly stubbed. Main trading/account code and existing safety gates
are preserved; placeholders are intentionally nonfunctional.

The export copies only tracked Git objects, never untracked files, private configuration
or env files. All source/tests/fixtures match except one pre-existing environment-reference
substitution. `PUBLIC-REVIEW-PARITY.json` records the exact exclusions/substitutions.
A pattern scan found no known private vault references, extracted receipt identifiers
or supported high-confidence credential patterns. This is not a proof of absence of all
sensitive prose. Gitleaks/trufflehog were unavailable.

Review-copy validation: **1798 market-data tests PASS**, API/UI build PASS.
