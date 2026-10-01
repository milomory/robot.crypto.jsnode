import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyOkxCapacityEvidence, isVerifiedOkxCapacityEvidence } from '../src/live/okx-capacity-evidence.js';
import type { OkxCapacityArchive } from '../src/accounts/okx-capacity-contract.js';
import { fundsEvidenceFixture } from './helpers/funds-evidence-fixture.js';

const hash = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const failure = /^capacity-evidence-invalid$/;
const BASE_BLOCKERS = ['source-time-unavailable', 'capacity-not-reserved', 'fee-inclusion-unconfirmed', 'separate-funds-evidence-required'] as const;

/** Independent synthetic archive, with an existing synthetic signed pin. No disk or network I/O. */
function fixture() {
  const funds = fundsEvidenceFixture();
  const start = funds.archive.startedAt + 1000, collectorSourceHash = 'c'.repeat(64);
  const config = (offset: number) => ({
    identity: { ...funds.pin.identities.okx, accountType: '0' as const, mainAccountConfirmed: true as const,
      requestedAt: start + offset, receivedAt: start + offset + 100 },
    configuration: { accountMode: '1' as const, autoLoan: false, enableSpotBorrow: false,
      spotBorrowAutoRepay: false, feeType: '0' as const, unavailableFields: {} },
  });
  const archive: OkxCapacityArchive = {
    schema: 1, kind: 'okx-capacity-observation', archiveId: '22446688-3355-4477-8899-223344556677',
    startedAt: start, endedAt: start + 700, environment: 'mainnet',
    selectionReceipt: copy(funds.pin.selection.receipt), bundleVersion: funds.pin.bundleVersion,
    pinHash: hash(funds.pinBytes), bindingSourceHash: funds.pin.sourceHash, collectorSourceHash,
    identityEnrolled: true, credentialBundleMatched: true, capacityBound: true, capacityAdmission: false, executable: false, requestCount: 3,
    okx: { schema: 1, venue: 'okx', environment: 'mainnet', origin: 'https://www.okx.com', symbol: 'BTC/USDT',
      requestCount: 3, identityAccepted: true, configurationStable: true, executable: false,
      before: config(100), after: config(500),
      capacity: { source: '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDT',
        requestedAt: start + 300, receivedAt: start + 400, sourceUpdatedAt: null,
        quoteCurrencyEcho: 'not-reported', buyQuoteAvailable: '100.123456789012345678901234567890', sellBaseAvailable: '0.000000000000000000000000000001', buyUnit: 'USDT', sellUnit: 'BTC' },
      blockers: [...BASE_BLOCKERS] },
  };
  const input = () => {
    const archiveBytes = encode(archive);
    return { archiveBytes, receipt: { schema: 1, kind: 'okx-capacity-observation-receipt', archiveId: archive.archiveId, archiveHash: hash(archiveBytes) },
      pinBytes: Buffer.from(funds.pinBytes), bindingKey: Buffer.from(funds.bindingKey), expectedCollectorSourceHash: collectorSourceHash, now: start + 800 };
  };
  return { funds, archive, collectorSourceHash, input };
}
type Fixture = ReturnType<typeof fixture>;
const verifies = (f: Fixture) => verifyOkxCapacityEvidence(f.input());

describe('private OKX capacity evidence boundary', () => {
  it('accepts the old signed binding and distinct exact-three-request collector offline', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network-forbidden'));
    try {
      const f = fixture(), input = f.input(), result = verifyOkxCapacityEvidence(input);
      expect(result).toMatchObject({ schema: 1, kind: 'verified-private-okx-capacity-evidence', pinHash: f.archive.pinHash,
        sourceHash: f.funds.pin.sourceHash, collectorSourceHash: f.collectorSourceHash, bundleVersion: f.funds.pin.bundleVersion,
        capacityProvenanceVerified: true, credentialCheck: 'capture-time-only', executable: false });
      expect(result.snapshot.requestCount).toBe(3);
      expect([result.snapshot.before.identity.source, result.snapshot.capacity.source, result.snapshot.after.identity.source]).toEqual([
        '/api/v5/account/config', '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cash&tradeQuoteCcy=USDT', '/api/v5/account/config',
      ]);
      expect(result.identity.uid).toBe(f.funds.pin.identities.okx.uid);
      expect(result.snapshot.before.identity.uid).toBe(result.snapshot.after.identity.uid);
      expect(result.snapshot.capacity).toMatchObject({ buyQuoteAvailable: '100.123456789012345678901234567890',
        sellBaseAvailable: '0.000000000000000000000000000001', buyUnit: 'USDT', sellUnit: 'BTC', sourceUpdatedAt: null });
      expect(result.snapshot.blockers).toEqual(BASE_BLOCKERS);
      expect(result.snapshot.executable).toBe(false);
      expect(result).not.toHaveProperty('admissionAllowed');
      expect(result).not.toHaveProperty('fundsVerified');
      expect(isVerifiedOkxCapacityEvidence(result)).toBe(true);
      expect(input.bindingKey).toEqual(Buffer.alloc(32, 7));
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('freezes every nested output and does not retain mutable input aliases', () => {
    const f = fixture(), input = f.input(), result = verifyOkxCapacityEvidence(input);
    const checkFrozen = (value: unknown) => {
      if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(checkFrozen); }
    };
    checkFrozen(result);
    input.receipt.archiveHash = 'd'.repeat(64); input.archiveBytes.fill(0); input.pinBytes.fill(0); input.bindingKey.fill(0);
    f.archive.okx.capacity.buyQuoteAvailable = '0';
    expect(result.receipt.archiveHash).not.toBe(input.receipt.archiveHash);
    expect(result.snapshot.capacity.buyQuoteAvailable).toBe('100.123456789012345678901234567890');
    expect(() => { result.snapshot.capacity.buyQuoteAvailable = '0'; }).toThrow(TypeError);
    expect(isVerifiedOkxCapacityEvidence(result)).toBe(true);
  });

  it('does not recognize copied, serialized, inherited or forged verification brands', () => {
    const result = verifies(fixture());
    for (const value of [null, undefined, true, 1, 'verified', {}, { ...result }, copy(result), Object.create(result),
      new Proxy(result, {}), Object.freeze({ capacityProvenanceVerified: true, executable: false })]) {
      expect(isVerifiedOkxCapacityEvidence(value)).toBe(false);
    }
  });

  it.each([
    ['bundle version', (f: Fixture) => { f.archive.bundleVersion = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }],
    ['pin digest', (f: Fixture) => { f.archive.pinHash = 'a'.repeat(64); }],
    ['old binding source', (f: Fixture) => { f.archive.bindingSourceHash = 'e'.repeat(64); }],
    ['new collector source', (f: Fixture) => { f.archive.collectorSourceHash = 'e'.repeat(64); }],
    ['selection archive', (f: Fixture) => { f.archive.selectionReceipt.archiveId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }],
    ['selection digest', (f: Fixture) => { f.archive.selectionReceipt.archiveHash = 'e'.repeat(64); }],
    ['both observed accounts', (f: Fixture) => { for (const c of [f.archive.okx.before, f.archive.okx.after]) c.identity.uid = c.identity.mainUid = '999'; }],
  ] as const)('rejects mismatched %s even under a recomputed archive receipt', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(() => verifies(f)).toThrow(failure);
  });

  it.each(['before', 'after'] as const)('checks %s identity and configuration independently', stage => {
    const f = fixture(); f.archive.okx[stage].identity.uid = f.archive.okx[stage].identity.mainUid = '999';
    expect(() => verifies(f)).toThrow(failure);
    const g = fixture(); g.archive.okx[stage].configuration.feeType = '1';
    expect(() => verifies(g)).toThrow(failure);
  });

  it('requires a separate collector even if the caller also selects the old hash', () => {
    const f = fixture(); f.archive.collectorSourceHash = f.archive.bindingSourceHash;
    expect(() => verifyOkxCapacityEvidence({ ...f.input(), expectedCollectorSourceHash: f.archive.bindingSourceHash })).toThrow(failure);
  });

  it('rejects the wrong expected collector and malformed collector hashes', () => {
    for (const expectedCollectorSourceHash of ['e'.repeat(64), '', 'C'.repeat(64), 'x'.repeat(64), 'c'.repeat(63)]) {
      expect(() => verifyOkxCapacityEvidence({ ...fixture().input(), expectedCollectorSourceHash })).toThrow(failure);
    }
  });

  it('checks archive bytes against the accepted receipt, including exact decimal lexemes', () => {
    const input = fixture().input();
    input.archiveBytes = Buffer.from(input.archiveBytes.toString().replace('100.123456789012345678901234567890', '100.12345678901234567890123456789'));
    expect(() => verifyOkxCapacityEvidence(input)).toThrow(failure);
  });

  it.each(['archiveId', 'archiveHash'] as const)('rejects receipt %s mismatch', field => {
    const input = fixture().input(); input.receipt[field] = field === 'archiveId' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'f'.repeat(64);
    expect(() => verifyOkxCapacityEvidence(input)).toThrow(failure);
  });

  it('checks pin HMAC even when the changed pin digest and archive receipt both match', () => {
    const f = fixture(), pin = copy(f.funds.pin); pin.credentialFingerprint = 'd'.repeat(64);
    const pinBytes = encode(pin); f.archive.pinHash = hash(pinBytes);
    expect(() => verifyOkxCapacityEvidence({ ...f.input(), pinBytes })).toThrow(failure);
  });

  it('uses the pin HMAC domain, not another otherwise valid keyed digest', () => {
    const f = fixture(), pin = copy(f.funds.pin), { pinIntegrity: _ignored, ...body } = pin;
    pin.pinIntegrity = createHmac('sha256', f.funds.bindingKey).update('crypto-account-binding/credential/v1\0').update(JSON.stringify(body)).digest('hex');
    const pinBytes = encode(pin); f.archive.pinHash = hash(pinBytes);
    expect(() => verifyOkxCapacityEvidence({ ...f.input(), pinBytes })).toThrow(failure);
  });

  it.each([-1, 0, 1])('requires signed selection no later than capture start (offset %i)', offset => {
    const f = fixture(), pin = copy(f.funds.pin); pin.selection.selectedAt = f.archive.startedAt + offset;
    const { pinIntegrity: _ignored, ...body } = pin;
    pin.pinIntegrity = createHmac('sha256', f.funds.bindingKey).update('crypto-account-binding/pin/v1\0').update(JSON.stringify(body)).digest('hex');
    const pinBytes = encode(pin); f.archive.pinHash = hash(pinBytes);
    const call = () => verifyOkxCapacityEvidence({ ...f.input(), pinBytes });
    if (offset <= 0) expect(isVerifiedOkxCapacityEvidence(call())).toBe(true); else expect(call).toThrow(failure);
  });

  it('sanitizes invalid private binding keys and preserves the caller key on failure', () => {
    const input = fixture().input(); input.bindingKey.fill(3);
    expect(() => verifyOkxCapacityEvidence(input)).toThrow(failure);
    expect(input.bindingKey).toEqual(Buffer.alloc(32, 3));
  });
});

describe('OKX capacity freshness, semantics and admission', () => {
  it.each([59_999, 60_000, 60_001])('measures freshness from capture start at age %i', age => {
    const f = fixture(), input = { ...f.input(), now: f.archive.startedAt + age };
    if (age <= 60_000) expect(isVerifiedOkxCapacityEvidence(verifyOkxCapacityEvidence(input))).toBe(true);
    else expect(() => verifyOkxCapacityEvidence(input)).toThrow(failure);
  });

  it.each([29_999, 30_000, 30_001])('requires total capture duration strictly below 30 seconds (%i)', duration => {
    const f = fixture(); f.archive.endedAt = f.archive.startedAt + duration;
    const call = () => verifyOkxCapacityEvidence({ ...f.input(), now: f.archive.endedAt });
    if (duration < 30_000) expect(isVerifiedOkxCapacityEvidence(call())).toBe(true); else expect(call).toThrow(failure);
  });

  it('cannot freshen an old capture by moving only its end to the maximum allowed time', () => {
    const f = fixture(); f.archive.endedAt = f.archive.startedAt + 29_999;
    expect(() => verifyOkxCapacityEvidence({ ...f.input(), now: f.archive.startedAt + 60_001 })).toThrow(failure);
  });

  it.each([
    (f: Fixture) => { f.archive.startedAt = f.archive.okx.before.identity.requestedAt + 1; },
    (f: Fixture) => { f.archive.okx.before.identity.receivedAt = f.archive.okx.before.identity.requestedAt - 1; },
    (f: Fixture) => { f.archive.okx.capacity.requestedAt = f.archive.okx.before.identity.receivedAt - 1; },
    (f: Fixture) => { f.archive.okx.capacity.receivedAt = f.archive.okx.capacity.requestedAt - 1; },
    (f: Fixture) => { f.archive.okx.after.identity.requestedAt = f.archive.okx.capacity.receivedAt - 1; },
    (f: Fixture) => { f.archive.okx.after.identity.receivedAt = f.archive.okx.after.identity.requestedAt - 1; },
    (f: Fixture) => { f.archive.endedAt = f.archive.okx.after.identity.receivedAt - 1; },
  ])('rejects each reordered or overlapping request boundary', mutate => {
    const f = fixture(); mutate(f); expect(() => verifies(f)).toThrow(failure);
  });

  it('allows equal sequential boundaries and a repeated check at the same time', () => {
    const f = fixture();
    for (const config of [f.archive.okx.before, f.archive.okx.after]) config.identity.requestedAt = config.identity.receivedAt = f.archive.startedAt;
    f.archive.okx.capacity.requestedAt = f.archive.okx.capacity.receivedAt = f.archive.startedAt;
    f.archive.endedAt = f.archive.startedAt;
    const input = { ...f.input(), now: f.archive.startedAt, previousCheckedAt: f.archive.startedAt };
    expect(isVerifiedOkxCapacityEvidence(verifyOkxCapacityEvidence(input))).toBe(true);
  });

  it('rejects clock rollback relative to capture end or the previous check', () => {
    const f = fixture(), input = f.input();
    expect(() => verifyOkxCapacityEvidence({ ...input, now: f.archive.endedAt - 1 })).toThrow(failure);
    expect(() => verifyOkxCapacityEvidence({ ...input, previousCheckedAt: input.now + 1 })).toThrow(failure);
  });

  it.each([0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid check times %s', value => {
    const input = fixture().input();
    expect(() => verifyOkxCapacityEvidence({ ...input, now: value })).toThrow(failure);
    expect(() => verifyOkxCapacityEvidence({ ...input, previousCheckedAt: value })).toThrow(failure);
  });

  it('retains zero amounts without substituting balances or approving a trade', () => {
    const f = fixture(); f.archive.okx.capacity.buyQuoteAvailable = f.archive.okx.capacity.sellBaseAvailable = '0';
    const result = verifies(f);
    expect(result.snapshot.capacity).toMatchObject({ buyQuoteAvailable: '0', sellBaseAvailable: '0', buyUnit: 'USDT', sellUnit: 'BTC' });
    expect(result.snapshot.blockers).toEqual(BASE_BLOCKERS);
    expect(result.executable).toBe(false);
  });

  it.each([123, null, '', '-1', '1e2', '01', '0.0000000000000000000000000000001'])('rejects nonexact/invalid amounts %j', value => {
    for (const field of ['buyQuoteAvailable', 'sellBaseAvailable'] as const) {
      const f = fixture(); Object.assign(f.archive.okx.capacity, { [field]: value });
      expect(() => verifies(f)).toThrow(failure);
    }
  });

  it.each([
    { buyUnit: 'BTC' }, { sellUnit: 'USDT' }, { buyUnit: 'USD' }, { sourceUpdatedAt: '1800000000000' },
    { source: '/api/v5/account/max-size?instId=BTC-USDT&tdMode=cash' },
    { source: '/api/v5/account/max-avail-size?instId=BTC-USDT&tdMode=cross&tradeQuoteCcy=USDT' },
    { source: '/api/v5/account/max-avail-size?instId=ETH-USDT&tdMode=cash&tradeQuoteCcy=USDT' },
    { eq: '1000000' },
  ])('rejects mixed units, different request or invented provenance: %j', patch => {
    const f = fixture(); Object.assign(f.archive.okx.capacity, patch); expect(() => verifies(f)).toThrow(failure);
  });

  it.each([
    ['archive', { requestCount: 2 }], ['archive', { capacityAdmission: true }], ['archive', { executable: true }],
    ['archive', { credentialBundleMatched: false }], ['archive', { capacityBound: false }],
    ['snapshot', { requestCount: 4 }], ['snapshot', { executable: true }], ['snapshot', { identityAccepted: false }],
    ['snapshot', { configurationStable: false }], ['snapshot', { environment: 'demo' }], ['snapshot', { symbol: 'ETH/USDT' }],
    ['snapshot', { origin: 'https://openapi.okx.com' }], ['snapshot', { admissionAllowed: true }],
  ] as const)('rejects claimed %s scope/admission changes: %j', (target, patch) => {
    const f = fixture(); Object.assign(target === 'archive' ? f.archive : f.archive.okx, patch); expect(() => verifies(f)).toThrow(failure);
  });

  it.each([[], [...BASE_BLOCKERS].reverse(), [...BASE_BLOCKERS, BASE_BLOCKERS[0]], [...BASE_BLOCKERS, 'claimed-safe']].map(blockers => ({ blockers })))
  ('rejects missing, reordered, duplicated or invented derived blockers $blockers', ({ blockers }) => {
    const f = fixture(); Object.assign(f.archive.okx, { blockers }); expect(() => verifies(f)).toThrow(failure);
  });

  it('accepts truthful unknown configuration as blocked, then rejects suppressed derived reasons', () => {
    const f = fixture();
    for (const config of [f.archive.okx.before, f.archive.okx.after]) {
      config.configuration.accountMode = null; config.configuration.autoLoan = null; config.configuration.feeType = null;
      config.configuration.unavailableFields = { accountMode: 'missing', autoLoan: 'empty', feeType: 'null' };
    }
    f.archive.okx.blockers.push('account-mode-unconfirmed', 'borrow-settings-unconfirmed', 'fee-currency-unconfirmed');
    const result = verifies(f);
    expect(result.capacityProvenanceVerified).toBe(true);
    expect(result.executable).toBe(false);
    expect(result.snapshot.before.configuration.unavailableFields).toEqual({ accountMode: 'missing', autoLoan: 'empty', feeType: 'null' });
    f.archive.okx.blockers = [...BASE_BLOCKERS]; expect(() => verifies(f)).toThrow(failure);
  });

  it('recomputes non-Spot and borrowing blockers rather than trusting admission-like flags', () => {
    const f = fixture();
    for (const config of [f.archive.okx.before, f.archive.okx.after]) {
      config.configuration.accountMode = '3'; config.configuration.enableSpotBorrow = true;
    }
    expect(() => verifies(f)).toThrow(failure);
    f.archive.okx.blockers.push('account-mode-not-spot', 'borrow-setting-enabled');
    expect(verifies(f).snapshot.blockers).toEqual([...BASE_BLOCKERS, 'account-mode-not-spot', 'borrow-setting-enabled']);
  });

  it.each(['before', 'after'] as const)('rejects %s missing-field provenance that disagrees with its value', stage => {
    const f = fixture(); f.archive.okx[stage].configuration.unavailableFields = { feeType: 'missing' };
    expect(() => verifies(f)).toThrow(failure);
  });
});

describe('OKX capacity protected serialization', () => {
  const shapes = ['duplicate', 'escaped-duplicate', 'pretty', 'missing-newline', 'extra-newline', 'invalid-utf8', 'bom'] as const;
  function malformed(raw: Buffer, shape: typeof shapes[number]) {
    const text = raw.toString();
    if (shape === 'duplicate') return Buffer.from(text.replace('"schema":1,', '"schema":1,"schema":1,'));
    if (shape === 'escaped-duplicate') return Buffer.from(text.replace('"schema":1,', '"schema":1,"sch\\u0065ma":1,'));
    if (shape === 'pretty') return Buffer.from(JSON.stringify(JSON.parse(text), null, 2) + '\n');
    if (shape === 'missing-newline') return Buffer.from(text.trimEnd());
    if (shape === 'extra-newline') return Buffer.from(text + '\n');
    if (shape === 'bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]);
    return Buffer.concat([raw, Buffer.from([0xff])]);
  }

  it.each(shapes)('rejects noncanonical archive %s even with matching receipt hash', shape => {
    const input = fixture().input(); input.archiveBytes = malformed(input.archiveBytes, shape); input.receipt.archiveHash = hash(input.archiveBytes);
    expect(() => verifyOkxCapacityEvidence(input)).toThrow(failure);
  });

  it.each(shapes)('rejects noncanonical pin %s even with matching pin hash and receipt', shape => {
    const f = fixture(), input = f.input(), pinBytes = malformed(input.pinBytes, shape); f.archive.pinHash = hash(pinBytes);
    expect(() => verifyOkxCapacityEvidence({ ...f.input(), pinBytes })).toThrow(failure);
  });

  it.each([
    ['archiveBytes', Buffer.alloc(0)], ['archiveBytes', Buffer.alloc(128 * 1024 + 1)], ['archiveBytes', 'not-bytes'],
    ['pinBytes', Buffer.alloc(0)], ['pinBytes', Buffer.alloc(64 * 1024 + 1)], ['pinBytes', 'not-bytes'],
    ['bindingKey', Buffer.alloc(31)], ['bindingKey', Buffer.alloc(33)], ['bindingKey', 'not-bytes'],
  ])('bounds and types %s', (field, value) => {
    const input = fixture().input(); Object.assign(input, { [field as string]: value });
    expect(() => verifyOkxCapacityEvidence(input)).toThrow(failure);
  });

  it('rejects unknown top-level and receipt properties', () => {
    expect(() => verifyOkxCapacityEvidence({ ...fixture().input(), verified: true } as never)).toThrow(failure);
    const input = fixture().input(); Object.assign(input.receipt, { capacityAdmission: true });
    expect(() => verifyOkxCapacityEvidence(input)).toThrow(failure);
  });
});
