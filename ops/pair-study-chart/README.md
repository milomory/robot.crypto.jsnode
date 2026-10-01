# Local selected-scenario paper chart

Rebuild only from a completed, verified paired-paper report:

```sh
python3 ops/render-pair-study-chart.py \
  output/pair-study-20260926/hyperion/report/report.json \
  --output output/pair-study-20260926/chart
```

Outputs: `chart/dist/index.html` plus the content-addressed data sidecar for HTTP
preview, and portable self-contained `chart/pair-study.html`. The Data app's
supported offline export creates the portable file after verifying the split
build. No publication, external assets, new API calls, keys, or installs occur.

Preview: `python3 -m http.server 4192 --bind 127.0.0.1 --directory output/pair-study-20260926/chart/dist`.
The generator pins Data plugin 1.0.11 and uses its prebuilt runtime. It preserves
the app ID on repeated builds of its own output directory. The `--legacy-quote`
option is required to develop against the earlier five-minute report; it visibly
labels that dataset and its assumed quote-currency fees. Never use that option
to substitute old evidence for a thirty-minute or day study. The versioned day
policy `mexc-okx-paired-study-24h-v1` accepts exactly 1,440 one-minute slots and
reports up to 16 MiB; earlier policies retain the 2 MiB bound. Never point the
generator at an active capture: independently verify and replay the completed
archive first, then pass its final report.json.

The graph uses only `study.selectedFeeScenario`. Unknown selection yields no
plotted values. Null observations remain gaps; exact decimal strings are kept in
source inspection while finite numbers are used for visual positions. Both
purchase directions use UTC and share the zero reference. USD-index coverage,
fee-mode limitations and absence of exchange-admission proof remain visible.
Counts above zero are computed from exact selected-scenario decimals separately
for both directions. Their denominator is that direction's evaluated observations,
not scheduled slots or trades. Missing selection displays “нет расчёта”.

The day chart explicitly labels frozen initial fees as sensitivity assumptions,
not continuously verified tariffs. It checks the report's declared fee policy and
maximum fee age against final report time minus earliest fee request time; the
visible age is rounded upward to a minute. Both UTC endpoint dates are shown
when the study crosses midnight. Day studies also show the separate MEXC/OKX
rule-refresh coverage out of 48, with an explicit incomplete marker when needed.
Source inspection retains exact decimal strings,
all original sample rows, report hash, diagnostic exclusions and the fee caveat.

Local rendered checks use Playwright when browser tools are unavailable. Verify
360 (30-minute) or 1,440 (day) source rows, selected fee mode, no runtime errors, visible two-line chart,
legend hide/restore, source preview and overflow at 390px/1440px before delivery.

If a report contains `diagnostics.mode = schedule-diagnostics`, the artifact is
visibly labelled diagnostic and repeats the exact excluded early-slot count.
Excluded observations must already be unavailable and have no directions; the
generator refuses a report that still plots them. Raw archive evidence is not
modified. `buildStatus = complete` means only the chart artifact is authored,
never that the original capture passed its schedule protocol.

For synthetic renderer QA only, construct a report with the exact marker
`"chartFixture": "synthetic-not-real-results"` and pass `--synthetic-fixture`.
Marker and flag must match; the title and a conspicuous banner say SYNTHETIC / не
реальные результаты. This must never label the actual capture or stand in for
its result. Keep synthetic reports and screenshots under `/tmp`, outside Git.

```sh
python3 -m unittest ops/test_pair_study_chart.py -v
```

These offline tests cover profile/size limits, unknown fee mode, exact positive
counts, missing rows, timestamp/fee evidence consistency, required synthetic
labels, and five-minute/thirty-minute diagnostic compatibility. Rendered QA must
also exercise legend hide/restore, source inspection and mobile/desktop overflow.

The day plot draws zero as a neutral mathematical series from the existing
`zero = 0` reviewed field, labelled “Ноль после затрат”. The two colored series
remain the two exchange directions. Legacy charts retain their annotation.
Chrome CPU profiling of the dense synthetic day fixture located a 39.8-second
hotspot in automatic annotation collision measurement, not source loading.
Using a normal zero series avoids that work without dropping or downsampling any
rows and without changing the pinned plugin runtime. Verify fresh timing in the
actual browser; the QA fixture is not market evidence.
