import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPair, PAIR_STUDY_PLAN } from '../src/paper-pair/capture.js';
import { parsePairInstrument } from '../src/paper-pair/public.js';
import { reportPair } from '../src/paper-pair/report.js';
import type { PaymentModes } from '../src/paper-pair/study-analysis.js';
import { canonical } from '../src/paper-v2/ledger.js';
import { T, fakeCaptureOptions, fees, rawInstrument } from './helpers/pair-fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function study(modes: PaymentModes, missingIndex = -1, usdCap = '1000000') {
  const root = await mkdtemp(join(tmpdir(), 'pair-study-report-test-'));
  roots.push(root);
  const directory = join(root, 'archive'), base = fakeCaptureOptions();
  let indexSequence = 0;
  await collectPair(directory, { ...fees(), paymentModes: modes }, {
    ...base, profile: 'study-30m', client: {
      ...base.client,
      getInstrument: async venue => {
        const original = await base.client.getInstrument(venue);
        if (venue === 'mexc') return original;
        const raw = rawInstrument('okx'); raw.data[0].maxMktAmt = usdCap;
        return parsePairInstrument('okx', raw, original.requestedAt, original.receivedAt);
      },
      getUsdIndex: async () => {
        const sequence = indexSequence++, requestedAt = base.clock();
        await base.sleep(1);
        if (sequence === missingIndex) throw new Error('PRIVATE_INDEX_RESPONSE');
        return { venue: 'okx', instrument: 'BTC-USD', requestedAt, receivedAt: base.clock(),
          sourceAt: requestedAt, usdPerBtc: '50000.000000000000000001' };
      }
    }
  });
  return { directory, report: await reportPair(directory) };
}
function assertNoAdmissionOrTrades(report: Awaited<ReturnType<typeof reportPair>>) {
  expect(report).toMatchObject({ executable: false, funding: 'synthetic', deterministicReplay: true,
    counts: { directionalComparisons: 720, positiveDirections: 360, ruleEligibleDirections: 0, paperPairs: 0 },
    coverage: { sourceSynchronizationProven: false },
    study: { headlineFeeScenario: 'quote', usdAdmissionFormulaVerified: false, mexcOrderQuantityStepVerified: false,
      mxFeeValuationSupported: false, continuousOpportunityWindowProven: false,
      baseFeeQuantumIsOrderStep: false, settingsFrozenAtStart: true } });
  expect(report.paper.balances).toEqual(report.opening);
  expect(report.journal).toEqual([]);
  expect(report.observations).toHaveLength(PAIR_STUDY_PLAN.samples);
  for (const observation of report.observations) {
    expect(observation.paperDecision).toBe('rules-blocked');
    expect(observation.directions).toHaveLength(2);
    for (const direction of observation.directions) {
      expect(direction.ruleStatus).toBe('blocked');
      expect(direction.ruleReasons).toContain('mexc:quantity-step-unconfirmed');
      expect(direction.usdLimit?.exchangeAdmissionProven).toBe(false);
    }
  }
}

describe('paired study report evidence and admission boundaries', () => {
  it('reports actual obtained-asset mode, BTC fee inventory effect and USD proxy without inventing readiness', async () => {
    const modes: PaymentModes = { observedAt: T, mexcMxDeduct: false, okxFeeType: '0' };
    const { directory, report } = await study(modes);
    assertNoAdmissionOrTrades(report);
    expect(report.coverage.complete).toBe(true);
    expect(report.feeEvidence.paymentModes).toEqual(modes);
    expect(report.study).toMatchObject({ paymentModes: modes, selectedFeeScenario: 'okx-received-base',
      usdIndexCoverage: { available: 360, scheduled: 360, complete: true } });
    const buyOkx = report.observations[0].directions.find(row => row.buyVenue === 'okx')!;
    // 10 bps on an equal gross purchase costs 10 satoshis; acquiring the target net needs
    // 10,011 satoshis gross and an upward-rounded fee of 11 satoshis in this paper model.
    expect(buyOkx.feeScenarios?.quote).toMatchObject({ requiredBuyQuantityBtc: '0.0001', residualBtc: '0' });
    expect(buyOkx.feeScenarios?.okxReceivedBase).toMatchObject({ requiredBuyQuantityBtc: '0.00010011',
      receivedBtc: '0.0001', residualBtc: '0', buyFeeBtc: '0.00000011', equalGrossResidualBtc: '-0.0000001' });
    expect(buyOkx.usdLimit).toMatchObject({ basis: 'okx-btc-usd-index-proxy-1pct-buffer',
      quantityBtc: '0.00010011', maximumUsd: '1000000', bufferBps: '100',
      bufferedNotionalUsd: '5.055555000000000001', status: 'within-model-cap' });
    expect(buyOkx.usdLimitScenario).toBe('okx-received-base');
    expect(buyOkx.usdLimit).toEqual(buyOkx.usdLimits?.okxReceivedBase);
    expect(report.study?.selectedScenarioSummary).toEqual({ directionalComparisons: 720, positiveDirections: 360,
      netRangeUsdt: { minimum: buyOkx.feeScenarios!.okxReceivedBase.netUsdt, maximum: report.netRangeUsdt!.maximum } });
    expect(report.study?.selectedScenarioSummary?.netRangeUsdt?.minimum).not.toBe(report.netRangeUsdt!.minimum);
    expect(buyOkx.ruleReasons).toEqual(expect.arrayContaining([
      'okx:usd-admission-basis-unconfirmed', 'base-fee-scenario-only'
    ]));
    expect(report.study?.quoteScenario.find(row => row.buyVenue === 'mexc')).toMatchObject({
      positiveSamples: 360, longestConsecutivePositiveSamples: 360,
      longestSampledSpanMs: 1_795_000, continuousWindowProven: false
    });
    expect(canonical(await reportPair(directory))).toBe(canonical(report));
  });

  it('selects observed quote fee mode while retaining both sensitivities and unresolved market-rule blockers', async () => {
    const modes: PaymentModes = { observedAt: T, mexcMxDeduct: false, okxFeeType: '1' };
    const { report } = await study(modes, -1, '5.053');
    assertNoAdmissionOrTrades(report);
    expect(report.study).toMatchObject({ paymentModes: modes, selectedFeeScenario: 'quote' });
    expect(report.study?.selectedScenarioSummary).toEqual({ directionalComparisons: 720, positiveDirections: 360,
      netRangeUsdt: report.netRangeUsdt });
    const buyOkx = report.observations[0].directions.find(row => row.buyVenue === 'okx')!;
    // The quote-mode order is within this independent USD cap; grossing up BTC fees
    // exceeds it. Selecting the wrong scenario must not hide the distinction.
    expect(buyOkx.usdLimits?.quote).toMatchObject({ quantityBtc: '0.0001', status: 'within-model-cap',
      bufferedNotionalUsd: '5.050000000000000001', maximumUsd: '5.053' });
    expect(buyOkx.usdLimits?.okxReceivedBase).toMatchObject({ quantityBtc: '0.00010011', status: 'above-model-cap',
      bufferedNotionalUsd: '5.055555000000000001', maximumUsd: '5.053' });
    expect(buyOkx.usdLimitScenario).toBe('quote');
    expect(buyOkx.usdLimit).toEqual(buyOkx.usdLimits?.quote);
    for (const observation of report.observations) {
      for (const direction of observation.directions) {
        expect(direction.feeScenarios?.quote).toBeDefined();
        expect(direction.feeScenarios?.okxReceivedBase).toBeDefined();
        expect(direction.ruleReasons).toContain('okx:usd-admission-basis-unconfirmed');
        expect(direction.ruleReasons).not.toContain('base-fee-scenario-only');
        expect(direction.ruleReasons).not.toContain('account-fee-asset-unconfirmed');
      }
    }
  });

  it('keeps unsupported MX fee mode unknown and missing USD data visible despite complete positive book comparisons', async () => {
    const modes: PaymentModes = { observedAt: T, mexcMxDeduct: true, okxFeeType: '1' };
    const { report } = await study(modes, 17);
    assertNoAdmissionOrTrades(report);
    expect(report.coverage).toMatchObject({ scheduledPairs: 360, availablePairs: 360, unavailablePairs: 0, complete: false });
    expect(report.study).toMatchObject({ paymentModes: modes, selectedFeeScenario: null, selectedScenarioSummary: null,
      usdIndexCoverage: { available: 359, scheduled: 360, complete: false } });
    for (const observation of report.observations) {
      for (const direction of observation.directions) {
        expect(direction.ruleReasons).toContain('account-fee-asset-unconfirmed');
        expect(direction.usdLimitScenario).toBe('okx-received-base');
        expect(direction.usdLimit).toEqual(direction.usdLimits?.okxReceivedBase);
      }
    }
    const missing = report.observations[17];
    expect(missing.status).toBe('available');
    for (const direction of missing.directions) {
      expect(direction.usdLimit).toMatchObject({ status: 'unavailable', reason: 'missing-stale-or-invalid-index' });
      expect(direction.ruleReasons).toContain('okx:usd-model-limit-unavailable-or-exceeded');
    }
    expect(canonical(report)).not.toContain('PRIVATE_INDEX_RESPONSE');
  });
});


it('requires explicit diagnostics and excludes early scheduled slots without changing the archived evidence', async () => {
  const { directory } = await study({ observedAt: T, mexcMxDeduct: false, okxFeeType: '0' });
  const path = join(directory, '050.json');
  const sample = JSON.parse(await readFile(path, 'utf8')); sample.startedAt -= 1;
  const raw = JSON.stringify(sample); await writeFile(path, raw);
  await expect(reportPair(directory)).rejects.toThrow('incomplete-or-invalid-pair-archive');
  const report = await reportPair(directory, { scheduleDiagnostics: true });
  expect(report.diagnostics).toEqual({ mode: 'schedule-diagnostics', protocolConformant: false,
    excludedEarlySlots: [{ sequence: 50, earlyByMs: 1 }], rawArchiveUnchanged: true });
  expect(report.coverage).toMatchObject({ scheduledPairs: 360, availablePairs: 359, unavailablePairs: 1, complete: false });
  expect(report.counts.directionalComparisons).toBe(718);
  expect(report.study?.selectedScenarioSummary?.directionalComparisons).toBe(718);
  expect(report.observations[50]).toMatchObject({ status: 'unavailable', reason: 'early-scheduled-slot',
    paperDecision: 'excluded-protocol-timing', directions: [] });
  expect(report.study?.quoteScenario[0].longestConsecutivePositiveSamples).toBe(309);
  expect(await readFile(path, 'utf8')).toBe(raw);
});
