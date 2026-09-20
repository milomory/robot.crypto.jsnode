import { initStore } from '../lab/observation-store.js';
import { runCampaign } from '../lab/campaign.js';
import { readReport } from '../lab/observations.js';

const [command, root, ...extra] = process.argv.slice(2);
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  if (!root || extra.length) throw new Error();
  if (command === 'init') { await initStore(root); console.log(JSON.stringify({ initialized: true })); }
  else if (command === 'run') console.log(JSON.stringify(await runCampaign(root, controller.signal)));
  else if (command === 'report') console.log(JSON.stringify(await readReport(root), null, 2));
  else throw new Error();
} catch {
  console.error('Campaign failed; inspect the managed store and collection state. No automatic restart.');
  process.exitCode = 1;
}
