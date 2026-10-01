/** Strict persisted capture contract, shared by the collector and the offline evidence verifier. */
import { z } from 'zod';
import { parseAccountFeeSnapshot, type AccountFeeSnapshot } from './account-fee-reader.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const time = z.number().int().positive().safe().max(8_640_000_000_000_000);
export const accountFeesReceiptSchema = z.object({ schema: z.literal(1), kind: z.literal('account-fees-observation-receipt'),
  archiveId: uuid, archiveHash: hash }).strict();
const archiveSchema = z.object({ schema: z.literal(1), kind: z.literal('account-fees-observation'), archiveId: uuid,
  startedAt: time, endedAt: time, environment: z.literal('mainnet'),
  selectionReceipt: z.object({ schema: z.literal(1), kind: z.literal('account-identity-observation-receipt'), archiveId: uuid, archiveHash: hash }).strict(),
  bundleVersion: uuid, pinHash: hash, bindingSourceHash: hash, collectorSourceHash: hash,
  identityEnrolled: z.literal(true), feesBound: z.literal(true), feeAdmission: z.literal(false), executable: z.literal(false),
  requestCount: z.literal(5), mexc: z.unknown(), okx: z.unknown() }).strict();
export type AccountFeesArchive = Omit<z.infer<typeof archiveSchema>, 'mexc' | 'okx'> & { mexc: Extract<AccountFeeSnapshot, { venue: 'mexc' }>; okx: Extract<AccountFeeSnapshot, { venue: 'okx' }> };
export function parseAccountFeesArchive(value: unknown): AccountFeesArchive {
  try {
    const parsed = archiveSchema.parse(value), mexc = parseAccountFeeSnapshot(parsed.mexc), okx = parseAccountFeeSnapshot(parsed.okx);
    if (mexc.venue !== 'mexc' || okx.venue !== 'okx') throw new Error();
    return { ...parsed, mexc, okx };
  } catch { throw new Error('fees-evidence-invalid'); }
}
/** All five requests are serial. Age is measured from the beginning, not the last fee response. */
export function checkAccountFeesTiming(archive: AccountFeesArchive, checkedAt: number, previousCheckedAt?: number): boolean {
  try {
    time.parse(checkedAt); if (previousCheckedAt !== undefined) time.parse(previousCheckedAt);
    const mexc = archive.mexc, okx = archive.okx;
    if (mexc.venue !== 'mexc' || okx.venue !== 'okx') return false;
    const sequence = [archive.startedAt, mexc.identity.requestedAt, mexc.identity.receivedAt,
      mexc.fees.requestedAt, mexc.fees.receivedAt, mexc.configuration.requestedAt, mexc.configuration.receivedAt,
      okx.identity.requestedAt, okx.identity.receivedAt, okx.fees.requestedAt, okx.fees.receivedAt, archive.endedAt, checkedAt];
    if (sequence.some((value, index) => !time.safeParse(value).success || (index > 0 && value < sequence[index - 1]))) return false;
    return archive.endedAt - archive.startedAt <= 30_000 && checkedAt - archive.startedAt <= 60_000 &&
      (previousCheckedAt === undefined || checkedAt >= previousCheckedAt);
  } catch { return false; }
}
