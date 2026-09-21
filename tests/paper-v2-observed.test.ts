import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonical } from '../src/paper-v2/ledger.js';
import { replayScenario } from '../src/paper-v2/replay.js';
import { accountSchema, scenarioSchema, type Scenario } from '../src/paper-v2/schema.js';

const fixtureBytes = await readFile(new URL('../fixtures/paper-v2/basic.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as Extract<Scenario, { schema: 1 }>;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// Contract tests reuse known fixture prices. This is not captured-market evidence.
function observed(): Extract<Scenario, { schema: 2 }> {
  const { schema, synthetic, ...base } = structuredClone(fixture);
  return { ...base, schema: 2, funding: 'synthetic', marketData: {
    kind: 'public-decimal-observations', schema: 1,
    captureId: '9f9706ba-38b0-4897-9caf-297f2de416a1', datasetHash: 'a'.repeat(64), policy: 'fixed-probe-v1'
  } };
}

describe('versioned observed prices with separately labelled synthetic funding', () => {
  it('keeps schema1 canonical artifact identical to the accepted offline result', () => {
    const result = replayScenario(fixture);
    const artifact = canonical({ ...result, provenance: {
      inputHash: result.inputHash, sourceFileSha256: sha256(fixtureBytes)
    } }) + '\n';
    expect(sha256(artifact)).toBe('28353f8f8e32e90f7ee76121c97de68e99a17571226ab06933c6295a05ffa47f');
    expect(result).toMatchObject({ schema: 1, synthetic: true, model: 'paper-v2-exact-1' });
    expect(result).not.toHaveProperty('funding');
    expect(result).not.toHaveProperty('marketData');
  });

  it('labels observed prices and synthetic funding separately without changing the accounting model', () => {
    const input = observed();
    expect(scenarioSchema.parse(input)).toEqual(input);
    const result = replayScenario(input);
    const previous = replayScenario(fixture);
    expect(result).toMatchObject({ schema: 2, model: 'paper-v2-exact-1', funding: 'synthetic',
      marketData: input.marketData, ledgerSchema: 1, costModel: 'quote-fee-exact-gross-v1' });
    expect(result).not.toHaveProperty('synthetic');
    expect(result.comparison.interpretation).toBe('Observed public prices with synthetic funding and fixed probe intents; not actual trades or strategy performance.');
    expect(result.strategy).toEqual(previous.strategy);
    expect(result.benchmarks).toEqual(previous.benchmarks);
    expect(result.assumptions).toEqual(previous.assumptions);
  });

  it('binds capture provenance and fixed policy into deterministic input and run identities', () => {
    const input = observed();
    const result = replayScenario(input);
    expect(result.inputHash).toBe(sha256(canonical(input)));
    expect(result.runId).toBe(`pv2-${result.inputHash}`);
    expect(result.inputHash).not.toBe(replayScenario(fixture).inputHash);
    expect(canonical(replayScenario(structuredClone(input)))).toBe(canonical(result));
    for (const marketData of [
      { ...input.marketData, datasetHash: 'b'.repeat(64) },
      { ...input.marketData, captureId: '8f9706ba-38b0-4897-9caf-297f2de416a1' }
    ]) {
      const changed = replayScenario({ ...input, marketData });
      expect(changed.inputHash).not.toBe(result.inputHash);
      expect(changed.runId).not.toBe(result.runId);
      expect(changed.strategy).toEqual(result.strategy);
    }
  });

  it('shares a strict account contract across both source formats', () => {
    const { venue, symbol, opening, costs, instrument } = fixture;
    const account = { venue, symbol, opening, costs, instrument };
    expect(accountSchema.parse(account)).toEqual(account);
    expect(accountSchema.safeParse({ ...account, credential: 'PRIVATE_SENTINEL' }).success).toBe(false);
    expect(accountSchema.safeParse(fixture).success).toBe(false);
    expect(accountSchema.safeParse(observed()).success).toBe(false);
  });

  it.each([
    ['missing policy', (s: any) => { delete s.marketData.policy; }],
    ['unknown policy', (s: any) => { s.marketData.policy = 'optimised-or-live-v1'; }],
    ['wrong source kind', (s: any) => { s.marketData.kind = 'private-account'; }],
    ['unsupported dataset schema', (s: any) => { s.marketData.schema = 2; }],
    ['bad capture ID', (s: any) => { s.marketData.captureId = '../PRIVATE_SENTINEL'; }],
    ['uppercase hash', (s: any) => { s.marketData.datasetHash = 'A'.repeat(64); }],
    ['short hash', (s: any) => { s.marketData.datasetHash = 'a'.repeat(63); }],
    ['real funding', (s: any) => { s.funding = 'real'; }],
    ['boolean funding', (s: any) => { s.funding = false; }],
    ['numeric opening money', (s: any) => { s.opening.USDT = 1000; }],
    ['numeric book price', (s: any) => { s.steps[0].book.bids[0][0] = 99990; }],
    ['nested credential', (s: any) => { s.marketData.credential = 'PRIVATE_SENTINEL'; }],
    ['top-level credential', (s: any) => { s.credential = 'PRIVATE_SENTINEL'; }],
    ['mixed synthetic label', (s: any) => { s.synthetic = true; }]
  ])('rejects %s without exposing content', (_name, mutate) => {
    const input = observed(); mutate(input);
    expect(() => replayScenario(input)).toThrow(/^invalid-scenario$/);
  });

  it('does not accept schema2 source labels on a schema1 fixture', () => {
    expect(() => replayScenario({ ...fixture, funding: 'synthetic', marketData: observed().marketData }))
      .toThrow(/^invalid-scenario$/);
  });
});
