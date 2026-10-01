import { z } from 'zod';

/** Capability metadata only. It is not an account observation or position list. */
const mexcEarnProductCapabilitySchema = z.object({
  product: z.enum([
    'hold-and-earn', 'futures-earn', 'flexible-savings', 'fixed-savings', 'onchain-earn', 'earn-plus'
  ]),
  enrollment: z.literal('unknown'),
  principalUsdt: z.null(),
  accrued7dUsdt: z.null(),
  accrued30dUsdt: z.null(),
  walletRelationship: z.enum(['spot-included', 'futures-included', 'not-established'])
}).strict();

export const mexcEarnSchema = z.object({
  schema: z.literal(1),
  venue: z.literal('mexc'),
  status: z.literal('not-connected'),
  reason: z.literal('provider-contract-unverified'),
  // Reviewing public protocol documentation is not a successful account read.
  observedAt: z.null(),
  contractReviewedOn: z.literal('2026-09-28'),
  scope: z.literal('main-account'),
  readOnly: z.literal(true),
  principalUsdt: z.null(),
  accrued7dUsdt: z.null(),
  accrued30dUsdt: z.null(),
  realizedApr7d: z.null(),
  realizedApr30d: z.null(),
  coverage: z.literal('unverified'),
  products: z.array(mexcEarnProductCapabilitySchema).length(6)
}).strict().superRefine((value, context) => {
  const products = value.products;
  if (new Set(products.map(product => product.product)).size !== 6 ||
      products.some(product => product.walletRelationship !== (
        product.product === 'hold-and-earn' ? 'spot-included' :
          product.product === 'futures-earn' ? 'futures-included' : 'not-established'
      ))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid MEXC Earn capability coverage' });
  }
});

export type MexcEarn = z.infer<typeof mexcEarnSchema>;
