import { z } from 'zod';
import { okxEarnSchema } from './earn-contract.js';
import { mexcEarnSchema } from './mexc-earn-contract.js';

// This projection contains account data, never credentials or arbitrary upstream text.
export const ACCOUNT_DASHBOARD_PATH = '/api/accounts/dashboard';
export const ACCOUNT_DASHBOARD_MAX_AGE_MS = 10 * 60_000;
const timestamp = z.number().int().positive().max(8_640_000_000_000_000).safe();
const decimal = z.string().max(152).regex(/^-?(?:0|[1-9]\d{0,89})(?:\.\d{1,60})?$/);
const amount = decimal.nullable();
const currency = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
export const dashboardAssetSchema = z.object({
  currency, total: decimal, available: amount, locked: amount, valueUsdt: amount
}).strict();
export const dashboardCoverageSchema = z.object({
  basis: z.enum(['mexc-spot', 'mexc-spot-futures', 'okx-trading-funding', 'okx-account-total']),
  status: z.enum(['complete', 'partial']), scope: z.literal('current-account'),
  wallets: z.array(z.object({
    id: z.enum(['spot', 'futures', 'trading', 'funding', 'earn', 'classic']),
    status: z.enum(['included', 'unavailable', 'unsupported']), valueUsdt: amount,
    reason: z.enum(['read-failed', 'unsupported', 'ambiguous-equity', 'unpriced']).optional()
  }).strict()).min(1).max(6),
  assetBreakdown: z.enum(['spot', 'trading-funding']),
  breakdownMatchesTotal: z.boolean().optional()
}).strict().superRefine((coverage, context) => {
  if (new Set(coverage.wallets.map(row => row.id)).size !== coverage.wallets.length ||
      coverage.wallets.some(row => row.status !== 'included' && row.valueUsdt !== null) ||
      (coverage.status === 'complete' && coverage.wallets.some(row => row.status !== 'included'))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid account coverage' });
  }
});
export const dashboardExchangeSchema = z.object({
  venue: z.enum(['mexc', 'okx']), status: z.enum(['connected', 'error', 'stale']),
  observedAt: timestamp.nullable(), portfolioUsdt: amount, pricedUsdt: amount,
  usdtBalance: amount, availableUsdt: amount, valuationComplete: z.boolean(),
  unpricedAssets: z.array(currency).max(7_000), assets: z.array(dashboardAssetSchema).max(7_000),
  coverage: dashboardCoverageSchema.optional()
}).strict().superRefine((value, context) => {
  if (new Set(value.assets.map(row => row.currency)).size !== value.assets.length ||
      new Set(value.unpricedAssets).size !== value.unpricedAssets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate dashboard assets' });
  }
  if (value.coverage) {
    const c = value.coverage;
    const expected = value.venue === 'mexc' ? ['earn', 'futures', 'spot'] : ['classic', 'earn', 'funding', 'trading'];
    if (!c.basis.startsWith(value.venue + '-') ||
        c.wallets.map(row => row.id).sort().join(',') !== expected.join(',') ||
        c.assetBreakdown !== (value.venue === 'mexc' ? 'spot' : 'trading-funding') ||
        (c.status === 'complete' && c.basis !== 'okx-account-total') ||
        (c.basis === 'okx-account-total' && (c.status !== 'complete' || c.wallets.some(row => row.status !== 'included'))) ||
        (c.basis === 'mexc-spot-futures' && c.wallets.find(row => row.id === 'futures')?.status !== 'included')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid venue coverage' });
    }
  }
  if (value.status === 'connected' && value.observedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing observation timestamp' });
  }
  if (value.valuationComplete && (value.portfolioUsdt === null || value.unpricedAssets.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete dashboard valuation' });
  }
  if (!value.valuationComplete && value.portfolioUsdt !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Partial portfolio cannot be a total' });
  }
});
export const dashboardOperationSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_.\/-]+$/),
  venue: z.enum(['mexc', 'okx']), type: z.enum(['trade', 'deposit', 'withdrawal', 'order']),
  symbol: z.string().min(1).max(70).regex(/^[A-Z0-9._/-]+$/).nullable(),
  asset: currency, side: z.enum(['buy', 'sell']).nullable(), amount: decimal,
  quoteAmount: amount, fee: amount, feeAsset: currency.nullable(),
  status: z.enum(['pending', 'completed', 'cancelled', 'failed', 'partial', 'unknown']),
  at: timestamp, isOpen: z.boolean()
}).strict();
export const accountDashboardOperationsSchema = z.object({
  status: z.enum(['not-connected', 'available', 'partial', 'error']),
  items: z.array(dashboardOperationSchema).max(500),
  coverageLabel: z.string().min(1).max(240)
}).strict();
export const accountDashboardSchema = z.object({
  schema: z.literal(1), observedAt: timestamp,
  status: z.enum(['ready', 'partial', 'stale', 'unavailable']),
  totals: z.object({ portfolioUsdt: amount, pricedUsdt: amount, usdtBalance: amount,
    availableUsdt: amount, valuationComplete: z.boolean() }).strict(),
  exchanges: z.array(dashboardExchangeSchema).length(2),
  operations: accountDashboardOperationsSchema,
  earn: z.object({ okx: okxEarnSchema, mexc: mexcEarnSchema }).strict().optional(),
  liveExecutionEnabled: z.literal(false)
}).strict().superRefine((value, context) => {
  if (new Set(value.exchanges.map(row => row.venue)).size !== 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid dashboard venues' });
  }
  if (value.exchanges.some(row => row.status !== 'connected') &&
      (value.totals.portfolioUsdt !== null || value.totals.pricedUsdt !== null ||
       value.totals.usdtBalance !== null || value.totals.availableUsdt !== null || value.totals.valuationComplete)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unavailable venue cannot produce a total' });
  }
  if (value.totals.valuationComplete && (value.totals.portfolioUsdt === null ||
      !value.exchanges.every(row => row.valuationComplete))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete combined valuation' });
  }
  if (!value.totals.valuationComplete && value.totals.portfolioUsdt !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Partial combined portfolio cannot be a total' });
  }
});
export type DashboardOperation = z.infer<typeof dashboardOperationSchema>;
export type DashboardAsset = z.infer<typeof dashboardAssetSchema>;
export type DashboardExchange = z.infer<typeof dashboardExchangeSchema>;
export type AccountDashboard = z.infer<typeof accountDashboardSchema>;

export type DashboardCoverage = z.infer<typeof dashboardCoverageSchema>;
