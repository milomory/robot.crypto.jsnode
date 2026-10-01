import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readArchiveFile, newArchive, writeReplayFile } from '../market-exact/archive.js';
import { canonical } from '../paper-v2/ledger.js';
import { auditRecordedOrder } from './execution-audit.js';

export async function writeExecutionAudit(input: string, output: string) {
  const audit = auditRecordedOrder(await readArchiveFile(input));
  const normalizedSha256 = createHash('sha256').update(canonical(audit)).digest('hex');
  const report = { schema: 1, kind: 'offline-execution-audit-report', normalizedSha256,
    captureProvenanceVerified: false, networkUsed: false, exchangeOrders: 0,
    limitations: ['Source label is supplied by the input producer; this offline audit does not authenticate exchange provenance',
      'Only selected-order consistency is checked; this is not whole-account history or permission to trade',
      'OKX price-times-size quote is diagnostic and cannot be posted as exact settlement',
      'No negative fees, later corrections or precision truncation; unsupported inputs fail'], audit };
  await newArchive(output); await writeReplayFile(join(output, 'report.json'), report);
  // No raw IDs, quantities, fees, credentials or upstream error text on stdout.
  return { source: audit.source, venue: audit.venue, uniqueFills: audit.uniqueFills,
    settlementReady: audit.settlementReady, blockers: audit.blockers, normalizedSha256, output };
}
