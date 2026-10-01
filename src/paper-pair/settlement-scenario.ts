import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { newArchive, readArchiveFile, writeReplayFile } from '../market-exact/archive.js';
import { canonical } from '../paper-v2/ledger.js';
import { applySettlementEvent, createSettlementState, replaySettlementJournal, viewSettlementState } from './settlement.js';
import type { SettlementBalances, SettlementEvent, SettlementState } from './settlement.js';

const schema = z.object({ schema: z.literal(1), kind: z.literal('synthetic-settlement-scenario'),
  scenarioId: z.string().regex(/^[a-z0-9-]{1,80}$/), initialBalances: z.unknown(), events: z.array(z.unknown()).min(1).max(2000) }).strict();
export async function runSettlementScenario(input: string, output: string) {
  const scenario = schema.parse(await readArchiveFile(input));
  const opening = createSettlementState(scenario.initialBalances as SettlementBalances);
  const state = scenario.events.reduce<SettlementState>((s, e) => applySettlementEvent(s, e as SettlementEvent), opening);
  const result = viewSettlementState(state);
  if (canonical(result) !== canonical(viewSettlementState(replaySettlementJournal(state.initialBalances, state.journal)))) {
    throw new Error('settlement-replay-mismatch');
  }
  const report = { schema: 1, kind: 'synthetic-settlement-report', scenarioId: scenario.scenarioId,
    sourceSha256: createHash('sha256').update(canonical(scenario)).digest('hex'), deterministicReplay: true,
    marketOpportunityEvidence: false, exchangeAdmissionProven: false,
    assumptions: ['Synthetic initial balances and supplied fill facts; no exchange executions or observed market-profit evidence',
      'Gross quote budget and separate fee caps are internal accounting limits, not an assertion about exchange order parameters',
      'All fees are supplied final nonnegative amounts; no fee-rate inference, rounding, rebates or late fee corrections',
      'Cash deltas exclude valuation of BTC/MX and opening cost basis; they are not account profit'],
    initialBalances: state.initialBalances, journal: state.journal, result };
  await newArchive(output); await writeReplayFile(join(output, 'report.json'), report);
  return { scenarioId: report.scenarioId, sourceSha256: report.sourceSha256, deterministicReplay: true,
    executable: false, funding: 'synthetic', positions: result.positions.map(p => ({ pairId: p.pairId,
      settlement: p.settlement, residualBtc: p.residualBtc, cashDeltaUsdt: p.cashDeltaUsdt, feesByAsset: p.feesByAsset })), output };
}
