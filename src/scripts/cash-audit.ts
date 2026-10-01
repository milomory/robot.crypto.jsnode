import { writeCashAudit } from '../paper-pair/cash-audit-report.js';
const [input, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || extra.length) throw new Error();
  console.log(JSON.stringify(await writeCashAudit(input, output)));
} catch {
  console.error('Offline cash audit failed. Use RECORD_JSON NEW_OUTPUT_DIRECTORY. Existing files are preserved.');
  process.exitCode = 1;
}
