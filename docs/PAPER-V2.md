# Offline paper-v2 account

Implemented 2026-09-21. This is the first offline accounting stage from
[PAPER-V2-PLAN.md](PAPER-V2-PLAN.md). It runs synthetic BTC/USDT fixtures through
an exact account ledger. It has no network, production configuration, database,
Auth, exchange credentials, strategy loop or automatic continuation.

## Run and inspect

```sh
# From the checkout with its existing Node dependencies installed:
mkdir -p output
npm run lab:paper-v2 -- fixtures/paper-v2/basic.json output/paper-v2-first
# After npm run build:api, the same CLI is available without tsx:
node dist/scripts/paper-v2.js fixtures/paper-v2/basic.json output/paper-v2-built
```

The output directory must be new; its parent must already exist. Reusing any
existing output directory fails without modifying it, including an empty one.
Both commands publish one `result.json` with identical bytes for identical input
bytes. Output has no wall-clock time or filesystem path. The CLI prints only the
scenario ID; malformed inputs produce a fixed error, not source contents.

Input is a regular non-symlink file, at most 2 MiB and 1000 scenario steps.
Output is a new directory with mode 0700 and a file with mode 0600. The file is
fsynced and published atomically through an exclusive hard link; existing data
is never replaced. If writing fails, inspect the new directory before doing
anything else: partial evidence is retained, with no automatic cleanup/resume.
No scheduled retention or quota worker is installed by this offline command.

The strict schema lives in `src/paper-v2/schema.ts`. It requires `synthetic:true`,
explicit starting balances, costs, instrument rules and a fixed benchmark size.
All money/prices/quantities are unsigned decimal **strings**, at most 20 integer
and 8 fractional digits. Numeric JSON money, exponents, fee assets other than
USDT and unknown fields are rejected. Intermediate products use arbitrary-size
integers; output amounts have eight decimal places. Times are integer epoch ms.
The first model requires positive minimum quantity and quantity step. It does
not infer missing or disabled public exchange rules.

## Accounting and execution

- One venue per scenario; balances are keyed by venue and asset. A second venue
  needs its own independently funded account. There are no implicit transfers.
- Each accepted full fill posts cash, BTC, fees and FIFO lot changes together.
  Missing/stale books, future local receipt/metadata, invalid increments/limits,
  insufficient depth/cash/base and unsupported inputs cannot debit the account.
  Rejected valid intents remain in the journal with zero postings.
- Local request/receipt and instrument fetch times cannot be later than the event.
  Books have a 5-second age limit, metadata 1 hour. External source timestamps,
  when present, allow at most 1 second future clock skew; absence is labelled.
- Buys walk asks; sells walk bids. Exact raw quote is the sum of price times
  quantity. Slippage increases buy cost and reduces sell proceeds. Fees use the
  exact adjusted gross, before gross rounding, and are always charged in USDT.
- Buy gross and fees round up to one USDT atom (0.00000001); sell gross rounds
  down and fees up. Cash equals rounded gross plus/minus the rounded fee.
  Each fill stores exact raw/slippage fractions and the adverse cash-rounding
  fraction. Fraction units are **USDT atoms**, not USDT. No floating-point money.
- Acquisition cost includes buy fees/slippage. FIFO releases cost on sale;
  partial-lot cost floors to a quote atom and leaves the residual in the lot.
  Closing a lot releases all its original cost. Opening BTC requires an explicit
  cost basis, including an explicit zero for a zero-cost synthetic acquisition.
- After every event, cash and BTC reconcile to starting balances plus postings,
  lot quantities reconcile to BTC, acquired/released costs reconcile to remaining
  cost, and `cash + remaining cost = opening cash + opening cost + realised P/L`.
- Same event ID and content is a no-op, even on redelivery after later events.
  An ID with different content or a new out-of-order/equal-time event fails.
  Prefix delivery plus the remaining events produces the same final journal.
  Process recovery is by full deterministic replay, not a mutable checkpoint.

`schema:1`, `model:paper-v2-exact-1`, `ledgerSchema:1` and
`costModel:quote-fee-exact-gross-v1` version the result. A deterministic
`pv2-<canonical-input-SHA256>` identifies the run; the source-byte hash separately
records formatting changes. Input assumptions, event hashes, balances, FIFO
lots and reconciliation results are included in the result.

## Equity, drawdown and benchmarks

Equity uses full liquidation through valid bids, with assumed exit costs.
These exit costs affect valuation only until a sell occurs; they are not posted
twice. Cash-only accounts need no market mark. For open BTC, missing/stale data,
insufficient depth or a size rule that prevents full liquidation makes valuation
unavailable. No previous mark is silently carried forward.

The equity schedule includes opening valuation and the state after each unique
event. Maximum drawdown includes open positions at those points; it does not
claim to capture price extremes between snapshots. Any unavailable point makes
whole-period return and drawdown unavailable, with coverage counts retained.
Zero opening equity has no percentage return or percentage drawdown. Percentage
strings truncate to six decimals; accounting amounts remain exact.

The cash baseline (or `hold-opening-assets` when initial BTC is nonzero) and a
fixed-quantity buy-and-hold path share starting balances, venue, timestamps,
books and costs. Buy-and-hold attempts entry once at the first event, with no
retry or parameter search. Failed entry or any incomplete path marks the
comparison non-comparable. The report is fixture accounting, not an assessment
of strategy performance or executable cross-venue arbitrage.

## Verification and next gate

50 new tests passed; full suite 177 passed and 15 existing PostgreSQL integration
tests skipped because no disposable test DB was configured. Backend typecheck
and complete build passed. Tests cover exact fractions/large values, FIFO,
partial sales, rejections, idempotency, chronology/look-ahead, opening cost,
venue isolation, open-position drawdown, missing valuation, benchmark entry,
file boundaries, deterministic publication and fixed CLI errors. A transitive
import allowlist and fetch trap protect the offline boundary.

The source and built CLI independently produced byte-identical results for the
included fixture. Starting from **synthetic** 1000 USDT/0 BTC: two fills, one
rejected sale, final cash 940.18937020 USDT, remaining 0.00060000 BTC,
realised P/L +0.27940020 USDT, final liquidation equity 998.90119960 USDT,
maximum observed drawdown 1.79730090 USDT. These are invented scenario prices,
not the running robot's results or a profit forecast.
See [acceptance evidence](evidence/paper-v2-20260921/acceptance.json).

Next: preserve exchange decimal strings in a separate versioned observation
format and verify their conversion into this model. The first depth-v2 archive
contains JSON numbers and is not accepted as exact monetary input. Then replay
a fixed real period with identical benchmark assumptions before assessing a
strategy. More venues, keys, a dashboard or an autonomous worker are not part
of this first implementation. A worker still requires the separate namespace,
storage/backup plan and scoped rollback in the plan. Hyperion remains on its
existing paper engine; this change does not require a server restart.
