import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical, digest } from '../paper-v2/ledger.js';
import { scenarioSchema } from '../paper-v2/schema.js';
import { replayScenario } from '../paper-v2/replay.js';
import { PaperError } from '../paper-v2/exact.js';
import { newArchive, readCompleteArchive, writeArchiveFile } from './archive.js';
import { toPaperBook, toPaperInstrument } from './bybit.js';

export async function buildObservedScenario(directory: string) {
  const archive = await readCompleteArchive(directory);
  const { manifest, samples } = archive;
  const { plan } = manifest;
  const datasetHash = digest(archive);
  // Index-based intents were fixed in the manifest before any books arrived.
  // Preserve the full declared window; never select only successful samples.
  const steps = samples.map(sample => {
    if (!sample.available) throw new PaperError('incomplete-exact-series');
    return { id: `sample-${sample.sequence}`, at: sample.checkedAt, book: toPaperBook(sample.book),
      ...(sample.sequence === 0 ? { intent: { side: 'buy' as const, quantity: plan.buyQuantityBTC } } :
        sample.sequence === plan.sellSequence ? { intent: { side: 'sell' as const, quantity: plan.sellQuantityBTC } } : {}) };
  });
  const scenario = scenarioSchema.parse({ schema: 2, model: 'paper-v2-exact-1', funding: 'synthetic',
    scenarioId: `observed-${manifest.captureId}`, venue: manifest.venue, symbol: manifest.symbol,
    marketData: { kind: 'public-decimal-observations', schema: 1, captureId: manifest.captureId,
      datasetHash, policy: plan.policy },
    opening: { USDT: plan.openingUSDT, BTC: '0' },
    costs: { feeBps: plan.feeBps, slippageBps: plan.slippageBps, feeAsset: 'USDT' },
    instrument: toPaperInstrument(manifest.instrument),
    benchmark: { buyQuantityBTC: plan.buyQuantityBTC }, steps });
  return scenario;
}

export async function replayObservedTo(inputDirectory: string, outputDirectory: string) {
  const scenario = await buildObservedScenario(inputDirectory);
  const result = replayScenario(scenario);
  const sourceBytes = canonical(scenario) + '\n';
  const artifact = { ...result, provenance: { inputHash: result.inputHash,
    sourceFileSha256: createHash('sha256').update(sourceBytes).digest('hex') } };
  await newArchive(outputDirectory);
  await writeArchiveFile(join(outputDirectory, 'scenario.json'), scenario);
  await writeArchiveFile(join(outputDirectory, 'result.json'), artifact);
  return { scenarioId: result.scenarioId, runId: result.runId, comparable: result.comparison.comparable };
}
