/** Private receipt/pin boundary. A supplied rate or claimed verified flag cannot create this object. */
import { createHash } from 'node:crypto';
import { parseAccountBindingPin, verifyPinIntegrity, compareAccountIdentity, type AccountBindingPin } from '../accounts/account-binding.js';
import { accountFeesReceiptSchema, parseAccountFeesArchive, checkAccountFeesTiming, type AccountFeesArchive } from '../accounts/account-fees-contract.js';
export type VerifiedAccountFeeEvidence = Readonly<{ schema: 1; kind: 'verified-private-account-fee-evidence';
  receipt: { schema: 1; kind: 'account-fees-observation-receipt'; archiveId: string; archiveHash: string };
  pinHash: string; bundleVersion: string; sourceHash: string; collectorSourceHash: string;
  startedAt: number; endedAt: number; checkedAt: number; identities: AccountBindingPin['identities'];
  snapshots: Readonly<Pick<AccountFeesArchive, 'mexc' | 'okx'>>;
  rateProvenanceVerified: true; credentialCheck: 'capture-time-only'; executable: false }>;
export type VerifyAccountFeeEvidenceInput = Readonly<{ archiveBytes: Uint8Array; receipt: unknown; pinBytes: Uint8Array;
  bindingKey: Uint8Array; expectedCollectorSourceHash: string; now: number; previousCheckedAt?: number }>;
const instances = new WeakSet<object>();
export function isVerifiedAccountFeeEvidence(value: unknown): value is VerifiedAccountFeeEvidence {
  return !!value && typeof value === 'object' && instances.has(value);
}
const fail = (): never => { throw new Error('fees-evidence-invalid'); };
const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
function bytes(value: unknown, max: number) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > max) return fail();
  return Buffer.from(value);
}
function canonical(raw: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw), parsed: unknown = JSON.parse(text);
  if (JSON.stringify(parsed) + '\n' !== text) return fail();
  return parsed;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function verifyAccountFeeEvidence(input: VerifyAccountFeeEvidenceInput): VerifiedAccountFeeEvidence {
  let key: Buffer | undefined;
  try {
    if (!input || Object.keys(input).some(name => !['archiveBytes','receipt','pinBytes','bindingKey','expectedCollectorSourceHash','now','previousCheckedAt'].includes(name)) ||
      !/^[a-f0-9]{64}$/.test(input.expectedCollectorSourceHash)) return fail();
    const archiveBytes = bytes(input.archiveBytes, 128 * 1024), pinBytes = bytes(input.pinBytes, 64 * 1024);
    key = bytes(input.bindingKey, 32); if (key.length !== 32) return fail();
    const receipt = accountFeesReceiptSchema.parse(input.receipt), pin = parseAccountBindingPin(canonical(pinBytes));
    const archive = parseAccountFeesArchive(canonical(archiveBytes));
    if (!verifyPinIntegrity(pin, key) || digest(archiveBytes) !== receipt.archiveHash || archive.archiveId !== receipt.archiveId ||
      digest(pinBytes) !== archive.pinHash || archive.bundleVersion !== pin.bundleVersion || archive.bindingSourceHash !== pin.sourceHash ||
      archive.collectorSourceHash !== input.expectedCollectorSourceHash || archive.collectorSourceHash === archive.bindingSourceHash ||
      JSON.stringify(archive.selectionReceipt) !== JSON.stringify(pin.selection.receipt) || pin.selection.selectedAt > archive.startedAt ||
      !checkAccountFeesTiming(archive, input.now, input.previousCheckedAt)) return fail();
    for (const venue of ['mexc','okx'] as const) if (!compareAccountIdentity(pin, venue, archive[venue].identity, key).matched) return fail();
    const result: VerifiedAccountFeeEvidence = freeze({ schema: 1, kind: 'verified-private-account-fee-evidence', receipt,
      pinHash: archive.pinHash, bundleVersion: archive.bundleVersion, sourceHash: pin.sourceHash, collectorSourceHash: archive.collectorSourceHash,
      startedAt: archive.startedAt, endedAt: archive.endedAt, checkedAt: input.now,
      identities: { mexc: archive.mexc.identity, okx: archive.okx.identity }, snapshots: { mexc: archive.mexc, okx: archive.okx },
      rateProvenanceVerified: true, credentialCheck: 'capture-time-only', executable: false });
    instances.add(result); return result;
  } catch { return fail(); } finally { key?.fill(0); }
}
