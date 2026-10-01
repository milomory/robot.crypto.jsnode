import { z } from 'zod';

export const BALANCE_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const BALANCE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const BALANCE_HISTORY_MAX_POINTS = 9_000;
export const BALANCE_HISTORY_MAX_TRANSFERS = 2_000;
const time = z.number().int().positive().safe().max(8_640_000_000_000_000);
const decimal = z.string().max(152).regex(/^-?(?:0|[1-9]\d{0,89})(?:\.\d{1,60})?$/);
export function sumHistoryAmounts(left: string, right: string): string {
  if (!decimal.safeParse(left).success || !decimal.safeParse(right).success) throw new Error('history-invalid-decimal');
  const unpack = (value: string) => {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
    return { atoms: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
  };
  const a = unpack(left), b = unpack(right), scale = Math.max(a.scale, b.scale);
  const atoms = a.atoms * 10n ** BigInt(scale - a.scale) + b.atoms * 10n ** BigInt(scale - b.scale);
  if (atoms === 0n) return '0';
  const digits = (atoms < 0n ? -atoms : atoms).toString().padStart(scale + 1, '0');
  const value = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
  return `${atoms < 0n ? '-' : ''}${value}`;
}
export const balanceHistoryBasisSchema = z.object({
  mexc: z.enum(['mexc-spot', 'mexc-spot-futures']),
  okx: z.enum(['okx-trading-funding', 'okx-account-total'])
}).strict();
export const balanceHistoryPointSchema = z.object({
  at: time, totalUsdt: decimal.nullable(), mexcUsdt: decimal.nullable(), okxUsdt: decimal.nullable(),
  // Missing basis is legacy MEXC Spot + OKX Trading/Funding. Never rewrite old
  // values as if newly observed wallets had already been included.
  basis: balanceHistoryBasisSchema.optional()
}).strict().superRefine((point, context) => {
  const known = point.mexcUsdt !== null && point.okxUsdt !== null;
  if (!known) {
    if (point.totalUsdt !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown total' });
  } else {
    try {
      if (point.totalUsdt === null || sumHistoryAmounts(point.totalUsdt, '0') !== sumHistoryAmounts(point.mexcUsdt!, point.okxUsdt!)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent total' });
      }
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid total' }); }
  }
});
export const balanceHistoryTransferSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_.\/-]+$/),
  venue: z.enum(['mexc', 'okx']), type: z.enum(['deposit', 'withdrawal']),
  asset: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),
  amount: z.string().max(151).regex(/^(?:0|[1-9]\d{0,89})(?:\.\d{1,60})?$/), at: time
}).strict();
export const balanceHistorySchema = z.object({
  schema: z.literal(1), startedAt: time, updatedAt: time,
  points: z.array(balanceHistoryPointSchema).min(1).max(BALANCE_HISTORY_MAX_POINTS),
  transfers: z.array(balanceHistoryTransferSchema).max(BALANCE_HISTORY_MAX_TRANSFERS)
}).strict().superRefine((history, context) => {
  if (history.updatedAt < history.startedAt || history.points.at(-1)?.at !== history.updatedAt ||
    history.points.some((point, index) => point.at < history.startedAt ||
      (index > 0 && point.at <= history.points[index - 1].at)) ||
    history.transfers.some((transfer, index) => transfer.at < history.startedAt || transfer.at > history.updatedAt ||
      (index > 0 && transfer.at < history.transfers[index - 1].at)) ||
    new Set(history.transfers.map(row => `${row.venue}:${row.type}:${row.id}`)).size !== history.transfers.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid balance history chronology' });
  }
});
export type BalanceHistoryPoint = z.infer<typeof balanceHistoryPointSchema>;
export type BalanceHistoryTransfer = z.infer<typeof balanceHistoryTransferSchema>;
export type BalanceHistory = z.infer<typeof balanceHistorySchema>;
export type BalanceHistoryResponse = Omit<BalanceHistory, 'startedAt' | 'updatedAt'> & {
  startedAt: number | null; updatedAt: number | null;
  range: '1d' | '7d' | '30d'; from: number; to: number; transfersCoverage: 'observed-only';
};
