import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical } from '../paper-v2/ledger.js';
import { PaperError } from '../paper-v2/exact.js';
import { runStudy } from '../paper-v2/study.js';
import { buildObservedScenario } from './replay.js';
import { newArchive, writeReplayFile, REPLAY_FILE_LIMIT } from './archive.js';

// Only complete, immutable archives enter a study. No network or wall-clock inputs.
export async function runObservedStudyTo(inputDirectory: string, outputDirectory: string) {
  const source = await buildObservedScenario(inputDirectory);
  const study = runStudy(source);
  // A scenario declaration alone is not proof of the complete fixed archive.
  // Only this adapter has checked the manifest, schedule, full files and terminal state.
  const eligibility = source.schema === 2 && source.marketData.policy === 'fixed-study-30m-v1'
    ? { eligible: true, reason: 'validated-complete-declared-archive' }
    : study.eligibility;
  const scenarioBytes = canonical(study.scenario) + '\n';
  const result = { ...study.result, provenance: { inputHash: study.result.inputHash,
    sourceFileSha256: createHash('sha256').update(scenarioBytes).digest('hex') } };
  const resultBytes = canonical(result) + '\n';
  const { scenario: _scenario, result: _result, ...summary } = study;
  const report = { ...summary, eligibility,
    source: source.schema === 2 ? source.marketData : undefined,
    resultSha256: createHash('sha256').update(resultBytes).digest('hex'),
    comparison: result.comparison,
    performance: { strategy: result.strategy.performance,
      cash: result.benchmarks.baseline.performance, buyAndHold: result.benchmarks.buyAndHold.performance },
    counts: result.strategy.counts, finalAccount: result.strategy.finalAccount };
  const artifacts = [['scenario.json', study.scenario], ['result.json', result], ['study.json', report]] as const;
  // Check all sizes before creating output; retain evidence if a later filesystem operation fails.
  for (const [, value] of artifacts) {
    if (Buffer.byteLength(canonical(value) + '\n') > REPLAY_FILE_LIMIT) throw new PaperError('study-artifact-too-large');
  }
  await newArchive(outputDirectory);
  for (const [name, value] of artifacts) await writeReplayFile(join(outputDirectory, name), value);
  return { scenarioId: result.scenarioId, runId: result.runId, eligibility,
    comparable: result.comparison.comparable };
}
