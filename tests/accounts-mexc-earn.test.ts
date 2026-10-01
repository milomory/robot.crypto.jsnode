import { describe, expect, it } from 'vitest';
import { mexcEarnNotConnected } from '../src/accounts/mexc-earn.js';
import { mexcEarnSchema } from '../src/accounts/mexc-earn-contract.js';

describe('MEXC Earn unconnected coverage', () => {
  it('does not represent public contract review as account data or an empty account', () => {
    const result = mexcEarnNotConnected();
    expect(result).toMatchObject({
      venue: 'mexc', status: 'not-connected', reason: 'provider-contract-unverified',
      observedAt: null, coverage: 'unverified', readOnly: true,
      principalUsdt: null, accrued7dUsdt: null, accrued30dUsdt: null,
      realizedApr7d: null, realizedApr30d: null
    });
    expect(result.products.every(row => row.enrollment === 'unknown' &&
      row.principalUsdt === null && row.accrued7dUsdt === null && row.accrued30dUsdt === null)).toBe(true);
  });

  it.each(['principalUsdt', 'accrued7dUsdt', 'accrued30dUsdt', 'realizedApr7d', 'realizedApr30d'])
    ('refuses a fabricated zero or amount in %s', field => {
      for (const value of [0, '0', '1.23']) {
        expect(mexcEarnSchema.safeParse({ ...mexcEarnNotConnected(), [field]: value }).success).toBe(false);
      }
    });

  it('preserves wallet overlap without inferring participation or missing-product zero', () => {
    const products = mexcEarnNotConnected().products;
    expect(products.find(row => row.product === 'hold-and-earn')?.walletRelationship).toBe('spot-included');
    expect(products.find(row => row.product === 'futures-earn')?.walletRelationship).toBe('futures-included');
    expect(products.filter(row => !['hold-and-earn', 'futures-earn'].includes(row.product))
      .every(row => row.walletRelationship === 'not-established')).toBe(true);
    const invalid = mexcEarnNotConnected();
    invalid.products[0].walletRelationship = 'not-established';
    expect(mexcEarnSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires complete distinct capability entries and refuses real position rows', () => {
    const result = mexcEarnNotConnected();
    expect(mexcEarnSchema.safeParse({ ...result, products: [] }).success).toBe(false);
    expect(mexcEarnSchema.safeParse({ ...result, products: Array(6).fill(result.products[0]) }).success).toBe(false);
    expect(mexcEarnSchema.safeParse({ ...result, products: result.products.map((row, n) =>
      n === 0 ? { ...row, enrollment: 'active', principalUsdt: '10' } : row) }).success).toBe(false);
  });

  it('rejects private or arbitrary provider fields at every boundary', () => {
    const result = mexcEarnNotConnected();
    expect(mexcEarnSchema.safeParse({ ...result, apiSecret: 'PRIVATE_TEST_MARKER' }).success).toBe(false);
    expect(mexcEarnSchema.safeParse({ ...result, message: 'PRIVATE_TEST_MARKER' }).success).toBe(false);
    expect(mexcEarnSchema.safeParse({ ...result, products: result.products.map((row, n) =>
      n === 0 ? { ...row, accountId: 'PRIVATE_TEST_MARKER' } : row) }).success).toBe(false);
  });

  it('refuses a fake successful read, fresh timestamp or write capability', () => {
    const result = mexcEarnNotConnected();
    for (const delta of [
      { status: 'connected' }, { observedAt: 1_800_000_000_000 }, { coverage: 'complete' },
      { readOnly: false }, { scope: 'all-accounts' }
    ]) expect(mexcEarnSchema.safeParse({ ...result, ...delta }).success).toBe(false);
  });

  it('returns independent metadata so caller mutations cannot affect later projections', () => {
    const first = mexcEarnNotConnected();
    first.products.pop();
    expect(mexcEarnNotConnected().products).toHaveLength(6);
  });
});
