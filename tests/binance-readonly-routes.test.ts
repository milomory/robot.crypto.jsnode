import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/http/api.js';
import type { DbPool } from '../src/db/pool.js';

const auth = { authorization: `Basic ${Buffer.from('test:local-test-password').toString('base64')}` };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function server(authEnabled = true) {
  vi.stubEnv('DASHBOARD_AUTH_ENABLED', String(authEnabled));
  vi.stubEnv('DASHBOARD_USERNAME', 'test');
  vi.stubEnv('DASHBOARD_PASSWORD', 'local-test-password');
  vi.stubEnv('AUTO_PAPER_TRADER_ENABLED', 'false');
  vi.stubEnv('BINANCE_READONLY_ENABLED', 'false');
  vi.stubEnv('BINANCE_API_KEY', 'fake-private-key');
  vi.stubEnv('BINANCE_API_SECRET', 'fake-private-secret');
  return buildServer({} as DbPool);
}

describe('private exchange HTTP access', () => {
  it('requires authentication and makes no network calls for disabled connectors', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const app = await server();
    try {
      expect((await app.inject('/api/exchanges/binance/account')).statusCode).toBe(401);
      const result = await app.inject({ url: '/api/exchanges/binance/account', headers: auth });
      expect(result.statusCode).toBe(503);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(fetcher).not.toHaveBeenCalled();
      const status = await app.inject({ url: '/api/exchanges/binance/status', headers: auth });
      expect(status.json()).toMatchObject({ enabled: false, configured: true, verifiedAt: null });
      const runtime = await app.inject({ url: '/api/runtime-config', headers: auth });
      expect(runtime.body).not.toContain('fake-private');
      expect(status.body).not.toContain('fake-private');
    } finally { await app.close(); }
  });
  it('refuses private data if dashboard authentication is disabled', async () => {
    const app = await server(false);
    try {
      expect((await app.inject('/api/exchanges/binance/account')).statusCode).toBe(503);
    } finally { await app.close(); }
  });
  it('rejects invalid history input and does not register execution routes', async () => {
    const app = await server();
    try {
      expect((await app.inject({ url: '/api/exchanges/binance/trades?symbol=BTC%2FUSDT&limit=1001', headers: auth })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/exchanges/binance/orders', headers: auth, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: '/api/exchanges/binance/open-orders', headers: auth })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
