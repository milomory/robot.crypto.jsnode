/** Private, explicit account selection. No I/O, implicit enrollment, or trading admission. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AccountCredentialBundle } from './credentials.js';

export const ACCOUNT_BINDING_REFERENCES = Object.freeze({
  mexc: 'secret://inbox/public-review-record-b11569db2351',
  okx: 'secret://inbox/public-review-record-e8115fd14c14',
  okxPassphrase: 'secret://inbox/public-review-record-1425c23b6554',
});
export const ACCOUNT_BINDING_CONTEXT = Object.freeze({ environment: 'mainnet' as const, region: 'global' as const,
  origins: Object.freeze({ mexc: 'https://api.mexc.com', okx: 'https://www.okx.com' }) });
const POLICY = 'account-binding-v1;explicit-accepted-identity-selection;hmac-sha256-private-key-32;' +
  'exact-credentials-references-origins-mainnet-global;opaque-mexc-uid-visible-ascii-1-256;' +
  'okx-main-uid-type-consistent;mexc-main-unverified;capture-ms<=30000;age-from-start-ms<=60000;' +
  'four-sequential-identity-funds-requests;mexc-then-okx;no-auto-enrollment;no-funds-admission';
export const ACCOUNT_BINDING_POLICY_HASH = createHash('sha256').update(POLICY).digest('hex');
const failure = (): never => { throw new Error('account-binding-invalid'); };
const timestamp = z.number().int().positive().max(8_640_000_000_000_000).safe();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const credential = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const credentialBase = z.object({ schema: z.literal(1), environment: z.literal('mainnet'), region: z.literal('global'),
  apiKey: credential.max(1024), apiSecret: credential });
const credentialsSchema = z.object({ schema: z.literal(1),
  mexc: credentialBase.extend({ venue: z.literal('mexc') }).strict(),
  okx: credentialBase.extend({ venue: z.literal('okx'),
    passphrase: z.string().min(1).max(1024).regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/) }).strict(),
}).strict();
const referencesSchema = z.object({ mexc: z.literal(ACCOUNT_BINDING_REFERENCES.mexc),
  okx: z.literal(ACCOUNT_BINDING_REFERENCES.okx), okxPassphrase: z.literal(ACCOUNT_BINDING_REFERENCES.okxPassphrase) }).strict();
const contextSchema = z.object({ environment: z.literal('mainnet'), region: z.literal('global'),
  origins: z.object({ mexc: z.literal(ACCOUNT_BINDING_CONTEXT.origins.mexc), okx: z.literal(ACCOUNT_BINDING_CONTEXT.origins.okx) }).strict(),
}).strict();
const receiptSchema = z.object({ schema: z.literal(1), kind: z.literal('account-identity-observation-receipt'),
  archiveId: uuid, archiveHash: hash }).strict();
const timing = { requestedAt: timestamp, receivedAt: timestamp };
const mexcIdentitySchema = z.object({ venue: z.literal('mexc'), uid: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/),
  mainUid: z.null(), accountType: z.null(), mainAccountConfirmed: z.literal(false),
  mainAccountEvidence: z.literal('not-reported'), source: z.literal('/api/v3/uid'), ...timing }).strict()
  .refine(value => value.receivedAt >= value.requestedAt);
const okxUid = z.string().regex(/^[1-9][0-9]{0,63}$/);
const okxIdentitySchema = z.object({ venue: z.literal('okx'), uid: okxUid, mainUid: okxUid,
  accountType: z.enum(['0', '1', '2', '5', '9', '12']), mainAccountConfirmed: z.boolean(),
  mainAccountEvidence: z.literal('uid-mainUid-and-account-type'), source: z.literal('/api/v5/account/config'), ...timing }).strict()
  .refine(value => value.receivedAt >= value.requestedAt &&
    (value.accountType === '0') === (value.uid === value.mainUid) && value.mainAccountConfirmed === (value.accountType === '0'));
const identitiesSchema = z.object({ mexc: mexcIdentitySchema, okx: okxIdentitySchema }).strict();
const selectionSchema = z.object({ kind: z.literal('explicit-accepted-observation'), receipt: receiptSchema, selectedAt: timestamp }).strict();
const accountSelectionSchema = z.object({ schema: z.literal(1), kind: z.literal('explicit-account-selection'),
  selection: selectionSchema, sourceHash: hash, bundleVersion: uuid, identities: identitiesSchema }).strict()
  .refine(value => value.identities.mexc.receivedAt <= value.identities.okx.requestedAt &&
    value.selection.selectedAt >= value.identities.okx.receivedAt && value.identities.okx.mainAccountConfirmed);
export type AccountSelection = z.infer<typeof accountSelectionSchema>;
/** No credentials are needed to validate a separately selected, previously accepted observation. */
export function parseAccountSelection(value: unknown): AccountSelection {
  try { return frozen(accountSelectionSchema.parse(value)); } catch { return failure(); }
}
const policyHashSchema = z.literal(ACCOUNT_BINDING_POLICY_HASH);
const contextFields = { context: contextSchema, references: referencesSchema, sourceHash: hash,
  policyHash: policyHashSchema, bundleVersion: uuid };
const createSchema = z.object({ selection: selectionSchema, identities: identitiesSchema,
  credentials: credentialsSchema, ...contextFields }).strict()
  .refine(value => value.identities.mexc.receivedAt <= value.identities.okx.requestedAt &&
    value.selection.selectedAt >= value.identities.okx.receivedAt && value.identities.okx.mainAccountConfirmed);
const pinBodySchema = z.object({ schema: z.literal(1), kind: z.literal('account-binding-pin'),
  selection: selectionSchema, identities: identitiesSchema, ...contextFields,
  credentialFingerprint: hash, identitySelectionBound: z.literal(true),
  mexcMainStatus: z.literal('user-declared-unverified'), okxMainStatus: z.literal('exchange-confirmed'),
  fundsVerified: z.literal(false), admissionAllowed: z.literal(false), executable: z.literal(false) }).strict()
  .refine(value => value.identities.mexc.receivedAt <= value.identities.okx.requestedAt &&
    value.selection.selectedAt >= value.identities.okx.receivedAt && value.identities.okx.mainAccountConfirmed);
// z.intersection would retain permissive object behavior; compose the strict full schema explicitly.
const pinSchema = z.object({ schema: z.literal(1), kind: z.literal('account-binding-pin'), selection: selectionSchema,
  identities: identitiesSchema, ...contextFields, credentialFingerprint: hash,
  identitySelectionBound: z.literal(true), mexcMainStatus: z.literal('user-declared-unverified'),
  okxMainStatus: z.literal('exchange-confirmed'), fundsVerified: z.literal(false),
  admissionAllowed: z.literal(false), executable: z.literal(false), pinIntegrity: hash }).strict()
  .refine(value => value.identities.mexc.receivedAt <= value.identities.okx.requestedAt &&
    value.selection.selectedAt >= value.identities.okx.receivedAt && value.identities.okx.mainAccountConfirmed);
export type AccountBindingPin = z.infer<typeof pinSchema>;
export type AccountBindingCreateInput = z.infer<typeof createSchema>;
const credentialComparisonSchema = z.object({ credentials: credentialsSchema, ...contextFields }).strict();
export type AccountBindingCredentialComparison = z.infer<typeof credentialComparisonSchema>;
const comparisonSchema = credentialComparisonSchema.extend({ identities: identitiesSchema }).strict();
export type AccountBindingComparison = z.infer<typeof comparisonSchema>;
export type AccountBindingStatusCode = 'matched' | 'invalid' | 'pin-integrity-invalid' |
  'context-mismatch' | 'credential-rotation' | 'identity-mismatch';
export type AccountBindingStatus = Readonly<{ schema: 1; code: AccountBindingStatusCode; matched: boolean;
  mainAccountsVerified: false; fundsVerified: false; admissionAllowed: false; executable: false }>;
const status = (code: AccountBindingStatusCode): AccountBindingStatus => Object.freeze({ schema: 1, code, matched: code === 'matched',
  mainAccountsVerified: false, fundsVerified: false, admissionAllowed: false, executable: false });

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function keyCopy(value: unknown) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) return failure();
  return Buffer.from(value);
}
function mac(key: Buffer, domain: string, data: unknown) {
  return createHmac('sha256', key).update(domain).update('\0').update(JSON.stringify(data)).digest('hex');
}
function sameHash(a: string, b: string) { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
/** Canonical reconstruction matters: parser key order and caller object order cannot affect versions. */
function canonicalCredentials(value: z.infer<typeof credentialsSchema>) {
  // The standard consumer parser remains a second independent guard on the credential boundary.
  if (AccountCredentialBundle.parse(JSON.stringify(value.mexc)).venue !== 'mexc' ||
      AccountCredentialBundle.parse(JSON.stringify(value.okx)).venue !== 'okx') return failure();
  return { schema: 1, mexc: { schema: 1, venue: 'mexc', environment: 'mainnet', region: 'global',
    apiKey: value.mexc.apiKey, apiSecret: value.mexc.apiSecret },
  okx: { schema: 1, venue: 'okx', environment: 'mainnet', region: 'global',
    apiKey: value.okx.apiKey, apiSecret: value.okx.apiSecret, passphrase: value.okx.passphrase } };
}
function fingerprint(credentials: z.infer<typeof credentialsSchema>, references: z.infer<typeof referencesSchema>, key: Buffer) {
  return mac(key, 'crypto-account-binding/credential/v1', { credentials: canonicalCredentials(credentials),
    references: { mexc: references.mexc, okx: references.okx, okxPassphrase: references.okxPassphrase } });
}
function pinBody(pin: AccountBindingPin) {
  const { pinIntegrity: _ignored, ...body } = pin;
  return pinBodySchema.parse(body);
}
/** Private return value includes UID and keyed versions. Never publish or log this DTO. */
export function parseAccountBindingPin(value: unknown): AccountBindingPin {
  try { return frozen(pinSchema.parse(value)); } catch { return failure(); }
}
/**
 * Only the separate enrollment operation may call this constructor. The caller must verify the
 * selected accepted archive's hash and exact normalized identities before calling. A matching
 * first API response is not that authority. This function cannot verify human authorization.
 * bundleVersion is an explicit private binding UUID, not a claimed vault revision.
 */
export function createAccountBindingPin(value: unknown, bindingKey: unknown): AccountBindingPin {
  let key: Buffer | undefined;
  try {
    key = keyCopy(bindingKey);
    const input = createSchema.parse(value);
    const body = pinBodySchema.parse({ schema: 1, kind: 'account-binding-pin', selection: input.selection,
      identities: input.identities, context: input.context, references: input.references, sourceHash: input.sourceHash,
      policyHash: input.policyHash, bundleVersion: input.bundleVersion,
      credentialFingerprint: fingerprint(input.credentials, input.references, key), identitySelectionBound: true,
      mexcMainStatus: 'user-declared-unverified', okxMainStatus: 'exchange-confirmed', fundsVerified: false,
      admissionAllowed: false, executable: false });
    const pinIntegrity = mac(key, 'crypto-account-binding/pin/v1', body);
    return parseAccountBindingPin({ ...body, pinIntegrity });
  } catch { return failure(); } finally { key?.fill(0); }
}
/** Key-only preflight. False is fixed and never includes an identifier, digest, or exception. */
export function verifyPinIntegrity(value: unknown, bindingKey: unknown): boolean {
  let key: Buffer | undefined;
  try {
    key = keyCopy(bindingKey); const pin = parseAccountBindingPin(value);
    return sameHash(pin.pinIntegrity, mac(key, 'crypto-account-binding/pin/v1', pinBody(pin)));
  } catch { return false; } finally { key?.fill(0); }
}
function contextMatches(pin: AccountBindingPin, input: AccountBindingCredentialComparison) {
  return pin.sourceHash === input.sourceHash && pin.policyHash === input.policyHash && pin.bundleVersion === input.bundleVersion &&
    JSON.stringify(pin.context) === JSON.stringify(input.context) && JSON.stringify(pin.references) === JSON.stringify(input.references);
}
/** Call before any API request. Rotation closes this comparison; it never rewrites the pin. */
export function compareAccountCredentials(value: unknown, current: unknown, bindingKey: unknown): AccountBindingStatus {
  let key: Buffer | undefined;
  try {
    key = keyCopy(bindingKey); const pin = parseAccountBindingPin(value);
    if (!verifyPinIntegrity(pin, key)) return status('pin-integrity-invalid');
    const input = credentialComparisonSchema.parse(current);
    if (!contextMatches(pin, input)) return status('context-mismatch');
    return status(sameHash(pin.credentialFingerprint, fingerprint(input.credentials, input.references, key)) ? 'matched' : 'credential-rotation');
  } catch { return status('invalid'); } finally { key?.fill(0); }
}
function identityMatches(pin: AccountBindingPin, venue: 'mexc' | 'okx', current: unknown) {
  const expected = pin.identities[venue];
  const identity = venue === 'mexc' ? mexcIdentitySchema.parse(current) : okxIdentitySchema.parse(current);
  // Observation timestamps must be individually valid, but are not account identifiers.
  return expected.venue === identity.venue && expected.uid === identity.uid && expected.mainUid === identity.mainUid &&
    expected.accountType === identity.accountType && expected.mainAccountConfirmed === identity.mainAccountConfirmed &&
    expected.mainAccountEvidence === identity.mainAccountEvidence && expected.source === identity.source;
}
/** Call immediately after each identity GET and before that venue's funds GET. */
export function compareAccountIdentity(value: unknown, venue: unknown, identity: unknown, bindingKey: unknown): AccountBindingStatus {
  try {
    const pin = parseAccountBindingPin(value);
    if (!verifyPinIntegrity(pin, bindingKey)) return status('pin-integrity-invalid');
    if (venue !== 'mexc' && venue !== 'okx') return status('invalid');
    return status(identityMatches(pin, venue, identity) ? 'matched' : 'identity-mismatch');
  } catch { return status('invalid'); }
}
/** Full final comparison is still not main-account proof, accepted funds semantics, or admission. */
export function compareAccountBinding(value: unknown, current: unknown, bindingKey: unknown): AccountBindingStatus {
  try {
    const input = comparisonSchema.parse(current), { identities, ...credentialInput } = input;
    const credentials = compareAccountCredentials(value, credentialInput, bindingKey);
    if (!credentials.matched) return credentials;
    const pin = parseAccountBindingPin(value);
    return status(identityMatches(pin, 'mexc', identities.mexc) && identityMatches(pin, 'okx', identities.okx) ? 'matched' : 'identity-mismatch');
  } catch { return status('invalid'); }
}

const requestInterval = z.object({ venue: z.enum(['mexc', 'okx']), stage: z.enum(['identity', 'funds']),
  requestedAt: timestamp, receivedAt: timestamp }).strict();
const freshnessSchema = z.object({ startedAt: timestamp, endedAt: timestamp, checkedAt: timestamp,
  previousCheckedAt: timestamp.optional(), requests: z.array(requestInterval).length(4) }).strict();
export type AccountCaptureFreshnessInput = z.infer<typeof freshnessSchema>;
export type AccountCaptureFreshnessCode = 'fresh' | 'invalid' | 'clock-regression' | 'interval-exceeded' | 'stale';
export type AccountCaptureFreshness = Readonly<{ schema: 1; code: AccountCaptureFreshnessCode; fresh: boolean;
  fundsVerified: false; admissionAllowed: false; executable: false }>;
const freshness = (code: AccountCaptureFreshnessCode): AccountCaptureFreshness => Object.freeze({ schema: 1, code,
  fresh: code === 'fresh', fundsVerified: false, admissionAllowed: false, executable: false });
/** Inclusive bounds, measured from capture start, not the most recent HTTP response. */
export function assessCaptureFreshness(value: unknown): AccountCaptureFreshness {
  try {
    const input = freshnessSchema.parse(value);
    const expected = ['mexc:identity', 'mexc:funds', 'okx:identity', 'okx:funds'];
    if (input.requests.some((request, i) => request.venue + ':' + request.stage !== expected[i])) return freshness('invalid');
    const ordered = [input.startedAt, ...input.requests.flatMap(request => [request.requestedAt, request.receivedAt]), input.endedAt, input.checkedAt];
    if (ordered.some((value, i) => i > 0 && value < ordered[i - 1]) ||
        (input.previousCheckedAt !== undefined && input.checkedAt < input.previousCheckedAt)) return freshness('clock-regression');
    if (input.endedAt - input.startedAt > 30_000) return freshness('interval-exceeded');
    if (input.checkedAt - input.startedAt > 60_000) return freshness('stale');
    return freshness('fresh');
  } catch { return freshness('invalid'); }
}
