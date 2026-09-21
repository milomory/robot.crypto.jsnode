import { collectExact } from '../market-exact/collect.js';

const [directory, ...extra] = process.argv.slice(2);
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
try {
  if (!directory || extra.length) throw new Error();
  const result = await collectExact(directory, controller.signal);
  console.log(JSON.stringify(result));
  if (result.status !== 'completed') process.exitCode = 1;
} catch {
  console.error('Exact public capture failed; inspect the preserved archive. No automatic retry.');
  process.exitCode = 1;
}
