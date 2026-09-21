import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readScenario, runOffline } from '../src/paper-v2/io.js';
import { replayScenario } from '../src/paper-v2/replay.js';

const fixturePath = new URL('../fixtures/paper-v2/basic.json', import.meta.url).pathname;
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'crypto-paper-v2-test-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('isolated offline paper-v2 input and publication', () => {
  it('replays the fixture into byte-identical private artifacts with both hashes', async () => {
    const parent = await directory();
    const first = await runOffline(fixturePath, join(parent, 'first'));
    const second = await runOffline(fixturePath, join(parent, 'second'));
    const a = await readFile(first.resultPath);
    expect(await readFile(second.resultPath)).toEqual(a);
    const result = JSON.parse(a.toString('utf8'));
    expect(result.scenarioId).toBe('basic-bybit-btc-usdt');
    expect(first.scenarioId).toBe(result.scenarioId);
    expect(result.provenance).toEqual({
      inputHash: replayScenario(await readScenario(fixturePath)).inputHash,
      sourceFileSha256: createHash('sha256').update(await readFile(fixturePath)).digest('hex')
    });
    expect((await stat(first.resultPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(parent, 'first'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(parent, 'first'))).toEqual(['result.json']);
    expect(a.toString('utf8')).not.toContain(parent);
  });

  it('preserves previous output bytes on collision, including empty directories and symlinks', async () => {
    const parent = await directory();
    const output = join(parent, 'result');
    const first = await runOffline(fixturePath, output);
    const original = await readFile(first.resultPath);
    await expect(runOffline(fixturePath, output)).rejects.toThrow(/^cannot-create-paper-v2-result$/);
    expect(await readFile(first.resultPath)).toEqual(original);
    const empty = join(parent, 'empty');
    await mkdir(empty);
    await expect(runOffline(fixturePath, empty)).rejects.toThrow(/^cannot-create-paper-v2-result$/);
    expect(await readdir(empty)).toEqual([]);
    const alias = join(parent, 'alias');
    await symlink(output, alias);
    await expect(runOffline(fixturePath, alias)).rejects.toThrow(/^cannot-create-paper-v2-result$/);
    expect(await readFile(first.resultPath)).toEqual(original);
  });

  it('refuses missing or symlinked output parents without creating directories', async () => {
    const parent = await directory();
    await expect(runOffline(fixturePath, join(parent, 'missing', 'result'))).rejects.toThrow(/^cannot-create-paper-v2-result$/);
    await symlink(parent, join(parent, 'alias'));
    await expect(runOffline(fixturePath, join(parent, 'alias', 'result'))).rejects.toThrow(/^cannot-create-paper-v2-result$/);
    expect((await readdir(parent)).sort()).toEqual(['alias']);
  });

  it('bounds regular file reads and refuses symlinks, directories and malformed input with fixed errors', async () => {
    const parent = await directory();
    const input = join(parent, 'input.json');
    await symlink(fixturePath, input);
    await expect(readScenario(input)).rejects.toThrow(/^invalid-or-unreadable-paper-v2-input$/);
    await rm(input);
    await writeFile(input, 'PRIVATE_SENTINEL');
    await expect(readScenario(input)).rejects.toThrow(/^invalid-or-unreadable-paper-v2-input$/);
    await writeFile(input, ' '.repeat(2 * 1024 * 1024 + 1));
    await expect(readScenario(input)).rejects.toThrow(/^invalid-or-unreadable-paper-v2-input$/);
    await expect(readScenario(parent)).rejects.toThrow(/^invalid-or-unreadable-paper-v2-input$/);
    await expect(readScenario(join(parent, 'missing'))).rejects.toThrow(/^invalid-or-unreadable-paper-v2-input$/);
  });

  it('validates scenario content before creating any output and never echoes the rejected value', async () => {
    const parent = await directory();
    const input = join(parent, 'bad.json');
    const output = join(parent, 'result');
    await writeFile(input, JSON.stringify({ PRIVATE_SENTINEL: 'PRIVATE_SENTINEL' }));
    await expect(runOffline(input, output)).rejects.toThrow(/^invalid-paper-v2-scenario$/);
    expect(await readdir(parent)).toEqual(['bad.json']);
  });

  it('distinguishes source formatting from canonical scenario identity', async () => {
    const parent = await directory();
    const source = await readScenario(fixturePath);
    const input = join(parent, 'compact.json');
    await writeFile(input, JSON.stringify(source));
    const first = await runOffline(fixturePath, join(parent, 'pretty'));
    const second = await runOffline(input, join(parent, 'compact'));
    const a = JSON.parse(await readFile(first.resultPath, 'utf8'));
    const b = JSON.parse(await readFile(second.resultPath, 'utf8'));
    expect(a.provenance.inputHash).toBe(b.provenance.inputHash);
    expect(a.provenance.sourceFileSha256).not.toBe(b.provenance.sourceFileSha256);
    delete a.provenance;
    delete b.provenance;
    expect(a).toEqual(b);
  });

  it('keeps CLI errors fixed and requires exactly two arguments', async () => {
    const parent = await directory();
    const input = join(parent, 'PRIVATE_SENTINEL.json');
    await writeFile(input, 'PRIVATE_SENTINEL');
    const script = new URL('../src/scripts/paper-v2.ts', import.meta.url).pathname;
    const bad = spawnSync(process.execPath, ['--import=tsx', script, input, join(parent, 'output')], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr.trim()).toBe('paper-v2 replay failed');
    const extra = spawnSync(process.execPath, ['--import=tsx', script, input, join(parent, 'output'), 'PRIVATE_SENTINEL'], { encoding: 'utf8' });
    expect(extra.status).toBe(1);
    expect(extra.stdout).toBe('');
    expect(extra.stderr.trim()).toBe('usage: paper-v2 FIXTURE NEW_OUTPUT_DIR');
  });


  it('keeps the complete CLI import graph inside offline modules and explicit local utilities', async () => {
    const root = resolve(new URL('../', import.meta.url).pathname);
    const pending = [join(root, 'src/scripts/paper-v2.ts')];
    const visited = new Set<string>();
    const allowedExternal = new Set(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'zod']);
    while (pending.length) {
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      expect(path === join(root, 'src/scripts/paper-v2.ts') || path.startsWith(join(root, 'src/paper-v2') + '/')).toBe(true);
      const tree = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const dependencies: string[] = [];
      function visit(node: ts.Node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
          if (ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
        }
        // Computed module loading would bypass this allowlist: reject it entirely.
        if (ts.isCallExpression(node)) {
          expect(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')).toBe(false);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      for (const dependency of dependencies) {
        if (dependency.startsWith('.')) pending.push(resolve(dirname(path), dependency.replace(/\.js$/, '.ts')));
        else expect(allowedExternal.has(dependency)).toBe(true);
      }
    }
    expect(visited.size).toBeGreaterThanOrEqual(6);
  });

  it('does not call fetch while reading and replaying a complete fixture', async () => {
    const parent = await directory();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network-forbidden-in-offline-replay'));
    try {
      await runOffline(fixturePath, join(parent, 'offline'));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

});
