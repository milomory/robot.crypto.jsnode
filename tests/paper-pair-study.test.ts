import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { canonical } from '../src/paper-v2/ledger.js';
import { join } from 'node:path';
import { collectPair, feeCosts, PAIR_PLAN, PAIR_STUDY_PLAN, readPairArchive } from '../src/paper-pair/capture.js';
import { T, fakeCaptureOptions, fees } from './helpers/pair-fixtures.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function archivePath() {
  const root = await mkdtemp(join(tmpdir(), 'pair-study-test-')); roots.push(root);
  return join(root, 'archive');
}
function studyOptions(failedBook = -1, failedIndex = -1) {
  const base = fakeCaptureOptions(failedBook);
  const calls = { instrument: 0, book: 0, index: 0 };
  return { calls, options: { ...base, profile: 'study-30m' as const, client: {
    getInstrument: async (...args: Parameters<typeof base.client.getInstrument>) => {
      calls.instrument++; return base.client.getInstrument(...args);
    },
    getBook: async (...args: Parameters<typeof base.client.getBook>) => {
      calls.book++; return base.client.getBook(...args);
    },
    getUsdIndex: async () => {
      const sequence = calls.index++, requestedAt = base.clock();
      await base.sleep(1);
      if (sequence === failedIndex) throw new Error('private-upstream-response');
      return { venue: 'okx' as const, instrument: 'BTC-USD' as const,
        requestedAt, receivedAt: base.clock(), sourceAt: requestedAt, usdPerBtc: '50000.000000000000000001' };
    }
  } } };
}
describe('fixed paired 30-minute collection protocol', () => {
  it('retains optional observed payment modes, rejects stale or unknown values and leaves fee costs unchanged', () => {
    const legacy = feeCosts(fees(), T);
    const evidence = { ...fees(), paymentModes: { observedAt: T - 10, mexcMxDeduct: false, okxFeeType: '0' } };
    const parsed = feeCosts(evidence, T);
    expect(parsed.costs).toEqual(legacy.costs);
    expect(parsed.evidence.paymentModes).toEqual(evidence.paymentModes);
    expect(Object.hasOwn(legacy.evidence, 'paymentModes')).toBe(false);
    expect(feeCosts({ ...fees(), paymentModes: { observedAt: T, mexcMxDeduct: null, okxFeeType: null } }, T)
      .evidence.paymentModes?.okxFeeType).toBe(null);
    for (const paymentModes of [
      { ...evidence.paymentModes, observedAt: T + 1 },
      { ...evidence.paymentModes, observedAt: T - 120_001 },
      { ...evidence.paymentModes, okxFeeType: 'future-mode' },
      { ...evidence.paymentModes, privateField: 'must-not-pass' }
    ]) expect(() => feeCosts({ ...fees(), paymentModes }, T)).toThrow('invalid-fee-evidence');
  });
  it('keeps the default probe plan, count and archive shape unchanged', async () => {
    const archive = await archivePath(), run = studyOptions();
    const { profile: _profile, ...options } = run.options;
    await collectPair(archive, fees(), options);
    const parsed = await readPairArchive(archive);
    expect(parsed.manifest.plan).toEqual(PAIR_PLAN);
    expect(parsed.samples).toHaveLength(60);
    expect(parsed.samples.every(sample => !Object.hasOwn(sample, 'usdIndex'))).toBe(true);
    expect(run.calls).toEqual({ instrument: 2, book: 120, index: 0 });
  });
  it('preserves all360 slots, freezes initial fees and rules, and serializes the public USD proxy after books', async () => {
    const archive = await archivePath(), run = studyOptions();
    const result = await collectPair(archive, fees(), run.options);
    const parsed = await readPairArchive(archive);
    expect(result).toMatchObject({ samples: 360, status: 'completed' });
    expect(parsed.manifest.plan).toEqual(PAIR_STUDY_PLAN);
    expect(parsed.samples).toHaveLength(360);
    expect(await readdir(archive)).toHaveLength(363);
    expect(parsed.samples[359].startedAt - parsed.samples[0].startedAt).toBe(1_795_000);
    expect(parsed.state.endedAt - parsed.manifest.feeEvidence.checkedAt).toBeGreaterThan(600_000);
    expect(parsed.state.endedAt - parsed.manifest.startedAt).toBeLessThan(PAIR_STUDY_PLAN.maxDurationMs);
    expect(parsed.manifest.feeEvidence).toEqual(fees());
    expect(run.calls).toEqual({ instrument: 2, book: 720, index: 360 });
    for (const sample of parsed.samples) {
      expect(sample.usdIndex?.available).toBe(true);
      if (sample.usdIndex?.available && sample.books.mexc.available && sample.books.okx.available) {
        expect(sample.usdIndex.value.requestedAt).toBeGreaterThanOrEqual(
          Math.max(sample.books.mexc.value.receivedAt, sample.books.okx.value.receivedAt));
        expect(sample.usdIndex.value.receivedAt).toBeLessThanOrEqual(sample.checkedAt);
      }
    }
  });
  it('retains failed books and USD proxies without filtering, retries or replacement requests', async () => {
    const archive = await archivePath(), run = studyOptions(3, 142);
    await collectPair(archive, fees(), run.options);
    const parsed = await readPairArchive(archive);
    expect(parsed.samples).toHaveLength(360);
    expect(parsed.samples[3].books.okx).toEqual({ available: false, reason: 'public-data-unavailable' });
    expect(parsed.samples[142].usdIndex).toEqual({ available: false, reason: 'public-data-unavailable' });
    expect(parsed.samples[359].sequence).toBe(359);
    expect(run.calls).toEqual({ instrument: 2, book: 720, index: 360 });
    expect(JSON.stringify(parsed)).not.toContain('private-upstream-response');
  });
  it('records a missing USD reader as unavailable without introducing a fallback source', async () => {
    const archive = await archivePath();
    await collectPair(archive, fees(), { ...fakeCaptureOptions(), profile: 'study-30m' });
    const parsed = await readPairArchive(archive);
    expect(parsed.samples.every(sample => sample.usdIndex?.available === false)).toBe(true);
    expect(parsed.samples.every(sample => sample.books.mexc.available && sample.books.okx.available)).toBe(true);
  });
  it('retains missed schedule slots and makes no catch-up book or proxy requests', async () => {
    const archive = await archivePath(), run = studyOptions();
    let sleeps = 0;
    const options = { ...run.options, sleep: async (ms: number) => {
      await run.options.sleep(ms + (sleeps++ === 0 ? PAIR_STUDY_PLAN.intervalMs : 0));
    } };
    await collectPair(archive, fees(), options);
    const parsed = await readPairArchive(archive), missed = parsed.samples[1];
    expect(missed.books.mexc).toEqual({ available: false, reason: 'missed-slot' });
    expect(missed.books.okx).toEqual({ available: false, reason: 'missed-slot' });
    expect(missed.usdIndex).toEqual({ available: false, reason: 'missed-slot' });
    expect(parsed.samples).toHaveLength(360);
    expect(run.calls).toEqual({ instrument: 2, book: 718, index: 359 });
  });
  it('leaves a failed partial archive at the deadline, refuses replay and refuses resume', async () => {
    const archive = await archivePath(), run = studyOptions();
    const options = { ...run.options, sleep: async (ms: number) => {
      await run.options.sleep(ms + PAIR_STUDY_PLAN.maxDurationMs);
    } };
    await expect(collectPair(archive, fees(), options)).rejects.toThrow('capture-failed');
    const state = JSON.parse(await readFile(join(archive, 'state.json'), 'utf8'));
    expect(state).toMatchObject({ status: 'failed', samples: 1 });
    expect(run.calls).toEqual({ instrument: 2, book: 2, index: 1 });
    await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
    await expect(collectPair(archive, fees(), studyOptions().options)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(archive, 'state.json'), 'utf8'))).toEqual(state);
  });
  it('refuses edited study schedules, relabelled policies, counts, fee assumptions and incomplete file sets', async () => {
    const archive = await archivePath();
    await collectPair(archive, fees(), studyOptions().options);
    const path = join(archive, 'manifest.json'), original = await readFile(path, 'utf8');
    for (const mutation of [
      (p: any) => { p.plan.samples = 60; },
      (p: any) => { p.plan.policy = PAIR_PLAN.policy; },
      (p: any) => { p.plan.intervalMs = 1_000; },
      (p: any) => { p.plan.feePolicy = 'continuously-refreshed'; },
      (p: any) => { p.plan.unrecognized = true; }
    ]) {
      const edited = JSON.parse(original); mutation(edited); await writeFile(path, JSON.stringify(edited));
      await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
      await writeFile(path, original);
    }
    const statePath = join(archive, 'state.json'), originalState = await readFile(statePath, 'utf8');
    const state = JSON.parse(originalState); state.samples = 60;
    await writeFile(statePath, JSON.stringify(state));
    await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
    await writeFile(statePath, originalState);
    await rm(join(archive, '359.json'));
    await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
  });
  it('refuses absent or impossible USD evidence and USD fields added to legacy archives', async () => {
    const archive = await archivePath();
    await collectPair(archive, fees(), studyOptions().options);
    const path = join(archive, '200.json'), original = await readFile(path, 'utf8');
    for (const mutation of [
      (p: any) => { delete p.usdIndex; },
      (p: any) => { p.usdIndex.value.requestedAt = p.startedAt - 1; },
      (p: any) => { p.usdIndex.value.receivedAt = p.checkedAt + 1; },
      (p: any) => { p.usdIndex.value.instrument = 'USDT-USD'; }
    ]) {
      const edited = JSON.parse(original); mutation(edited); await writeFile(path, JSON.stringify(edited));
      await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
      await writeFile(path, original);
    }
    const legacy = await archivePath(); await collectPair(legacy, fees(), fakeCaptureOptions());
    const legacyPath = join(legacy, '000.json'), sample = JSON.parse(await readFile(legacyPath, 'utf8'));
    sample.usdIndex = { available: false, reason: 'public-data-unavailable' };
    await writeFile(legacyPath, JSON.stringify(sample));
    await expect(readPairArchive(legacy)).rejects.toThrow('incomplete-or-invalid-pair-archive');
  });
  it('rejects stale initial fees and unknown runtime profiles before making requests or creating archives', async () => {
    const archive = await archivePath(), run = studyOptions();
    await expect(collectPair(archive, fees(T - 600_001), run.options)).rejects.toThrow('stale-fee-evidence');
    await expect(collectPair(archive, fees(), { ...run.options, profile: 'adaptive' as any })).rejects.toThrow('invalid-pair-profile');
    expect(run.calls).toEqual({ instrument: 0, book: 0, index: 0 });
    await expect(readdir(archive)).rejects.toThrow();
  });
  it('rechecks a timer that wakes one millisecond early before issuing any slot requests', async () => {
    const archive = await archivePath(), run = studyOptions();
    let scheduleSleeps = 0;
    await collectPair(archive, fees(), { ...run.options, sleep: async (ms: number) => {
      const early = scheduleSleeps++ === 0;
      await run.options.sleep(ms - (early ? 1 : 0));
    } });
    const parsed = await readPairArchive(archive);
    expect(parsed.scheduleViolations).toEqual([]);
    expect(scheduleSleeps).toBeGreaterThan(PAIR_STUDY_PLAN.samples - 1);
    expect(run.calls).toEqual({ instrument: 2, book: 720, index: 360 });
    for (const sample of parsed.samples) {
      const due = parsed.instruments.samplingStartedAt + sample.sequence * PAIR_STUDY_PLAN.intervalMs;
      expect(sample.startedAt).toBeGreaterThanOrEqual(due);
      for (const venue of ['mexc', 'okx'] as const) {
        const row = sample.books[venue];
        if (row.available) expect(row.value.requestedAt).toBeGreaterThanOrEqual(due);
      }
    }
  });
  it('bounds positive waits and retains failure evidence if an injected clock never advances', async () => {
    const archive = await archivePath(), run = studyOptions(), waits: number[] = [];
    await expect(collectPair(archive, fees(), { ...run.options, sleep: async ms => { waits.push(ms); } }))
      .rejects.toThrow('capture-failed');
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.length).toBeLessThanOrEqual(16);
    expect(waits.every(ms => Number.isInteger(ms) && ms >= 1 && ms <= PAIR_STUDY_PLAN.intervalMs)).toBe(true);
    expect(run.calls).toEqual({ instrument: 2, book: 2, index: 1 });
    expect(JSON.parse(await readFile(join(archive, 'state.json'), 'utf8'))).toMatchObject({ status: 'failed', samples: 1 });
  });
  it.each(['probe', 'study-30m'] as const)('keeps %s replay strict and retains early timestamps only with explicit diagnostic opt-in', async profile => {
    const archive = await archivePath(), run = studyOptions();
    await collectPair(archive, fees(), { ...run.options, profile });
    const strict = await readPairArchive(archive);
    const cleanDiagnostic = await readPairArchive(archive, { retainEarlySlotsForDiagnostics: true });
    expect(cleanDiagnostic.archiveHash).toBe(strict.archiveHash);
    expect(cleanDiagnostic.scheduleViolations).toEqual([]);
    const samplePath = join(archive, '050.json');
    const sample = JSON.parse(await readFile(samplePath, 'utf8'));
    sample.startedAt--; sample.checkedAt--;
    for (const venue of ['mexc', 'okx']) {
      const book = sample.books[venue].value;
      book.requestedAt--; book.receivedAt--;
      if (book.sourceAt !== null) book.sourceAt--;
    }
    if (sample.usdIndex?.available) {
      sample.usdIndex.value.requestedAt--; sample.usdIndex.value.receivedAt--; sample.usdIndex.value.sourceAt--;
    }
    await writeFile(samplePath, JSON.stringify(sample));
    const originalBytes = await readFile(samplePath);
    await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
    await expect(readPairArchive(archive, { retainEarlySlotsForDiagnostics: false })).rejects.toThrow('incomplete-or-invalid-pair-archive');
    const diagnostic = await readPairArchive(archive, { retainEarlySlotsForDiagnostics: true });
    expect(diagnostic.scheduleViolations).toEqual([{ sequence: 50, earlyByMs: 1 }]);
    expect(diagnostic.samples[50]).toEqual(sample);
    expect(await readFile(samplePath)).toEqual(originalBytes);
    expect(diagnostic.archiveHash).not.toBe(strict.archiveHash);
    const raw = {
      manifest: JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8')),
      instruments: JSON.parse(await readFile(join(archive, 'instruments.json'), 'utf8')),
      samples: await Promise.all(Array.from({ length: strict.manifest.plan.samples }, async (_, n) =>
        JSON.parse(await readFile(join(archive, String(n).padStart(3, '0') + '.json'), 'utf8')))),
      state: JSON.parse(await readFile(join(archive, 'state.json'), 'utf8'))
    };
    expect(diagnostic.archiveHash).toBe(createHash('sha256').update(canonical(raw)).digest('hex'));
    // Diagnostic mode relaxes only early scheduling, never identity or book chronology.
    for (const mutate of [
      (p: any) => { p.sequence = 49; },
      (p: any) => { p.books.mexc.value.requestedAt = p.startedAt - 1; },
      (p: any) => { p.books.okx.value.receivedAt = p.checkedAt + 1; }
    ]) {
      const altered = JSON.parse(originalBytes.toString('utf8')); mutate(altered);
      await writeFile(samplePath, JSON.stringify(altered));
      await expect(readPairArchive(archive, { retainEarlySlotsForDiagnostics: true }))
        .rejects.toThrow('incomplete-or-invalid-pair-archive');
      await writeFile(samplePath, originalBytes);
    }
  });

});
