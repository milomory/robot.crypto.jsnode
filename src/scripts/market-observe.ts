import { hostname } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { createRun, collectSample, startRun, saveSample, readReport } from '../lab/observations.js';
import { PublicBookClient } from '../lab/public-books.js';

const [command, directory, ...args] = process.argv.slice(2);
try {
  if (!directory || !['collect', 'report'].includes(command)) throw new Error();
  if (command === 'report') {
    if (args.length) throw new Error();
    console.log(JSON.stringify(await readReport(directory), null, 2));
  } else {
    if (args.length > 6) throw new Error();
    const [symbol = 'BTC/USDT', quantity = '.0001', samples = '3', interval = '10000', fee = '10', slippage = '5'] = args;
    const run = createRun(hostname(), symbol, Number(quantity), Number(samples), Number(interval), Number(fee), Number(slippage));
    await startRun(directory, run);
    const client = new PublicBookClient();
    for (let i = 0; i < run.samples; i++) {
      const sample = await collectSample(run, i, client);
      await saveSample(directory, run, sample);
      console.error(`Saved observation ${i + 1}/${run.samples}`);
      if (i + 1 < run.samples) await setTimeout(run.intervalMs);
    }
    console.log(JSON.stringify(await readReport(directory), null, 2));
  }
} catch {
  // No arbitrary file contents, upstream bodies or exception strings in output.
  console.error('Observation command failed: check arguments, new writable directory, or run integrity.');
  console.error('Usage: lab:observe collect NEW_DIRECTORY [SYMBOL QUANTITY SAMPLES INTERVAL_MS FEE_BPS SLIPPAGE_BPS]');
  console.error('       lab:observe report DIRECTORY');
  process.exitCode = 1;
}
