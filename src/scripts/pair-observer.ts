import { extendAccountCoverage, observeAccountCoverage } from '../accounts/account-coverage.js';
import { unlink } from 'node:fs/promises';
import { updateHistory } from '../accounts/balance-history.js';
import { AccountValuationClient, buildAccountDashboard } from '../accounts/portfolio-observation.js';
import { collectOkxEarn } from '../accounts/earn-observation.js';
import { mexcEarnNotConnected } from '../accounts/mexc-earn.js';
import { observeRecentOperations } from '../accounts/operations.js';
import { accountDashboardSchema, accountDashboardOperationsSchema } from '../accounts/dashboard-contract.js';
import { MexcAccountReader } from '../accounts/mexc.js';
import { OkxAccountReader } from '../accounts/okx.js';
import { observeAccountPair } from '../accounts/pair-observation.js';
import { loadCooldowns, parsePairInput, persistentFetch, writePrivateJson } from '../accounts/pair-runtime.js';
import { ExtendedPublicBookClient } from '../lab/extended-public-books.js';

const directory = '/state';
const dashboardDirectory = '/state/dashboard';
const startedAt = Date.now();
process.umask(0o077);
let raw: Buffer | undefined;
async function input() {
  const chunks: Buffer[] = []; let size = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('observer-input-timeout')), 10_000);
  try {
    for await (const part of process.stdin) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > 40 * 1024) { chunk.fill(0); throw new Error(); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); chunks.forEach(chunk => chunk.fill(0)); }
}
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
  raw = await input();
  const credentials = parsePairInput(raw); raw.fill(0); raw = undefined;
  const cooldowns = await loadCooldowns(directory);
  let saveQueue = Promise.resolve();
  const saveCooldowns = () => {
    const next = saveQueue.then(() => writePrivateJson(directory, 'cooldowns.json', cooldowns));
    saveQueue = next.catch(() => {});
    return next;
  };
  const request = persistentFetch(cooldowns, saveCooldowns);
  const mexc = credentials.mexc.reader({ fetch: request }), okx = credentials.okx.reader({ fetch: request });
  if (!(mexc instanceof MexcAccountReader) || !(okx instanceof OkxAccountReader)) throw new Error();
  const report = await observeAccountPair(mexc, okx, new ExtendedPublicBookClient(request));
  // Also persist HTTP-200 API rate-limit codes reported by the account readers.
  for (const venue of ['mexc', 'okx'] as const) {
    const account = report.accounts[venue];
    if ((account.status === 'unavailable' && account.reason === 'account-rate-limited') ||
        (account.status === 'available' && 'feePayment' in account && account.feePayment.reason === 'account-rate-limited')) {
      cooldowns[venue] = Math.max(cooldowns[venue], Date.now() + 60_000);
    }
  }
  await saveCooldowns();
  const coverage = await observeAccountCoverage(credentials.mexc.mexcFuturesReader({ fetch: request }), okx, {
    deadline: startedAt + 35_000, onRateLimit: async venue => {
      cooldowns[venue] = Math.max(cooldowns[venue], Date.now() + 60_000);
      await saveCooldowns();
    }
  });
  // Public valuation and private history are independent; account-reader calls
  // within each venue stay sequential. The outer worker retains its 55s bound.
  const [dashboard, operations] = await Promise.all([
    (async () => {
      const prices = new AccountValuationClient(request);
      return extendAccountCoverage(await buildAccountDashboard(report, prices), coverage, prices);
    })(),
    observeRecentOperations(mexc, okx, { deadline: startedAt + 45_000, onRateLimit: async venue => {
      cooldowns[venue] = Math.max(cooldowns[venue], Date.now() + 60_000);
      await saveCooldowns();
    } }).then(value => accountDashboardOperationsSchema.parse(value)).catch(() => ({
      status: 'error' as const, items: [], coverageLabel: 'История временно недоступна; баланс получен отдельно.'
    }))
  ]);
  dashboard.operations = operations;
  // Earn uses the same sequential OKX reader and persisted backoff, after
  // account/history reads. It has its own deadline and cannot invalidate
  // independently obtained balances when a product read is unavailable.
  const earnOptions = { deadlineAt: startedAt + 48_000, onRateLimit: async () => {
    cooldowns.okx = Math.max(cooldowns.okx, Date.now() + 60_000);
    await saveCooldowns();
  } };
  const earn = await collectOkxEarn(okx, earnOptions).catch(() => collectOkxEarn({
    getEarnBalance: async () => { throw new Error(); },
    getEarnHistoryPage: async () => { throw new Error(); }
  }));
  dashboard.earn = { okx: earn, mexc: mexcEarnNotConnected() };

  // Observation age continues to reflect balance/price collection, not the
  // time spent reading history. The HTTP reader independently expires it.
  accountDashboardSchema.parse(dashboard);
  credentials.assertNoSecrets(JSON.stringify(dashboard));
  await writePrivateJson(dashboardDirectory, 'current.json', dashboard);
  if (report.checkedAt === null) throw new Error();
  credentials.assertNoSecrets(JSON.stringify(report));
  await writePrivateJson(directory, 'current.json', report);
  // Preserve real historical samples across worker restarts. History failure
  // must not remove the independently verified current account snapshot; its
  // owner-only reader reports the file error or age, never fabricates a point.
  await updateHistory(dashboardDirectory, dashboard, credentials.assertNoSecrets).catch(() => {});
  const summary = { schema: 1, mode: 'observation-only',
    accounts: Object.fromEntries((['mexc', 'okx'] as const).map(venue => [venue, {
      available: report.accounts[venue].status === 'available', feeReadVerified: report.accounts[venue].status === 'available'
    }])),
    books: Object.fromEntries((['mexc', 'okx'] as const).map(venue => [venue, report.books[venue].status === 'available'])),
    comparisonCount: report.comparisons.filter(row => row.status === 'observed').length,
    checkedAt: new Date(report.checkedAt).toISOString(), reportWritten: true, executable: false };
  const encoded = JSON.stringify(summary); credentials.assertNoSecrets(encoded);
  process.stdout.write(encoded + '\n');
} catch {
  await unlink(dashboardDirectory + '/current.json').catch(() => {});
  await writePrivateJson(directory, 'current.json', { schema: 1, mode: 'observation-only', executable: false,
    checkedAt: Date.now(), status: 'blocked', reason: 'observer-failed', comparisons: [] }).catch(() => {});
  process.stdout.write('{"schema":1,"error":"observer-failed"}\n');
  process.exitCode = 1;
} finally { raw?.fill(0); }
