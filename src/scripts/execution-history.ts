import { parsePairInput, loadCooldowns, persistentFetch, writePrivateJson } from '../accounts/pair-runtime.js';
import { collectExecutionHistory } from '../accounts/execution-history.js';
import { writeExecutionCapture } from '../accounts/execution-archive.js';
const startedAt = Date.now();
process.umask(0o077);
let raw: Buffer | undefined;
async function input() {
  const chunks: Buffer[] = []; let size = 0;
  const timeout = setTimeout(() => process.stdin.destroy(new Error('history-input-timeout')), 5000);
  try {
    for await (const part of process.stdin) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); size += chunk.length;
      if (size > 40 * 1024) { chunk.fill(0); throw new Error(); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timeout); chunks.forEach(c => c.fill(0)); }
}
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
  raw = await input(); const bundles = parsePairInput(raw); raw.fill(0); raw = undefined;
  // Shared observer flock is held by the outer runner throughout this process.
  const cooldowns = await loadCooldowns('/observer-state');
  let saveQueue = Promise.resolve();
  const save = () => {
    const pending = saveQueue.then(() => writePrivateJson('/observer-state', 'cooldowns.json', cooldowns));
    saveQueue = pending.catch(() => {}); return pending;
  };
  const request = persistentFetch(cooldowns, save);
  const report = await collectExecutionHistory({ mexc: bundles.mexc.executionHistoryReader({ fetch: request }),
    okx: bundles.okx.executionHistoryReader({ fetch: request }) }, { deadline: startedAt + 35_000,
    onRateLimit: async venue => { cooldowns[venue] = Math.max(cooldowns[venue], Date.now() + 60_000); await save(); } });
  await saveQueue;
  await writeExecutionCapture('/state', report, bundles.assertNoSecrets);
  const summary = { schema: 1, mode: 'execution-history-readonly', captureId: report.captureId,
    checkedAt: new Date(report.endedAt).toISOString(), venues: { mexc: report.venues.mexc.meta, okx: report.venues.okx.meta },
    reportWritten: true, executable: false };
  const text = JSON.stringify(summary); bundles.assertNoSecrets(text); process.stdout.write(text + '\n');
} catch {
  process.stdout.write('{"schema":1,"error":"history-failed"}\n'); process.exitCode = 1;
} finally { raw?.fill(0); }
