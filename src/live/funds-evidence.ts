/** Private, pure evidence verification. No network, secret reads, funds admission or enrollment. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseAccountBindingPin, verifyPinIntegrity, compareAccountIdentity, assessCaptureFreshness,
  type AccountBindingPin } from '../accounts/account-binding.js';
import { ACCOUNT_FUNDS_REASONS } from '../accounts/account-funds-reader.js';

const fail = (): never => { throw new Error('funds-evidence-invalid'); };
const timestamp = z.number().int().positive().safe().max(8_640_000_000_000_000);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const amount = z.string().regex(/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const currency = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
const sourceTime = z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)) && Number(value) <= 8_640_000_000_000_000).nullable();
const tag = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).nullable();
const unavailable = z.record(z.enum(['available', 'updateTime', 'accountType', 'canTrade', 'cashBal', 'availBal', 'frozenBal',
  'liab', 'crossLiab', 'isoLiab', 'interest', 'borrowFroz', 'uTime', 'acctLv', 'autoLoan', 'enableSpotBorrow', 'spotBorrowAutoRepay']),
  z.enum(['missing', 'null', 'empty']));
const interval = { requestedAt: timestamp, receivedAt: timestamp };
const identityReceipt = z.object({ schema: z.literal(1), kind: z.literal('account-identity-observation-receipt'), archiveId: uuid, archiveHash: hash }).strict();
const receiptSchema = z.object({ schema: z.literal(1), kind: z.literal('account-funds-observation-receipt'), archiveId: uuid, archiveHash: hash }).strict();
const assessment = z.object({ requiredAssets: z.object({ BTC: z.boolean(), USDT: z.boolean(), MX: z.boolean() }).strict(),
  reasons: z.array(z.enum(ACCOUNT_FUNDS_REASONS)).max(ACCOUNT_FUNDS_REASONS.length) }).strict();
const mexcRow = z.object({ currency, free: amount, locked: amount, available: amount.nullable(), unavailableFields: unavailable }).strict();
const okxRow = z.object({ currency, cashBal: amount.nullable(), availBal: amount.nullable(), frozenBal: amount.nullable(),
  liab: amount.nullable(), crossLiab: amount.nullable(), isoLiab: amount.nullable(), interest: amount.nullable(), borrowFroz: amount.nullable(),
  sourceUpdatedAt: sourceTime, unavailableFields: unavailable }).strict();
const common = { schema: z.literal(1), environment: z.literal('mainnet'), identity: z.unknown(), requestCount: z.literal(2),
  identityAccepted: z.literal(true), fundsAdmission: z.literal(false), executable: z.literal(false), assessment };
const mexcSnapshot = z.object({ ...common, venue: z.literal('mexc'), origin: z.literal('https://api.mexc.com'), configuration: z.null(),
  funds: z.object({ ...interval, source: z.literal('/api/v3/account'), sourceUpdatedAt: sourceTime, accountType: tag,
    canTrade: z.boolean().nullable(), unavailableFields: unavailable, balances: z.array(mexcRow).max(2_000) }).strict() }).strict();
const okxSnapshot = z.object({ ...common, venue: z.literal('okx'), origin: z.literal('https://www.okx.com'),
  configuration: z.object({ accountMode: tag, autoLoan: z.boolean().nullable(), enableSpotBorrow: z.boolean().nullable(),
    spotBorrowAutoRepay: z.boolean().nullable(), unavailableFields: unavailable }).strict(),
  funds: z.object({ ...interval, source: z.literal('/api/v5/account/balance'), sourceUpdatedAt: sourceTime,
    unavailableFields: unavailable, balances: z.array(okxRow).max(2_000) }).strict() }).strict();
const archiveSchema = z.object({ schema: z.literal(1), kind: z.literal('account-funds-observation'), archiveId: uuid,
  startedAt: timestamp, endedAt: timestamp, environment: z.literal('mainnet'), selectionReceipt: identityReceipt,
  bundleVersion: uuid, pinHash: hash, identityEnrolled: z.literal(true), fundsBound: z.literal(true),
  fundsAdmission: z.literal(false), executable: z.literal(false), requestCount: z.literal(4), mexc: mexcSnapshot, okx: okxSnapshot }).strict();
export const FUNDS_EVIDENCE_BLOCKERS = [
  'mexc-available-semantics-unconfirmed', 'mexc-main-account-unconfirmed', 'mexc-spot-account-unconfirmed', 'mexc-can-trade-unconfirmed',
  'okx-mode-not-supported', 'okx-borrow-enabled-or-unknown', 'asset-not-reported', 'amount-unavailable',
  'negative-amount-reported', 'precision-over-18', 'liability-reported', 'liability-unavailable',
  'source-time-unavailable', 'source-time-in-future',
] as const;
export type FundsEvidenceBlocker = typeof FUNDS_EVIDENCE_BLOCKERS[number];
export type FundsEvidenceAsset = Readonly<{ reported: boolean; candidateAmount: string | null;
  /** Observed trading-wallet ownership candidate, including held funds; never spendable capital or portfolio-wide ownership. */
  ownedAmount: string | null; blockers: readonly FundsEvidenceBlocker[];
  /** An explicit documented N/A marker; no zero balance or debt is synthesized. */
  notApplicableFields?: readonly 'isoLiab'[] }>;
export type FundsEvidenceVenue = Readonly<{ blockers: readonly FundsEvidenceBlocker[];
  assets: Readonly<Record<'BTC' | 'USDT' | 'MX', FundsEvidenceAsset>> }>;
/** Contains private UID and binding references. Never log, serialize into a public response or store in the public journal. */
export type VerifiedFundsEvidence = Readonly<{ schema: 1; kind: 'verified-private-funds-evidence';
  receipt: z.infer<typeof receiptSchema>; pinHash: string; sourceHash: string; bundleVersion: string;
  identities: AccountBindingPin['identities']; startedAt: number; endedAt: number; checkedAt: number;
  credentialCheck: 'capture-time-only'; venues: Readonly<Record<'mexc' | 'okx', FundsEvidenceVenue>>;
  fundsAdmission: false; executable: false }>;
export type VerifyFundsEvidenceInput = Readonly<{ archiveBytes: Uint8Array; receipt: unknown; pinBytes: Uint8Array;
  bindingKey: Uint8Array; now: number; previousCheckedAt?: number }>;
const verified = new WeakSet<object>();
export function isVerifiedFundsEvidence(value: unknown): value is VerifiedFundsEvidence {
  return !!value && typeof value === 'object' && verified.has(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function bytes(value: unknown, max: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > max) return fail();
  return Buffer.from(value);
}
/** Capture format uses insertion-order JSON plus exactly one newline; comparison also rejects duplicate keys. */
function canonical(raw: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw), value: unknown = JSON.parse(text);
  if (JSON.stringify(value) + '\n' !== text) return fail();
  return value;
}
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function checkUnavailable(row: { unavailableFields: Record<string, string> }, fields: Record<string, unknown>) {
  const missing = Object.entries(fields).filter(([, value]) => value === null).map(([key]) => key).sort();
  if (JSON.stringify(missing) !== JSON.stringify(Object.keys(row.unavailableFields).sort())) fail();
}
function timeBlockers(value: string | null, receivedAt: number): FundsEvidenceBlocker[] {
  return value === null ? ['source-time-unavailable'] : Number(value) > receivedAt ? ['source-time-in-future'] : [];
}
const precise = (value: string) => (value.split('.')[1]?.length ?? 0) <= 18;
const negative = (value: string) => value.startsWith('-');
function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
function numericBlockers(values: readonly (string | null)[]): FundsEvidenceBlocker[] {
  const result: FundsEvidenceBlocker[] = [];
  if (values.includes(null)) result.push('amount-unavailable');
  if (values.some(value => value !== null && negative(value))) result.push('negative-amount-reported');
  if (values.some(value => value !== null && !precise(value))) result.push('precision-over-18');
  return result;
}
function candidate(a: string | null, b: string | null): string | null {
  if (a === null || b === null || numericBlockers([a, b]).length) return null;
  return units(a) <= units(b) ? a : b;
}
function owned(values: readonly (string | null)[]): string | null {
  if (numericBlockers(values).length) return null;
  const total = values.reduce<bigint>((sum, value) => sum + units(value!), 0n);
  const scale = 10n ** 18n, fraction = (total % scale).toString().padStart(18, '0').replace(/0+$/, '');
  return (total / scale).toString() + (fraction ? '.' + fraction : '');
}
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
function assetProjection(rows: readonly ({ currency: string } & Record<string, unknown>)[], project: (row: Record<string, unknown>) => FundsEvidenceAsset) {
  if (new Set(rows.map(row => row.currency)).size !== rows.length) return fail();
  const result = {} as Record<'BTC' | 'USDT' | 'MX', FundsEvidenceAsset>;
  for (const symbol of ['BTC', 'USDT', 'MX'] as const) {
    const row = rows.find(item => item.currency === symbol);
    result[symbol] = row ? project(row) : { reported: false, candidateAmount: null, ownedAmount: null, blockers: ['asset-not-reported'] };
  }
  return result;
}
function projectMexc(snapshot: z.infer<typeof mexcSnapshot>): FundsEvidenceVenue {
  const funds = snapshot.funds;
  checkUnavailable(funds, { updateTime: funds.sourceUpdatedAt, accountType: funds.accountType, canTrade: funds.canTrade });
  const blockers: FundsEvidenceBlocker[] = ['mexc-available-semantics-unconfirmed', 'mexc-main-account-unconfirmed', ...timeBlockers(funds.sourceUpdatedAt, funds.receivedAt)];
  if (funds.accountType !== 'SPOT') blockers.push('mexc-spot-account-unconfirmed');
  if (funds.canTrade !== true) blockers.push('mexc-can-trade-unconfirmed');
  for (const row of funds.balances) {
    checkUnavailable(row, { available: row.available });
    blockers.push(...numericBlockers([row.free, row.locked, row.available]).filter(reason => reason !== 'amount-unavailable'));
  }
  const assets = assetProjection(funds.balances, raw => {
    const row = raw as z.infer<typeof mexcRow>, reasons = numericBlockers([row.free, row.locked, row.available]);
    return { reported: true, candidateAmount: reasons.length ? null : candidate(row.free, row.available), ownedAmount: owned([row.free, row.locked]), blockers: reasons };
  });
  return { blockers: unique(blockers), assets };
}
const liabilityFields = ['liab', 'crossLiab', 'isoLiab', 'interest', 'borrowFroz'] as const;
/** OKX Get balance documents isoLiab only for multi-currency/portfolio margin and returns an empty string for N/A fields.
 * Keep missing/null unknown. The borrowFroz text and applicability table conflict, so that field remains unchanged. */
function spotIsoLiabNotApplicable(config: z.infer<typeof okxSnapshot>['configuration'], row: z.infer<typeof okxRow>): boolean {
  return config.accountMode === '1' && row.isoLiab === null && row.unavailableFields.isoLiab === 'empty';
}
function projectOkx(snapshot: z.infer<typeof okxSnapshot>): FundsEvidenceVenue {
  const { funds, configuration: config } = snapshot;
  checkUnavailable(config, { acctLv: config.accountMode, autoLoan: config.autoLoan, enableSpotBorrow: config.enableSpotBorrow, spotBorrowAutoRepay: config.spotBorrowAutoRepay });
  checkUnavailable(funds, { uTime: funds.sourceUpdatedAt });
  const blockers: FundsEvidenceBlocker[] = timeBlockers(funds.sourceUpdatedAt, funds.receivedAt);
  if (config.accountMode !== '1') blockers.push('okx-mode-not-supported');
  if (config.autoLoan !== false || config.enableSpotBorrow !== false || config.spotBorrowAutoRepay !== false) blockers.push('okx-borrow-enabled-or-unknown');
  const rowReasons = new Map<string, FundsEvidenceBlocker[]>();
  for (const row of funds.balances) {
    checkUnavailable(row, { cashBal: row.cashBal, availBal: row.availBal, frozenBal: row.frozenBal, liab: row.liab,
      crossLiab: row.crossLiab, isoLiab: row.isoLiab, interest: row.interest, borrowFroz: row.borrowFroz, uTime: row.sourceUpdatedAt });
    const applicableLiabilities = liabilityFields.filter(field => field !== 'isoLiab' || !spotIsoLiabNotApplicable(config, row));
    const numeric = numericBlockers([row.cashBal, row.availBal, row.frozenBal, ...applicableLiabilities.map(field => row[field])]);
    const liabilities: FundsEvidenceBlocker[] = [];
    if (applicableLiabilities.some(field => row[field] === null)) liabilities.push('liability-unavailable');
    if (applicableLiabilities.some(field => row[field] !== null && /[1-9]/.test(row[field]!))) liabilities.push('liability-reported');
    const times = timeBlockers(row.sourceUpdatedAt, funds.receivedAt);
    rowReasons.set(row.currency, unique([...numeric, ...liabilities, ...times]));
    // Debt in another currency still affects the account. Missing MX as a whole does not.
    blockers.push(...numeric.filter(reason => reason !== 'amount-unavailable'), ...liabilities, ...times);
  }
  const assets = assetProjection(funds.balances, raw => {
    const row = raw as z.infer<typeof okxRow>, reasons = rowReasons.get(row.currency)!;
    return { reported: true, candidateAmount: reasons.length ? null : candidate(row.cashBal, row.availBal), ownedAmount: owned([row.cashBal]), blockers: reasons,
      ...(spotIsoLiabNotApplicable(config, row) ? { notApplicableFields: ['isoLiab'] as const } : {}) };
  });
  return { blockers: unique(blockers), assets };
}
/**
 * The receipt and pin must come from the protected accepted archive/selection boundary.
 * A SHA receipt authenticates bytes against that input, not an exchange signature or fresh credentials.
 * Official contracts reviewed 2026-09-30: MEXC /spot-account-trade/account-information;
 * OKX docs-v5 Get balance / Get account configuration. Candidate amounts never imply admission.
 */
export function verifyFundsEvidence(input: VerifyFundsEvidenceInput): VerifiedFundsEvidence {
  let key: Buffer | undefined;
  try {
    if (!input || typeof input !== 'object' || Object.keys(input).some(name => !['archiveBytes', 'receipt', 'pinBytes', 'bindingKey', 'now', 'previousCheckedAt'].includes(name))) return fail();
    const archiveBytes = bytes(input.archiveBytes, 1024 * 1024), pinBytes = bytes(input.pinBytes, 64 * 1024);
    key = bytes(input.bindingKey, 32); if (key.length !== 32) return fail();
    const receipt = receiptSchema.parse(input.receipt), archive = archiveSchema.parse(canonical(archiveBytes));
    const pin = parseAccountBindingPin(canonical(pinBytes));
    if (!verifyPinIntegrity(pin, key) || digest(archiveBytes) !== receipt.archiveHash || archive.archiveId !== receipt.archiveId ||
        digest(pinBytes) !== archive.pinHash || pin.bundleVersion !== archive.bundleVersion ||
        JSON.stringify(pin.selection.receipt) !== JSON.stringify(archive.selectionReceipt) || pin.selection.selectedAt > archive.startedAt) return fail();
    for (const venue of ['mexc', 'okx'] as const) if (!compareAccountIdentity(pin, venue, archive[venue].identity, key).matched) return fail();
    const identities = { mexc: archive.mexc.identity, okx: archive.okx.identity } as AccountBindingPin['identities'];
    const freshness = assessCaptureFreshness({ startedAt: archive.startedAt, endedAt: archive.endedAt, checkedAt: input.now,
      ...(input.previousCheckedAt === undefined ? {} : { previousCheckedAt: input.previousCheckedAt }), requests: [
        { venue: 'mexc', stage: 'identity', requestedAt: identities.mexc.requestedAt, receivedAt: identities.mexc.receivedAt },
        { venue: 'mexc', stage: 'funds', requestedAt: archive.mexc.funds.requestedAt, receivedAt: archive.mexc.funds.receivedAt },
        { venue: 'okx', stage: 'identity', requestedAt: identities.okx.requestedAt, receivedAt: identities.okx.receivedAt },
        { venue: 'okx', stage: 'funds', requestedAt: archive.okx.funds.requestedAt, receivedAt: archive.okx.funds.receivedAt },
      ] });
    if (!freshness.fresh) return fail();
    const result: VerifiedFundsEvidence = freeze({ schema: 1, kind: 'verified-private-funds-evidence', receipt,
      pinHash: archive.pinHash, sourceHash: pin.sourceHash, bundleVersion: pin.bundleVersion, identities,
      startedAt: archive.startedAt, endedAt: archive.endedAt, checkedAt: input.now, credentialCheck: 'capture-time-only',
      venues: { mexc: projectMexc(archive.mexc), okx: projectOkx(archive.okx) }, fundsAdmission: false, executable: false });
    verified.add(result); return result;
  } catch { return fail(); } finally { key?.fill(0); }
}
