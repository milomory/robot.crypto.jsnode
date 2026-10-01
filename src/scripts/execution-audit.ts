import { writeExecutionAudit } from '../paper-pair/execution-audit-report.js';
const [input, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || extra.length) throw new Error();
  console.log(JSON.stringify(await writeExecutionAudit(input, output)));
} catch {
  console.error('Offline order audit failed. Use RECORD_JSON NEW_OUTPUT_DIRECTORY. No existing files are overwritten.');
  process.exitCode = 1;
}
