import { join } from 'node:path';
import { newArchive, readArchiveFile, writeReplayFile } from '../market-exact/archive.js';
import { createSettlementJournal, appendSettlementJournal, readSettlementJournal } from '../paper-pair/settlement-journal.js';
import type { SettlementJournalCheckpoint } from '../paper-pair/settlement-journal.js';
import type { SettlementBalances, SettlementEvent } from '../paper-pair/settlement.js';
import { viewSettlementState } from '../paper-pair/settlement.js';

const [command, input, directory, expectedHead, ...extra] = process.argv.slice(2);
try {
  if (!input || !directory || extra.length ||
      !['init', 'append', 'inspect'].includes(command) || (command === 'append' ? !expectedHead : command === 'init' && expectedHead !== undefined)) throw new Error();
  const result = command === 'init' ? await createSettlementJournal(directory, await readArchiveFile(input) as SettlementBalances) :
    command === 'append' ? await appendSettlementJournal(directory, await readArchiveFile(input) as SettlementEvent, expectedHead!) :
      await readSettlementJournal(input, expectedHead === undefined ? undefined : await readArchiveFile(expectedHead) as SettlementJournalCheckpoint);
  if (command === 'inspect') {
    await newArchive(directory);
    await writeReplayFile(join(directory, 'report.json'), { schema: 1, kind: 'durable-paper-settlement-report',
      journalId: result.journalId, revision: result.revision, headHash: result.headHash, pendingFiles: result.pendingFiles,
      initialBalances: result.state.initialBalances, journal: result.state.journal, result: viewSettlementState(result.state) });
    await writeReplayFile(join(directory, 'checkpoint.json'), { journalId: result.journalId, revision: result.revision, headHash: result.headHash });
  }
  console.log(JSON.stringify({ journalId: result.journalId, revision: result.revision,
    headHash: result.headHash, pendingFiles: result.pendingFiles, executable: false, funding: 'synthetic',
    ...('appended' in result ? { appended: result.appended } : {}), ...(command === 'inspect' ? { reportWritten: true } : {}) }));
} catch {
  console.error('Local paper journal command failed. Use init OPENING_JSON NEW_JOURNAL, append EVENT_JSON JOURNAL EXPECTED_HEAD, or inspect JOURNAL NEW_REPORT [CHECKPOINT_JSON]. Preserve files and re-read after uncertain writes.');
  process.exitCode = 1;
}
