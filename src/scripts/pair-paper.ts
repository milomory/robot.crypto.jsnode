import { readArchiveFile } from '../market-exact/archive.js';
import { collectPair } from '../paper-pair/capture.js';
import { writePairReport } from '../paper-pair/report.js';

const [command, input, output, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || extra.length || !['collect', 'collect-study', 'collect-day', 'report', 'report-diagnostics'].includes(command)) throw new Error();
  const result = command.startsWith('collect') ? await collectPair(output, await readArchiveFile(input),
    { profile: command === 'collect-day' ? 'study-24h' : command === 'collect-study' ? 'study-30m' : 'probe' }) : await writePairReport(input, output, { scheduleDiagnostics: command === 'report-diagnostics' });
  console.log(JSON.stringify(result));
} catch {
  console.error('Paired paper lab failed. Use collect/collect-study/collect-day FEES_JSON NEW_ARCHIVE or report/report-diagnostics ARCHIVE NEW_OUTPUT. Preserve evidence; no automatic retry.');
  process.exitCode = 1;
}
