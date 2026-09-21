import { collectExact } from '../market-exact/collect.js';
import { PLAN, STUDY_PLAN } from '../market-exact/archive.js';

const args = process.argv.slice(2);
const study = args[0] === '--study-30m';
if (study) args.shift();
const profile = study ? STUDY_PLAN : PLAN;
const [directory, ...extra] = args;
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
try {
  if (!directory || directory.startsWith('--') || extra.length) throw new Error();
  const result = await collectExact(directory, controller.signal, undefined, profile);
  console.log(JSON.stringify(result));
  if (result.status !== 'completed') process.exitCode = 1;
} catch {
  console.error('Exact public capture failed; inspect the preserved archive. No automatic retry.');
  process.exitCode = 1;
}
