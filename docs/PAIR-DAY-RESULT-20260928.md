# MEXC / OKX: accepted day observation

Accepted **28 September 2026**, strict mode. The predefined BTC/USDT study
ran from **26 September 13:24:42.769 UTC** through the last scheduled observation
on **27 September 13:23:42.769 UTC** (1,440 one-minute slots; nominal 24 hours).
The final sample completed at 13:23:43.524 UTC; the container exited successfully
at 13:23:43.759 UTC. No restart, retry, catch-up or parameter change was made.

## Result

**No positive cost-adjusted comparison was observed in either direction.**
The size was 0.0001 BTC. Initial account fees/payment settings were frozen and
adverse slippage was fixed at 5 bps per leg. This is a price/cost sensitivity
calculation, not realized profit/loss, an exchange fill or proof of live readiness.

The selected scenario is `okx-received-base`, matching the initial observed OKX
fee mode. Buying on OKX therefore grosses up the BTC amount to cover the assumed
base-currency fee before comparing the sale proceeds.

| Buy → sell | Evaluated | Above zero | Minimum, USDT | Maximum, USDT | Mean, USDT |
| --- | ---: | ---: | ---: | ---: | ---: |
| MEXC → OKX | 1,419 | 0 | −0.02392446 | −0.01568865 | −0.02115170 |
| OKX → MEXC | 1,419 | 0 | −0.02757259 | −0.01910515 | −0.02190579 |

Means above are rounded to eight decimals; the independent audit retains eighteen.
Across both directions the selected range is **−0.02757259…−0.01568865 USDT**.
Longest consecutive sampled positive sequence: **0** in each direction. Paper fills
and admitted directions: **0**. All directions also retain the frozen-fee gate and
unresolved exchange-contract restrictions.

The separate quote-fee scenario also has zero positives; its aggregate range is
−0.02672392…−0.01568865 USDT. The report's top-level `netRangeUsdt` and verifier's
compact report summary refer to that quote scenario. Use
`study.selectedScenarioSummary` for the selected scenario above. They are distinct
calculations, not conflicting runs.

## Data quality and acceptance

- **1,440 / 1,440** scheduled slots archived, no duplicates, early or skipped slots.
  Starts were 1–65 ms after their scheduled times.
- **1,419 / 1,440 usable book pairs (98.54%)**. Nine MEXC depth reads were
  unavailable; twelve pairs exceeded the one-second receipt-skew limit. All 21
  remain explicit gaps; they were not replaced, interpolated or counted as zero.
- USD index: **1,440 / 1,440** fresh reads. Instrument refreshes: **MEXC 47/48,
  OKX 48/48**. MEXC refresh at sequence 1200 failed; the absent rule evidence
  remains a separate admission restriction until the next scheduled refresh.
- Receipt skew: maximum 4,305 ms overall, 958 ms among accepted book pairs.
  MEXC lacks a source timestamp, so synchronized source data is not proven.
- Maximum frozen fee-evidence age: **86,431,739 ms** (about 24 h 00 m 32 s).
  Fees and payment settings were not continuously verified.
- **1,443 files / 8,246,779 bytes**: all hashes matched the remote acceptance
  manifest. Current compiled CLI and the captured source bundle produced
  byte-identical reports; original archive hashes remained unchanged.
- Independent Python Decimal calculation reproduced **all 2,838 directions**
  from raw depth, both fee scenarios and their rounding/gross-up steps.
- Collector exit 0, zero restarts, no OOM; original container isolation and main
  application's identity/image/start/restart state passed the verifier.

Thus **the capture protocol and deterministic calculation are accepted**.
`coverage.complete=false` and `metadataComplete=false` remain truthful: usable
market data and rules were not complete. No application-source/runtime/Auth/credentials,
observer schedule, scan, orders, transfers or live-lock changed for acceptance.

## Evidence and reproducibility

- [Compact acceptance](evidence/pair-day-20260926/acceptance-20260928.json).
- [Independent results](evidence/pair-day-20260926/independent-audit-20260928.json)
  and [executed Decimal audit](evidence/pair-day-20260926/independent-audit-20260928.py).
  The audit records its original local input and `/tmp` output paths; its copied
  script is unchanged. Running it requires the retained local archive.
- Capture: `7a976c9c-27a1-4fc0-8aff-9631aa69dd35`.
- Collector source: `3a6dd03715ef4570b406cc8ddff33e851faace4c`.
- Bundle SHA256: `41096fa8e5c08cface7d01102860699777dfa2ccc3ea5463759ef7e71af25402`.
- Archive aggregate hash: `44be35d067d0ce4e47b502f4e31fda0695556b8cc2d25ee5955ef0c4015d9b2d`.
- Report SHA256: `ca489947c3b2e1c97c50387bbfeba5a851c40e86f6c9332a9e812e16d1114f8a`.
- Local archive, full file manifest and both reports:
  `output/pair-day-20260926/hyperion/` (ignored build/evidence output).
- Remote archive retained:
  `/home/mil/crypto-pair-paper-20260926T132434Z-41096fa8/data/archive`.

The read-only verifier ran on 28 September; completion was observed by
05:22:42 UTC. The independent audit is a local recomputation, not a second remote
acceptance or new capture. Shared memory search was available but returned no
relevant day-study state; the original protocol and actual archive were authoritative.

## Actual report chart

The [portable day chart](../output/pair-day-20260926/chart/pair-study.html) is a
local, self-contained artifact generated from the accepted report above. It has
not been deployed to the Crypto web interface. HTML SHA256:
`b300843166cc6e7f7fc28a404d6a4f207b3a8feadffe5152f32255cdff34d800`.

[Rendered QA evidence](evidence/pair-day-20260926/chart-qa-20260928.json): installed
Google Chrome through Playwright, 390×844 and 1440×1100. Both exchange-direction
lines and zero are visible; 21 missing rows remain 17 separate gap groups and
18 segments per line. Legend hide/restore, exact source decimals, all 1,440 rows,
report hash and fee/coverage caveats passed. No overflow, runtime errors or external
requests; the portable export also rendered. Initial render was about 1.75 seconds.
Screenshots and the QA script remain under `/tmp/crypto-day-real-chart-qa-20260928`.
Browser plugin and in-app opener were unavailable; Safari/iPhone were not tested.
The portable file and source inspector contain no credentials or account payloads.

## Interpretation and next step

This run supplies no demonstrated positive edge for the sampled BTC/USDT strategy
under its fixed costs. Minute sampling cannot establish the absence of opportunities
between snapshots, on other pairs, at other sizes or under other actual fee terms.
The fixed 8-decimal upward-rounded base fee is a model assumption; the OKX USD
admission proxy and MEXC quantity/budget semantics remain unconfirmed. No capital
allocation or live activation follows from accepting this report.

The study is finished. Remaining work is delivery of the prepared account-homepage
improvements, the already drafted exchange-contract questions, and reconciliation
of existing nonempty execution history when available. Another market study needs
its scope and assumptions recorded before capture; retain this negative result.
See [the updated plan](PAIR-NEXT-STEPS.md). No additional keys are needed now.
