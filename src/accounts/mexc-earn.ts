import { mexcEarnSchema, type MexcEarn } from './mexc-earn-contract.js';

/**
 * MEXC publishes financial capabilities in its official CLI. Integration of
 * those reads is pending verification of the CLI gateway signature and response
 * contracts; the Spot API signature must not be assumed to work there.
 *
 * This factory performs no request and accepts no credentials. Products below
 * describe coverage, never actual enrolment or balances. In particular, a Spot
 * holding is not proof of Hold and Earn participation. No value from this
 * projection may be added to the account portfolio total.
 *
 * Evidence and the exact discovered read paths: docs/EARN-MEXC-CONTRACT.md.
 */
export function mexcEarnNotConnected(): MexcEarn {
  return mexcEarnSchema.parse({
    schema: 1,
    venue: 'mexc',
    status: 'not-connected',
    reason: 'provider-contract-unverified',
    observedAt: null,
    contractReviewedOn: '2026-09-28',
    scope: 'main-account',
    readOnly: true,
    principalUsdt: null,
    accrued7dUsdt: null,
    accrued30dUsdt: null,
    realizedApr7d: null,
    realizedApr30d: null,
    coverage: 'unverified',
    products: [
      { product: 'hold-and-earn', walletRelationship: 'spot-included' },
      { product: 'futures-earn', walletRelationship: 'futures-included' },
      { product: 'flexible-savings', walletRelationship: 'not-established' },
      { product: 'fixed-savings', walletRelationship: 'not-established' },
      { product: 'onchain-earn', walletRelationship: 'not-established' },
      { product: 'earn-plus', walletRelationship: 'not-established' }
    ].map(product => ({
      ...product, enrollment: 'unknown', principalUsdt: null,
      accrued7dUsdt: null, accrued30dUsdt: null
    }))
  });
}
