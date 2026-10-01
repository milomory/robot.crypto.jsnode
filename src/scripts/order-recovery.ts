/** Offline captured-response inspection/import. Never looks up keys or contacts an exchange. */
import { join, resolve } from 'node:path';
import { newArchive, readArchiveFile, writeReplayFile } from '../market-exact/archive.js';
import { readLiveOrderJournal, type LiveOrderJournalCheckpoint } from '../live/order-journal.js';
import { replayLiveOrderEvents } from '../live/order-lifecycle.js';
import { buildLiveOrderRecoveryEvidence } from '../live/order-recovery-evidence.js';
import { applyCapturedOrderRecovery } from '../live/order-recovery-journal.js';
import { readLiveOrderRecoveryArchive } from '../live/order-recovery-session.js';
import { ORDER_RECOVERY_POLICY } from '../live/order-recovery-collection.js';

try {
  const [command, ...args] = process.argv.slice(2);
  const archived = command === 'inspect-archive' || command === 'import-archive';
  const importing = command === 'import' || command === 'import-archive';
  if (!['inspect', 'import', 'inspect-archive', 'import-archive'].includes(command) ||
      (archived ? (args.length < (importing ? 2 : 3) || args.length > (importing ? 3 : 4))
        : (args.length !== (importing ? 4 : 5) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[3])))) throw new Error();
  const archive = archived ? await readLiveOrderRecoveryArchive(resolve(args[0]), args[importing ? 2 : 3] === undefined
    ? undefined : await readArchiveFile(args[importing ? 2 : 3])) : null;
  const capture = archive?.capture ?? await readArchiveFile(args[0]);
  const base = archive?.baseCheckpoint ?? await readArchiveFile(args[2]) as LiveOrderJournalCheckpoint;
  const intent = archive?.orderIntentId ?? args[3], directory = args[1];
  if (importing) {
    const result = await applyCapturedOrderRecovery(directory, base, intent, capture);
    console.log(JSON.stringify({ schema: 1, kind: 'offline-recovery-import-result', executable: false,
      captureProvenanceVerified: false, accountIdentityVerified: false,
      checkpoint: result.checkpoint, appended: result.appended, alreadyApplied: result.alreadyApplied,
      captureTiming: result.captureTiming, blockers: result.plan.blockers }));
  } else {
    const current = await readLiveOrderJournal(directory, base);
    const state = replayLiveOrderEvents(current.state.events.slice(0, base.revision));
    const plan = buildLiveOrderRecoveryEvidence(state, intent, capture, { ...ORDER_RECOVERY_POLICY, now: Date.now() });
    const report = args[archived ? 2 : 4];
    await newArchive(report);
    await writeReplayFile(join(report, 'report.json'), { schema: 1, kind: 'offline-order-recovery-report',
      executable: false, captureProvenanceVerified: false, accountIdentityVerified: false,
      baseCheckpoint: base, currentCheckpoint: current.checkpoint, plan });
    console.log(JSON.stringify({ schema: 1, kind: 'offline-recovery-inspection-result', executable: false,
      captureProvenanceVerified: false, accountIdentityVerified: false,
      eventsProposed: plan.events.length, blockers: plan.blockers, reportWritten: true }));
  }
} catch {
  console.error('Offline recovery command failed. Use inspect CAPTURE_JSON JOURNAL BASE_CHECKPOINT_JSON INTENT_UUID NEW_REPORT, import CAPTURE_JSON JOURNAL BASE_CHECKPOINT_JSON INTENT_UUID, inspect-archive ARCHIVE JOURNAL NEW_REPORT [TRUSTED_RECEIPT_JSON], or import-archive ARCHIVE JOURNAL [TRUSTED_RECEIPT_JSON]. Preserve the capture and published journal prefix after any failure. No exchange operation is available.');
  process.exitCode = 1;
}
