import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyAccountFeeEvidence, isVerifiedAccountFeeEvidence } from '../src/live/account-fee-evidence.js';
import { accountFeesFixture } from './helpers/account-fees-fixture.js';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('private account fee evidence verification', () => {
  it('verifies receipt, original binding and separate collector without any network', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network-forbidden'));
    try {
      const f = accountFeesFixture(), result = verifyAccountFeeEvidence(f.input());
      expect(result).toMatchObject({ kind: 'verified-private-account-fee-evidence', sourceHash: f.funds.pin.sourceHash,
        collectorSourceHash: f.collectorSourceHash, pinHash: f.archive.pinHash, bundleVersion: f.funds.pin.bundleVersion,
        rateProvenanceVerified: true, credentialCheck: 'capture-time-only', executable: false });
      expect(result.snapshots.mexc.fees.takerRateRaw).toBe('0.000500000000000000');
      expect(result.snapshots.okx.fees.takerCostRate).toBe('0.001');
      expect(isVerifiedAccountFeeEvidence(result)).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.snapshots.okx.fees)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(f.bindingKey).toEqual(Buffer.alloc(32, 7));
    } finally { fetch.mockRestore(); }
  });
  it('does not recognize a forged, copied or deserialized brand', () => {
    const result = verifyAccountFeeEvidence(accountFeesFixture().input());
    for (const value of [undefined, null, true, {}, { ...result }, JSON.parse(JSON.stringify(result))]) {
      expect(isVerifiedAccountFeeEvidence(value)).toBe(false);
    }
  });
  it('retains unknown MEXC currency as a blocker while proving observed rates', () => {
    const result = verifyAccountFeeEvidence(accountFeesFixture({ mxEnabled: true }).input());
    expect(result.rateProvenanceVerified).toBe(true);
    expect(result.snapshots.mexc.blockers).toEqual(['fee-currency-unconfirmed', 'mx-fee-conversion-unconfirmed']);
    expect(result.snapshots.mexc.fees.takerCostRate).toBe('0.0005');
  });
  it.each([
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.mexc.identity.uid = 'other-selected-account'; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.okx.identity.uid = f.archive.okx.identity.mainUid = '999999'; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.bundleVersion = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.pinHash = 'a'.repeat(64); },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.bindingSourceHash = 'd'.repeat(64); },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.collectorSourceHash = 'e'.repeat(64); },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.selectionReceipt = { ...f.archive.selectionReceipt, archiveHash: 'e'.repeat(64) }; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.mexc.fees.makerCostRate = '0.1'; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.okx.fees.takerCostRate = '0'; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.mexc.blockers = []; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.okx.configuration.feeCurrencyMode = 'received-asset'; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.okx.fees.source = '/api/v5/account/trade-fee?instType=SPOT&instId=ETH-USDT'; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.mexc.requestCount = 2; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.requestCount = 4; },
  ])('rejects changed protected binding or forged derivation despite matching new receipt hash', mutate => {
    const f = accountFeesFixture(); mutate(f);
    expect(() => verifyAccountFeeEvidence(f.input())).toThrow(/^fees-evidence-invalid$/);
  });
  it('does not treat the old funds collector as the new fee collector', () => {
    const f = accountFeesFixture(); f.archive.collectorSourceHash = f.archive.bindingSourceHash;
    expect(() => verifyAccountFeeEvidence({ ...f.input(), expectedCollectorSourceHash: f.archive.bindingSourceHash })).toThrow(/^fees-evidence-invalid$/);
  });
  it('rejects a wrong expected collector even if archive and receipt are internally consistent', () => {
    expect(() => verifyAccountFeeEvidence({ ...accountFeesFixture().input(), expectedCollectorSourceHash: 'e'.repeat(64) })).toThrow(/^fees-evidence-invalid$/);
  });
  it('rejects modified archive bytes under the original receipt', () => {
    const input = accountFeesFixture().input();
    input.archiveBytes = Buffer.from(input.archiveBytes.toString().replace('0.000500000000000000', '0.000400000000000000'));
    expect(() => verifyAccountFeeEvidence(input)).toThrow(/^fees-evidence-invalid$/);
  });
  it('rejects a receipt for a different archive id', () => {
    const input = accountFeesFixture().input(); input.receipt.archiveId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(() => verifyAccountFeeEvidence(input)).toThrow(/^fees-evidence-invalid$/);
  });
  it('verifies pin HMAC rather than relying on the pin hash alone', () => {
    const f = accountFeesFixture(), pin = JSON.parse(f.pinBytes.toString());
    pin.credentialFingerprint = 'a'.repeat(64);
    const pinBytes = Buffer.from(JSON.stringify(pin) + '\n'); f.archive.pinHash = hash(pinBytes);
    expect(() => verifyAccountFeeEvidence({ ...f.input(), pinBytes })).toThrow(/^fees-evidence-invalid$/);
  });
  it('rejects the wrong private binding key without disclosing protected contents', () => {
    const f = accountFeesFixture();
    try { verifyAccountFeeEvidence({ ...f.input(), bindingKey: Buffer.alloc(32, 3) }); throw new Error('unexpected-pass'); }
    catch (error) {
      expect((error as Error).message).toBe('fees-evidence-invalid');
      expect(String(error)).not.toContain(f.archive.mexc.identity.uid);
    }
  });
  it.each([60_000, 60_001])('uses start-of-capture age boundary %sms', age => {
    const f = accountFeesFixture(), input = { ...f.input(), now: f.archive.startedAt + age };
    if (age === 60_000) expect(isVerifiedAccountFeeEvidence(verifyAccountFeeEvidence(input))).toBe(true);
    else expect(() => verifyAccountFeeEvidence(input)).toThrow(/^fees-evidence-invalid$/);
  });
  it('cannot refresh old evidence by moving only endedAt or verifier time', () => {
    const f = accountFeesFixture(); f.archive.endedAt += 30_000;
    expect(() => verifyAccountFeeEvidence({ ...f.input(), now: f.archive.endedAt })).toThrow(/^fees-evidence-invalid$/);
  });
  it.each([
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.okx.identity.requestedAt = f.archive.mexc.configuration.receivedAt - 1; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.mexc.fees.receivedAt = f.archive.mexc.fees.requestedAt - 1; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.startedAt = f.archive.mexc.identity.requestedAt + 1; },
    (f: ReturnType<typeof accountFeesFixture>) => { f.archive.endedAt = f.archive.okx.fees.receivedAt - 1; },
  ])('rejects reordered/overlapping capture intervals', mutate => {
    const f = accountFeesFixture(); mutate(f);
    expect(() => verifyAccountFeeEvidence(f.input())).toThrow(/^fees-evidence-invalid$/);
  });
  it('rejects check time before capture ends or previous check', () => {
    const f = accountFeesFixture();
    expect(() => verifyAccountFeeEvidence({ ...f.input(), now: f.archive.endedAt - 1 })).toThrow(/^fees-evidence-invalid$/);
    expect(() => verifyAccountFeeEvidence({ ...f.input(), previousCheckedAt: f.now + 1 })).toThrow(/^fees-evidence-invalid$/);
  });
  it.each([0, -1, NaN, Infinity, 0.5])('rejects invalid check time %s', now => {
    expect(() => verifyAccountFeeEvidence({ ...accountFeesFixture().input(), now })).toThrow(/^fees-evidence-invalid$/);
  });
  it('accepts source-time-stale as a truthful blocking observation, not as usable budget evidence', () => {
    const f = accountFeesFixture(); f.archive.okx.fees.sourceUpdatedAt = String(f.archive.okx.fees.requestedAt - 60_001);
    f.archive.okx.blockers = ['source-time-stale'];
    const result = verifyAccountFeeEvidence(f.input());
    expect(result.snapshots.okx.blockers).toContain('source-time-stale');
  });
  it.each(['duplicate', 'pretty', 'missing-newline', 'extra-newline', 'invalid-utf8'])('rejects noncanonical protected archive %s', shape => {
    const f = accountFeesFixture(), input = f.input();
    const text = input.archiveBytes.toString();
    input.archiveBytes = shape === 'duplicate' ? Buffer.from(text.replace('"schema":1,', '"schema":1,"schema":1,')) :
      shape === 'pretty' ? Buffer.from(JSON.stringify(f.archive, null, 2) + '\n') :
      shape === 'missing-newline' ? Buffer.from(text.trimEnd()) :
      shape === 'extra-newline' ? Buffer.from(text + '\n') : Buffer.concat([input.archiveBytes, Buffer.from([0xff])]);
    input.receipt.archiveHash = hash(input.archiveBytes);
    expect(() => verifyAccountFeeEvidence(input)).toThrow(/^fees-evidence-invalid$/);
  });
  it.each([Buffer.alloc(0), Buffer.alloc(128 * 1024 + 1), 'not-bytes'])('bounds archive input bytes', archiveBytes => {
    expect(() => verifyAccountFeeEvidence({ ...accountFeesFixture().input(), archiveBytes: archiveBytes as never })).toThrow(/^fees-evidence-invalid$/);
  });
});
