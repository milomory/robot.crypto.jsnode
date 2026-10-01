import { createHash } from 'node:crypto';
import { createAccountBindingPin, ACCOUNT_BINDING_CONTEXT, ACCOUNT_BINDING_REFERENCES, ACCOUNT_BINDING_POLICY_HASH } from '../../src/accounts/account-binding.js';
export const FUNDS_EVIDENCE_TEST_TIME = Date.UTC(2026, 8, 30, 12);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
/** Synthetic only. No filesystem, credentials delivery or exchange API calls. */
export function fundsEvidenceFixture(options: { now?: number; mexcUid?: string; okxUid?: string; mexcUSDT?: string; okxUSDT?: string; okxAccountMode?: string; checkedAt?: number } = {}) {
  const now = options.now ?? FUNDS_EVIDENCE_TEST_TIME;
  const bindingKey = Buffer.alloc(32, 7);
  const identities = {
    mexc: { venue: 'mexc', uid: options.mexcUid ?? 'PRIVATE_MEXC_UID_ABC', mainUid: null, accountType: null, mainAccountConfirmed: false,
      mainAccountEvidence: 'not-reported', source: '/api/v3/uid', requestedAt: now - 100_000, receivedAt: now - 99_900 },
    okx: { venue: 'okx', uid: options.okxUid ?? '9876543212345678901', mainUid: options.okxUid ?? '9876543212345678901', accountType: '0', mainAccountConfirmed: true,
      mainAccountEvidence: 'uid-mainUid-and-account-type', source: '/api/v5/account/config', requestedAt: now - 99_800, receivedAt: now - 99_700 },
  };
  const pin = createAccountBindingPin({ selection: { kind: 'explicit-accepted-observation', selectedAt: now - 99_000,
    receipt: { schema: 1, kind: 'account-identity-observation-receipt', archiveId: 'b223a553-8322-44d5-9a31-70b4b20fbba0', archiveHash: 'a'.repeat(64) } },
    identities, credentials: { schema: 1,
      mexc: { schema: 1, venue: 'mexc', environment: 'mainnet', region: 'global', apiKey: 'SYNTHETIC_MEXC_KEY', apiSecret: 'SYNTHETIC_MEXC_SECRET' },
      okx: { schema: 1, venue: 'okx', environment: 'mainnet', region: 'global', apiKey: 'SYNTHETIC_OKX_KEY', apiSecret: 'SYNTHETIC_OKX_SECRET', passphrase: 'SYNTHETIC_PASSPHRASE' } },
    context: ACCOUNT_BINDING_CONTEXT, references: ACCOUNT_BINDING_REFERENCES, sourceHash: 'b'.repeat(64), policyHash: ACCOUNT_BINDING_POLICY_HASH,
    bundleVersion: 'f5df060f-6e8f-4051-9179-3137049478c0' }, bindingKey);
  const pinBytes = encode(pin);
  const assessment = () => ({ requiredAssets: { BTC: false, USDT: false, MX: false }, reasons: [] });
  const common = { schema: 1, environment: 'mainnet', requestCount: 2, identityAccepted: true, fundsAdmission: false, executable: false };
  const mexcRow = (currency: string, free: string) => ({ currency, free, locked: '0', available: free, unavailableFields: {} });
  const okxRow = (currency: string, cashBal: string) => ({ currency, cashBal, availBal: cashBal, frozenBal: '0', liab: '0', crossLiab: '0', isoLiab: '0', interest: '0', borrowFroz: '0', sourceUpdatedAt: String(now), unavailableFields: {} });
  const archive = { schema: 1, kind: 'account-funds-observation', archiveId: '11335577-2244-4466-8899-112233445566', startedAt: now, endedAt: now + 800,
    environment: 'mainnet', selectionReceipt: pin.selection.receipt, bundleVersion: pin.bundleVersion, pinHash: digest(pinBytes),
    identityEnrolled: true, fundsBound: true, fundsAdmission: false, executable: false, requestCount: 4,
    mexc: { ...common, identity: { ...identities.mexc, requestedAt: now + 100, receivedAt: now + 200 }, venue: 'mexc', origin: 'https://api.mexc.com', configuration: null,
      funds: { requestedAt: now + 300, receivedAt: now + 400, source: '/api/v3/account', sourceUpdatedAt: String(now), accountType: 'SPOT', canTrade: true, unavailableFields: {},
        balances: [mexcRow('BTC', '0.100000000000000001'), mexcRow('USDT', options.mexcUSDT ?? '10'), mexcRow('MX', '0')] }, assessment: assessment() },
    okx: { ...common, identity: { ...identities.okx, requestedAt: now + 500, receivedAt: now + 600 }, venue: 'okx', origin: 'https://www.okx.com',
      configuration: { accountMode: options.okxAccountMode ?? '1', autoLoan: false, enableSpotBorrow: false, spotBorrowAutoRepay: false, unavailableFields: {} },
      funds: { requestedAt: now + 700, receivedAt: now + 800, source: '/api/v5/account/balance', sourceUpdatedAt: String(now), unavailableFields: {},
        balances: [okxRow('BTC', '1.000000000000000001'), okxRow('USDT', options.okxUSDT ?? '99.999999999999999999')] }, assessment: assessment() },
  };
  const input = () => {
    const archiveBytes = encode(archive);
    return { archiveBytes, receipt: { schema: 1, kind: 'account-funds-observation-receipt', archiveId: archive.archiveId, archiveHash: digest(archiveBytes) }, pinBytes, bindingKey, now: options.checkedAt ?? now + 900 };
  };
  return { ...input(), archive, pin, input };
}
