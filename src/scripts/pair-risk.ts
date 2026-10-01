import { runPaperRiskScenario } from '../paper-pair/risk-scenario.js';

const [input, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || extra.length) throw new Error('invalid-arguments');
  console.log(JSON.stringify(await runPaperRiskScenario(input, output)));
} catch {
  console.error('Offline paper risk scenario failed. Use SCENARIO_JSON NEW_OUTPUT_DIRECTORY. Existing files are preserved.');
  process.exitCode = 1;
}
