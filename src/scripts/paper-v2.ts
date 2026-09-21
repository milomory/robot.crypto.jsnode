import { runOffline } from '../paper-v2/io.js';

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('usage: paper-v2 FIXTURE NEW_OUTPUT_DIR');
  process.exitCode = 1;
} else {
  try {
    const result = await runOffline(args[0], args[1]);
    console.log(JSON.stringify({ scenarioId: result.scenarioId }));
  } catch {
    // Never print input values, paths, schema issues, or nested exception text.
    console.error('paper-v2 replay failed');
    process.exitCode = 1;
  }
}
