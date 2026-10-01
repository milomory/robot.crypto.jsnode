import { mkdtemp, chmod, readFile, lstat, symlink, unlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parsePairInput, persistentFetch, loadCooldowns, writePrivateJson } from '../src/accounts/pair-runtime.js';
import { OkxAccountReader } from '../src/accounts/okx.js';
const pair = { schema: 1,
  mexc: { schema: 1, venue: 'mexc', environment: 'mainnet', region: 'global', apiKey: 'MEXC_PRIVATE_KEY', apiSecret: 'MEXC_PRIVATE_SECRET' },
  okx: { schema: 1, venue: 'okx', environment: 'mainnet', region: 'global', apiKey: 'OKX_PRIVATE_KEY', apiSecret: 'OKX_PRIVATE_SECRET', passphrase: 'PRIVATE inner phrase' } };
const now = 1_800_000_000_000;
describe('pair protected runtime', () => {
  it('accepts exact two-venue bundles and preserves internal passphrase spaces', async () => {
    const value = parsePairInput(Buffer.from(JSON.stringify(pair)));
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE/);
    expect(() => value.assertNoSecrets('safe report')).not.toThrow();
    expect(() => value.assertNoSecrets(JSON.stringify(pair))).toThrow('observer-output-rejected');
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: '0', data: [{ perm: 'read_only', acctLv: '1' }] }));
    const reader = value.okx.reader({ fetch: request, clock: () => now }) as OkxAccountReader;
    await reader.getKeyPermissions();
    expect(new Headers(request.mock.calls[0][1]?.headers).get('OK-ACCESS-PASSPHRASE')).toBe(pair.okx.passphrase);
  });
  it.each([' leading', 'trailing ', 'line\nfeed', ''])('rejects non-preservable passphrase before a request', passphrase => {
    expect(() => parsePairInput(Buffer.from(JSON.stringify({ ...pair, okx: { ...pair.okx, passphrase } })))).toThrow('observer-invalid-input');
  });
  it.each([{}, { ...pair, extra: 'SECRET' }, { ...pair, schema: 2 }, { ...pair, mexc: pair.okx }, { ...pair, okx: { ...pair.okx, environment: 'demo' } }])('rejects malformed pairs without values in errors', value => {
    expect(() => parsePairInput(Buffer.from(JSON.stringify(value)))).toThrow(/^observer-invalid-input$/);
  });
  it('bounds input bytes', () => { expect(() => parsePairInput(Buffer.alloc(40 * 1024 + 1))).toThrow(/^observer-invalid-input$/); });
  it('shares long Retry-After across process state reload and venues remain independent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crypto-pair-runtime-'));
    try {
      await chmod(directory, 0o700);
      const state = await loadCooldowns(directory);
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '7200' } }));
      const run = persistentFetch(state, () => writePrivateJson(directory, 'cooldowns.json', state), request, () => now);
      await run('https://api.mexc.com/api/v3/account', { method: 'GET' });
      const reloaded = await loadCooldowns(directory);
      expect(reloaded.mexc).toBe(now + 7_200_000);
      const second = persistentFetch(reloaded, async () => {}, request, () => now + 300_000);
      await expect(second('https://api.mexc.com/api/v3/depth', { method: 'GET' })).rejects.toThrow('account-rate-limited');
      await second('https://www.okx.com/api/v5/account/balance', { method: 'GET' });
      expect(request).toHaveBeenCalledTimes(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('honors HTTP-date Retry-After and refuses unknown origins or write verbs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 418, headers: { 'retry-after': new Date(now + 86_400_000).toUTCString() } }));
    const state = { schema: 1 as const, mexc: 0, okx: 0 }, save = vi.fn(async () => {});
    const run = persistentFetch(state, save, request, () => now);
    for (const [url, method] of [['https://example.com', 'GET'], ['https://api.mexc.com/api/v3/account', 'POST']]) {
      await expect(run(url, { method })).rejects.toThrow('account-unsupported-endpoint');
    }
    expect(request).not.toHaveBeenCalled();
    await run('https://www.okx.com/api/v5/account/balance', { method: 'GET' });
    expect(state.okx).toBe(now + 86_400_000); expect(save).toHaveBeenCalledOnce();
  });
  it('does not update backoff on a late aborted response', async () => {
    const controller = new AbortController(), state = { schema: 1 as const, mexc: 0, okx: 0 };
    const save = vi.fn(async () => {}), request = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort(); return new Response('', { status: 429, headers: { 'retry-after': '9999999' } });
    });
    await expect(persistentFetch(state, save, request, () => now)('https://api.mexc.com/api/v3/account', { method: 'GET', signal: controller.signal })).rejects.toThrow('account-timeout');
    expect(save).not.toHaveBeenCalled(); expect(state.mexc).toBe(0);
  });
  it('replaces latest report atomically with private permissions; rejects symlinks/unsafe state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crypto-pair-runtime-'));
    try {
      await chmod(directory, 0o700);
      await writePrivateJson(directory, 'current.json', { status: 'observed' });
      await writePrivateJson(directory, 'current.json', { status: 'blocked' });
      expect(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'))).toEqual({ status: 'blocked' });
      expect((await lstat(join(directory, 'current.json'))).mode & 0o777).toBe(0o600);
      await unlink(join(directory, 'current.json'));
      await symlink(join(directory, 'target'), join(directory, 'current.json'));
      await expect(writePrivateJson(directory, 'current.json', {})).rejects.toThrow();
      await writeFile(join(directory, 'cooldowns.json'), '{"schema":1,"mexc":-1,"okx":0}', { mode: 0o600 });
      await expect(loadCooldowns(directory)).rejects.toThrow('observer-invalid-cooldowns');
      await chmod(directory, 0o755);
      await expect(loadCooldowns(directory)).rejects.toThrow('observer-private-directory-required');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
