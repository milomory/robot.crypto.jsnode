import { describe, expect, it } from 'vitest';
import { applyLiveOrderEvent, createLiveOrderState, replayLiveOrderEvents } from '../src/live/order-lifecycle.js';
import { readFile } from 'node:fs/promises';
const fixture = JSON.parse(await readFile('fixtures/live-order-rehearsal/partial-cancel.json', 'utf8'));
function dispatched() { return fixture.events.slice(0, 2).reduce(applyLiveOrderEvent, createLiveOrderState()); }
const observation = {
  ...fixture.events[7], at: '2026-09-28T12:00:10.000Z',
  observation: { ...fixture.events[7].observation, status: 'new', cumulativeBaseQuantity: '0', cumulativeQuoteQuantity: '0',
    sourceCreatedAt: '2026-09-28T12:00:02.000Z', sourceUpdatedAt: '2026-09-28T12:00:03.000Z' },
};
const next = (patch: Record<string, unknown>) => ({ ...observation, eventId: '30000000-0000-4000-8000-000000000001',
  at: '2026-09-28T12:00:11.000Z', observation: { ...observation.observation, ...patch } });
describe('durable upstream order timestamps', () => {
  it('retains binding across replay and rejects older, missing or changed identity timestamps', () => {
    const state = replayLiveOrderEvents(applyLiveOrderEvent(dispatched(), observation).events);
    for (const patch of [
      { sourceUpdatedAt: '2026-09-28T12:00:02.500Z' },
      { sourceCreatedAt: undefined, sourceUpdatedAt: undefined },
      { sourceCreatedAt: '2026-09-28T12:00:01.000Z' },
    ]) expect(() => applyLiveOrderEvent(state, next(patch))).toThrow('source-time-regression');
    const updated = applyLiveOrderEvent(state, next({ sourceUpdatedAt: '2026-09-28T12:00:04.000Z' }));
    expect(updated.orders[0].latestObservation?.sourceUpdatedAt).toBe('2026-09-28T12:00:04.000Z');
  });
  it('requires a complete valid time pair and preserves old journals without fabricated timestamps', () => {
    const state = dispatched();
    expect(() => applyLiveOrderEvent(state, next({ sourceCreatedAt: undefined }))).toThrow('invalid-event');
    expect(() => applyLiveOrderEvent(state, next({ sourceUpdatedAt: '2026-09-28T12:00:01.000Z' }))).toThrow('invalid-event');
    const legacy = applyLiveOrderEvent(state, next({ sourceCreatedAt: undefined, sourceUpdatedAt: undefined }));
    expect(legacy.orders[0].latestObservation?.sourceCreatedAt).toBeUndefined();
    expect(replayLiveOrderEvents(legacy.events)).toEqual(legacy);
  });
});
