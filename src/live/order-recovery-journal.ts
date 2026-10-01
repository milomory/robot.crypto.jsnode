/** Replayable import into a rehearsal journal. No claim of multi-record atomicity or verified provenance. */
import { appendLiveOrderJournal, readLiveOrderJournal, type LiveOrderJournalCheckpoint } from './order-journal.js';
import { applyLiveOrderEvent, canonicalLiveOrderJson, replayLiveOrderEvents } from './order-lifecycle.js';
import { buildLiveOrderRecoveryEvidence } from './order-recovery-evidence.js';
import { ORDER_RECOVERY_POLICY } from './order-recovery-collection.js';

export class OrderRecoveryImportError extends Error {
  constructor(readonly code: 'recovery-invalid-input' | 'recovery-head-conflict' | 'recovery-invalid-plan') {
    super(code); this.name = 'OrderRecoveryImportError';
  }
}
function fail(code: OrderRecoveryImportError['code']): never { throw new OrderRecoveryImportError(code); }

/** Retain the original capture and base checkpoint externally. On interruption,
 * replay that exact pair; only its already committed prefix may be resumed. */
export async function applyCapturedOrderRecovery(directory: string, baseCheckpoint: LiveOrderJournalCheckpoint,
  orderIntentId: string, capture: unknown, now = Date.now()) {
  let savedCapture: unknown, savedCheckpoint: LiveOrderJournalCheckpoint;
  try {
    if (Buffer.byteLength(JSON.stringify(capture)) > 128 * 1024 || !Number.isSafeInteger(now) || now <= 0) throw new Error();
    savedCapture = structuredClone(capture); savedCheckpoint = structuredClone(baseCheckpoint);
  } catch { return fail('recovery-invalid-input'); }
  const current = await readLiveOrderJournal(directory, savedCheckpoint);
  const baseState = replayLiveOrderEvents(current.state.events.slice(0, savedCheckpoint.revision));
  const suffix = current.state.events.slice(savedCheckpoint.revision);
  // First import requires a fresh capture. An interrupted identical import can
  // resume later: its persisted prefix anchors the original deterministic plan.
  const captureTime = savedCapture && typeof savedCapture === 'object' && 'receivedAt' in savedCapture
    ? savedCapture.receivedAt : undefined;
  const evaluationTime = suffix.length && Number.isSafeInteger(captureTime) ? captureTime as number : now;
  if (evaluationTime > now) fail('recovery-invalid-input');
  const plan = buildLiveOrderRecoveryEvidence(baseState, orderIntentId, savedCapture, { ...ORDER_RECOVERY_POLICY, now: evaluationTime });
  // Nothing is written unless the complete proposed transition sequence validates.
  try { plan.events.reduce((state, event) => applyLiveOrderEvent(state, event), baseState); }
  catch { return fail('recovery-invalid-plan'); }
  if (suffix.length > plan.events.length || suffix.some((event, index) =>
      canonicalLiveOrderJson(event) !== canonicalLiveOrderJson(plan.events[index]))) fail('recovery-head-conflict');
  let checkpoint = current.checkpoint, appended = 0;
  for (const event of plan.events.slice(suffix.length)) {
    // Concurrent unrelated changes cause CAS failure; already published records survive.
    const next = await appendLiveOrderJournal(directory, event, checkpoint);
    checkpoint = next.checkpoint;
    if (next.appended) appended++;
  }
  return { schema: 1 as const, kind: 'rehearsal-recovery-import' as const,
    executable: false as const, captureProvenanceVerified: false as const,
    captureTiming: typeof captureTime === 'number' && now >= captureTime && now - captureTime <= ORDER_RECOVERY_POLICY.maxCaptureAgeMs
      ? 'within-freshness-window' as const : suffix.length > 0 ? 'resumed-historical' as const : 'outside-freshness-window' as const,
    checkpoint, appended, alreadyApplied: suffix.length, plan };
}
