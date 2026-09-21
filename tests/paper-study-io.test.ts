import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectExact } from '../src/market-exact/collect.js';
import { PLAN, STUDY_PLAN, type ExactPlan } from '../src/market-exact/archive.js';
import type { RawBook, RawInstrument } from '../src/market-exact/bybit.js';
import { runObservedStudyTo } from '../src/market-exact/study.js';
import { runOffline } from '../src/paper-v2/io.js';

const roots: string[] = [];
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network-forbidden')); });
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function captured(plan: ExactPlan = STUDY_PLAN, depth = 1) {
  const root = await mkdtemp(join(tmpdir(), 'crypto-study-io-')); roots.push(root);
  let now = 5_000_000, sequence = 0;
  await collectExact(join(root, 'archive'), new AbortController().signal, {
    host: 'offline-fixture', clock: () => now, sleep: async ms => { now += ms; },
    client: {
      getInstrument: async (): Promise<RawInstrument> => { const requestedAt = now; now += 20; return {
        venue: 'bybit', symbol: 'BTC/USDT', requestedAt, receivedAt: now, status: 'Trading',
        basePrecision: '0.000001', quotePrecision: '0.00000001', minOrderAmt: '5', maxMarketOrderQty: '100', tickSize: '0.01' }; },
      getBook: async (): Promise<RawBook> => { const requestedAt = now; now += 20; const price = 100000 + sequence++ * 200; return {
        venue: 'bybit', symbol: 'BTC/USDT', requestedAt, receivedAt: now, systemAt: now - 2, matchingAt: now - 3,
        bids: Array.from({ length: depth }, (_, i) => [`${price-i}.12345678`, '1.12345678']),
        asks: Array.from({ length: depth }, (_, i) => [`${price+1+i}.12345678`, '1.12345678']) }; }
    }
  }, plan);
  return { root, archive: join(root, 'archive') };
}
async function hashFiles(directory: string) {
  return Promise.all((await readdir(directory)).sort().map(async name => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')]));
}

describe('complete observed study publication', () => {
  it('handles 60 full-depth books beyond the raw-file cap and reproduces standalone result bytes', async () => {
    const { root, archive } = await captured(STUDY_PLAN, 50);
    const before = await hashFiles(archive);
    const out = join(root, 'study');
    const result = await runObservedStudyTo(archive, out);
    expect(result.eligibility.eligible).toBe(true);
    expect(result.comparable).toBe(true);
    const scenario = join(out, 'scenario.json');
    expect((await stat(scenario)).size).toBeGreaterThan(128 * 1024);
    expect((await stat(scenario)).size).toBeLessThan(2 * 1024 * 1024);
    await runOffline(scenario, join(root, 'standalone'));
    const bytes = await readFile(join(out, 'result.json'));
    expect(await readFile(join(root, 'standalone/result.json'))).toEqual(bytes);
    await runObservedStudyTo(archive, join(root, 'again'));
    for (const name of ['scenario.json', 'result.json', 'study.json']) {
      expect(await readFile(join(root, 'again', name))).toEqual(await readFile(join(out, name)));
      expect((await stat(join(out, name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(out)).mode & 0o777).toBe(0o700);
    const report = JSON.parse(await readFile(join(out, 'study.json'), 'utf8'));
    expect(report.resultSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(report.decisions).toHaveLength(60);
    expect(report.performance.strategy.expectedPoints).toBe(61);
    expect(report.finalAccount.reconciled).toBe(true);
    expect(await hashFiles(archive)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('labels a six-sample replay as a smoke check and preserves all snapshots', async () => {
    const { root, archive } = await captured(PLAN);
    const result = await runObservedStudyTo(archive, join(root, 'study'));
    expect(result.eligibility.eligible).toBe(false);
    const report = JSON.parse(await readFile(join(root, 'study/study.json'), 'utf8'));
    expect(report.decisions).toHaveLength(6);
    expect(report.counts).toEqual({ filled: 0, rejected: 0, marked: 6 });
  });

  it('preserves all output on collisions and refuses symlinked parents', async () => {
    const { root, archive } = await captured(PLAN);
    const output = join(root, 'study');
    await runObservedStudyTo(archive, output);
    const before = await hashFiles(output);
    await expect(runObservedStudyTo(archive, output)).rejects.toThrow();
    expect(await hashFiles(output)).toEqual(before);
    await mkdir(join(root, 'empty'));
    await expect(runObservedStudyTo(archive, join(root, 'empty'))).rejects.toThrow();
    expect(await readdir(join(root, 'empty'))).toEqual([]);
    await symlink(root, join(root, 'alias'));
    await expect(runObservedStudyTo(archive, join(root, 'alias/new'))).rejects.toThrow();
    expect(await readdir(root)).not.toContain('new');
  });

  it('refuses incomplete archives before creating output', async () => {
    const { root, archive } = await captured();
    await rm(join(archive, '059.json'));
    await expect(runObservedStudyTo(archive, join(root, 'study'))).rejects.toThrow();
    expect(await readdir(root)).toEqual(['archive']);
  });

  it('keeps CLI errors fixed and requires two arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crypto-study-cli-')); roots.push(root);
    const script = resolve('src/scripts/paper-study.ts');
    const failed = spawnSync(process.execPath, ['--import=tsx', script, join(root, 'PRIVATE_SENTINEL'), join(root, 'out')], { encoding: 'utf8' });
    expect(failed.status).toBe(1); expect(failed.stdout).toBe('');
    expect(failed.stderr.trim()).toBe('Paper study failed; inspect the preserved inputs and output. No automatic retry.');
    const extra = spawnSync(process.execPath, ['--import=tsx', script, 'a', 'b', 'PRIVATE_SENTINEL'], { encoding: 'utf8' });
    expect(extra.status).toBe(1); expect(extra.stdout).toBe('');
    expect(extra.stderr.trim()).toBe('usage: paper-study EXACT_ARCHIVE NEW_OUTPUT_DIR');
  });

  it('keeps its transitive modules outside production configuration, DB, Auth and trading', async () => {
    const root = resolve('.'), pending = [resolve('src/scripts/paper-study.ts')], visited = new Set<string>();
    const allowedExternal = new Set(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'zod']);
    while (pending.length) {
      const path = pending.pop()!; if (visited.has(path)) continue; visited.add(path);
      expect(path === join(root, 'src/scripts/paper-study.ts') || path.startsWith(join(root, 'src/paper-v2') + '/') ||
        /^.*\/src\/market-exact\/(archive|replay|study|bybit)\.ts$/.test(path)).toBe(true);
      const tree = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const dependencies: string[] = [];
      function visit(node: ts.Node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
          if (ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node)) expect(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')).toBe(false);
        ts.forEachChild(node, visit);
      }
      visit(tree);
      for (const dependency of dependencies) {
        if (dependency.startsWith('.')) pending.push(resolve(dirname(path), dependency.replace(/\.js$/, '.ts')));
        else expect(allowedExternal.has(dependency)).toBe(true);
      }
    }
    expect(visited.size).toBeGreaterThan(7);
  });
});
