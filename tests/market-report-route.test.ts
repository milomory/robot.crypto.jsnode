import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServer } from '../src/http/api.js';
import type { DbPool } from '../src/db/pool.js';
import { createRun, startRun } from '../src/lab/observations.js';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('serves only the configured report, with authentication, no network and no path selection', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'crypto-report-route-'));
  const directory = join(parent, 'run');
  await startRun(directory, createRun('fixture'));
  vi.stubEnv('AUTH_CORE_ENABLED', 'false');
  vi.stubEnv('DASHBOARD_AUTH_ENABLED', 'true');
  vi.stubEnv('DASHBOARD_USERNAME', 'test');
  vi.stubEnv('DASHBOARD_PASSWORD', 'local-test-password');
  vi.stubEnv('AUTO_PAPER_TRADER_ENABLED', 'false');
  vi.stubEnv('LAB_OBSERVATION_RUN_DIR', directory);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const app = await buildServer({} as DbPool);
  try {
    expect((await app.inject('/api/lab/report')).statusCode).toBe(401);
    const response = await app.inject({ url: '/api/lab/report?directory=/etc/passwd', headers: {
      authorization: `Basic ${Buffer.from('test:local-test-password').toString('base64')}`
    } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ available: true, report: { recordedSamples: 0, sizeValidation: 'not-checked' } });
    expect(response.body).not.toContain(directory);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await app.close(); await rm(parent, { recursive: true, force: true }); }
});
