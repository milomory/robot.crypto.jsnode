/** Persisted private three-request observation; admission always remains false. */
import { z } from 'zod';
import { parseOkxCapacitySnapshot, type OkxCapacitySnapshot } from './okx-capacity-reader.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const time = z.number().int().positive().safe().max(8_640_000_000_000_000);
export const okxCapacityReceiptSchema = z.object({ schema: z.literal(1), kind: z.literal('okx-capacity-observation-receipt'), archiveId: uuid, archiveHash: hash }).strict();
const archiveSchema = z.object({ schema: z.literal(1), kind: z.literal('okx-capacity-observation'), archiveId: uuid,
  startedAt: time, endedAt: time, environment: z.literal('mainnet'),
  selectionReceipt: z.object({ schema: z.literal(1), kind: z.literal('account-identity-observation-receipt'), archiveId: uuid, archiveHash: hash }).strict(),
  bundleVersion: uuid, pinHash: hash, bindingSourceHash: hash, collectorSourceHash: hash,
  identityEnrolled: z.literal(true), credentialBundleMatched: z.literal(true), capacityBound: z.literal(true),
  capacityAdmission: z.literal(false), executable: z.literal(false), requestCount: z.literal(3), okx: z.unknown() }).strict();
export type OkxCapacityArchive = Omit<z.infer<typeof archiveSchema>, 'okx'> & { okx: OkxCapacitySnapshot };
export function parseOkxCapacityArchive(value: unknown): OkxCapacityArchive {
  try { const parsed = archiveSchema.parse(value); return { ...parsed, okx: parseOkxCapacitySnapshot(parsed.okx) }; }
  catch { throw new Error('capacity-evidence-invalid'); }
}
export function checkOkxCapacityTiming(archive: OkxCapacityArchive, checkedAt: number, previousCheckedAt?: number): boolean {
  try {
    time.parse(checkedAt); if (previousCheckedAt !== undefined) time.parse(previousCheckedAt);
    const o = archive.okx;
    const sequence = [archive.startedAt, o.before.identity.requestedAt, o.before.identity.receivedAt,
      o.capacity.requestedAt, o.capacity.receivedAt, o.after.identity.requestedAt, o.after.identity.receivedAt, archive.endedAt, checkedAt];
    return !sequence.some((v,i) => !time.safeParse(v).success || (i > 0 && v < sequence[i-1])) &&
      archive.endedAt - archive.startedAt < 30_000 && checkedAt - archive.startedAt <= 60_000 &&
      (previousCheckedAt === undefined || checkedAt >= previousCheckedAt);
  } catch { return false; }
}
