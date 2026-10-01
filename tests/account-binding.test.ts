import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_BINDING_CONTEXT, ACCOUNT_BINDING_POLICY_HASH, ACCOUNT_BINDING_REFERENCES,
  assessCaptureFreshness, compareAccountBinding, compareAccountCredentials, compareAccountIdentity,
  createAccountBindingPin, parseAccountBindingPin, parseAccountSelection, verifyPinIntegrity,
  type AccountBindingStatus, type AccountCaptureFreshnessInput,
} from '../src/accounts/account-binding.js';

const start = Date.UTC(2026, 8, 30, 10);
const key = () => Buffer.from('93a64f130c6a6ed30fe480ce7842c82e8172b1c9fb423a503c8222fe57635510', 'hex');
const secretValues = ['MEXC_KEY_PRIVATE_5290', 'MEXC_SECRET_PRIVATE_5291', 'OKX_KEY_PRIVATE_5292', 'OKX_SECRET_PRIVATE_5293', 'OKX phrase PRIVATE 5294'];
const mexcUid = 'CaAb-eed7_opaque#5295', okxUid = '123456789876543210123456789876543210';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identities = () => ({
  mexc: { venue: 'mexc' as const, uid: mexcUid, mainUid: null, accountType: null, mainAccountConfirmed: false as const,
    mainAccountEvidence: 'not-reported' as const, source: '/api/v3/uid' as const, requestedAt: start, receivedAt: start + 10 },
  okx: { venue: 'okx' as const, uid: okxUid, mainUid: okxUid, accountType: '0' as const, mainAccountConfirmed: true,
    mainAccountEvidence: 'uid-mainUid-and-account-type' as const, source: '/api/v5/account/config' as const,
    requestedAt: start + 20, receivedAt: start + 30 },
});
const credentials = () => ({ schema: 1, mexc: { schema: 1, venue: 'mexc', environment: 'mainnet', region: 'global',
  apiKey: secretValues[0], apiSecret: secretValues[1] }, okx: { schema: 1, venue: 'okx', environment: 'mainnet', region: 'global',
  apiKey: secretValues[2], apiSecret: secretValues[3], passphrase: secretValues[4] } });
const selection = () => ({ schema: 1, kind: 'explicit-account-selection', selection: {
  kind: 'explicit-accepted-observation', receipt: { schema: 1, kind: 'account-identity-observation-receipt',
    archiveId: 'd058bfba-03f3-4cf6-bfed-02e6fc51eaae', archiveHash: 'f'.repeat(64) }, selectedAt: start + 40 },
  identities: identities(), sourceHash: 'a'.repeat(64), bundleVersion: 'd058bfba-03f3-4cf6-bfed-02e6fc51eaaf' });
const input = () => { const { selection: selected, identities: ids, sourceHash, bundleVersion } = selection();
  return { selection: selected, identities: ids, sourceHash, bundleVersion, policyHash: ACCOUNT_BINDING_POLICY_HASH,
    credentials: credentials(), context: copy(ACCOUNT_BINDING_CONTEXT), references: copy(ACCOUNT_BINDING_REFERENCES) }; };
const comparison = () => { const { selection: _selection, ...rest } = input(); return rest; };
const credentialComparison = () => { const { identities: _identities, ...rest } = comparison(); return rest; };
const pin = () => createAccountBindingPin(input(), key());
const closed = (result: AccountBindingStatus, code: AccountBindingStatus['code']) => {
  expect(result).toEqual({ schema: 1, code, matched: code === 'matched', mainAccountsVerified: false,
    fundsVerified: false, admissionAllowed: false, executable: false });
  expect(Object.isFrozen(result)).toBe(true);
  const text = JSON.stringify(result);
  for (const value of [...secretValues, mexcUid, okxUid]) expect(text).not.toContain(value);
};

 describe('explicit private account selection and stable credential binding', () => {
  it('binds only an explicit accepted selection and never upgrades MEXC proof or funds admission', () => {
    const selected = parseAccountSelection(selection()), result = pin();
    expect(selected.selection.kind).toBe('explicit-accepted-observation');
    expect(result).toMatchObject({ schema: 1, kind: 'account-binding-pin', selection: selected.selection,
      identitySelectionBound: true, mexcMainStatus: 'user-declared-unverified', okxMainStatus: 'exchange-confirmed',
      fundsVerified: false, admissionAllowed: false, executable: false });
    expect(result.identities.mexc.uid).toBe(mexcUid); expect(result.identities.okx.uid).toBe(okxUid);
    expect(result.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(result.pinIntegrity).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyPinIntegrity(result, key())).toBe(true);
    closed(compareAccountBinding(result, comparison(), key()), 'matched');
    for (const value of secretValues) expect(JSON.stringify(result)).not.toContain(value);
    expect(Object.isFrozen(result.identities.mexc)).toBe(true); expect(Object.isFrozen(result.selection.receipt)).toBe(true);
    expect(Object.isFrozen(result.context.origins)).toBe(true); expect(Object.isFrozen(selected.identities.okx)).toBe(true);
  });
  it('does not create a baseline from an observation or comparison alone', () => {
    for (const absent of [null, undefined, {}, identities()]) closed(compareAccountBinding(absent, comparison(), key()), 'invalid');
    const value = input(); delete (value as Partial<typeof value>).selection;
    expect(() => createAccountBindingPin(value, key())).toThrow('account-binding-invalid');
    const implicit = { ...input(), selection: { ...selection().selection, kind: 'first-observation' } };
    expect(() => createAccountBindingPin(implicit, key())).toThrow('account-binding-invalid');
  });
  it('requires main account proof from the OKX response when selecting the main-only baseline', () => {
    const sub = { ...identities().okx, uid: '999', accountType: '1', mainAccountConfirmed: false };
    expect(() => createAccountBindingPin({ ...input(), identities: { ...identities(), okx: sub } }, key())).toThrow('account-binding-invalid');
    expect(() => parseAccountSelection({ ...selection(), identities: { ...identities(), okx: sub } })).toThrow('account-binding-invalid');
  });
  it('snapshots and freezes caller-owned identities, refs and selection instead of following later mutation', () => {
    const value = input(), snapshot = copy(value), result = createAccountBindingPin(value, key());
    value.identities.mexc.uid = 'different'; value.credentials.okx.passphrase = 'different';
    value.selection.receipt.archiveHash = '1'.repeat(64); value.sourceHash = '2'.repeat(64);
    expect(result.identities.mexc.uid).toBe(snapshot.identities.mexc.uid);
    expect(result.selection.receipt.archiveHash).toBe(snapshot.selection.receipt.archiveHash);
    expect(result.sourceHash).toBe(snapshot.sourceHash);
    closed(compareAccountBinding(result, comparison(), key()), 'matched');
    expect(() => { result.identities.mexc.uid = 'rewrite'; }).toThrow();
  });
  it('retains equality across JSON persistence and arbitrary caller key order', () => {
    const original = input();
    const reversed = (value: unknown): unknown => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ?
      Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)])) : value;
    const first = createAccountBindingPin(original, key()), second = createAccountBindingPin(reversed(original), key());
    expect(first).toEqual(second);
    expect(parseAccountBindingPin(copy(first))).toEqual(first); expect(verifyPinIntegrity(reversed(first), key())).toBe(true);
    closed(compareAccountBinding(copy(first), reversed(comparison()), key()), 'matched');
  });
  it('uses keyed versions and domain separation, not a public plaintext credential hash', () => {
    const first = pin(), changedKey = key(); changedKey[0] ^= 1;
    const second = createAccountBindingPin(input(), changedKey);
    expect(second.credentialFingerprint).not.toBe(first.credentialFingerprint); expect(second.pinIntegrity).not.toBe(first.pinIntegrity);
    expect(first.credentialFingerprint).not.toBe(createHash('sha256').update(JSON.stringify(credentials())).digest('hex'));
    expect(verifyPinIntegrity(first, changedKey)).toBe(false);
    closed(compareAccountBinding(first, comparison(), changedKey), 'pin-integrity-invalid');
    const spoof = { ...first, pinIntegrity: first.credentialFingerprint };
    expect(verifyPinIntegrity(spoof, key())).toBe(false);
    const alternate = { ...first, pinIntegrity: createHmac('sha256', key()).update(JSON.stringify(first)).digest('hex') };
    expect(verifyPinIntegrity(alternate, key())).toBe(false);
  });
  it('accepts a view of exactly32 key bytes and never wipes or changes the caller key', () => {
    const allocation = Buffer.concat([Buffer.from([1]), key(), Buffer.from([2])]), view = allocation.subarray(1, 33), before = Buffer.from(allocation);
    const result = createAccountBindingPin(input(), view);
    expect(allocation).toEqual(before); expect(verifyPinIntegrity(result, view)).toBe(true);
    closed(compareAccountCredentials(result, credentialComparison(), view), 'matched'); expect(allocation).toEqual(before);
  });
  it.each([null, undefined, [], 'a'.repeat(32), Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), new Uint16Array(16)])
    ('rejects invalid binding key without leaking it: case %#', value => {
      expect(() => createAccountBindingPin(input(), value)).toThrow('account-binding-invalid');
      expect(verifyPinIntegrity(pin(), value)).toBe(false);
      closed(compareAccountCredentials(pin(), credentialComparison(), value), 'invalid');
    });
  it('makes no fetch, file, environment or vault request', () => {
    const request = vi.spyOn(globalThis, 'fetch');
    try { const selected = pin(); compareAccountBinding(selected, comparison(), key()); verifyPinIntegrity(selected, key()); expect(request).not.toHaveBeenCalled(); }
    finally { request.mockRestore(); }
  });
});

describe('strict selection and pin boundary', () => {
  const changes: [string, (value: ReturnType<typeof input>) => void][] = [
    ['unknown constructor field', value => Object.assign(value, { enroll: true })],
    ['unrecognized context origin', value => { Object.assign(value.context.origins, { mexc: 'https://api.mexc.com.evil' }); }],
    ['other environment', value => Object.assign(value.context, { environment: 'testnet' })],
    ['other region', value => Object.assign(value.context, { region: 'eu' })],
    ['unexpected reference', value => { Object.assign(value.references, { mexc: 'secret://other' }); }],
    ['wrong case source hash', value => { value.sourceHash = 'A'.repeat(64); }],
    ['wrong policy', value => { value.policyHash = 'b'.repeat(64); }],
    ['non UUID binding version', value => { value.bundleVersion = 'vault-latest'; }],
    ['numeric MEXC UID', value => Object.assign(value.identities.mexc, { uid: 9876 })],
    ['MEXC main assertion', value => Object.assign(value.identities.mexc, { mainAccountConfirmed: true })],
    ['MEXC claimed mainUID', value => Object.assign(value.identities.mexc, { mainUid: mexcUid })],
    ['MEXC unknown source', value => Object.assign(value.identities.mexc, { source: '/api/v3/account' })],
    ['leading zero OKXUID', value => { value.identities.okx.uid = '0123'; value.identities.okx.mainUid = '0123'; }],
    ['inconsistent OKX mainUID', value => { value.identities.okx.mainUid = '456'; }],
    ['unknown OKX type', value => Object.assign(value.identities.okx, { accountType: '99' })],
    ['inconsistent OKXmainflag', value => { value.identities.okx.mainAccountConfirmed = false; }],
    ['selection precedes observation', value => { value.selection.selectedAt = start + 29; }],
    ['overlapping identity responses', value => { value.identities.okx.requestedAt = start + 9; }],
    ['backward identity clock', value => { value.identities.mexc.receivedAt = start - 1; }],
    ['missing accepted receipt', value => { delete (value.selection as Partial<typeof value.selection>).receipt; }],
    ['forged accepted kind', value => { value.selection.receipt.kind = 'account-funds-receipt'; }],
    ['extra receipt field', value => Object.assign(value.selection.receipt, { uid: mexcUid })],
    ['extra normalized identity field', value => Object.assign(value.identities.okx, { apiKey: secretValues[2] })],
    ['swapped credential venue', value => { value.credentials.mexc.venue = 'okx'; }],
    ['unsupported credential environment', value => { value.credentials.okx.environment = 'demo'; }],
    ['unexpected credential member', value => Object.assign(value.credentials.mexc, { passphrase: 'no' })],
    ['trailing passphrase space', value => { value.credentials.okx.passphrase += ' '; }],
  ];
  it.each(changes)('rejects %s with a fixed error', (_label, change) => {
    const value = input(); change(value);
    expect(() => createAccountBindingPin(value, key())).toThrow(/^account-binding-invalid$/);
  });
  it.each(['', ' ', 'uid trailing ', 'uid\n', '\u0000private', 'юид', 'x'.repeat(257)])('does not normalize invalid MEXC opaque UID %#', uid => {
    const value = input(); value.identities.mexc.uid = uid;
    expect(() => createAccountBindingPin(value, key())).toThrow(/^account-binding-invalid$/);
  });
  it.each(['!', 'A-a_#:[({+?$%', '1', '0', 'x'.repeat(256)])('preserves a bounded visible ASCII MEXC UID exactly %#', uid => {
    const value = input(); value.identities.mexc.uid = uid;
    const selected = createAccountBindingPin(value, key()); expect(selected.identities.mexc.uid).toBe(uid);
    closed(compareAccountIdentity(selected, 'mexc', { ...identities().mexc, uid }, key()), 'matched');
  });
  it.each([NaN, Infinity, 0, -1, 1.5, 8_640_000_000_000_001])('rejects invalid selection time %#', selectedAt => {
    const value = selection(); value.selection.selectedAt = selectedAt;
    expect(() => parseAccountSelection(value)).toThrow(/^account-binding-invalid$/);
  });
  it('requires exact selection-only fields before keys and rejects attempts to attach them', () => {
    expect(() => parseAccountSelection({ ...selection(), credentials: credentials() })).toThrow(/^account-binding-invalid$/);
    const missing = selection(); delete (missing as Partial<typeof missing>).selection;
    expect(() => parseAccountSelection(missing)).toThrow(/^account-binding-invalid$/);
    expect(() => parseAccountSelection({ ...selection(), extra: { private: secretValues[0] } })).toThrow(/^account-binding-invalid$/);
  });
  it('contains thrown private strings even from hostile getters, proxies or toJSON values', () => {
    const evil = Object.defineProperty({}, 'schema', { get() { throw new Error(secretValues[0]); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error(mexcUid); } });
    for (const value of [evil, proxy, { toJSON() { throw new Error(secretValues[1]); } }]) {
      expect(() => parseAccountBindingPin(value)).toThrow(/^account-binding-invalid$/);
      expect(() => parseAccountSelection(value)).toThrow(/^account-binding-invalid$/);
      expect(() => createAccountBindingPin(value, key())).toThrow(/^account-binding-invalid$/);
      closed(compareAccountBinding(value, comparison(), key()), 'invalid');
      expect(verifyPinIntegrity(value, key())).toBe(false);
    }
  });
});

describe('rotation, identity drift and pin tampering fail closed', () => {
  it.each([
    ['mexc', 'apiKey'], ['mexc', 'apiSecret'], ['okx', 'apiKey'], ['okx', 'apiSecret'], ['okx', 'passphrase'],
  ] as const)('detects same-reference %s/%s rotation before requests without changing the baseline', (venue, field) => {
    const selected = pin(), before = JSON.stringify(selected), changed = credentialComparison();
    (changed.credentials[venue] as Record<string, string | number>)[field] = 'NEW_PRIVATE_ROTATED_VALUE';
    closed(compareAccountCredentials(selected, changed, key()), 'credential-rotation');
    expect(JSON.stringify(selected)).toBe(before);
    closed(compareAccountCredentials(selected, credentialComparison(), key()), 'matched');
  });
  it('does not accept passphrase case or interior-space normalization as the same key', () => {
    const selected = pin(), changed = credentialComparison(); changed.credentials.okx.passphrase = secretValues[4].toLowerCase();
    closed(compareAccountCredentials(selected, changed, key()), 'credential-rotation');
    changed.credentials.okx.passphrase = secretValues[4].replace(' ', '  ');
    closed(compareAccountCredentials(selected, changed, key()), 'credential-rotation');
  });
  it.each(['sourceHash', 'bundleVersion'] as const)('requires the selected %s without silently repinning', field => {
    const selected = pin(), changed = credentialComparison();
    changed[field] = field === 'sourceHash' ? 'b'.repeat(64) : 'd058bfba-03f3-4cf6-bfed-02e6fc51eab0';
    closed(compareAccountCredentials(selected, changed, key()), 'context-mismatch');
  });
  it.each(['mexc', 'okx'] as const)('rejects changed %s identity before funds and at final comparison', venue => {
    const selected = pin(), current = comparison();
    if (venue === 'mexc') current.identities.mexc.uid = mexcUid.toLowerCase();
    else { current.identities.okx.uid = '111'; current.identities.okx.mainUid = '111'; }
    closed(compareAccountIdentity(selected, venue, current.identities[venue], key()), 'identity-mismatch');
    closed(compareAccountBinding(selected, current, key()), 'identity-mismatch');
    closed(compareAccountBinding(selected, comparison(), key()), 'matched');
  });
  it('rejects a current consistent OKX subaccount while preserving a main baseline', () => {
    const selected = pin(); const sub = { ...identities().okx, uid: '456', accountType: '1', mainAccountConfirmed: false };
    closed(compareAccountIdentity(selected, 'okx', sub, key()), 'identity-mismatch');
  });
  it('accepts later observation timestamps without interpreting them as immutable account identity', () => {
    const selected = pin(), current = comparison();
    for (const venue of ['mexc', 'okx'] as const) { current.identities[venue].requestedAt += 1000; current.identities[venue].receivedAt += 1000; }
    closed(compareAccountBinding(selected, current, key()), 'matched');
    closed(compareAccountIdentity(selected, 'mexc', current.identities.mexc, key()), 'matched');
  });
  it('rejects reversed venues and unsupported single-venue calls', () => {
    closed(compareAccountIdentity(pin(), 'mexc', identities().okx, key()), 'invalid');
    closed(compareAccountIdentity(pin(), 'okx', identities().mexc, key()), 'invalid');
    closed(compareAccountIdentity(pin(), 'bybit', identities().mexc, key()), 'invalid');
  });
  it.each([
    (value: ReturnType<typeof pin>) => { value.identities.mexc.uid = 'other-valid-private-uid'; },
    (value: ReturnType<typeof pin>) => { value.identities.okx.uid = '111'; value.identities.okx.mainUid = '111'; },
    (value: ReturnType<typeof pin>) => { value.credentialFingerprint = '0'.repeat(64); },
    (value: ReturnType<typeof pin>) => { value.selection.receipt.archiveHash = '0'.repeat(64); },
    (value: ReturnType<typeof pin>) => { value.selection.receipt.archiveId = 'd058bfba-03f3-4cf6-bfed-02e6fc51eab0'; },
    (value: ReturnType<typeof pin>) => { value.selection.selectedAt += 1; },
    (value: ReturnType<typeof pin>) => { value.sourceHash = 'b'.repeat(64); },
    (value: ReturnType<typeof pin>) => { value.bundleVersion = 'd058bfba-03f3-4cf6-bfed-02e6fc51eab0'; },
  ])('authenticates every private baseline component rather than merely validating shape %#', change => {
    const selected = copy(pin()); change(selected);
    expect(() => parseAccountBindingPin(selected)).not.toThrow(); expect(verifyPinIntegrity(selected, key())).toBe(false);
    closed(compareAccountCredentials(selected, credentialComparison(), key()), 'pin-integrity-invalid');
    closed(compareAccountIdentity(selected, 'mexc', identities().mexc, key()), 'pin-integrity-invalid');
  });
  it.each(['fundsVerified', 'admissionAllowed', 'executable'] as const)('rejects elevation of private pin flag %s', flag => {
    const selected = { ...pin(), [flag]: true };
    expect(() => parseAccountBindingPin(selected)).toThrow(/^account-binding-invalid$/);
    expect(verifyPinIntegrity(selected, key())).toBe(false); closed(compareAccountBinding(selected, comparison(), key()), 'invalid');
  });
  it('never returns selection hashes, receipts, UIDs, digests or supplied private error text in public statuses', () => {
    const selected = pin(), input = comparison(); input.identities.mexc.uid = 'PRIVATE_CHANGED_ACCOUNT';
    const result = compareAccountBinding(selected, input, key()), text = JSON.stringify(result);
    for (const value of [selected.pinIntegrity, selected.credentialFingerprint, selected.selection.receipt.archiveHash,
      selected.selection.receipt.archiveId, selected.sourceHash, selected.policyHash, 'PRIVATE_CHANGED_ACCOUNT', mexcUid, okxUid, ...secretValues]) expect(text).not.toContain(value);
    expect(Object.keys(result).sort()).toEqual(['admissionAllowed', 'code', 'executable', 'fundsVerified', 'mainAccountsVerified', 'matched', 'schema']);
  });
});

const capture = (): AccountCaptureFreshnessInput => ({ startedAt: start, endedAt: start + 1000, checkedAt: start + 1000,
  requests: [{ venue: 'mexc', stage: 'identity', requestedAt: start, receivedAt: start + 100 },
    { venue: 'mexc', stage: 'funds', requestedAt: start + 100, receivedAt: start + 200 },
    { venue: 'okx', stage: 'identity', requestedAt: start + 300, receivedAt: start + 400 },
    { venue: 'okx', stage: 'funds', requestedAt: start + 500, receivedAt: start + 900 }] });
const freshResult = (code: 'fresh' | 'invalid' | 'clock-regression' | 'interval-exceeded' | 'stale') => ({ schema: 1, code,
  fresh: code === 'fresh', fundsVerified: false, admissionAllowed: false, executable: false });
describe('bounded freshness of a four-request funds capture', () => {
  it('accepts ordered captures and inclusive 30-second interval and60-second start age without funds admission', () => {
    const input = capture(); input.endedAt = start + 30_000; input.checkedAt = start + 60_000;
    const output = assessCaptureFreshness(input); expect(output).toEqual(freshResult('fresh')); expect(Object.isFrozen(output)).toBe(true);
  });
  it('ages from the first request interval start, not from the last response', () => {
    const input = capture(); input.endedAt = start + 30_000; input.checkedAt = start + 60_001;
    expect(assessCaptureFreshness(input)).toEqual(freshResult('stale'));
  });
  it('rejects a slow capture even if the last response is recent', () => {
    const input = capture(); input.endedAt = start + 30_001; input.checkedAt = input.endedAt;
    expect(assessCaptureFreshness(input)).toEqual(freshResult('interval-exceeded'));
  });
  it('accepts an instantaneous bounded clock without inventing a minimum interval', () => {
    const input = capture(); for (const item of input.requests) item.requestedAt = item.receivedAt = start;
    input.endedAt = input.checkedAt = start; expect(assessCaptureFreshness(input)).toEqual(freshResult('fresh'));
  });
  it.each([
    (v: AccountCaptureFreshnessInput) => { v.requests[0].requestedAt = start - 1; },
    (v: AccountCaptureFreshnessInput) => { v.requests[0].receivedAt = start - 1; },
    (v: AccountCaptureFreshnessInput) => { v.requests[1].requestedAt = start + 99; },
    (v: AccountCaptureFreshnessInput) => { v.requests[2].requestedAt = start + 199; },
    (v: AccountCaptureFreshnessInput) => { v.requests[3].receivedAt = start + 499; },
    (v: AccountCaptureFreshnessInput) => { v.endedAt = start + 899; },
    (v: AccountCaptureFreshnessInput) => { v.checkedAt = start + 999; },
    (v: AccountCaptureFreshnessInput) => { v.previousCheckedAt = start + 1001; },
  ])('rejects clock regression at every boundary or after a previous use %#', change => {
    const value = capture(); change(value); expect(assessCaptureFreshness(value)).toEqual(freshResult('clock-regression'));
  });
  it('accepts equal previous check time but does not mutate or establish a hidden baseline', () => {
    const value = capture(); value.previousCheckedAt = value.checkedAt;
    const before = copy(value); expect(assessCaptureFreshness(value)).toEqual(freshResult('fresh')); expect(value).toEqual(before);
    expect(assessCaptureFreshness(capture())).toEqual(freshResult('fresh'));
  });
  it.each([0, -1, NaN, Infinity, 1.2, 8_640_000_000_000_001])('rejects malformed public clock values %#', value => {
    expect(assessCaptureFreshness({ ...capture(), checkedAt: value })).toEqual(freshResult('invalid'));
  });
  it('rejects missing/extra intervals, wrong venue order and concurrent reused snapshots', () => {
    const values = [capture(), capture(), capture(), capture()];
    values[0].requests.pop(); values[1].requests.push({ ...values[1].requests[3] });
    values[2].requests.reverse(); values[3].requests[2] = { ...values[3].requests[0] };
    for (const value of values) expect(assessCaptureFreshness(value)).toEqual(freshResult('invalid'));
  });
  it('rejects private amounts or identities inserted into a public freshness argument', () => {
    const value = { ...capture(), uid: mexcUid };
    expect(assessCaptureFreshness(value)).toEqual(freshResult('invalid'));
    const another = capture(); Object.assign(another.requests[0], { balance: '123.45' });
    expect(assessCaptureFreshness(another)).toEqual(freshResult('invalid'));
  });
});
