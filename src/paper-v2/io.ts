import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonical } from './ledger.js';
import { replayScenario } from './replay.js';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

// Read once: both hashes and the replay refer to exactly these source bytes.
// O_NONBLOCK also prevents a named pipe from hanging before the regular-file check.
async function readInput(path: string): Promise<{ input: unknown; sha256: string }> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_INPUT_BYTES) throw new Error();
      bytes = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
    return { input: JSON.parse(bytes.toString('utf8')) as unknown,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    throw new Error('invalid-or-unreadable-paper-v2-input');
  }
}

export async function readScenario(path: string): Promise<unknown> {
  return (await readInput(path)).input;
}

export async function runOffline(inputPath: string, outputDir: string): Promise<{ scenarioId: string; resultPath: string }> {
  const source = await readInput(inputPath);
  let scenarioId: string;
  let bytes: string;
  try {
    const result = replayScenario(source.input);
    scenarioId = result.scenarioId;
    bytes = canonical({ ...result, provenance: {
      inputHash: result.inputHash, sourceFileSha256: source.sha256
    } }) + '\n';
  } catch {
    throw new Error('invalid-paper-v2-scenario');
  }

  try {
    // A new private directory is the unit of publication. Never reuse a previous
    // result, create missing parents, or remove evidence after a partial failure.
    const parent = await lstat(dirname(outputDir));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
    await mkdir(outputDir, { mode: 0o700 });
    const temporaryPath = join(outputDir, '.result-' + randomUUID() + '.tmp');
    const resultPath = join(outputDir, 'result.json');
    const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Exclusive hard-link publication is atomic like rename, but cannot replace
    // a file that appeared at the destination. The temp survives any failure.
    await link(temporaryPath, resultPath);
    await unlink(temporaryPath);
    const directory = await open(outputDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return { scenarioId, resultPath };
  } catch {
    throw new Error('cannot-create-paper-v2-result');
  }
}
