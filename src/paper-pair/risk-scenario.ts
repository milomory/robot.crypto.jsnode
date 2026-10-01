/** Bounded offline synthetic scenarios; no exchange transport or account inputs. */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { newArchive, readArchiveFile, REPLAY_FILE_LIMIT, writeReplayFile } from '../market-exact/archive.js';
import { canonical } from '../paper-v2/ledger.js';
import { assessPaperPairRisk, paperRiskPolicySchema, replayPaperRiskJournal, viewPaperRiskState } from './risk.js';
import type { SettlementEvent } from './settlement.js';

const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const funds = z.object({ BTC: amount, USDT: amount, MX: amount }).strict();
const venue = z.enum(['mexc', 'okx']);
// Validate probe structure before assessment: malformed inputs must not become
// apparently meaningful blocked decisions. Economic rejection is a decision.
const prepare = z.object({ type: z.literal('prepare'), id, pairId: id,
  at: z.number().int().nonnegative().safe(),
  buy: z.object({ venue, orderId: id, feeCaps: funds, sizing: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('base'), baseQuantity: amount, maxQuoteAmount: amount }).strict(),
    z.object({ kind: z.literal('quote-budget'), quoteAmount: amount }).strict()
  ]) }).strict(),
  sell: z.object({ venue, orderId: id, baseQuantity: amount, feeCaps: funds }).strict()
}).strict();
const scenarioSchema = z.object({ schema: z.literal(1), kind: z.literal('synthetic-pair-risk-scenario'),
  scenarioId: id, initialBalances: z.object({ mexc: funds, okx: funds }).strict(),
  policy: paperRiskPolicySchema, events: z.array(z.unknown()).max(2000),
  probes: z.array(prepare).max(20)
}).strict();

async function checkedPath(path: string, output: boolean): Promise<string> {
  if (path.split(sep).includes('..')) throw new Error('invalid-scenario-path');
  const absolute = resolve(path), existing = output ? dirname(absolute) : absolute;
  // readArchiveFile also refuses a symlink at the input leaf. This check rejects
  // symlink ancestors; paths remain a local filesystem trust boundary.
  if (await realpath(existing) !== existing) throw new Error('invalid-scenario-path');
  return absolute;
}

export async function runPaperRiskScenario(input: string, output: string) {
  const inputPath = await checkedPath(input, false), outputPath = await checkedPath(output, true);
  const scenario = scenarioSchema.parse(await readArchiveFile(inputPath));
  // A fixed policy must admit every historical preparation, not just the last
  // candidate. Any invalid history aborts before an output directory is created.
  const state = replayPaperRiskJournal(scenario.initialBalances, scenario.policy, scenario.events as SettlementEvent[]);
  const risk = viewPaperRiskState(state);
  const probes = scenario.probes.map(probe => ({ id: probe.id, pairId: probe.pairId,
    decision: assessPaperPairRisk(state, probe) }));
  // Candidate decisions do not change the supplied session.
  if (canonical(viewPaperRiskState(state)) !== canonical(risk)) throw new Error('risk-probe-mutated-state');
  const report = { schema: 1, kind: 'synthetic-pair-risk-report', executable: false, funding: 'synthetic',
    scenarioId: scenario.scenarioId,
    inputHashSha256: createHash('sha256').update(canonical(scenario)).digest('hex'), risk, probes };
  const bytes = canonical(report) + '\n';
  if (Buffer.byteLength(bytes) > REPLAY_FILE_LIMIT) throw new Error('risk-report-too-large');
  await newArchive(outputPath);
  await writeReplayFile(join(outputPath, 'report.json'), report);
  const allowedCount = probes.filter(probe => probe.decision.paperAllowed).length;
  return { schema: 1, kind: 'synthetic-pair-risk-summary', executable: false, funding: 'synthetic',
    eventCount: scenario.events.length, probeCount: probes.length, allowedCount, blockedCount: probes.length - allowedCount,
    reportHash: createHash('sha256').update(bytes).digest('hex') };
}
