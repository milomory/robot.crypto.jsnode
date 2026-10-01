import { join } from 'node:path';
import { z } from 'zod';
import { newArchive, readArchiveFile, writeReplayFile } from '../market-exact/archive.js';
import { appendRiskSettlementJournal, createRiskSettlementJournal, readRiskSettlementJournal } from '../paper-pair/settlement-journal.js';
import { paperRiskPolicySchema, viewPaperRiskState } from '../paper-pair/risk.js';
import type { SettlementBalances, SettlementEvent } from '../paper-pair/settlement.js';

const initializationSchema = z.object({ schema: z.literal(1), kind: z.literal('synthetic-risk-journal-input'),
  initialBalances: z.unknown(), policy: paperRiskPolicySchema }).strict();
type Checkpoint = Parameters<typeof appendRiskSettlementJournal>[2];
const [command, input, directory, checkpointFile, ...extra] = process.argv.slice(2);
try {
  if (!input || !directory || extra.length || !['init', 'append', 'inspect'].includes(command) ||
      (command === 'append' ? !checkpointFile : command === 'init' && checkpointFile !== undefined)) throw new Error();
  const initialization = command === 'init' ? initializationSchema.parse(await readArchiveFile(input)) : undefined;
  const checkpoint = checkpointFile === undefined ? undefined : await readArchiveFile(checkpointFile) as Checkpoint;
  const result = command === 'init' ? await createRiskSettlementJournal(directory,
    initialization!.initialBalances as SettlementBalances, initialization!.policy) : command === 'append' ?
      await appendRiskSettlementJournal(directory, await readArchiveFile(input) as SettlementEvent, checkpoint!) :
      await readRiskSettlementJournal(input, checkpoint);
  if (command === 'inspect') {
    await newArchive(directory);
    await writeReplayFile(join(directory, 'report.json'), { schema: 2, kind: 'durable-paper-risk-settlement-report',
      executable: false, funding: 'synthetic', journalId: result.journalId, revision: result.revision,
      headHash: result.headHash, policyHash: result.policyHash, pendingFiles: result.pendingFiles,
      checkpoint: result.checkpoint, initialBalances: result.state.initialBalances, journal: result.state.journal,
      result: viewPaperRiskState({ policy: result.policy, settlement: result.state }) });
    await writeReplayFile(join(directory, 'checkpoint.json'), result.checkpoint);
  }
  console.log(JSON.stringify({ schema: 2, journalId: result.journalId, revision: result.revision,
    headHash: result.headHash, policyHash: result.policyHash, pendingFiles: result.pendingFiles,
    checkpoint: result.checkpoint, executable: false, funding: 'synthetic',
    ...('appended' in result ? { appended: result.appended } : {}), ...(command === 'inspect' ? { reportWritten: true } : {}) }));
} catch {
  console.error('Local paper risk journal command failed. Use init INITIALIZATION_JSON NEW_JOURNAL, append EVENT_JSON JOURNAL CHECKPOINT_JSON, or inspect JOURNAL NEW_REPORT [MINIMUM_CHECKPOINT_JSON]. Preserve files and re-read after uncertain writes.');
  process.exitCode = 1;
}
