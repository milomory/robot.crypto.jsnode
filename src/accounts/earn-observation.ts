import { AccountError } from './types.js';
import { okxEarnSchema, type EarnPeriod, type OkxEarnBalance, type OkxEarnHistoryRecord,
  type OkxEarnObservation, type OkxEarnReader } from './earn-contract.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_PAGES = 9;
// Both savings/balance and savings/lending-history: 6 requests/second, User ID.
// https://my.okx.com/docs-v5/en/#financial-product-simple-earn-flexible-get-lending-history
// Keep our combined Earn reads below that limit, even with immediate responses.
const MIN_REQUEST_INTERVAL_MS = 201;
const SCALE = 10n ** 30n;
function atoms(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return BigInt(whole + fraction.padEnd(30, '0')) * (negative ? -1n : 1n);
}
function format(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(30, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / SCALE}${fraction ? '.' + fraction : ''}`;
}
function validClock(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 30 * DAY || value > 8_640_000_000_000_000) {
    throw new AccountError('account-invalid-clock');
  }
  return value;
}
function same(a: OkxEarnHistoryRecord, b: OkxEarnHistoryRecord): boolean {
  return atoms(a.amount) === atoms(b.amount) && atoms(a.earnings) === atoms(b.earnings);
}

/**
 * Bounded reading of one product in one main account. API rows, never balance
 * changes, establish earnings. A missing hourly row is not assumed to mean zero.
 * The API's "past month" retention does not by itself prove a full 30-day window.
 * A history lending amount has no documented interval or guarantee that it
 * represents all subscribed funds, so neither a current nor historical row is
 * used to manufacture effective annual yield.
 */
export async function collectOkxEarn(reader: OkxEarnReader,
  options: { clock?: () => number; deadlineAt?: number; onRateLimit?: () => Promise<void>;
    wait?: (milliseconds: number) => Promise<void> } = {}): Promise<OkxEarnObservation> {
  const clock = options.clock ?? Date.now;
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const observedAt = validClock(clock());
  const deadline = Math.min(observedAt + 35_000,
    options.deadlineAt === undefined ? observedAt + 35_000 : validClock(options.deadlineAt));
  let previousClock = observedAt;
  let lastRequestAt: number | null = null;
  const readClock = () => {
    const now = validClock(clock());
    if (now < previousClock) throw new AccountError('account-invalid-clock');
    previousClock = now;
    return now;
  };
  const reserveRequest = async () => {
    let now = readClock();
    const interval = lastRequestAt === null ? 0 : Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - lastRequestAt));
    // AccountTransport bounds response+body at five seconds. Include pacing
    // before making a request reservation, then recheck after timer scheduling.
    if (now + interval + 5_000 > deadline) return false;
    if (interval > 0) {
      await wait(interval);
      now = readClock();
    }
    if (now + 5_000 > deadline) return false;
    lastRequestAt = now;
    return true;
  };
  let stopAfterBalanceFailure = false;
  const recordFailure = async (error: unknown) => {
    if (!(error instanceof AccountError)) return false;
    if (error.code === 'account-rate-limited') {
      try { await options.onRateLimit?.(); } catch { /* Failed persistence never exposes raw failure data. */ }
    }
    return ['account-rate-limited', 'account-auth-failed', 'account-access-denied',
      'account-api-rejected', 'account-invalid-credentials'].includes(error.code);
  };
  let balance: OkxEarnBalance | null = null;
  let balanceStatus: OkxEarnObservation['balanceStatus'] = 'unavailable';
  try {
    if (await reserveRequest()) {
      balance = await reader.getEarnBalance();
      balanceStatus = 'available';
    }
  } catch (error) { stopAfterBalanceFailure = await recordFailure(error); }

  const all = new Map<number, OkxEarnHistoryRecord>();
  const duplicates = new Set<number>();
  const conflicts = new Set<number>();
  let duplicateRecords = 0;
  let pages = 0;
  let after: string | undefined;
  let pagination: OkxEarnObservation['history']['pagination'] = 'page-limit';
  const from = observedAt - 30 * DAY;
  for (let index = 0; index < MAX_PAGES; index++) {
    if (stopAfterBalanceFailure) { pagination = 'read-error'; break; }
    let rows: OkxEarnHistoryRecord[];
    try {
      if (!(await reserveRequest())) { pagination = 'deadline'; break; }
      rows = await reader.getEarnHistoryPage(after);
      pages++;
    } catch (error) { await recordFailure(error); pagination = 'read-error'; break; }
    // Timestamp ordering/currency/precision are checked by the reader before
    // this projection. Do not count a new hourly entry after our fixed cutoff.
    for (const row of rows) {
      if (row.at > observedAt) continue;
      const prior = all.get(row.at);
      if (prior) {
        duplicateRecords++;
        duplicates.add(row.at);
        if (!same(row, prior)) conflicts.add(row.at);
      } else all.set(row.at, row);
    }
    if (conflicts.size) { pagination = 'conflict'; break; }
    const oldest = rows.at(-1)?.at;
    if (rows.length === 0) { pagination = 'exhausted'; break; }
    // At most one record per currency/timestamp can be addressed by this API.
    // Advancing beyond a repeated timestamp could otherwise hide ambiguity.
    if (oldest === undefined || (after !== undefined && oldest >= Number(after))) {
      pagination = 'stalled'; break;
    }
    if (oldest <= from) { pagination = 'window-covered'; break; }
    if (rows.length < 100) { pagination = 'exhausted'; break; }
    after = String(oldest);
  }
  const rows = [...all.values()].filter(row => row.at > from).sort((a, b) => a.at - b.at);
  const gapsDetected = rows.some((row, index) => index > 0 && row.at - rows[index - 1].at > HOUR);
  const paginationComplete = ['exhausted', 'window-covered'].includes(pagination);
  const historyStatus = pages === 0 ? 'unavailable' :
    paginationComplete && duplicateRecords === 0 && !gapsDetected ? 'complete' : 'partial';
  const period = (days: 7 | 30): EarnPeriod => {
    const start = observedAt - days * DAY;
    const selected = rows.filter(row => row.at > start);
    const first = selected[0]?.at ?? null;
    const last = selected.at(-1)?.at ?? null;
    const ambiguous = [...conflicts].some(at => at > start && at <= observedAt);
    const duplicate = [...duplicates].some(at => at > start && at <= observedAt);
    const continuous = selected.every((row, index) => index === 0 || row.at - selected[index - 1].at === HOUR);
    // An exhausted endpoint with only recent subscriptions is not proof of
    // zero earnings earlier in the requested period. Require an unambiguous
    // row in every hourly slot and a cursor crossing that period's start.
    const olderBoundarySeen = [...all.keys()].some(at => at <= start);
    const coverageComplete = !ambiguous && !duplicate && first !== null && last !== null &&
      selected.length === days * 24 && continuous && first - start <= HOUR && observedAt - last < HOUR &&
      (paginationComplete || olderBoundarySeen);
    const earnings = pages === 0 || ambiguous ? null : format(selected.reduce((sum, row) => sum + atoms(row.earnings), 0n));
    return { days, from: start, to: observedAt, recordedEarningsUsdt: earnings, records: selected.length,
      coverage: earnings === null ? 'unavailable' : coverageComplete ? 'complete' : 'partial',
      firstRecordAt: first, lastRecordAt: last, realizedAprPercent: null,
      yieldReason: 'historical-principal-intervals-unavailable' };
  };
  const periods = { days7: period(7), days30: period(30) };
  return okxEarnSchema.parse({
    schema: 1, venue: 'okx', product: 'simple-earn-flexible', currency: 'USDT', observedAt,
    status: balanceStatus === 'unavailable' && pages === 0 ? 'unavailable' :
      balanceStatus === 'available' && historyStatus === 'complete' &&
      periods.days7.coverage === 'complete' && periods.days30.coverage === 'complete' ? 'available' : 'partial',
    balanceStatus, principalUsdt: balanceStatus === 'available' ? balance?.amount ?? '0' : null,
    lendingUsdt: balanceStatus === 'available' ? balance?.lendingAmount ?? '0' : null,
    pendingUsdt: balanceStatus === 'available' ? balance?.pendingAmount ?? '0' : null,
    // An absent product row proves no current holding, not zero past earnings.
    reportedEarningsUsdt: balanceStatus === 'available' ? balance?.reportedEarnings ?? null : null,
    reportedEarningsPeriod: 'unspecified',
    history: { status: historyStatus, pagination, pages, records: rows.length,
      firstRecordAt: rows[0]?.at ?? null, lastRecordAt: rows.at(-1)?.at ?? null,
      gapsDetected, duplicateRecords, conflictingRecords: conflicts.size }, periods,
  });
}
