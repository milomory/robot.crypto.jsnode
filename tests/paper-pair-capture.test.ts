import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPair, readPairArchive, feeCosts } from '../src/paper-pair/capture.js';
import { reportPair, writePairReport } from '../src/paper-pair/report.js';
import { canonical } from '../src/paper-v2/ledger.js';
import { T, fees, fakeCaptureOptions } from './helpers/pair-fixtures.js';
const roots: string[] = [];
async function setup(failure = -1) {
  const root = await mkdtemp(join(tmpdir(), 'pair-paper-test-')); roots.push(root);
  const archive = join(root, 'archive'); await collectPair(archive, fees(), fakeCaptureOptions(failure));
  return { root, archive };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe('bounded paired archive and replay', () => {
  it('records exact fee provenance and decimal-bps without pretending numeric JSON was lossless', () => {
    const costs = feeCosts(fees(), T); expect(costs.costs.mexc.feeBps).toBe('5'); expect(costs.costs.okx.feeBps).toBe('10');
    expect(costs.evidence.fees.mexc.ratePrecision).toBe('json-number');
    const f = fees(); f.fees.mexc.takerRate = '0.0000125'; expect(feeCosts(f, T).costs.mexc.feeBps).toBe('0.125');
    f.fees.mexc.takerRate = '1e-7'; expect(() => feeCosts(f, T)).toThrow('invalid-fee-evidence');
    expect(() => feeCosts(fees(), T + 600001)).toThrow('stale-fee-evidence');
  });
  it('collects all60 slots and replays byte-identically with zero trades on unconfirmed rules', async () => {
    const { root, archive } = await setup(); const parsed = await readPairArchive(archive);
    expect(parsed.samples).toHaveLength(60);
    expect(parsed.samples[0].startedAt).toBeGreaterThanOrEqual(parsed.instruments.samplingStartedAt);
    expect(parsed.samples[59].startedAt - parsed.samples[0].startedAt).toBe(295000);
    const first = await reportPair(archive), second = await reportPair(archive);
    expect(canonical(first)).toBe(canonical(second)); expect(first.coverage.complete).toBe(true);
    expect(first.counts).toMatchObject({ directionalComparisons: 120, positiveDirections: 60, paperPairs: 0, ruleEligibleDirections: 0 });
    expect(first.paper.balances).toEqual(first.opening); expect(first.journal).toEqual([]);
    expect(first.observations[0].directions[0].ruleReasons).toContain('mexc:quantity-step-unconfirmed');
    await writePairReport(archive, join(root, 'report'));
    expect((await stat(join(root, 'report/report.json'))).mode & 0o777).toBe(0o600);
    await expect(writePairReport(archive, join(root, 'report'))).rejects.toThrow();
  });
  it('retains a failed leg and labels whole-window coverage incomplete, never filling or filtering it', async () => {
    const { archive } = await setup(3); const report = await reportPair(archive);
    expect(report.coverage).toMatchObject({ scheduledPairs: 60, availablePairs: 59, unavailablePairs: 1, complete: false });
    expect(report.observations).toHaveLength(60); expect(report.observations[3].reason).toBe('missing-book');
    expect(canonical(report)).not.toContain('private-upstream-text');
  });
  it.each(['plan', 'costs', 'sequence', 'chronology', 'instrument', 'extra-file', 'missing-file', 'symlink'])('refuses altered %s', async kind => {
    const { archive, root } = await setup();
    if (kind === 'plan' || kind === 'costs') {
      const path = join(archive, 'manifest.json'), p = JSON.parse(await readFile(path, 'utf8'));
      if (kind === 'plan') p.plan.quantityBTC = '0.01'; else p.costs.mexc.feeBps = '0';
      await writeFile(path, JSON.stringify(p));
    } else if (kind === 'sequence' || kind === 'chronology') {
      const path = join(archive, '001.json'), p = JSON.parse(await readFile(path, 'utf8'));
      if (kind === 'sequence') p.sequence = 2; else p.books.mexc.value.receivedAt = p.checkedAt + 1;
      await writeFile(path, JSON.stringify(p));
    } else if (kind === 'instrument') {
      const path = join(archive, 'instruments.json'), p = JSON.parse(await readFile(path, 'utf8'));
      p.instruments.mexc.value.quantityStep = '0.000001'; await writeFile(path, JSON.stringify(p));
    } else if (kind === 'extra-file') await writeFile(join(archive, 'extra'), 'x');
    else if (kind === 'missing-file') await rm(join(archive, '059.json'));
    else {
      const source = join(root, 'source.json'); await writeFile(source, await readFile(join(archive, '059.json')));
      await rm(join(archive, '059.json')); await symlink(source, join(archive, '059.json'));
    }
    await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
  });
  it('never reuses an existing archive directory', async () => {
    const { archive } = await setup(); const before = await readFile(join(archive, 'manifest.json'), 'utf8');
    await expect(collectPair(archive, fees(), fakeCaptureOptions())).rejects.toThrow();
    expect(await readFile(join(archive, 'manifest.json'), 'utf8')).toBe(before);
  });
});
