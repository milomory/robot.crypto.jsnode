import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BalanceHistory } from '../src/accounts/balance-history-contract.js';
import { registerBalanceHistoryRoutes } from '../src/http/balance-history-routes.js';

const now = 1_800_000_000_000;
const day = 24 * 60 * 60_000;
const path = '/api/accounts/balance-history';
const directories: string[] = [];
function history(): BalanceHistory {
  const times = [now - 30 * day, now - 7 * day - 1, now - 7 * day, now - day - 1, now - day, now];
  return { schema: 1, startedAt: times[0], updatedAt: now,
    points: times.map(at => ({ at, totalUsdt: '0.300000000000000000000000000001',
      mexcUsdt: '0.100000000000000000000000000001', okxUsdt: '0.2' })),
    transfers: times.map((at, i) => ({ at, id: `okx:deposit:${i}`, venue: 'okx', type: 'deposit', asset: 'USDT', amount: '1.000000000000000000000000000001' })) };
}
async function directory(payload: unknown = history()) {
  const directory = await mkdtemp(join(tmpdir(), 'crypto-balance-history-api-')); directories.push(directory);
  await chmod(directory, 0o700);
  if (payload !== null) await writeFile(join(directory, 'balance-history.json'), JSON.stringify(payload), { mode: 0o600 });
  return directory;
}
function server(directory: string, owner = true, clock = () => now) {
  const app = Fastify({ logger: false });
  registerBalanceHistoryRoutes(app, { directory, isAccountOwner: () => owner, clock });
  return app;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('owner balance history API (offline)', () => {
  it.each([['', '1d', 2], ['?range=1d', '1d', 2], ['?range=7d', '7d', 4], ['?range=30d', '30d', 6]] as const)(
    'clips points and observed transfer markers with inclusive fixed range %s', async (query, range, count) => {
      const app = server(await directory());
      try {
        const response = await app.inject(path + query); const body = response.json();
        expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
        expect(body).toMatchObject({ schema: 1, range, from: now - Number(range.slice(0, -1)) * day, to: now,
          startedAt: now - 30 * day, updatedAt: now, transfersCoverage: 'observed-only' });
        expect(body.points).toHaveLength(count); expect(body.transfers).toHaveLength(count);
        expect(body.points[0].at).toBe(body.from); expect(body.points.at(-1).at).toBe(now);
        expect(body.points[0].totalUsdt).toBe('0.300000000000000000000000000001');
        expect(body.transfers[0].amount).toBe('1.000000000000000000000000000001');
      } finally { await app.close(); }
    });
  it('returns empty unstarted history only for an absent archive in a valid configured directory', async () => {
    const app = server(await directory(null));
    try {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ schema: 1, range: '1d', from: now - day, to: now,
        startedAt: null, updatedAt: null, points: [], transfers: [], transfersCoverage: 'observed-only' });
    } finally { await app.close(); }
  });
  it.each(['', '.', 'absent'])('does not treat invalid configured directory %s as an unstarted archive', async kind => {
    const valid = await directory(null);
    const app = server(kind === 'absent' ? join(valid, 'absent') : kind);
    try { expect((await app.inject(path)).statusCode).toBe(503); } finally { await app.close(); }
  });
  it('serves history independently of a missing or corrupt current snapshot, without writing it', async () => {
    const root = await directory(); const archive = join(root, 'balance-history.json');
    const bytes = await readFile(archive); const before = await stat(archive);
    const app = server(root);
    try {
      expect((await app.inject(path)).statusCode).toBe(200);
      await writeFile(join(root, 'current.json'), 'private-current-invalid-json', { mode: 0o600 });
      expect((await app.inject(path)).statusCode).toBe(200);
      expect(await readFile(archive)).toEqual(bytes); expect((await stat(archive)).mtimeMs).toBe(before.mtimeMs);
    } finally { await app.close(); }
  });
  it('preserves stale metadata and does not fabricate a fresh sample for an empty selected period', async () => {
    const old = history(); old.updatedAt = now - 2 * day;
    old.points = [{ at: old.updatedAt, totalUsdt: null, mexcUsdt: '3', okxUsdt: null }]; old.transfers = [];
    const app = server(await directory(old));
    try {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ startedAt: old.startedAt, updatedAt: old.updatedAt, points: [], transfers: [] });
    } finally { await app.close(); }
  });
  it.each(['?range=1d&range=7d', '?range=1d&range=1d', '?range=1d&file=current.json', '?file=../current.json',
    '?range=../current.json', '?range=%2e%2e%2fcurrent.json', '?range=', '?range=2d', '?range=1D',
    '?range[]=1d', '?range=1d&__proto__=hidden', '?constructor=hidden', '?=1d', '?range=1d?extra=value'])(
    'rejects unapproved query %s without opening an unconfigured path', async query => {
      const app = server('/deliberately-unconfigured');
      try {
        const response = await app.inject(path + query);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ ok: false, error: 'invalid_balance_history_query' });
        expect(response.headers['cache-control']).toBe('no-store');
      } finally { await app.close(); }
    });
  it('denies non-owner access before query or file handling, with no Basic override', async () => {
    const app = server('/deliberately-unconfigured', false);
    try {
      const response = await app.inject({ url: path + '?range=../private', headers: { authorization: 'Basic dGVzdDp0ZXN0' } });
      expect(response.statusCode).toBe(403); expect(response.json()).toEqual({ ok: false, error: 'account_owner_required' });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
  it.each(['json', 'unknown-field', 'nested-private-field', 'wrong-total', 'unknown-venue-total', 'negative-transfer',
    'future', 'permissions', 'oversize', 'invalid-clock', 'fractional-clock', 'throwing-clock'])(
    'redacts malformed history or runtime failure: %s', async kind => {
      const root = await directory();
      const fixture = history() as any;
      if (kind === 'json') await writeFile(join(root, 'balance-history.json'), '{synthetic-private-marker');
      if (kind === 'unknown-field') {
        fixture.secret = 'synthetic-private-marker';
        await writeFile(join(root, 'balance-history.json'), JSON.stringify(fixture));
      }
      if (kind === 'future') {
        fixture.updatedAt = now + 1; fixture.points.at(-1).at = now + 1;
        await writeFile(join(root, 'balance-history.json'), JSON.stringify(fixture));
      }
      if (kind === 'nested-private-field') {
        fixture.transfers[0].address = 'synthetic-private-marker';
        await writeFile(join(root, 'balance-history.json'), JSON.stringify(fixture));
      }
      if (kind === 'wrong-total' || kind === 'unknown-venue-total' || kind === 'negative-transfer') {
        if (kind === 'wrong-total') fixture.points[0].totalUsdt = '100';
        if (kind === 'unknown-venue-total') fixture.points[0].mexcUsdt = null;
        if (kind === 'negative-transfer') fixture.transfers[0].amount = '-5';
        await writeFile(join(root, 'balance-history.json'), JSON.stringify(fixture));
      }
      if (kind === 'permissions') await chmod(join(root, 'balance-history.json'), 0o644);
      if (kind === 'oversize') await writeFile(join(root, 'balance-history.json'), Buffer.alloc(8 * 1024 * 1024 + 1));
      const clock = () => {
        if (kind === 'throwing-clock') throw new Error('synthetic-private-marker');
        return kind === 'invalid-clock' ? NaN : kind === 'fractional-clock' ? now + 0.5 : now;
      };
      const app = server(root, true, clock);
      try {
        const response = await app.inject(path);
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ ok: false, error: 'balance_history_unavailable' });
        expect(response.body).not.toContain('synthetic-private-marker');
        expect(response.headers['cache-control']).toBe('no-store');
      } finally { await app.close(); }
    });
  it('registers GET only, with no mutation, HEAD or operator alias', async () => {
    const app = server(await directory());
    try {
      expect(app.hasRoute({ method: 'GET', url: path })).toBe(true);
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD'] as const) expect((await app.inject({ method, url: path })).statusCode).toBe(404);
      expect((await app.inject('/operator' + path)).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
