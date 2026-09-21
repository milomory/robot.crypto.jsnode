import { runObservedStudyTo } from '../market-exact/study.js';

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('usage: paper-study EXACT_ARCHIVE NEW_OUTPUT_DIR');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await runObservedStudyTo(args[0], args[1]))); }
  catch {
    console.error('Paper study failed; inspect the preserved inputs and output. No automatic retry.');
    process.exitCode = 1;
  }
}
