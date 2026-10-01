import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fundsEvidenceFixture as fixture, FUNDS_EVIDENCE_TEST_TIME as now } from './helpers/funds-evidence-fixture.js';
import { verifyFundsEvidence, isVerifiedFundsEvidence } from '../src/live/funds-evidence.js';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');

function rejects(input: Parameters<typeof verifyFundsEvidence>[0]) {
  expect(() => verifyFundsEvidence(input)).toThrowError(/^funds-evidence-invalid$/);
}
describe('private verified account funds evidence', () => {
  it('verifies a cryptographic pin/receipt fixture, preserves exact amounts, stays advisory and brands frozen independent projections', () => {
    const f = fixture(), data = f.input(), result = verifyFundsEvidence(data);
    expect(isVerifiedFundsEvidence(result)).toBe(true);
    expect(result).toMatchObject({ kind: 'verified-private-funds-evidence', fundsAdmission: false, executable: false, credentialCheck: 'capture-time-only',
      sourceHash: f.pin.sourceHash, bundleVersion: f.pin.bundleVersion, pinHash: f.archive.pinHash, startedAt: now, endedAt: now + 800, checkedAt: now + 900 });
    expect(result.venues.mexc.assets.BTC.candidateAmount).toBe('0.100000000000000001');
    expect(result.venues.okx.assets.USDT.candidateAmount).toBe('99.999999999999999999');
    expect(result.venues.mexc.blockers).toEqual(['mexc-available-semantics-unconfirmed', 'mexc-main-account-unconfirmed']);
    expect(result.venues.okx.blockers).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.identities.mexc)).toBe(true);
    expect(Object.isFrozen(result.venues.okx.assets.BTC)).toBe(true); expect(Object.isFrozen(result.receipt)).toBe(true);
    data.archiveBytes.fill(0); data.pinBytes.fill(0); f.archive.mexc.identity.uid = 'LATER_MUTATION';
    expect(result.identities.mexc.uid).toBe('PRIVATE_MEXC_UID_ABC');
    expect(f.bindingKey).toEqual(Buffer.alloc(32, 7));
  });
  it('rejects forged, copied or serialized verification brands and arbitrary values', () => {
    const result = verifyFundsEvidence(fixture().input());
    for (const value of [null, true, 1, 'verified', {}, { ...result }, JSON.parse(JSON.stringify(result)), Object.freeze({ verified: true })]) expect(isVerifiedFundsEvidence(value)).toBe(false);
  });
  it('retains required unknown vs zero distinction without making missing MX a global condition', () => {
    const result = verifyFundsEvidence(fixture().input());
    expect(result.venues.mexc.assets.MX).toEqual({ reported: true, candidateAmount: '0', ownedAmount: '0', blockers: [] });
    expect(result.venues.okx.assets.MX).toEqual({ reported: false, candidateAmount: null, ownedAmount: null, blockers: ['asset-not-reported'] });
    expect(result.venues.okx.blockers).not.toContain('asset-not-reported');
  });
  it('bounds candidates by both distinct funds values without subtracting locked/frozen funds twice', () => {
    const f = fixture(); f.archive.mexc.funds.balances[1].available = '1'; f.archive.mexc.funds.balances[1].locked = '9';
    f.archive.okx.funds.balances[1].availBal = '20'; f.archive.okx.funds.balances[1].frozenBal = '79';
    const result = verifyFundsEvidence(f.input());
    expect(result.venues.mexc.assets.USDT.candidateAmount).toBe('1'); expect(result.venues.okx.assets.USDT.candidateAmount).toBe('20');
    expect(result.venues.mexc.blockers).toContain('mexc-available-semantics-unconfirmed');
    f.archive.mexc.funds.balances[1].available = '100'; f.archive.okx.funds.balances[1].availBal = '200';
    const bounded = verifyFundsEvidence(f.input());
    expect(bounded.venues.mexc.assets.USDT.candidateAmount).toBe('10'); expect(bounded.venues.okx.assets.USDT.candidateAmount).toBe('99.999999999999999999');
  });
  it('reports held BTC as ownership even when nothing is spendable on either venue', () => {
    const f = fixture(), mexc = f.archive.mexc.funds.balances[0], okx = f.archive.okx.funds.balances[0];
    mexc.free = '0'; mexc.available = '0'; mexc.locked = '1';
    okx.cashBal = '1'; okx.availBal = '0'; okx.frozenBal = '1';
    const result = verifyFundsEvidence(f.input());
    expect(result.venues.mexc.assets.BTC).toMatchObject({ candidateAmount: '0', ownedAmount: '1' });
    expect(result.venues.okx.assets.BTC).toMatchObject({ candidateAmount: '0', ownedAmount: '1' });
    expect(result.venues.mexc.blockers).toContain('mexc-available-semantics-unconfirmed');
    expect(result).toMatchObject({ fundsAdmission: false, executable: false });
  });
  it('adds MEXC free and locked exactly without treating OKX frozen as additional ownership', () => {
    const f = fixture(), mexc = f.archive.mexc.funds.balances[0], okx = f.archive.okx.funds.balances[0];
    mexc.free = '0.999999999999999999'; mexc.locked = '0.000000000000000001'; mexc.available = '0';
    okx.cashBal = '1.000000000000000001'; okx.availBal = '0'; okx.frozenBal = '1.000000000000000001';
    const result = verifyFundsEvidence(f.input());
    expect(result.venues.mexc.assets.BTC.ownedAmount).toBe('1');
    expect(result.venues.okx.assets.BTC.ownedAmount).toBe('1.000000000000000001');
  });
  it.each(['mexc', 'okx'] as const)('does not manufacture zero owned BTC when the %s asset row is absent', venue => {
    const f = fixture(); f.archive[venue].funds.balances.splice(0, 1);
    expect(verifyFundsEvidence(f.input()).venues[venue].assets.BTC).toEqual({ reported: false, candidateAmount: null, ownedAmount: null, blockers: ['asset-not-reported'] });
  });
  it.each(['free', 'locked'])('keeps MEXC owned amount unknown for invalid owned %s precision or negative', field => {
    for (const value of ['-0', '-1', '1.0000000000000000001']) {
      const f = fixture(); (f.archive.mexc.funds.balances[0] as any)[field] = value;
      expect(verifyFundsEvidence(f.input()).venues.mexc.assets.BTC.ownedAmount).toBeNull();
    }
  });
  it.each(['-0', '-1', '1.0000000000000000001', null])('keeps OKX owned amount unknown for cashBal %s', value => {
    const f = fixture(), row = f.archive.okx.funds.balances[0] as any;
    row.cashBal = value; if (value === null) row.unavailableFields = { cashBal: 'empty' };
    expect(verifyFundsEvidence(f.input()).venues.okx.assets.BTC.ownedAmount).toBeNull();
  });
  it('preserves owned amounts when only available fields are absent', () => {
    const f = fixture(), mexc = f.archive.mexc.funds.balances[0] as any, okx = f.archive.okx.funds.balances[0] as any;
    mexc.available = null; mexc.unavailableFields = { available: 'missing' };
    okx.availBal = null; okx.unavailableFields = { availBal: 'empty' };
    const result = verifyFundsEvidence(f.input());
    expect(result.venues.mexc.assets.BTC).toMatchObject({ candidateAmount: null, ownedAmount: '0.100000000000000001' });
    expect(result.venues.okx.assets.BTC).toMatchObject({ candidateAmount: null, ownedAmount: '1.000000000000000001' });
    expect(result.venues.okx.assets.MX.ownedAmount).toBeNull();
  });
  it.each(['mexc', 'okx'] as const)('rejects exact %s account change despite a rebuilt archive checksum', venue => {
    const f = fixture(); f.archive[venue].identity.uid = venue === 'mexc' ? 'DIFFERENT_PRIVATE' : '123456789'; rejects(f.input());
  });
  it.each(['mainUid', 'accountType', 'mainAccountConfirmed', 'source', 'unapproved'] as const)('rejects altered or extra identity field %s', field => {
    const f = fixture(); const id = f.archive.okx.identity as any; id[field] = field === 'mainAccountConfirmed' ? false : '1'; rejects(f.input());
  });
  it.each(['archive', 'receipt', 'key', 'pin-mac', 'pin-hash', 'selection', 'bundle', 'source-hash'])('rejects tampering with %s', field => {
    const f = fixture(), input = f.input();
    if (field === 'archive') input.archiveBytes[input.archiveBytes.length - 2] ^= 1;
    if (field === 'receipt') input.receipt.archiveHash = '0'.repeat(64);
    if (field === 'key') input.bindingKey = Buffer.alloc(32, 8);
    if (field === 'pin-mac') input.pinBytes = encode({ ...f.pin, pinIntegrity: '0'.repeat(64) });
    if (field === 'pin-hash') { f.archive.pinHash = '0'.repeat(64); return rejects(f.input()); }
    if (field === 'selection') { f.archive.selectionReceipt = { ...f.archive.selectionReceipt, archiveHash: '0'.repeat(64) }; return rejects(f.input()); }
    if (field === 'bundle') { f.archive.bundleVersion = '00000000-0000-4000-8000-000000000000'; return rejects(f.input()); }
    if (field === 'source-hash') input.pinBytes = encode({ ...f.pin, sourceHash: '0'.repeat(64) });
    rejects(input);
  });
  it.each(['receipt-extra', 'archive-extra', 'snapshot-extra', 'funds-extra', 'config-extra', 'row-extra', 'assessment-extra', 'unknown-reason', 'future-selection', 'wrong-origin', 'wrong-environment', 'wrong-source', 'wrong-count', 'true-admission'])('rejects strict contract violation %s', field => {
    const f = fixture(), archive = f.archive as any;
    if (field === 'receipt-extra') return rejects({ ...f.input(), receipt: { ...f.input().receipt, verified: true } });
    if (field === 'archive-extra') archive.verified = true;
    if (field === 'snapshot-extra') archive.mexc.canTrade = true;
    if (field === 'funds-extra') archive.okx.funds.available = '1000';
    if (field === 'config-extra') archive.okx.configuration.borrowDisabled = true;
    if (field === 'row-extra') archive.mexc.funds.balances[0].admitted = true;
    if (field === 'assessment-extra') archive.okx.assessment.ready = true;
    if (field === 'unknown-reason') archive.okx.assessment.reasons = ['PRIVATE_SERVER_REASON'];
    if (field === 'future-selection') archive.startedAt = now - 999_000;
    if (field === 'wrong-origin') archive.mexc.origin = 'https://www.okx.com';
    if (field === 'wrong-environment') archive.environment = 'demo';
    if (field === 'wrong-source') archive.okx.funds.source = '/api/v5/asset/balances';
    if (field === 'wrong-count') archive.requestCount = 3;
    if (field === 'true-admission') archive.fundsAdmission = true;
    rejects(f.input());
  });
  it.each(['duplicate', 'escape', 'whitespace', 'newline', 'number', 'invalid-utf8'])('rejects noncanonical %s bytes even with a rebuilt checksum', kind => {
    const f = fixture(), input = f.input(); let text = input.archiveBytes.toString();
    if (kind === 'duplicate') text = text.replace('"schema":1', '"schema":1,"schema":1');
    if (kind === 'escape') text = text.replace('"schema"', '"\\u0073chema"');
    if (kind === 'whitespace') text = ' ' + text;
    if (kind === 'newline') text = text.trimEnd();
    if (kind === 'number') text = text.replace('"schema":1', '"schema":1.0');
    input.archiveBytes = kind === 'invalid-utf8' ? Buffer.concat([Buffer.from([255]), Buffer.from(text)]) : Buffer.from(text);
    input.receipt.archiveHash = digest(input.archiveBytes); rejects(input);
  });
  it.each([0, -1, NaN, Infinity, now + 60_001, now + 799, 8_640_000_000_000_001])('rejects invalid, early or expired consumer time %s', value => {
    rejects({ ...fixture().input(), now: value });
  });
  it('accepts exactly sixty seconds from start, checks previous time and ordered interval independently', () => {
    expect(verifyFundsEvidence({ ...fixture().input(), now: now + 60_000 }).checkedAt).toBe(now + 60_000);
    rejects({ ...fixture().input(), previousCheckedAt: now + 901 });
    expect(verifyFundsEvidence({ ...fixture().input(), previousCheckedAt: now + 900 }).checkedAt).toBe(now + 900);
    rejects({ ...fixture().input(), previousCheckedAt: NaN });
  });
  it.each(['reordered', 'negative-duration', 'over-window', 'future-end', 'invalid-timestamp'])('rejects capture sequence %s', field => {
    const f = fixture();
    if (field === 'reordered') f.archive.okx.identity.requestedAt = now + 399;
    if (field === 'negative-duration') f.archive.mexc.funds.receivedAt = now + 299;
    if (field === 'over-window') f.archive.endedAt = now + 30_001;
    if (field === 'future-end') f.archive.endedAt = now + 901;
    if (field === 'invalid-timestamp') f.archive.mexc.identity.requestedAt = 1.5;
    rejects(f.input());
  });
  it.each(['mexc', 'okx'] as const)('rejects duplicate %s assets', venue => {
    const f = fixture(); f.archive[venue].funds.balances[1].currency = 'BTC'; rejects(f.input());
  });
  it.each(['-0', '-0.000000000000000001', '0.0000000000000000001', '1.0000000000000000000'])('does not silently make %s spendable', value => {
    const f = fixture(); f.archive.mexc.funds.balances[1].free = value; f.archive.okx.funds.balances[1].availBal = value;
    const result = verifyFundsEvidence(f.input());
    expect(result.venues.mexc.assets.USDT.candidateAmount).toBeNull(); expect(result.venues.okx.assets.USDT.candidateAmount).toBeNull();
    expect(result.venues.mexc.blockers).toContain(value.startsWith('-') ? 'negative-amount-reported' : 'precision-over-18');
  });
  it.each(['1e3', '01', '+1', 'NaN', 'Infinity', '', ' 1', '1.', '9'.repeat(31), 1])('rejects malformed money %s', value => {
    const f = fixture(); (f.archive.okx.funds.balances[0] as any).cashBal = value; rejects(f.input());
  });
  it.each(['missing', 'null', 'empty'])('preserves unavailable MEXC available field from %s and never substitutes free', reason => {
    const f = fixture(); const row = f.archive.mexc.funds.balances[1] as any; row.available = null; row.unavailableFields = { available: reason };
    expect(verifyFundsEvidence(f.input()).venues.mexc.assets.USDT).toEqual({ reported: true, candidateAmount: null, ownedAmount: '10', blockers: ['amount-unavailable'] });
  });
  it('rejects special unknown metadata keys before object normalization can discard them', () => {
    const f = fixture(), input = f.input();
    input.archiveBytes = Buffer.from(input.archiveBytes.toString().replace('\"unavailableFields\":{}', '\"unavailableFields\":{\"__proto__\":\"missing\"}'));
    input.receipt.archiveHash = digest(input.archiveBytes); rejects(input);
  });
  it.each(['missing-record', 'extra-record', 'present-marked-unavailable', 'unknown-kind'])('rejects inconsistent unavailable metadata %s', kind => {
    const f = fixture(), row = f.archive.okx.funds.balances[1] as any;
    if (kind === 'missing-record') row.cashBal = null;
    if (kind === 'extra-record') row.unavailableFields = { arbitrary: 'missing' };
    if (kind === 'present-marked-unavailable') row.unavailableFields = { cashBal: 'empty' };
    if (kind === 'unknown-kind') { row.cashBal = null; row.unavailableFields = { cashBal: 'SECRET' }; }
    rejects(f.input());
  });
  it.each(['cashBal', 'availBal', 'frozenBal', 'liab', 'crossLiab', 'isoLiab', 'interest', 'borrowFroz'])('does not make nullable OKX %s zero', field => {
    const f = fixture(), row = f.archive.okx.funds.balances[1] as any; row[field] = null; row.unavailableFields = { [field]: field === 'isoLiab' ? 'null' : 'empty' };
    const result = verifyFundsEvidence(f.input()); expect(result.venues.okx.assets.USDT.candidateAmount).toBeNull();
    expect(result.venues.okx.assets.USDT.blockers).toContain('amount-unavailable');
    if (['liab','crossLiab','isoLiab','interest','borrowFroz'].includes(field)) expect(result.venues.okx.blockers).toContain('liability-unavailable');
  });
  it.each(['liab', 'crossLiab', 'isoLiab', 'interest', 'borrowFroz'])('blocks debt %s in another currency across the venue', field => {
    const f = fixture(), row = { ...f.archive.okx.funds.balances[0], currency: 'ETH', [field]: '0.000000000000000001' };
    f.archive.okx.funds.balances.push(row);
    const result = verifyFundsEvidence(f.input()); expect(result.venues.okx.blockers).toContain('liability-reported');
    expect(Object.keys(result.venues.okx.assets)).toEqual(['BTC', 'USDT', 'MX']);
  });
  it.each(['2','3','4','UNKNOWN',null])('blocks unsupported OKX mode %s', value => {
    const f = fixture(), config = f.archive.okx.configuration as any; config.accountMode = value;
    if (value === null) config.unavailableFields = { acctLv: 'empty' };
    expect(verifyFundsEvidence(f.input()).venues.okx.blockers).toContain('okx-mode-not-supported');
  });
  it.each(['autoLoan','enableSpotBorrow','spotBorrowAutoRepay'])('blocks enabled or unknown %s', field => {
    for (const value of [true, null]) {
      const f = fixture(), config = f.archive.okx.configuration as any; config[field] = value;
      if (value === null) config.unavailableFields = { [field]: 'missing' };
      expect(verifyFundsEvidence(f.input()).venues.okx.blockers).toContain('okx-borrow-enabled-or-unknown');
    }
  });
  it('recomputes reasons instead of trusting capture assessments', () => {
    const f = fixture(); (f.archive.mexc.assessment as any) = { requiredAssets: { BTC: true, USDT: true, MX: true }, reasons: [] };
    (f.archive.okx.assessment as any) = { requiredAssets: { BTC: false, USDT: false, MX: false }, reasons: ['liability-reported'] };
    const result = verifyFundsEvidence(f.input()); expect(result.venues.mexc.blockers).toContain('mexc-available-semantics-unconfirmed');
    expect(result.venues.okx.blockers).toEqual([]); expect(result.venues.okx.assets.MX.reported).toBe(false);
  });
  it('preserves absent source time and rejects future source time as a semantic blocker', () => {
    const f = fixture(), funds = f.archive.mexc.funds as any; funds.sourceUpdatedAt = null; funds.unavailableFields = { updateTime: 'null' };
    f.archive.okx.funds.sourceUpdatedAt = String(now + 801);
    const result = verifyFundsEvidence(f.input()); expect(result.venues.mexc.blockers).toContain('source-time-unavailable'); expect(result.venues.okx.blockers).toContain('source-time-in-future');
  });
  it.each(['archive-empty', 'archive-large', 'pin-large', 'key-short', 'extra-option', 'wrong-bytes', 'bad-receipt'])('bounds invalid input %s with fixed nonprivate failure', field => {
    const input: any = fixture().input();
    if (field === 'archive-empty') input.archiveBytes = Buffer.alloc(0);
    if (field === 'archive-large') input.archiveBytes = Buffer.alloc(1024 * 1024 + 1);
    if (field === 'pin-large') input.pinBytes = Buffer.alloc(64 * 1024 + 1);
    if (field === 'key-short') input.bindingKey = Buffer.alloc(31);
    if (field === 'extra-option') input.verified = true;
    if (field === 'wrong-bytes') input.archiveBytes = 'SECRET_FROM_CALLER';
    if (field === 'bad-receipt') input.receipt = { ...input.receipt, archiveId: 'PRIVATE_UID_SECRET' };
    rejects(input);
  });
});
