/** Three bounded private GET reads. No journal writes, order sender or credential lookup. */
import { performance } from 'node:perf_hooks';
import type { OrderRecoveryReader, RecoveryOrderRead, RecoveryFillsRead } from '../accounts/order-recovery-reader.js';
import { AccountError } from '../accounts/types.js';
import { planLiveOrderRecovery, type LiveOrderState } from './order-lifecycle.js';

export const ORDER_RECOVERY_POLICY = Object.freeze({ maxCaptureAgeMs: 60_000, maxCaptureDurationMs: 30_000, maxClockSkewMs: 2_000 });
export type OrderRecoveryReadPort = Pick<OrderRecoveryReader, 'venue' | 'getOrder' | 'getFills'>;
export interface LiveOrderRecoveryCapture {
  readonly schema: 1;
  readonly kind: 'live-order-recovery-capture';
  readonly venue: 'mexc' | 'okx';
  readonly account: 'main';
  readonly clientOrderId: string;
  readonly requestedAt: number;
  readonly receivedAt: number;
  readonly orderBefore: RecoveryOrderRead;
  readonly fills: RecoveryFillsRead;
  readonly orderAfter: RecoveryOrderRead;
}
export class OrderRecoveryCollectionError extends Error {
  constructor(readonly code: 'recovery-invalid-state' | 'recovery-invalid-clock' | 'recovery-ineligible-order' |
    'recovery-outside-retention' | 'recovery-busy' | 'recovery-deadline' | 'recovery-read-unavailable' |
    'recovery-rate-limited' | 'recovery-identity-mismatch') { super(code); this.name = 'OrderRecoveryCollectionError'; }
}
const active = new WeakSet<object>();
function fail(code: OrderRecoveryCollectionError['code']): never { throw new OrderRecoveryCollectionError(code); }
function validTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) fail('recovery-invalid-clock');
  return value;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
async function bounded<T>(call: () => Promise<T>, remaining: number): Promise<T> {
  if (remaining <= 0) fail('recovery-deadline');
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([call(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OrderRecoveryCollectionError('recovery-deadline')), Math.min(5000, remaining));
    })]);
  } finally { clearTimeout(timer!); }
}
/** Only dispatched, unreconciled intents qualify. The caller supplies the scoped
 * read-only reader; no environment, vault lookup or runtime composition is provided. */
export async function collectLiveOrderRecovery(state: LiveOrderState, orderIntentId: string,
  reader: OrderRecoveryReadPort, options: { clock?: () => number; wait?: (ms: number) => Promise<void> } = {})
  : Promise<LiveOrderRecoveryCapture> {
  try { planLiveOrderRecovery(state); } catch { return fail('recovery-invalid-state'); }
  const order = state.orders.find(row => row.intent.orderIntentId === orderIntentId);
  if (!order || !order.dispatchAt || order.phase === 'prepared' || order.phase === 'reconciled') fail('recovery-ineligible-order');
  if (!reader || reader.venue !== order.intent.venue) fail('recovery-identity-mismatch');
  if (active.has(reader)) fail('recovery-busy');
  const clock = options.clock ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const readClock = () => {
    try { return validTime(clock()); } catch { return fail('recovery-invalid-clock'); }
  };
  const started = performance.now(), requestedAt = readClock(), dispatchAt = Date.parse(order.dispatchAt);
  let lastClock = requestedAt;
  const now = () => {
    const value = readClock();
    if (value < lastClock) fail('recovery-invalid-clock');
    lastClock = value;
    if (value - requestedAt > ORDER_RECOVERY_POLICY.maxCaptureDurationMs) fail('recovery-deadline');
    return value;
  };
  if (dispatchAt > requestedAt + ORDER_RECOVERY_POLICY.maxClockSkewMs) fail('recovery-invalid-clock');
  if (requestedAt - dispatchAt + ORDER_RECOVERY_POLICY.maxClockSkewMs >= 7 * 86400_000) fail('recovery-outside-retention');
  const remaining = () => ORDER_RECOVERY_POLICY.maxCaptureDurationMs - (performance.now() - started);
  active.add(reader);
  try {
    const before = freeze(structuredClone(await bounded(() => reader.getOrder(order.exchangeOrderId
      ? { exchangeOrderId: order.exchangeOrderId } : { clientOrderId: order.clientOrderId }), remaining())));
    now();
    const data = before.data as unknown as Record<string, unknown>;
    const id = reader.venue === 'mexc' ? data.orderId : data.ordId;
    const client = reader.venue === 'mexc' ? data.clientOrderId : data.clOrdId;
    if (before.venue !== order.intent.venue || before.kind !== 'order' || typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(id) || client !== order.clientOrderId ||
        (order.exchangeOrderId !== null && order.exchangeOrderId !== id)) fail('recovery-identity-mismatch');
    await bounded(() => wait(250), remaining());
    const to = now();
    const fills = freeze(structuredClone(await bounded(() => reader.getFills(id, { from: Math.max(1, dispatchAt - ORDER_RECOVERY_POLICY.maxClockSkewMs), to }), remaining())));
    now();
    await bounded(() => wait(250), remaining());
    const after = freeze(structuredClone(await bounded(() => reader.getOrder({ exchangeOrderId: id }), remaining())));
    const receivedAt = now();
    // Deep-copy at the boundary: a mocked or caller-owned port cannot mutate a returned capture.
    return freeze(structuredClone({ schema: 1 as const, kind: 'live-order-recovery-capture' as const,
      venue: order.intent.venue, account: 'main' as const, clientOrderId: order.clientOrderId,
      requestedAt, receivedAt, orderBefore: before, fills, orderAfter: after }));
  } catch (error) {
    if (error instanceof OrderRecoveryCollectionError) throw error;
    if (error instanceof AccountError && error.code === 'account-rate-limited') fail('recovery-rate-limited');
    fail('recovery-read-unavailable');
  } finally { active.delete(reader); }
}
