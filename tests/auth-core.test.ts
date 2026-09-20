import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAuthCore, logSafeRequest, type AuthCoreConfig } from '../src/auth/auth-core.js';
import { buildServer } from '../src/http/api.js';
import type { DbPool } from '../src/db/pool.js';

const uid = '12345678-1234-4234-8234-123456789abc';
const config: AuthCoreConfig = { enabled: true, origin: 'https://auth.example', appOrigin: 'https://crypto.example',
  clientSecret: 'synthetic-client-secret-with-32-characters', viewerIds: [uid] };
const bearer = 'T'.repeat(43);
const code = 'C'.repeat(43);
const cookieHeader = (response: { headers: Record<string, unknown> }, name: string) => {
  const headers = response.headers['set-cookie'];
  const cookies = Array.isArray(headers) ? headers : [headers];
  return String(cookies.filter(v => String(v).startsWith(name + '=')).at(-1)).split(';')[0];
};
function upstream() {
  let challenge = '', consumed = false, issued = 0;
  const state = { active: true, service: 'crypto.robot', id: uid, expires: Date.now() + 3600000, fail: '', malformed: false };
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split('/').at(-1);
    const body = JSON.parse(String(options?.body));
    if (state.fail === endpoint) throw new Error('synthetic-secret-that-must-not-leak');
    if (url.origin !== config.origin || options?.method !== 'POST' || options?.redirect !== 'error' ||
        (options?.headers as Record<string, string>).authorization !== `Bearer ${config.clientSecret}` ||
        (options?.headers as Record<string, string>).origin !== config.origin || body.client_id !== 'crypto.robot') return Response.json({}, { status: 401 });
    if (state.malformed) return Response.json({ unexpected: true });
    if (endpoint === 'exchange') {
      if (consumed || Date.now() - issued > 60000 || body.code !== code || body.redirect_uri !== config.appOrigin + '/auth/callback' ||
          createHash('sha256').update(body.code_verifier).digest('base64url') !== challenge) return Response.json({}, { status: 400 });
      consumed = true;
      return Response.json({ token: bearer, expiresAt: new Date(state.expires).toISOString() });
    }
    if (body.token !== bearer) return Response.json({}, { status: 400 });
    if (endpoint === 'introspect') return Response.json(state.active ? { active: true, service: state.service,
      user: { id: state.id, displayName: 'Not an authorization identity' }, expiresAt: new Date(state.expires).toISOString() } : { active: false });
    if (endpoint === 'revoke') { state.active = false; return Response.json({ ok: true }); }
    throw new Error('Unexpected endpoint');
  });
  return { fetcher, state, authorize: (url: URL) => { challenge = url.searchParams.get('code_challenge')!; issued = Date.now(); } };
}
async function fixture(overrides: Partial<AuthCoreConfig> = {}) {
  const fake = upstream();
  const app = Fastify({ logger: false });
  registerAuthCore(app, { ...config, ...overrides }, fake.fetcher);
  app.get('/', async () => 'Crypto viewer');
  app.get('/api/status', async () => ({ ok: true }));
  app.get('/api/lab/report', async () => ({ available: false }));
  app.get('/api/runtime-config', async () => ({ private: true }));
  app.get('/api/exchanges/binance/account', async () => ({ private: true }));
  for (const path of ['/api/auto-trader/scan', '/api/paper/orders', '/api/admin/live-unlock']) {
    app.post(path, async () => { throw new Error('Viewer reached a mutation'); });
  }
  app.get('/health', async () => ({ ok: true }));
  async function begin() {
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location!);
    fake.authorize(url);
    const loginCookie = cookieHeader(login, '__Host-crypto_login');
    const callback = `/auth/callback?code=${code}&state=${url.searchParams.get('state')}`;
    return { login, url, loginCookie, callback };
  }
  async function login() {
    const start = await begin();
    const result = await app.inject({ url: start.callback, headers: { cookie: start.loginCookie } });
    return { ...start, result, sessionCookie: cookieHeader(result, '__Host-crypto_sso') };
  }
  return { app, fake, begin, login };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Auth Core viewer adapter (offline)', () => {
  it('allows only authenticated viewer reads of the observation report', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject('/api/lab/report')).statusCode).toBe(401);
      const flow = await f.login();
      expect((await f.app.inject({ url: '/api/lab/report', headers: { cookie: flow.sessionCookie } })).statusCode).toBe(200);
      expect((await f.app.inject({ method: 'POST', url: '/api/lab/report', headers: { cookie: flow.sessionCookie } })).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });
  it('redirects unauthenticated documents to login but never redirects API calls', async () => {
    const f = await fixture();
    try {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await f.app.inject({ method, url: '/?returnTo=https://evil.example' });
        expect(r.statusCode).toBe(303);
        expect(r.headers.location).toBe('/auth/login');
        expect(r.headers['www-authenticate']).toBeUndefined();
      }
      const r = await f.app.inject({ url: '/api/status', headers: { accept: 'text/html' } });
      expect(r.statusCode).toBe(401);
      expect(r.headers.location).toBeUndefined();
    } finally { await f.app.close(); }
  });
  it('redirects revoked page sessions, without loops for forbidden grants or outages', async () => {
    const f = await fixture();
    try {
      const flow = await f.login();
      const headers = { cookie: flow.sessionCookie };
      f.fake.state.fail = 'introspect';
      expect((await f.app.inject({ url: '/', headers })).statusCode).toBe(503);
      f.fake.state.fail = '';
      f.fake.state.active = false;
      const r = await f.app.inject({ url: '/', headers });
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe('/auth/login');
    } finally { await f.app.close(); }
    const denied = await fixture({ viewerIds: [] });
    try {
      const flow = await denied.login();
      expect(flow.result.statusCode).toBe(403);
      expect(flow.result.headers.location).toBeUndefined();
    } finally { await denied.app.close(); }
  });
  it('uses browser-bound S256 and separate secure cookies; introspects every request', async () => {
    const f = await fixture();
    try {
      const flow = await f.login();
      expect(flow.result.statusCode).toBe(303);
      expect(flow.url.searchParams.get('sso_client')).toBe('crypto.robot');
      expect(flow.url.searchParams.get('redirect_uri')).toBe('https://crypto.example/auth/callback');
      expect(flow.url.searchParams.get('code_challenge')).toHaveLength(43);
      const rawCookies = JSON.stringify(flow.result.headers['set-cookie']);
      for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(rawCookies).toContain(attr);
      expect(rawCookies).not.toContain('Domain=');
      expect(rawCookies).not.toContain(bearer);
      const first = await f.app.inject({ url: '/auth/session', headers: { cookie: flow.sessionCookie } });
      expect(first.json().actor).toEqual({ issuer: config.origin, subject: uid });
      expect(first.json().role).toBe('viewer');
      expect(first.body).not.toContain(bearer);
      const before = f.fake.fetcher.mock.calls.length;
      await f.app.inject({ url: '/api/status', headers: { cookie: flow.sessionCookie } });
      await f.app.inject({ method: 'HEAD', url: '/api/status', headers: { cookie: flow.sessionCookie } });
      expect(f.fake.fetcher.mock.calls.length).toBe(before + 2);
      expect(flow.result.headers['referrer-policy']).toBe('no-referrer');
      expect(flow.result.headers['cache-control']).toBe('no-store');
    } finally { await f.app.close(); }
  });
  it('rejects direct access and forged identity headers', async () => {
    const f = await fixture();
    try {
      const r = await f.app.inject({ url: '/api/status', headers: { owner_id: uid, role: 'admin' } });
      expect(r.statusCode).toBe(401);
      expect(f.fake.fetcher).not.toHaveBeenCalled();
      expect((await f.app.inject('/health')).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });
  it.each(['state', 'cookie', 'duplicate-cookie', 'missing-cookie'])('rejects wrong %s without exchange', async (kind) => {
    const f = await fixture();
    try {
      const start = await f.begin();
      const url = kind === 'state' ? start.callback.replace(/state=.*/, 'state=' + 'X'.repeat(43)) : start.callback;
      const cookie = kind === 'cookie' ? '__Host-crypto_login=' + 'X'.repeat(43) :
        kind === 'duplicate-cookie' ? start.loginCookie + '; ' + start.loginCookie : kind === 'missing-cookie' ? '' : start.loginCookie;
      expect((await f.app.inject({ url, headers: { cookie } })).statusCode).toBe(400);
      expect(f.fake.fetcher).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('consumes a callback once, even under concurrent requests', async () => {
    const f = await fixture();
    try {
      const start = await f.begin();
      const send = () => f.app.inject({ url: start.callback, headers: { cookie: start.loginCookie } });
      const results = await Promise.all([send(), send()]);
      expect(results.map(r => r.statusCode).sort()).toEqual([303, 400]);
      expect((await send()).statusCode).toBe(400);
    } finally { await f.app.close(); }
  });
  it.each(['client', 'secret', 'callback', 'pkce', 'code'])('fails closed on an exchange with wrong %s', async (kind) => {
    const fake = upstream();
    const fetcher: typeof fetch = async (input, options) => {
      const body = JSON.parse(String(options?.body));
      const opts = { ...options, headers: { ...options?.headers as Record<string, string> } };
      if (String(input).endsWith('/exchange')) {
        if (kind === 'client') body.client_id = 'other';
        if (kind === 'callback') body.redirect_uri = 'https://evil.example/auth/callback';
        if (kind === 'pkce') body.code_verifier = 'Z'.repeat(43);
        if (kind === 'code') body.code = 'Z'.repeat(43);
        if (kind === 'secret') opts.headers.authorization = 'Bearer wrong';
      }
      return fake.fetcher(input, { ...opts, body: JSON.stringify(body) });
    };
    const app = Fastify(); registerAuthCore(app, config, fetcher);
    try {
      const login = await app.inject('/auth/login'); const url = new URL(login.headers.location!); fake.authorize(url);
      const r = await app.inject({ url: '/auth/callback?code=' + code + '&state=' + url.searchParams.get('state'), headers: { cookie: cookieHeader(login, '__Host-crypto_login') } });
      expect(r.statusCode).toBe(503);
      expect(String(r.headers['set-cookie'])).not.toContain(bearer);
    } finally { await app.close(); }
  });
  it.each(['membership', 'local-permission', 'wrong-service', 'invalid-subject', 'expired', 'malformed'])('denies %s', async (kind) => {
    const f = await fixture(kind === 'local-permission' ? { viewerIds: [] } : {});
    try {
      if (kind === 'membership') f.fake.state.active = false;
      if (kind === 'wrong-service') f.fake.state.service = 'tinvest.robot';
      if (kind === 'invalid-subject') f.fake.state.id = 'admin@example.com';
      if (kind === 'expired') f.fake.state.expires = Date.now() - 1000;
      if (kind === 'malformed') f.fake.state.malformed = true;
      expect((await f.login()).result.statusCode).toBeGreaterThanOrEqual(400);
    } finally { await f.app.close(); }
  });
  it('honors 60-second upstream code expiry and 10-minute browser transaction expiry', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = await fixture();
    try {
      const start = await f.begin(); now += 61000;
      expect((await f.app.inject({ url: start.callback, headers: { cookie: start.loginCookie } })).statusCode).toBe(503);
      const next = await f.begin(); now += 601000;
      expect((await f.app.inject({ url: next.callback, headers: { cookie: next.loginCookie } })).statusCode).toBe(400);
    } finally { await f.app.close(); }
  });
  it('revocation denies the next request and never falls back to Basic', async () => {
    const f = await fixture();
    try {
      const flow = await f.login(); f.fake.state.active = false;
      const r = await f.app.inject({ url: '/api/status', headers: { cookie: flow.sessionCookie, authorization: 'Basic dGVzdDp0ZXN0' } });
      expect(r.statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
  it('fails closed on introspection timeout, subject replacement or malformed response', async () => {
    for (const kind of ['timeout', 'subject', 'malformed']) {
      const f = await fixture();
      try {
        const flow = await f.login();
        if (kind === 'timeout') f.fake.state.fail = 'introspect';
        if (kind === 'subject') f.fake.state.id = '22345678-1234-4234-8234-123456789abc';
        if (kind === 'malformed') f.fake.state.malformed = true;
        const r = await f.app.inject({ url: '/api/status', headers: { cookie: flow.sessionCookie } });
        expect(r.statusCode).toBe(503); expect(r.body).not.toContain('synthetic-secret');
      } finally { await f.app.close(); }
    }
  });
  it('denies all mutations and unreviewed reads to viewers', async () => {
    const f = await fixture();
    try {
      const flow = await f.login();
      for (const url of ['/api/auto-trader/scan', '/api/paper/orders', '/api/admin/live-unlock']) {
        expect((await f.app.inject({ method: 'POST', url, payload: {}, headers: { cookie: flow.sessionCookie, origin: config.appOrigin, role: 'admin' } })).statusCode).toBe(403);
      }
      for (const url of ['/api/runtime-config', '/api/exchanges/binance/account', '/unknown']) {
        expect((await f.app.inject({ url, headers: { cookie: flow.sessionCookie } })).statusCode).toBe(403);
      }
    } finally { await f.app.close(); }
  });
  it('requires exact Origin and CSRF for logout; clears locally on remote failure', async () => {
    const f = await fixture();
    try {
      const flow = await f.login();
      const session = (await f.app.inject({ url: '/auth/session', headers: { cookie: flow.sessionCookie } })).json();
      for (const headers of [{}, { origin: 'https://evil.example', 'x-csrf-token': session.csrfToken }, { origin: config.appOrigin }]) {
        expect((await f.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: flow.sessionCookie, ...headers } })).statusCode).toBe(403);
      }
      f.fake.state.fail = 'revoke';
      const r = await f.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: flow.sessionCookie, origin: config.appOrigin, 'x-csrf-token': session.csrfToken } });
      expect(r.statusCode).toBe(503); expect(r.json()).toMatchObject({ localLoggedOut: true, revoked: false });
      expect((await f.app.inject({ url: '/api/status', headers: { cookie: flow.sessionCookie } })).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
  it('never logs callback codes, state or credentials', () => {
    expect(logSafeRequest({ method: 'GET', url: '/auth/callback?code=SECRET&state=STATE' })).toEqual({ id: undefined, method: 'GET', url: '/auth/callback' });
  });
  it.each(['http://auth.example', 'https://auth.example/path', 'https://user:pass@auth.example'])('rejects unsafe origin %s', async origin => {
    const app = Fastify();
    try { expect(() => registerAuthCore(app, { ...config, origin })).toThrow(); }
    finally { await app.close(); }
  });
});

describe('Fastify integration and explicit operator boundary', () => {
  it('preserves Basic only on operator routes and enforces operator CSRF without executing trades', async () => {
    vi.stubEnv('AUTH_CORE_ENABLED', 'true'); vi.stubEnv('AUTH_CORE_ORIGIN', config.origin);
    vi.stubEnv('AUTH_CORE_APP_ORIGIN', config.appOrigin); vi.stubEnv('AUTH_CORE_CLIENT_SECRET', config.clientSecret);
    vi.stubEnv('AUTH_CORE_VIEWER_IDS', uid); vi.stubEnv('DASHBOARD_AUTH_ENABLED', 'true');
    vi.stubEnv('DASHBOARD_USERNAME', 'operator'); vi.stubEnv('DASHBOARD_PASSWORD', 'synthetic-password');
    vi.stubEnv('AUTO_PAPER_TRADER_ENABLED', 'false');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network allowed'); }));
    const query = vi.fn(() => { throw new Error('No database allowed'); });
    const app = await buildServer({ query } as unknown as DbPool);
    const authorization = 'Basic ' + Buffer.from('operator:synthetic-password').toString('base64');
    try {
      expect((await app.inject({ url: '/api/runtime-config', headers: { authorization } })).statusCode).toBe(401);
      expect((await app.inject('/operator/api/runtime-config')).statusCode).toBe(401);
      expect((await app.inject({ url: '/operator/api/runtime-config', headers: { authorization } })).statusCode).toBe(200);
      const bootstrap = await app.inject({ url: '/operator/auth/session', headers: { authorization } });
      expect(bootstrap.statusCode).toBe(200);
      const cookie = cookieHeader(bootstrap, '__Host-crypto_operator');
      expect((await app.inject({ method: 'POST', url: '/operator/api/admin/live-unlock', headers: { authorization, cookie } })).statusCode).toBe(403);
      const result = await app.inject({ method: 'POST', url: '/operator/api/admin/live-unlock', headers: { authorization, cookie,
        origin: config.appOrigin, 'x-csrf-token': bootstrap.json().csrfToken } });
      expect(result.statusCode).toBe(423);
      expect(query).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
