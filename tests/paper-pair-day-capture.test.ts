import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPair, PAIR_DAY_PLAN, PAIR_PLAN, PAIR_STUDY_PLAN, readPairArchive } from '../src/paper-pair/capture.js';
import { fakeCaptureOptions, fees } from './helpers/pair-fixtures.js';

const roots: string[] = [];
async function archivePath() {
  const root = await mkdtemp(join(tmpdir(), 'pair-day-test-')); roots.push(root);
  return join(root, 'archive');
}
function dayOptions(failedRefresh = -1) {
  const base = fakeCaptureOptions();
  const calls = { instrument: 0, book: 0, index: 0 };
  const requests: { kind: string; at: number }[] = [];
  return { calls, requests, options: { ...base, profile: 'study-24h' as const, client: {
    getInstrument: async (...args: Parameters<typeof base.client.getInstrument>) => {
      const round = Math.floor(calls.instrument++ / 2);
      requests.push({ kind: 'instrument', at: base.clock() });
      const result = await base.client.getInstrument(...args);
      if (round === failedRefresh && args[0] === 'okx') throw new Error('private-upstream-response');
      return result;
    },
    getBook: async (...args: Parameters<typeof base.client.getBook>) => {
      calls.book++; requests.push({ kind: 'book', at: base.clock() });
      return base.client.getBook(...args);
    },
    getUsdIndex: async () => {
      calls.index++; requests.push({ kind: 'index', at: base.clock() });
      const requestedAt = base.clock(); await base.sleep(1);
      return { venue: 'okx' as const, instrument: 'BTC-USD' as const,
        requestedAt, receivedAt: base.clock(), sourceAt: requestedAt, usdPerBtc: '50000' };
    }
  } } };
}

describe('separate bounded 24-hour public pair protocol', () => {
  let archive: string;
  let run: ReturnType<typeof dayOptions>;
  beforeAll(async () => {
    archive = await archivePath(); run = dayOptions(2);
    await collectPair(archive, fees(), run.options);
  }, 30_000);
  afterAll(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it('preserves all1440 scheduled slots, bounded calls, USD observations and exact refresh locations', async () => {
    const parsed = await readPairArchive(archive);
    expect(parsed.manifest.plan).toEqual(PAIR_DAY_PLAN);
    expect(parsed.samples).toHaveLength(1_440);
    expect(parsed.samples[1_439].startedAt - parsed.samples[0].startedAt).toBe(86_340_000);
    expect(parsed.state.endedAt - parsed.manifest.startedAt).toBeLessThan(PAIR_DAY_PLAN.maxDurationMs);
    expect(parsed.manifest.feeEvidence).toEqual(fees());
    expect(run.calls).toEqual({ instrument: 96, book: 2_880, index: 1_440 });
    expect(Object.values(run.calls).reduce((sum, count) => sum + count, 0)).toBe(PAIR_DAY_PLAN.maxPublicRequests);
    expect(parsed.samples.filter(sample => sample.instrumentRefresh).map(sample => sample.sequence))
      .toEqual(Array.from({ length: 47 }, (_, index) => (index + 1) * 30));
    for (const sample of parsed.samples) {
      expect(sample.usdIndex?.available).toBe(true);
      if (!sample.instrumentRefresh) continue;
      for (const venue of ['mexc', 'okx'] as const) {
        const refresh = sample.instrumentRefresh[venue];
        if (!refresh.available) continue;
        expect(refresh.value.requestedAt).toBeGreaterThanOrEqual(sample.startedAt);
        for (const bookVenue of ['mexc', 'okx'] as const) {
          const book = sample.books[bookVenue];
          if (book.available) expect(refresh.value.receivedAt).toBeLessThanOrEqual(book.value.requestedAt);
        }
      }
    }
    expect(parsed.samples[60].instrumentRefresh?.okx).toEqual({ available: false, reason: 'public-data-unavailable' });
    expect(parsed.samples[90].instrumentRefresh?.okx.available).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('private-upstream-response');
    const names = await readdir(archive);
    expect(names).toHaveLength(1_443);
    expect(names).toContain('999.json'); expect(names).toContain('1000.json'); expect(names).toContain('1439.json');
    const sizes = await Promise.all(names.map(async name => (await stat(join(archive, name))).size));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PAIR_DAY_PLAN.maximumFileBytes);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(PAIR_DAY_PLAN.maximumArchiveBytes);
    // Exact file set plus individual bounds is already tighter than the aggregate cap.
    expect(names.length * PAIR_DAY_PLAN.maximumFileBytes).toBeLessThan(PAIR_DAY_PLAN.maximumArchiveBytes);
  });

  it('rejects missing, extra, stale, late, incorrect-venue and falsely missed refresh evidence', async () => {
    const path = join(archive, '030.json'), original = await readFile(path, 'utf8');
    for (const mutate of [
      (sample: any) => { delete sample.instrumentRefresh; },
      (sample: any) => { delete sample.instrumentRefresh.okx; },
      (sample: any) => { sample.instrumentRefresh.extra = sample.instrumentRefresh.mexc; },
      (sample: any) => { sample.instrumentRefresh.mexc = sample.instrumentRefresh.okx; },
      (sample: any) => { sample.instrumentRefresh.mexc.value.requestedAt = sample.startedAt - 1; },
      (sample: any) => { sample.instrumentRefresh.mexc.value.receivedAt = sample.checkedAt + 1; },
      (sample: any) => { sample.instrumentRefresh.mexc.value.receivedAt = sample.books.mexc.value.requestedAt + 1; },
      (sample: any) => { sample.instrumentRefresh.mexc = { available: false, reason: 'missed-slot' }; },
      (sample: any) => {
        sample.books.mexc = { available: false, reason: 'public-data-unavailable' };
        sample.books.okx = { available: false, reason: 'public-data-unavailable' };
        sample.usdIndex.value.requestedAt = sample.startedAt;
      }
    ]) {
      try {
        const sample = JSON.parse(original); mutate(sample); await writeFile(path, JSON.stringify(sample));
        await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
      } finally { await writeFile(path, original); }
    }
    for (const sequence of [0, 31, 1439]) {
      const otherPath = join(archive, String(sequence).padStart(3, '0') + '.json');
      const otherOriginal = await readFile(otherPath, 'utf8');
      try {
        const sample = JSON.parse(otherOriginal); sample.instrumentRefresh = JSON.parse(original).instrumentRefresh;
        await writeFile(otherPath, JSON.stringify(sample));
        await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
      } finally { await writeFile(otherPath, otherOriginal); }
    }
  }, 30_000);

  it('checks actual file bytes including whitespace, manifest and the 32KiB boundary', async () => {
    const baseline = (await readPairArchive(archive)).archiveHash;
    for (const name of ['manifest.json', 'instruments.json', 'state.json', '000.json']) {
      const path = join(archive, name), original = await readFile(path, 'utf8');
      try {
        const padded = original + ' '.repeat(PAIR_DAY_PLAN.maximumFileBytes - Buffer.byteLength(original));
        await writeFile(path, padded);
        expect((await readPairArchive(archive)).archiveHash).toBe(baseline);
        await writeFile(path, padded + ' ');
        await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
      } finally { await writeFile(path, original); }
    }
  }, 30_000);

  it('fails closed for changed day bounds, request budget, schedule, policy and incomplete file sets', async () => {
    const path = join(archive, 'manifest.json'), original = await readFile(path, 'utf8');
    for (const mutate of [
      (manifest: any) => { manifest.plan.maximumArchiveBytes++; },
      (manifest: any) => { manifest.plan.maximumFileBytes++; },
      (manifest: any) => { manifest.plan.maxPublicRequests++; },
      (manifest: any) => { manifest.plan.metadataRefreshSlots = 60; },
      (manifest: any) => { manifest.plan.intervalMs = 5_000; },
      (manifest: any) => { manifest.plan.samples = 1_439; },
      (manifest: any) => { manifest.plan.policy = PAIR_STUDY_PLAN.policy; }
    ]) {
      try {
        const manifest = JSON.parse(original); mutate(manifest); await writeFile(path, JSON.stringify(manifest));
        await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
      } finally { await writeFile(path, original); }
    }
    const extra = join(archive, '1440.json');
    try {
      await writeFile(extra, '{}');
      await expect(readPairArchive(archive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
    } finally { await rm(extra); }
  });

  it('records a missed refresh with no catch-up requests or replacement refresh and rejects relabelled misses', async () => {
    const missedArchive = await archivePath(), missedRun = dayOptions(); let sleeps = 0;
    await collectPair(missedArchive, fees(), { ...missedRun.options, sleep: async ms => {
      await missedRun.options.sleep(ms + (++sleeps === 30 ? PAIR_DAY_PLAN.intervalMs : 0));
    } });
    const parsed = await readPairArchive(missedArchive), sample = parsed.samples[30];
    const missed = { available: false, reason: 'missed-slot' };
    expect(sample.instrumentRefresh).toEqual({ mexc: missed, okx: missed });
    expect(sample.books).toEqual({ mexc: missed, okx: missed });
    expect(sample.usdIndex).toEqual(missed);
    expect(parsed.samples[31].instrumentRefresh).toBeUndefined();
    expect(parsed.samples[60].instrumentRefresh?.mexc.available).toBe(true);
    expect(missedRun.calls).toEqual({ instrument: 94, book: 2_878, index: 1_439 });
    const path = join(missedArchive, '030.json'), original = await readFile(path, 'utf8');
    for (const mutate of [
      (value: any) => { value.instrumentRefresh.mexc.reason = 'public-data-unavailable'; },
      (value: any) => { value.books.okx.reason = 'public-data-unavailable'; },
      (value: any) => { value.usdIndex.reason = 'public-data-unavailable'; }
    ]) {
      try {
        const value = JSON.parse(original); mutate(value); await writeFile(path, JSON.stringify(value));
        await expect(readPairArchive(missedArchive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
      } finally { await writeFile(path, original); }
    }
  }, 30_000);

  it('preserves failed evidence when a sample exceeds the fixed write cap, with no oversized file', async () => {
    const largeArchive = await archivePath(), largeRun = dayOptions();
    const getBook = largeRun.options.client.getBook;
    await expect(collectPair(largeArchive, fees(), { ...largeRun.options, client: {
      ...largeRun.options.client,
      getBook: async venue => ({ ...await getBook(venue), sequence: '1'.repeat(PAIR_DAY_PLAN.maximumFileBytes) })
    } })).rejects.toThrow('capture-failed');
    expect(largeRun.calls).toEqual({ instrument: 2, book: 2, index: 1 });
    expect(await readdir(largeArchive)).toEqual(expect.arrayContaining(['manifest.json', 'instruments.json', 'state.json']));
    expect(await readdir(largeArchive)).not.toContain('000.json');
    expect(JSON.parse(await readFile(join(largeArchive, 'state.json'), 'utf8'))).toMatchObject({ status: 'failed', samples: 0 });
    await expect(readPairArchive(largeArchive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
  });

  it.each(['probe', 'study-30m'] as const)('rejects refresh fields inserted into the unchanged %s profile', async profile => {
    const legacyArchive = await archivePath();
    await collectPair(legacyArchive, fees(), { ...dayOptions().options, profile });
    const parsed = await readPairArchive(legacyArchive);
    expect(parsed.manifest.plan).toEqual(profile === 'probe' ? PAIR_PLAN : PAIR_STUDY_PLAN);
    expect(parsed.samples.every(sample => sample.instrumentRefresh === undefined)).toBe(true);
    const path = join(legacyArchive, '030.json'), sample = JSON.parse(await readFile(path, 'utf8'));
    sample.instrumentRefresh = { mexc: { available: false, reason: 'public-data-unavailable' },
      okx: { available: false, reason: 'public-data-unavailable' } };
    await writeFile(path, JSON.stringify(sample));
    await expect(readPairArchive(legacyArchive)).rejects.toThrow('incomplete-or-invalid-pair-archive');
  }, 30_000);
});
