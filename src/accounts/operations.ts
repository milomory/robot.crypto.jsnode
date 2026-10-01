import type { AccountDashboard, DashboardOperation } from './dashboard-contract.js';
import { AccountError } from './types.js';
import type { MexcAccountReader } from './mexc.js';
import type { OkxAccountReader } from './okx.js';
import type { OperationFeed } from './operation-records.js';

// Recent exchange activity includes manually initiated actions. It is a bounded
// window, not an audit ledger or evidence of which actor initiated an operation.
export async function observeRecentOperations(
  mexc: Pick<MexcAccountReader, 'getOpenOrders'|'getRecentTrades'|'getDeposits'|'getWithdrawals'>,
  okx: Pick<OkxAccountReader, 'getOpenOrders'|'getRecentTrades'|'getDeposits'|'getWithdrawals'>,
  options: { clock?: () => number; deadline?: number; onRateLimit?: (venue:'mexc'|'okx') => Promise<void> } = {}
): Promise<AccountDashboard['operations']> {
  const clock = options.clock ?? Date.now, start = clock(), since = start - 7 * 86400_000;
  if (!Number.isSafeInteger(start) || start <= 0) throw new Error('operations-invalid-clock');
  const deadline = options.deadline ?? start + 35_000;
  let failed = 0, succeeded = 0, truncated = false;
  const items: DashboardOperation[] = [];
  async function collect(venue: 'mexc'|'okx', reads: Array<() => Promise<OperationFeed>>) {
    let limited = false;
    for (const read of reads) {
      if (limited || clock() > deadline - 5000) { failed++; continue; }
      try {
        const result = await read(); succeeded++; truncated ||= result.truncated;
        items.push(...result.items.filter(row => row.isOpen || row.at >= since));
      } catch (error) {
        failed++;
        if (error instanceof AccountError && error.code === 'account-rate-limited') {
          limited = true; await options.onRateLimit?.(venue);
        }
      }
    }
  }
  await Promise.all([
    collect('mexc', [() => mexc.getOpenOrders(), () => mexc.getRecentTrades('BTC/USDT'),
      () => mexc.getRecentTrades('ETH/USDT'), () => mexc.getRecentTrades('SOL/USDT'),
      () => mexc.getDeposits(), () => mexc.getWithdrawals()]),
    collect('okx', [() => okx.getOpenOrders(), () => okx.getRecentTrades(), () => okx.getDeposits(), () => okx.getWithdrawals()])
  ]);
  const unique = [...new Map(items.map(row => [row.id, row])).values()].sort((a,b) => b.at - a.at || a.id.localeCompare(b.id));
  truncated ||= unique.length > 500;
  // Keep current operations ahead of old records at the bounded projection edge.
  const selected = unique.filter(row => row.isOpen).concat(unique.filter(row => !row.isOpen)).slice(0,500).sort((a,b) => b.at-a.at);
  const coverage = 'История за 7 дней, до 100 записей на источник. Сделки: MEXC BTC/ETH/SOL–USDT, OKX спот. Текущие спот-ордера, вводы/выводы. Внутренние переводы не включены.';
  return { status: !succeeded ? 'error' : failed || truncated ? 'partial' : 'available', items: selected,
    coverageLabel: coverage + (failed ? ' Часть запросов не выполнена.' : '') + (truncated ? ' Достигнут лимит записей.' : '') };
}
