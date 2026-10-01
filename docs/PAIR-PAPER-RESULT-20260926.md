# MEXC / OKX paired-paper acceptance — 2026-09-26

The first exact paired probe is complete. All 60 scheduled pairs were available;
120 directional comparisons were negative after the frozen observed taker tariffs
and assumed adverse slippage. There were **zero paper transactions and zero real
exchange mutations**. This short functional probe does not establish long-term
opportunity frequency or profitability.

## Observed window and results

- Capture: `0d804a30-4236-4fd0-b2f0-4ecb14e8a547`.
- Hyperion, 04:02:54.153–04:07:49.546 UTC (06:02:54–06:07:49 Amsterdam).
- BTC/USDT, 0.0001 BTC per direction, 60 concurrent request pairs, five-second slots.
- Maximum receipt skew 247ms; no missing pairs. MEXC source time is absent, so
  source synchronization and executable window duration remain unproven.
- Frozen taker cost: MEXC 5bps / OKX 10bps; adverse slippage 5bps per leg.
  Actual fee currency is unknown; USDT is a model assumption. MEXC's fee was
  originally numeric JSON; this precision limitation is retained in provenance.

| Buy → sell | Comparisons | Net range, USDT per pair | Positive |
| --- | ---: | ---: | ---: |
| MEXC → OKX | 60 | −0.02142950…−0.02036110 | 0 |
| OKX → MEXC | 60 | −0.02165032…−0.02057871 | 0 |

Raw depth spreads occasionally had a positive sign, but were smaller than the
assumed total costs. No opportunity was forced into a simulated trade.
All synthetic starting balances were unchanged. This is not the user's real
account balance or realised trading P/L.

## Admission gaps exposed by real metadata

- MEXC publishes minimum BTC quantity `0.000001`, base precision 8, and market
  notional limits 1…4,000,000 USDT. Its order quantity increment is not explicitly
  confirmed by the current public contract. Minimum quantity was not guessed to
  be its increment: admission is `quantity-step-unconfirmed`.
- OKX publishes BTC step `0.00000001`, minimum `0.00001`, market cap 1,000,000 USDT
  (`maxMktSz`) and an independent 1,000,000 USD cap (`maxMktAmt`). USD was not silently
  relabelled USDT: admission is `usd-limit-unconverted`.
- Both gates remain visible even though the observed net economics were already
  negative. A valid book or account connection does not imply order admissibility.

## Failure mechanics and validation

Independent synthetic fixtures verified linked reservations, partial executions,
one-leg rejection, residual BTC exposure, unknown-outcome reserve retention,
explicit reconciliation, duplicate/conflict handling, and deterministic restart.
New pairs are blocked until the prior pair settles without residual exposure.
Ordinary new fills cannot reuse stale books; late reconciliation records an
already occurred paper outcome. No automatic hedge, transfer or replayed order.

The [synthetic fault artifact](evidence/pair-paper-20260926/fault-acceptance.json)
is separate from the observed market report. It proves the state transitions,
not execution probability or market returns. The engine reports cash changes and
BTC exposure; it does not invent a FIFO cost basis for opening BTC.

Final checks: 1014 tests passed; 15 existing PostgreSQL tests skipped without a
separate test database. The new paired modules have 40 targeted tests. Typecheck,
API build and UI build passed. No production DB was used by the new lab.

The deployed bundle and independently compiled CLI produced byte-identical reports.
All 63 copied public archive files matched server SHA256 hashes and remained
unchanged after replay. Archive hash:
`87dc425555055fbf7d2da1e6a213eb7e533c9716c6b88d5886f46a2ae65d7d88`.
Report SHA256:
`9002eaec67c12c38e787dc362e33b638e805070952b4da0c427904f11ed1712d`.

## Runtime evidence and next boundary

Collector `crypto-pair-paper-20260926T040246Z-62d4c88c` exited 0 at 04:07:49.610 UTC,
with no OOM or restart. Its non-root identity, read-only rootfs, exact three mounts,
resource limits, no ports, no capabilities and disabled logs were verified.
The existing Crypto app retained its exact container ID, image, start time and
zero restart count. Observer, Auth, live lock and old paper journal were untouched.

Source revision: `c39c6381bccf39109e87b7c248e0a7d8b578fda8` (local commit).
Bundle SHA256:
`62d4c88c29ee9b1742e13dfce883393d26d3b467895bca11b93fd273a234294e`.
Server archive:
`/home/mil/crypto-pair-paper-20260926T040246Z-62d4c88c/data/archive`.
Local archive/replays:
`output/pair-paper-20260926/hyperion/`.

Durable evidence: [acceptance](evidence/pair-paper-20260926/acceptance.json),
[full report](evidence/pair-paper-20260926/report.json),
[checks](evidence/pair-paper-20260926/checks.json).
The new tools are `ops/run-pair-paper-probe.py` and
`ops/verify-pair-paper-probe.py`; each run uses a new directory and is bounded.

Next: confirm MEXC increment semantics, support separate USD cap valuation and
actual fee-asset effects, then capture a longer predeclared period with measured
latency/persistence and inventory constraints. Real execution would require its
own concrete monetary and recovery limits. No additional exchange keys are needed
for these remaining public-data and paper tasks.
