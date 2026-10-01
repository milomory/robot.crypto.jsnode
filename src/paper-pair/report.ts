import { join } from 'node:path';
import { newArchive, writeReplayFile, writeDayStudyReplayFile } from '../market-exact/archive.js';
import { canonical } from '../paper-v2/ledger.js';
import { PAIR_STUDY_PLAN, PAIR_DAY_PLAN, readPairArchive } from './capture.js';
import { quoteBook, quotePair, createPairState, applyPairEvent, replayPairJournal, viewPairState, PairPaperError } from './engine.js';
import type { PairBook, PairInstrument, PairEvent, PairMarketInput, PairBalances, PairState } from './engine.js';
import { assessUsdLimit, feeScenarios, sampledPersistence, selectedFeeScenario } from './study-analysis.js';
import type { PairBook as RawBook, PairInstrument as RawInstrument, PairVenue } from './public.js';

function units(text: string, places: number): bigint {
  const negative = text.startsWith('-'); const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  if (fraction.length > places) throw new Error('unsupported-report-precision');
  return (negative ? -1n : 1n) * (BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0')));
}
function text(value: bigint, places: number): string {
  const n = value < 0n ? -value : value, scale = 10n ** BigInt(places);
  const fraction = (n % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${n / scale}${fraction ? '.' + fraction : ''}`;
}
function book(raw: RawBook): PairBook {
  return { venue: raw.venue, symbol: raw.symbol, bids: raw.bids, asks: raw.asks,
    requestedAt: raw.requestedAt, receivedAt: raw.receivedAt, ...(raw.sourceAt === null ? {} : { sourceAt: raw.sourceAt }) };
}
function instrument(raw: RawInstrument): PairInstrument | null {
  if (raw.status !== 'supported' || raw.quantityStep === null) return null;
  return { venue: raw.venue, symbol: raw.symbol, fetchedAt: raw.receivedAt, trading: true,
    minQuantity: raw.minQuantity, quantityStep: raw.quantityStep,
    ...(raw.minNotionalUsdt === null ? {} : { minNotional: raw.minNotionalUsdt }), maxNotional: raw.maxNotionalUsdt };
}
export interface DirectionObservation {
  buyVenue: PairVenue; sellVenue: PairVenue; rawSpreadUsdt: string; netUsdt: string;
  buyCashUsdt: string; sellCashUsdt: string; feeUsdt: string; positiveNet: boolean;
  ruleStatus: 'accepted' | 'blocked'; ruleReasons: string[];
  feeScenarios?: ReturnType<typeof feeScenarios>; usdLimit?: ReturnType<typeof assessUsdLimit>;
  usdLimitScenario?: 'quote' | 'okx-received-base';
  usdLimits?: { quote: ReturnType<typeof assessUsdLimit>; okxReceivedBase: ReturnType<typeof assessUsdLimit> };
}
export interface PairReportOptions { scheduleDiagnostics?: boolean }
export async function reportPair(directory: string, options: PairReportOptions = {}) {
  const archive = await readPairArchive(directory, { retainEarlySlotsForDiagnostics: options.scheduleDiagnostics === true });
  const excludedEarlySlots = archive.scheduleViolations ?? [];
  const excludedSequences = new Set(excludedEarlySlots.map(row => row.sequence));
  const { manifest, instruments, samples } = archive;
  const { plan } = manifest;
  const dayStudy = plan.policy === PAIR_DAY_PLAN.policy;
  const study = plan.policy === PAIR_STUDY_PLAN.policy || dayStudy;
  let activeInstruments = instruments.instruments;
  let metadataSourceSequence = -1;
  const refreshes = [instruments.instruments, ...samples.flatMap(sample => sample.instrumentRefresh ? [sample.instrumentRefresh] : [])];
  const metadataComplete = refreshes.every(rows => rows.mexc.available && rows.okx.available);
  const selectedScenario = selectedFeeScenario(manifest.feeEvidence.paymentModes);
  const opening: PairBalances = { mexc: { usdt: plan.openingUsdtPerVenue, btc: plan.openingBtcPerVenue },
    okx: { usdt: plan.openingUsdtPerVenue, btc: plan.openingBtcPerVenue } };
  let state: PairState = createPairState(opening);
  const observations: { sequence: number; at: number; status: 'available' | 'unavailable'; reason?: string;
    receiptSkewMs?: number; metadataSourceSequence?: number; directions: DirectionObservation[]; paperDecision: string }[] = [];
  let validPairs = 0, positiveDirections = 0, ruleEligibleDirections = 0, paperPairs = 0;
  for (const sample of samples) {
    // A failed refresh replaces the previous evidence; never carry old rules forward.
    if (sample.instrumentRefresh) { activeInstruments = sample.instrumentRefresh; metadataSourceSequence = sample.sequence; }
    const row: typeof observations[number] = { sequence: sample.sequence, at: sample.checkedAt,
      status: 'unavailable', directions: [], paperDecision: 'missing-market-data',
      ...(dayStudy ? { metadataSourceSequence } : {}) };
    observations.push(row);
    if (excludedSequences.has(sample.sequence)) { row.reason = 'early-scheduled-slot'; row.paperDecision = 'excluded-protocol-timing'; continue; }
    if (!sample.books.mexc.available || !sample.books.okx.available) { row.reason = 'missing-book'; continue; }
    const books = { mexc: book(sample.books.mexc.value), okx: book(sample.books.okx.value) };
    row.receiptSkewMs = Math.abs(books.mexc.receivedAt - books.okx.receivedAt);
    if (row.receiptSkewMs > plan.maximumReceiptSkewMs) { row.reason = 'receipt-skew'; continue; }
    const candidates: { input: PairMarketInput; net: bigint; buyVenue: PairVenue }[] = [];
    try {
      for (const [buyVenue, sellVenue] of [['mexc', 'okx'], ['okx', 'mexc']] as const) {
        const buy = quoteBook(books[buyVenue], 'buy', plan.quantityBTC, manifest.costs[buyVenue], sample.checkedAt);
        const sell = quoteBook(books[sellVenue], 'sell', plan.quantityBTC, manifest.costs[sellVenue], sample.checkedAt);
        const net = units(sell.cashUsdt, 8) - units(buy.cashUsdt, 8);
        const ruleReasons: string[] = [];
        const limits: Partial<Record<PairVenue, PairInstrument>> = {};
        for (const venue of [buyVenue, sellVenue]) {
          const metadata = activeInstruments[venue];
          const normalized = metadata.available ? instrument(metadata.value) : null;
          if (dayStudy && metadata.available && (sample.checkedAt < metadata.value.receivedAt ||
              sample.checkedAt - metadata.value.receivedAt > 3_600_000)) ruleReasons.push(`${venue}:stale-instrument`);
          if (!normalized) ruleReasons.push(`${venue}:${metadata.available ? metadata.value.reason : 'missing-instrument'}`);
          else limits[venue] = normalized;
        }
        let input: PairMarketInput | undefined;
        if (ruleReasons.length === 0) {
          input = { buy: { book: books[buyVenue], instrument: limits[buyVenue]!, costs: manifest.costs[buyVenue] },
            sell: { book: books[sellVenue], instrument: limits[sellVenue]!, costs: manifest.costs[sellVenue] },
            quantity: plan.quantityBTC, now: sample.checkedAt };
          try { quotePair(input); } catch (error) { ruleReasons.push(error instanceof PairPaperError ? error.reason : 'rules-unavailable'); }
        }
        if (dayStudy) ruleReasons.push('frozen-fees-sensitivity-only');
        row.directions.push({ buyVenue, sellVenue, rawSpreadUsdt: text(units(sell.rawNotionalUsdt, 36) - units(buy.rawNotionalUsdt, 36), 36),
          netUsdt: text(net, 8), buyCashUsdt: buy.cashUsdt, sellCashUsdt: sell.cashUsdt,
          feeUsdt: text(units(sell.feeUsdt, 8) + units(buy.feeUsdt, 8), 8), positiveNet: net > 0n,
          ruleStatus: ruleReasons.length ? 'blocked' : 'accepted', ruleReasons });
        if (study) {
          const direction = row.directions.at(-1)!;
          direction.feeScenarios = feeScenarios({ buy: books[buyVenue], sell: books[sellVenue],
            quantity: plan.quantityBTC, costs: manifest.costs, now: sample.checkedAt });
          const index = sample.usdIndex?.available ? sample.usdIndex.value : null;
          const okxRule = activeInstruments.okx.available ? activeInstruments.okx.value : null;
          direction.usdLimits = {
            quote: assessUsdLimit(index, okxRule, plan.quantityBTC, sample.checkedAt),
            okxReceivedBase: assessUsdLimit(index, okxRule, direction.feeScenarios.okxReceivedBase.requiredBuyQuantityBtc, sample.checkedAt)
          };
          direction.usdLimitScenario = selectedScenario ?? 'okx-received-base';
          direction.usdLimit = direction.usdLimitScenario === 'quote' ? direction.usdLimits.quote : direction.usdLimits.okxReceivedBase;
          if (direction.usdLimit.status === 'within-model-cap') {
            const unresolved = ruleReasons.indexOf('okx:usd-limit-unconverted');
            if (unresolved !== -1) ruleReasons[unresolved] = 'okx:usd-admission-basis-unconfirmed';
          } else if (direction.usdLimit.status !== 'not-published') ruleReasons.push('okx:usd-model-limit-unavailable-or-exceeded');
          if (selectedScenario === null) ruleReasons.push('account-fee-asset-unconfirmed');
          else if (selectedScenario === 'okx-received-base' && buyVenue === 'okx') ruleReasons.push('base-fee-scenario-only');
          direction.ruleStatus = ruleReasons.length ? 'blocked' : 'accepted';
        }
        if (input && ruleReasons.length === 0 && net > 0n) candidates.push({ input, net, buyVenue });
      }
    } catch (error) {
      row.directions = []; row.reason = error instanceof PairPaperError ? error.reason : 'invalid-quote'; continue;
    }
    row.status = 'available'; validPairs++;
    positiveDirections += row.directions.filter(d => d.positiveNet).length;
    ruleEligibleDirections += row.directions.filter(d => d.ruleStatus === 'accepted').length;
    row.paperDecision = row.directions.some(d => d.positiveNet) ? 'rules-blocked' : 'non-positive-net';
    // Fixed deterministic policy: at most one complete pair per sample, best positive eligible direction.
    // Same-sample full fills are an optimistic simulation, never a claim of executable or atomic arbitrage.
    candidates.sort((a, b) => a.net > b.net ? -1 : a.net < b.net ? 1 : a.buyVenue.localeCompare(b.buyVenue));
    if (candidates.length) {
      const selected = candidates[0], pairId = `sample-${sample.sequence}`;
      const { now, ...market } = selected.input;
      const events: PairEvent[] = [
        { type: 'prepare', id: `${pairId}-prepare`, at: now, pairId, market },
        { type: 'leg', id: `${pairId}-buy`, at: now, pairId, side: 'buy', cumulativeQuantity: plan.quantityBTC, status: 'filled' },
        { type: 'leg', id: `${pairId}-sell`, at: now, pairId, side: 'sell', cumulativeQuantity: plan.quantityBTC, status: 'filled' }
      ];
      try {
        const next = events.reduce((s, event) => applyPairEvent(s, event), state);
        state = next; paperPairs++; row.paperDecision = 'paper-full-pair';
      } catch (error) { row.paperDecision = error instanceof PairPaperError ? error.reason : 'paper-refused'; }
    }
  }
  const indexedSamples = samples.filter(sample => {
    if (!sample.usdIndex?.available) return false;
    const index = sample.usdIndex.value;
    return index.receivedAt <= sample.checkedAt && sample.checkedAt - index.requestedAt <= 5_000 && sample.checkedAt - index.sourceAt <= 5_000;
  }).length;
  const scenarioRows = (kind: 'quote' | 'okxReceivedBase') => observations.flatMap(row => row.directions.flatMap(direction => {
    const value = direction.feeScenarios?.[kind];
    return value ? [{ sequence: row.sequence, at: row.at, buyVenue: direction.buyVenue, sellVenue: direction.sellVenue, netUsdt: value.netUsdt }] : [];
  }));
  const selectedRows = selectedScenario === null ? [] : scenarioRows(selectedScenario === 'quote' ? 'quote' : 'okxReceivedBase');
  const selectedNets = selectedRows.map(row => units(row.netUsdt, 18));
  const studyDetails = study ? {
    headlineFeeScenario: 'quote',
    selectedScenarioSummary: selectedScenario === null ? null : {
      directionalComparisons: selectedRows.length, positiveDirections: selectedNets.filter(n => n > 0n).length,
      netRangeUsdt: selectedNets.length ? { minimum: text(selectedNets.reduce((a, b) => a < b ? a : b), 18),
        maximum: text(selectedNets.reduce((a, b) => a > b ? a : b), 18) } : null
    },
    ...(dayStudy ? { feePolicy: 'initial-observed-fees-frozen-sensitivity-only',
      feeRatesContinuouslyVerified: false, maximumFeeEvidenceAgeMs: archive.state.endedAt - Math.min(
        manifest.feeEvidence.fees.mexc.requestedAt, manifest.feeEvidence.fees.okx.requestedAt),
      instrumentRefreshes: { scheduled: PAIR_DAY_PLAN.samples / PAIR_DAY_PLAN.metadataRefreshSlots,
        availableMexc: refreshes.filter(row => row.mexc.available).length,
        availableOkx: refreshes.filter(row => row.okx.available).length }, metadataComplete } : {}),
    policy: plan.policy, paymentModes: manifest.feeEvidence.paymentModes ?? null,
    selectedFeeScenario: selectedScenario, settingsFrozenAtStart: true,
    usdIndexCoverage: { available: indexedSamples, scheduled: plan.samples, complete: indexedSamples === plan.samples },
    usdAdmissionFormulaVerified: false, mexcOrderQuantityStepVerified: false,
    mexcMarketBuySemantics: 'quoteOrderQty-budget-not-fixed-BTC-fill',
    quoteScenario: sampledPersistence(scenarioRows('quote'), plan.samples),
    okxReceivedBaseScenario: sampledPersistence(scenarioRows('okxReceivedBase'), plan.samples),
    maximumReceiptSkewMs: Math.max(0, ...observations.map(row => row.receiptSkewMs ?? 0)),
    baseFeeDecimals: 8, baseFeeQuantumIsOrderStep: false,
    mxFeeValuationSupported: false, continuousOpportunityWindowProven: false
  } : undefined;
  const netValues = observations.flatMap(row => row.directions.map(d => units(d.netUsdt, 8)));
  const summary = viewPairState(state);
  const replay = viewPairState(replayPairJournal(opening, state.journal));
  if (canonical(summary) !== canonical(replay)) throw new Error('pair-journal-replay-mismatch');
  return { schema: 1, kind: 'paired-paper-report', executable: false, funding: 'synthetic',
    captureId: manifest.captureId, archiveHash: archive.archiveHash, period: {
      startedAt: instruments.samplingStartedAt, endedAt: archive.state.endedAt },
    plan: manifest.plan, costs: manifest.costs, feeEvidence: manifest.feeEvidence,
    coverage: { scheduledPairs: plan.samples, availablePairs: validPairs, unavailablePairs: plan.samples - validPairs,
      complete: validPairs === plan.samples && (!study || indexedSamples === plan.samples) && (!dayStudy || metadataComplete), sourceSynchronizationProven: false },
    counts: { directionalComparisons: netValues.length, positiveDirections, ruleEligibleDirections, paperPairs },
    netRangeUsdt: netValues.length ? { minimum: text(netValues.reduce((a, b) => a < b ? a : b), 8),
      maximum: text(netValues.reduce((a, b) => a > b ? a : b), 8) } : null,
    instrumentEvidence: instruments.instruments,
    assumptions: [study ? 'Quote and OKX received-base fee scenarios; selected mode only if observed at start' : 'USDT fee currency assumed; actual fee asset unknown',
      'MEXC tariff originates from JSON number, not preserved raw decimal fee',
      'Observed account tariffs may exclude promotions or discounts',
      'Independent synthetic opening balances; no transfers or shared inventory',
      'REST receipts are aligned only; MEXC source time is absent',
      'Same-snapshot full fills are optimistic; no queue, latency or execution probability model',
      'No profit/return/equity claim: opening BTC cost basis is not provided',
      dayStudy ? 'Twenty-four-hour sampling with frozen initial fees is a cost sensitivity study, not realized profit or execution evidence' :
      study ? 'Thirty-minute capture is sampled diagnostic evidence, not sustainable arbitrage evidence' : 'Five-minute capture is functional evidence, not sustainable arbitrage evidence'],
    ...(studyDetails ? { study: studyDetails } : {}),
    ...(options.scheduleDiagnostics ? { diagnostics: { mode: 'schedule-diagnostics', protocolConformant: excludedEarlySlots.length === 0,
      excludedEarlySlots, rawArchiveUnchanged: true } } : {}),
    opening, paper: summary, journal: state.journal, observations, deterministicReplay: true };
}
export async function writePairReport(directory: string, output: string, options: PairReportOptions = {}) {
  const report = await reportPair(directory, options);
  await newArchive(output);
  const write = report.plan.policy === PAIR_DAY_PLAN.policy ? writeDayStudyReplayFile : writeReplayFile;
  await write(join(output, 'report.json'), report);
  return { captureId: report.captureId, archiveHash: report.archiveHash, coverage: report.coverage, counts: report.counts,
    netRangeUsdt: report.netRangeUsdt, ...(report.diagnostics ? { diagnostics: report.diagnostics } : {}), output };
}
