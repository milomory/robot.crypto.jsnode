/** Offline files only. Never imports the server, account readers or an order sender. */
import { join } from 'node:path';
import { newArchive, readArchiveFile, writeReplayFile } from '../market-exact/archive.js';
import { createLiveOrderJournal, createPolicyBoundLiveOrderJournal, readLiveOrderJournal, appendLiveOrderJournal,
  type LiveOrderJournalCheckpoint } from '../live/order-journal.js';
import { assessLiveLaunchPreparation } from '../live/launch-readiness.js';

const usage = 'Offline order rehearsal failed. Use init NEW_JOURNAL, init-policy POLICY_JSON NEW_JOURNAL, append EVENT_JSON JOURNAL CHECKPOINT_JSON, or inspect JOURNAL NEW_REPORT [MINIMUM_CHECKPOINT_JSON [LIMITS_DRAFT_JSON]]. Preserve journal files after any uncertain write. No exchange operations are available.';
try {
  const [command, ...args] = process.argv.slice(2);
  if (!['init', 'init-policy', 'append', 'inspect'].includes(command) ||
      (command === 'init' && args.length !== 1) ||
      (command === 'init-policy' && args.length !== 2) ||
      (command === 'append' && args.length !== 3) ||
      (command === 'inspect' && (args.length < 2 || args.length > 4))) throw new Error();
  const checkpoint = command === 'append' || (command === 'inspect' && args[2])
    ? await readArchiveFile(args[2]) as LiveOrderJournalCheckpoint : undefined;
  const result = command === 'init-policy' ? await createPolicyBoundLiveOrderJournal(args[1], await readArchiveFile(args[0]))
    : command === 'init' ? await createLiveOrderJournal(args[0])
    : command === 'append' ? await appendLiveOrderJournal(args[1], await readArchiveFile(args[0]), checkpoint!)
      : await readLiveOrderJournal(args[0], checkpoint);
  if (command === 'inspect') {
    if (result.admissionPolicy && args[3] !== undefined) throw new Error();
    const limitsDraft = result.admissionPolicy?.limits ?? (args[3] === undefined ? undefined : await readArchiveFile(args[3]));
    const preparation = assessLiveLaunchPreparation(result.state, limitsDraft);
    await newArchive(args[1]);
    await writeReplayFile(join(args[1], 'report.json'), {
      schema: 1, kind: 'offline-order-rehearsal-report', source: 'local-rehearsal',
      executable: false, captureProvenanceVerified: false,
      checkpoint: result.checkpoint, pendingFiles: result.pendingFiles,
      orders: result.state.orders, preparation, admissionPolicy: result.admissionPolicy,
      rehearsalPolicyEnforced: result.schema === 2,
    });
    await writeReplayFile(join(args[1], 'checkpoint.json'), result.checkpoint);
  }
  console.log(JSON.stringify({
    schema: 1, kind: 'offline-order-rehearsal-result', executable: false,
    captureProvenanceVerified: false, checkpoint: result.checkpoint,
    revision: result.revision, pendingFiles: result.pendingFiles,
    ...(result.schema === 2 ? { rehearsalPolicyEnforced: true } : {}),
    ...('appended' in result ? { appended: result.appended } : {}),
    ...(command === 'inspect' ? { reportWritten: true } : {}),
  }));
} catch {
  // Never print input, filesystem path, upstream text, stack, order ID or secret.
  console.error(usage);
  process.exitCode = 1;
}
