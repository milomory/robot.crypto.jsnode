import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readArchiveFile, newArchive, writeReplayFile } from '../market-exact/archive.js';
import { canonical } from '../paper-v2/ledger.js';
import { auditOrderCash } from './cash-audit.js';

export async function writeCashAudit(input: string, output: string) {
  const audit = auditOrderCash(await readArchiveFile(input));
  const normalizedSha256 = createHash('sha256').update(canonical(audit)).digest('hex');
  const report = { schema: 1, kind: 'offline-cash-audit-report', normalizedSha256,
    networkUsed: false, exchangeOrders: 0, captureProvenanceVerified: false,
    limitations: ['A source label cannot authenticate exchange provenance',
      'Reported cash is the sum of supplied unique bills; matching an economic model cannot establish complete history',
      'Bill fee currency and gross-quote semantics are not inferred from ccy, sz or balChg',
      'OKX gross quote remains derived and blocked for nonzero settlement',
      'No support for rebates, cash rounding assumptions or precision truncation'], audit };
  await newArchive(output); await writeReplayFile(join(output, 'report.json'), report);
  return { source: audit.source, venue: audit.venue, comparison: audit.cash.comparison,
    uniqueFills: audit.orderAudit.uniqueFills, uniqueBills: audit.cash.uniqueBills,
    settlementReady: audit.settlementReady, blockers: [...audit.orderAudit.blockers, ...audit.cash.blockers], normalizedSha256 };
}
