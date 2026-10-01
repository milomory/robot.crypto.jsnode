import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { AccountCredentialBundle } from '../src/accounts/credentials.js';
import { checkAccount } from '../src/accounts/check.js';
const key = { schema: 1, venue: 'bybit', environment: 'mainnet', region: 'global', apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' };
const now = 1_800_000_000_000;
const encode = (data: unknown) => JSON.stringify(data);

describe('protected secret consumer contract', () => {
  it('keeps secret material out of JSON and inspect views of bundles and readers', () => {
    for (const venue of ['bybit', 'okx', 'hitbtc', 'mexc']) {
      const bundle = AccountCredentialBundle.parse(encode({ ...key, venue, ...(venue === 'okx' ? { passphrase: 'PRIVATE_PASS' } : {}) }));
      expect(JSON.stringify(bundle)).toBe(encode({ venue, environment: 'mainnet', region: 'global' }));
      expect(inspect(bundle)).not.toContain('PRIVATE');
      expect(JSON.stringify(bundle.reader())).not.toContain('PRIVATE');
      expect(inspect(bundle.reader())).not.toContain('PRIVATE');
    }
  });
  it.each([
    { venue: 'binance' }, { environment: 'demo' }, { region: 'eea' }, { venue: 'okx' },
    { endpoint: 'https://attacker.invalid' }, { apiSecret: '' }, { apiKey: 'PRIVATE\nKEY' },
    { passphrase: 'PRIVATE' }, { schema: 2 },
  ])('fails unsupported/incomplete bundles with fixed errors before network: %j', delta => {
    expect(() => AccountCredentialBundle.parse(encode({ ...key, ...delta }))).toThrow(/^account-invalid-credential-bundle$/);
  });
  it('bounds input and redacts invalid JSON', () => {
    for (const value of ['PRIVATE_SECRET', 'x'.repeat(16 * 1024 + 1)]) {
      expect(() => AccountCredentialBundle.parse(value)).toThrow(/^account-invalid-credential-bundle$/);
    }
  });
  it('accepts a full-rights Bybit key but outputs only metadata and makes three GET reads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ retCode: 0, result: { apiKey: 'PRIVATE_ECHO', readOnly: 0,
        permissions: { Spot: ['SpotTrade'], Wallet: ['AccountTransfer', 'SubMemberTransfer', 'Withdraw'] } } }))
      .mockResolvedValueOnce(Response.json({ retCode: 0, result: { list: [{ accountType: 'UNIFIED', coin: [{
        coin: 'USDT', walletBalance: '12345.6789', equity: '12345.6789', usdValue: '12345.6789',
        locked: '0', borrowAmount: '0', accruedInterest: '0' }] }] } }))
      .mockResolvedValueOnce(Response.json({ retCode: 0, result: { category: 'spot', list: [{ symbol: 'BTCUSDT', makerFeeRate: '0.001', takerFeeRate: '0.001' }] } }));
    const report = await checkAccount(AccountCredentialBundle.parse(encode(key)), { fetch, clock: () => now });
    expect(report).toMatchObject({ authenticatedReadsVerified: true, accountAssets: 1, fundingAssets: null,
      effectiveOperations: ['account-reads'], tradingExecuted: false, transfersExecuted: false,
      permissions: { verified: true, observed: { readOnly: false, rights: { withdraw: true } } } });
    expect(encode(report)).not.toMatch(/PRIVATE|12345/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('keeps HitBTC permissions unverified and verifies exact public market before its fee GET', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json([{ currency: 'USDT', available: '10', reserved: '0' }]))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ type: 'spot', base_currency: 'BTC', quote_currency: 'USDT', status: 'working' }))
      .mockResolvedValueOnce(Response.json({ take_rate: '0.001', make_rate: '0.001' }));
    const report = await checkAccount(AccountCredentialBundle.parse(encode({ ...key, venue: 'hitbtc' })), { fetch, clock: () => now });
    expect(report).toMatchObject({ authenticatedReadsVerified: true, permissions: { verified: false }, accountAssets: 1, fundingAssets: 0 });
    expect(new Headers(fetch.mock.calls[2][1]?.headers).has('authorization')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('checks MEXC with two GETs while keeping key permissions and funding unverified', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ accountType: 'SPOT', canTrade: true, canWithdraw: true, canDeposit: true,
        updateTime: null, permissions: ['SPOT'], balances: [{ asset: 'USDT', free: '12345.67', locked: '0', available: '1' }] }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { makerCommission: 0, takerCommission: 0.0005 }, msg: 'PRIVATE_ECHO' }));
    const report = await checkAccount(AccountCredentialBundle.parse(encode({ ...key, venue: 'mexc' })), { fetch, clock: () => now });
    expect(report).toMatchObject({ venue: 'mexc', authenticatedReadsVerified: true,
      permissions: { verified: false, reason: 'permission-introspection-not-implemented' },
      accountAssets: 1, fundingAssets: null, feeReadVerified: true, effectiveOperations: ['account-reads'],
      tradingExecuted: false, transfersExecuted: false });
    expect(encode(report)).not.toMatch(/PRIVATE|12345|canWithdraw|signature/);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('does not produce a success report when any fee read fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ type: 'spot', base_currency: 'BTC', quote_currency: 'USD', status: 'working' }));
    await expect(checkAccount(AccountCredentialBundle.parse(encode({ ...key, venue: 'hitbtc' })), { fetch, clock: () => now })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects argv, malformed/oversized secret stdin without echo and without a valid credential request', () => {
    const script = resolve('src/scripts/account-check.ts');
    for (const [args, input] of [ [['PRIVATE_SECRET_ARG'], ''], [[], 'PRIVATE_SECRET_BODY'], [[], 'x'.repeat(16385)] ] as [string[], string][]) {
      const run = spawnSync(process.execPath, ['--import=tsx', script, ...args], { input, encoding: 'utf8', timeout: 5000 });
      expect(run.status).toBe(1); expect(run.stdout).toBe('');
      expect(run.stderr.trim()).toBe('Account credential check failed. No trading or transfer was attempted.');
    }
  });
  it('imports no application config, database, Auth, trading service or environment loader', async () => {
    const root = resolve('.'), pending = [resolve('src/scripts/account-check.ts')], seen = new Set<string>();
    const externals = new Set(['node:crypto', 'zod']);
    while (pending.length) {
      const path = pending.pop()!; if (seen.has(path)) continue; seen.add(path);
      expect(path === resolve('src/scripts/account-check.ts') || path.startsWith(resolve('src/accounts') + '/')).toBe(true);
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
        else expect(externals.has(dependency)).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
});
