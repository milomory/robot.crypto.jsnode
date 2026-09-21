import { replayObservedTo } from '../market-exact/replay.js';

const [input, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || extra.length) throw new Error();
  console.log(JSON.stringify(await replayObservedTo(input, output)));
} catch {
  console.error('Exact market replay failed; input must be a complete unchanged archive.');
  process.exitCode = 1;
}
