import { randomUUID } from 'node:crypto';
import { auditRecordedOrder } from '../paper-pair/execution-audit.js';
import { auditOrderCash } from '../paper-pair/cash-audit.js';
import { ExecutionHistoryReader, type HistoryRead, type HistoryVenue, type HistoryWindow } from './execution-reader.js';
import { AccountError } from './types.js';
import { summarizeRecordedFees } from './recorded-fees.js';
type Row = Record<string, unknown>;
export const HISTORY_POLICY = { windowDays: 6, maxPages: 3, maxOrders: 2, maxRequestsPerVenue: 12, durationMs: 35_000 } as const;
function millis(value: unknown): number {
  const n = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error('invalid-source-time');
  return n;
}
function orderId(row: Row, venue: HistoryVenue): string {
  const value = row[venue === 'mexc' ? 'orderId' : 'ordId'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid-source-order');
  return value;
}
export async function collectExecutionHistory(readers: Record<HistoryVenue, Pick<ExecutionHistoryReader, 'getFills' | 'getBills' | 'getOrder'>>, options: {
  clock?: () => number; deadline?: number; onRateLimit?: (venue: HistoryVenue) => Promise<void>;
} = {}) {
  const clock = options.clock ?? Date.now, startedAt = clock();
  if (!Number.isSafeInteger(startedAt) || startedAt <= 6 * 86400_000) throw new Error('history-invalid-clock');
  if (options.deadline !== undefined && (!Number.isSafeInteger(options.deadline) || options.deadline <= startedAt)) throw new Error('history-invalid-deadline');
  const deadline = Math.min(options.deadline ?? startedAt + HISTORY_POLICY.durationMs, startedAt + HISTORY_POLICY.durationMs);
  const range = { from: startedAt - HISTORY_POLICY.windowDays * 86400_000, to: startedAt };
  async function venueCapture(venue: HistoryVenue) {
    const observedFeeRows: Row[] = [];
    const reads: HistoryRead[] = [], errors: Array<{ stage: string; reason: string }> = [], orders: Array<Record<string, unknown>> = [];
    const meta = { requests: 0, successfulRequests: 0, discoveredOrders: 0, capturedOrders: 0, fillRows: 0, billRows: 0, errors: 0, truncated: false };
    let stopped = false, lastClock = startedAt;
    function issue(stage: string, reason: string) { errors.push({ stage, reason }); meta.errors++; meta.truncated = true; }
    async function read(stage: string, call: () => Promise<HistoryRead>): Promise<HistoryRead | null> {
      const now = clock();
      if (stopped) return null;
      if (!Number.isSafeInteger(now) || now < lastClock || now > deadline - 5000 || meta.requests >= HISTORY_POLICY.maxRequestsPerVenue) {
        stopped = true; issue(stage, 'request-budget-or-clock'); return null;
      }
      lastClock = now; meta.requests++;
      try {
        const result = await call(), end = clock();
        if (!Number.isSafeInteger(end) || !Number.isSafeInteger(result.requestedAt) || !Number.isSafeInteger(result.receivedAt) ||
            end < now || end > deadline || result.requestedAt < now ||
            result.receivedAt < result.requestedAt || result.receivedAt > end) throw new Error('invalid-receipt');
        lastClock = end; reads.push(result); meta.successfulRequests++; return result;
      } catch (error) {
        const limited = error instanceof AccountError && error.code === 'account-rate-limited';
        issue(stage, limited ? 'rate-limited' : 'read-failed');
        // Do not issue further private reads with a rejected/uncertain authorization or rate state.
        stopped = true;
        if (limited) await options.onRateLimit?.(venue);
        return null;
      }
    }
    async function pages(kind: 'fills' | 'bills', stage: string, window: HistoryWindow, selected?: string) {
      const rows: Row[] = [], pageLengths: number[] = []; let cursor: string | undefined;
      const limit = venue === 'mexc' ? 1000 : 100;
      for (let i = 0; i < (venue === 'mexc' ? 1 : HISTORY_POLICY.maxPages); i++) {
        const result = await read(stage, () => kind === 'fills' ? readers[venue].getFills(window, selected, cursor) : readers[venue].getBills(window, cursor));
        if (!result) return { rows, pageLengths, drained: false };
        const page = result.data as Row[];
        if (!Array.isArray(page)) { issue(stage, 'invalid-page'); stopped = true; return { rows, pageLengths, drained: false }; }
        try {
          for (const item of page) {
            if (!item || typeof item !== 'object' || Array.isArray(item) ||
                (venue === 'mexc' ? item.symbol !== 'BTCUSDT' : item.instType !== 'SPOT' || item.instId !== 'BTC-USDT')) throw new Error();
            const at = millis(item[venue === 'mexc' ? 'time' : 'ts']);
            if (at < window.from || at > window.to || at > result.receivedAt) throw new Error();
            if (kind === 'fills') { const sourceId = orderId(item, venue); if (selected !== undefined && sourceId !== selected) throw new Error(); }
          }
          if (venue === 'okx') {
            const ids = page.map(item => {
              if (typeof item.billId !== 'string' || !/^[1-9][0-9]{0,39}$/.test(item.billId)) throw new Error();
              const value = BigInt(item.billId);
              if (cursor !== undefined && value >= BigInt(cursor)) throw new Error();
              return value;
            });
            if (ids.length) cursor = ids.reduce((a, b) => a < b ? a : b).toString();
          }
        } catch { issue(stage, 'page-scope-or-cursor'); stopped = true; return { rows, pageLengths, drained: false }; }
        // Only scope/time/cursor-validated pages enter fee arithmetic. Discovery and
        // per-order rereads may overlap; the summary rejects conflicts and counts exact duplicates once.
        if (kind === 'fills') observedFeeRows.push(...page);
        pageLengths.push(page.length); rows.push(...page);
        if (kind === 'fills') meta.fillRows += page.length; else meta.billRows += page.length;
        if (page.length < limit) return { rows, pageLengths, drained: true };
      }
      issue(stage, 'page-budget'); return { rows, pageLengths, drained: false };
    }
    const discovery = await pages('fills', 'discovery', range);
    const discovered = [...new Set(discovery.rows.map(r => orderId(r, venue)))];
    meta.discoveredOrders = discovered.length;
    if (discovered.length > HISTORY_POLICY.maxOrders) issue('selection', 'order-budget');
    // Bills are archived as independent evidence. No gross/net formula is inferred.
    const bills = venue === 'okx' ? await pages('bills', 'bills', range) : { rows: [] as Row[], pageLengths: [] as number[], drained: false };
    for (const selected of discovered.slice(0, HISTORY_POLICY.maxOrders)) {
      const before = await read('order-before', () => readers[venue].getOrder(selected));
      if (!before) break;
      const order = before.data as Row;
      let createdAt: number;
      try {
        createdAt = millis(order[venue === 'mexc' ? 'time' : 'cTime']);
        if (orderId(order, venue) !== selected || createdAt < range.from || createdAt > range.to ||
            (venue === 'okx' && order.instType !== 'SPOT')) throw new Error();
      } catch { issue('order-before', 'order-scope-or-retention'); continue; }
      // Fresh per-order end includes fills arriving after initial discovery.
      const orderRange = { from: createdAt, to: before.receivedAt };
      const fills = await pages('fills', 'order-fills', orderRange, selected);
      const after = await read('order-after', () => readers[venue].getOrder(selected));
      const linkedBills = bills.rows.filter(r => r.ordId === selected);
      const tradeIds = new Set(fills.rows.map(r => r.tradeId).filter(id => typeof id === 'string'));
      const fillBillIds = new Set(fills.rows.map(r => r.billId).filter(id => typeof id === 'string'));
      // Conflicting or missing order links must not vanish just because another
      // supported identity connects the bill to this order's executions.
      const related = (r: Row) => r.ordId === selected || (typeof r.tradeId === 'string' && tradeIds.has(r.tradeId)) ||
        (typeof r.billId === 'string' && fillBillIds.has(r.billId));
      const relatedBillIds = new Set(bills.rows.filter(related).map(r => r.billId).filter(id => typeof id === 'string'));
      // Include conflicting duplicates even if their changed order/trade links
      // would otherwise make them look unrelated after filtering.
      const cashRows = bills.rows.filter(r => related(r) || (typeof r.billId === 'string' && relatedBillIds.has(r.billId)));
      const cashCaptureBlockers: string[] = [];
      const captured: Record<string, unknown> = { orderId: selected, before, fills, after,
        linkedBills, billsWindow: range, billsAreSettlementEvidence: false, audit: null, cashAudit: null,
        cashCaptureBlockers, billEvidence: venue === 'okx' ? { window: range, pageLengths: bills.pageLengths,
          drained: bills.drained, sourceRows: bills.rows.length, selectedRows: linkedBills.length,
          candidateRows: cashRows.length } : null };
      orders.push(captured);
      if (!after || !fills.drained) { issue('audit', 'incomplete-order-capture'); cashCaptureBlockers.push('incomplete-order-capture'); continue; }
      meta.capturedOrders++;
      // Preserve multi-page material but do not bypass the current single-page audit contract.
      if (fills.rows.length >= (venue === 'mexc' ? 1000 : 100)) { captured.audit = { blocked: 'audit-page-boundary' }; cashCaptureBlockers.push('audit-page-boundary'); continue; }
      const side = venue === 'mexc' ? order.side === 'BUY' ? 'buy' : order.side === 'SELL' ? 'sell' : null : order.side;
      const orderInput = { schema: 1, kind: 'recorded-order-audit', source: 'recorded', account: 'main', venue,
          observedAt: after.receivedAt, expected: { orderId: selected, side }, limit: venue === 'mexc' ? 1000 : 100,
          orderBefore: venue === 'mexc' ? before.data : { code: '0', data: [before.data] },
          orderAfter: venue === 'mexc' ? after.data : { code: '0', data: [after.data] },
          fills: venue === 'mexc' ? fills.rows : { code: '0', data: fills.rows } };
      try { captured.audit = auditRecordedOrder(orderInput); }
      catch { captured.audit = { blocked: 'unsupported-or-conflicting-records' }; cashCaptureBlockers.push('unsupported-or-conflicting-records'); continue; }
      const singleBillPage = bills.drained && bills.pageLengths.length === 1 && bills.pageLengths[0] < 100;
      if (venue === 'okx' && !singleBillPage) cashCaptureBlockers.push(bills.drained ? 'cash-bill-page-boundary' : 'incomplete-bill-capture');
      try {
        captured.cashAudit = auditOrderCash({ schema: 1, kind: 'order-cash-audit', order: orderInput,
          ...(venue === 'okx' && singleBillPage ? { bills: { window: range, limit: 100, rows: cashRows } } : {}) });
      } catch { cashCaptureBlockers.push('unsupported-or-conflicting-cash-records'); }
    }
    const feeSummary = summarizeRecordedFees({ venue, rows: observedFeeRows });
    const incomplete = meta.truncated || !discovery.drained;
    // A failed/partial capture must not look like observed zero fees or a complete total.
    // Keep raw validated observations, but withhold the aggregate until the bounded capture succeeds.
    const feeObservation = { ...feeSummary,
      status: incomplete && feeSummary.status !== 'invalid' ? 'incomplete' as const : feeSummary.status,
      totals: incomplete ? null : feeSummary.totals,
      captureTruncated: meta.truncated, discoveryDrained: discovery.drained,
      captureReasons: incomplete ? ['capture-incomplete'] as const : [] };
    return { meta, reads, errors, discoveryDrained: discovery.drained, billsDrained: venue === 'okx' ? bills.drained : null, orders, feeObservation };
  }
  const [mexc, okx] = await Promise.all([venueCapture('mexc'), venueCapture('okx')]);
  return { schema: 1, kind: 'private-execution-history-capture', captureId: randomUUID(), startedAt, endedAt: clock(),
    policy: HISTORY_POLICY, window: range, account: 'main', symbol: 'BTC/USDT', executable: false,
    wholeAccountHistoryProven: false, orderDiscovery: 'recent-executions-only',
    assumptions: ['Orders without fills are not discovered', 'Only two discovered orders per venue are selected',
      'OKX bills are archived without assigning a reported gross quote',
      'Cash comparison requires one original short bill page and never changes settlement readiness', 'Private projection retains only allowlisted source fields; no signatures or headers'],
    venues: { mexc, okx } };
}
export type ExecutionHistoryCapture = Awaited<ReturnType<typeof collectExecutionHistory>>;
