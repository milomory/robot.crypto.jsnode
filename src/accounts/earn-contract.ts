import { z } from 'zod';

const time = z.number().int().positive().max(8_640_000_000_000_000).safe();
const decimal = z.string().max(65).regex(/^-?(?:0|[1-9]\d{0,32})(?:\.\d{1,30})?$/);
const amount = z.string().max(61).regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/);
const status = z.enum(['complete', 'partial', 'unavailable']);
const nullableTime = time.nullable();
const isZero = (value: string) => /^-?0(?:\.0+)?$/.test(value);
function validRange(records: number, first: number | null, last: number | null, from: number, to: number): boolean {
  if (records === 0) return first === null && last === null;
  return first !== null && last !== null && first > from && last <= to &&
    (records === 1 ? first === last : first < last) && records <= last - first + 1;
}
export const earnPeriodSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]), from: time, to: time,
  recordedEarningsUsdt: decimal.nullable(), records: z.number().int().min(0).max(900),
  coverage: status, firstRecordAt: nullableTime, lastRecordAt: nullableTime,
  // Current savings amount and a lending row do not establish historical
  // subscribed capital over a known interval. Never manufacture an APR.
  realizedAprPercent: z.null(), yieldReason: z.literal('historical-principal-intervals-unavailable'),
}).strict().superRefine((value, context) => {
  if (value.to - value.from !== value.days * 86_400_000 ||
      !validRange(value.records, value.firstRecordAt, value.lastRecordAt, value.from, value.to) ||
      ((value.coverage === 'unavailable') !== (value.recordedEarningsUsdt === null)) ||
      (value.records === 0 && value.recordedEarningsUsdt !== null && !isZero(value.recordedEarningsUsdt)) ||
      (value.coverage === 'complete' && (value.records !== value.days * 24 ||
        value.firstRecordAt === null || value.lastRecordAt === null || value.firstRecordAt - value.from > 3_600_000 ||
        value.to - value.lastRecordAt >= 3_600_000 ||
        value.lastRecordAt - value.firstRecordAt !== (value.records - 1) * 3_600_000))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Earn period' });
  }
});

export const okxEarnSchema = z.object({
  schema: z.literal(1), venue: z.literal('okx'), product: z.literal('simple-earn-flexible'),
  currency: z.literal('USDT'), observedAt: time,
  status: z.enum(['available', 'partial', 'unavailable']),
  balanceStatus: z.enum(['available', 'unavailable']),
  principalUsdt: amount.nullable(), lendingUsdt: amount.nullable(), pendingUsdt: amount.nullable(),
  reportedEarningsUsdt: decimal.nullable(), reportedEarningsPeriod: z.literal('unspecified'),
  history: z.object({
    status, pagination: z.enum(['exhausted', 'window-covered', 'page-limit', 'deadline', 'read-error', 'conflict', 'stalled']),
    pages: z.number().int().min(0).max(9), records: z.number().int().min(0).max(900),
    firstRecordAt: nullableTime, lastRecordAt: nullableTime,
    gapsDetected: z.boolean(), duplicateRecords: z.number().int().min(0).max(900),
    conflictingRecords: z.number().int().min(0).max(900),
  }).strict(),
  periods: z.object({ days7: earnPeriodSchema, days30: earnPeriodSchema }).strict(),
}).strict().superRefine((value, context) => {
  const seven = value.periods.days7, month = value.periods.days30;
  const periods = [seven, month];
  const history = value.history;
  const holdings = [value.principalUsdt, value.lendingUsdt, value.pendingUsdt];
  if (seven.days !== 7 || month.days !== 30 ||
      periods.some(period => period.to !== value.observedAt || period.records > history.records) ||
      month.records !== history.records || seven.records > month.records ||
      month.firstRecordAt !== history.firstRecordAt || month.lastRecordAt !== history.lastRecordAt ||
      !validRange(history.records, history.firstRecordAt, history.lastRecordAt, month.from, value.observedAt) ||
      (seven.records > 0 && (seven.lastRecordAt !== month.lastRecordAt || seven.firstRecordAt! < month.firstRecordAt!)) ||
      (seven.records === month.records && (seven.firstRecordAt !== month.firstRecordAt ||
        (seven.recordedEarningsUsdt !== null && month.recordedEarningsUsdt !== null &&
          seven.recordedEarningsUsdt !== month.recordedEarningsUsdt))) ||
      ((history.pages === 0) !== (history.status === 'unavailable')) ||
      history.records + history.duplicateRecords > history.pages * 100 ||
      history.conflictingRecords > history.duplicateRecords ||
      ((history.pagination === 'conflict') !== (history.conflictingRecords > 0)) ||
      (history.pagination === 'page-limit' && history.pages !== 9) ||
      (history.pagination === 'stalled' && history.pages < 2) ||
      (history.pages === 0 && (history.records !== 0 ||
        !['read-error', 'deadline'].includes(history.pagination) || periods.some(period => period.coverage !== 'unavailable'))) ||
      (history.gapsDetected && (history.records < 2 || history.lastRecordAt! - history.firstRecordAt! <= 3_600_000)) ||
      (history.status === 'complete' && (!['exhausted', 'window-covered'].includes(history.pagination) ||
        history.duplicateRecords > 0 || history.gapsDetected)) ||
      ((value.status === 'unavailable') !== (value.balanceStatus === 'unavailable' && history.status === 'unavailable')) ||
      (value.balanceStatus === 'unavailable' && [...holdings, value.reportedEarningsUsdt].some(amount => amount !== null)) ||
      (value.balanceStatus === 'available' && (holdings.some(amount => amount === null) ||
        (value.reportedEarningsUsdt === null && holdings.some(amount => amount !== null && !isZero(amount))))) ||
      (value.status === 'available' && (value.balanceStatus !== 'available' ||
        history.status !== 'complete' || periods.some(period => period.coverage !== 'complete')))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Earn observation' });
  }
});
export type EarnPeriod = z.infer<typeof earnPeriodSchema>;
export type OkxEarnObservation = z.infer<typeof okxEarnSchema>;

export type OkxEarnBalance = {
  currency: 'USDT'; amount: string; lendingAmount: string; pendingAmount: string;
  reportedEarnings: string;
};
export type OkxEarnHistoryRecord = { currency: 'USDT'; amount: string; earnings: string; at: number };
export type OkxEarnReader = {
  getEarnBalance(): Promise<OkxEarnBalance | null>;
  getEarnHistoryPage(after?: string): Promise<OkxEarnHistoryRecord[]>;
};
