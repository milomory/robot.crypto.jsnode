import { createHash } from 'node:crypto';
import { fundsEvidenceFixture } from './funds-evidence-fixture.js';
/** Synthetic private captures only. No I/O, real account, or exchange key. */
export function accountFeesFixture(options: { now?: number; feeType?: '0' | '1' | null; mxEnabled?: boolean; okxUSDT?: string;
  mexcUid?: string; okxUid?: string; collectorSourceHash?: string } = {}) {
  const funds = fundsEvidenceFixture({ now: options.now, mexcUid: options.mexcUid, okxUid: options.okxUid, okxUSDT: options.okxUSDT ?? '100' });
  for (const row of funds.archive.mexc.funds.balances) if (row.currency === 'BTC') row.free = row.available = '0';
  for (const row of funds.archive.okx.funds.balances) if (row.currency === 'BTC') row.cashBal = row.availBal = '0';
  const start = funds.archive.startedAt + 1_000, now = start + 1_100, collectorSourceHash = options.collectorSourceHash ?? 'c'.repeat(64);
  const feeType = options.feeType === undefined ? '1' : options.feeType;
  const common = { schema: 1, environment: 'mainnet', symbol: 'BTC/USDT', identityAccepted: true, executable: false };
  const archive = { schema: 1, kind: 'account-fees-observation', archiveId: '22446688-3355-4477-8899-223344556677', startedAt: start, endedAt: start + 1000,
    environment: 'mainnet', selectionReceipt: funds.pin.selection.receipt, bundleVersion: funds.pin.bundleVersion,
    pinHash: funds.archive.pinHash, bindingSourceHash: funds.pin.sourceHash, collectorSourceHash,
    identityEnrolled: true, feesBound: true, feeAdmission: false, executable: false, requestCount: 5,
    mexc: { ...common, venue: 'mexc', origin: 'https://api.mexc.com', requestCount: 3,
      identity: { ...funds.pin.identities.mexc, requestedAt: start + 100, receivedAt: start + 200 },
      fees: { source: '/api/v3/tradeFee?symbol=BTCUSDT', requestedAt: start + 300, receivedAt: start + 400,
        sourceUpdatedAt: String(start), makerRateRaw: '0E-18', takerRateRaw: '0.000500000000000000', makerCostRate: '0', takerCostRate: '0.0005',
        rateConvention: 'positive-fee', feeGroupId: null },
      configuration: { source: '/api/v3/mxDeduct/enable', requestedAt: start + 500, receivedAt: start + 600,
        mxDeductEnabled: options.mxEnabled ?? false, feeCurrencyMode: 'unknown' },
      blockers: options.mxEnabled ? ['fee-currency-unconfirmed', 'mx-fee-conversion-unconfirmed'] : ['fee-currency-unconfirmed'] },
    okx: { ...common, venue: 'okx', origin: 'https://www.okx.com', requestCount: 2,
      identity: { ...funds.pin.identities.okx, requestedAt: start + 700, receivedAt: start + 800 },
      fees: { source: '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT', requestedAt: start + 900, receivedAt: start + 1000,
        sourceUpdatedAt: String(start), makerRateRaw: '-0.0008', takerRateRaw: '-0.001', makerCostRate: '0.0008', takerCostRate: '0.001',
        rateConvention: 'negative-fee-positive-rebate', feeGroupId: '1' },
      configuration: { feeType, feeCurrencyMode: feeType === '0' ? 'received-asset' : feeType === '1' ? 'quote' : 'unknown' },
      blockers: feeType === null ? ['fee-currency-unconfirmed'] : [] },
  };
  const input = () => {
    const archiveBytes = Buffer.from(JSON.stringify(archive) + '\n');
    return { archiveBytes, receipt: { schema: 1, kind: 'account-fees-observation-receipt', archiveId: archive.archiveId,
      archiveHash: createHash('sha256').update(archiveBytes).digest('hex') }, pinBytes: funds.pinBytes, bindingKey: funds.bindingKey,
      expectedCollectorSourceHash: collectorSourceHash, now };
  };
  const fundsInput = () => ({ ...funds.input(), now });
  return { funds, archive, now, collectorSourceHash, pinBytes: funds.pinBytes, bindingKey: funds.bindingKey, input, fundsInput };
}
