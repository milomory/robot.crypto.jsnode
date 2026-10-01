import { runSettlementScenario } from '../paper-pair/settlement-scenario.js';
const [input, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || extra.length) throw new Error('invalid-arguments');
  console.log(JSON.stringify(await runSettlementScenario(input, output)));
} catch {
  console.error('Offline settlement scenario failed. Use SCENARIO_JSON NEW_OUTPUT_DIRECTORY. Existing files are preserved.');
  process.exitCode = 1;
}
