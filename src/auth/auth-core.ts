import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface AuthCoreConfig {
  enabled: boolean;
  origin: string;
  appOrigin: string;
  clientSecret: string;
  viewerIds: readonly string[];
}
const clientId = 'crypto.robot';
const sessionCookie = '__Host-crypto_sso';
const loginCookie = '__Host-crypto_login';
const operatorCookie = '__Host-crypto_operator';
const opaque = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
const key = (value: string) => digest(value).toString('hex');
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const subject = z.string().uuid();
const expiresAt = z.string().datetime({ offset: true });
const exchangeSchema = z.object({ token, expiresAt });
const infoSchema = z.object({ active: z.literal(true), service: z.literal(clientId),
  user: z.object({ id: subject }), expiresAt });
const same = (a: unknown, b: string) => typeof a === 'string' && a.length <= 256 && timingSafeEqual(digest(a), digest(b));
const cookie = (request: FastifyRequest, name: string) => {
  const matches = (request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
};
const setCookie = (reply: FastifyReply, name: string, value: string, maxAge: number) => {
  const previous = reply.getHeader('set-cookie');
  const values = previous ? (Array.isArray(previous) ? previous.map(String) : [String(previous)]) : [];
  reply.header('set-cookie', [...values, `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`]);
};
export const viewerPaths = new Set([
  '/api/status', '/api/market/tickers', '/api/risk-budget', '/api/journal',
  '/api/positions', '/api/risk-events', '/api/auto-trader/status'
]);
const operatorMutations = new Set(['/operator/api/auto-trader/scan', '/operator/api/paper/orders', '/operator/api/admin/live-unlock']);
export const isOperatorPath = (url: string) => url.split('?')[0].startsWith('/operator/');
export const logSafeRequest = (request: { id?: string; method?: string; url?: string }) => ({
  id: request.id, method: request.method, url: request.url?.split('?')[0]
});
interface Session { token: string; expires: number; csrf: string; userId?: string }
class Unavailable extends Error {}

export function registerAuthCore(app: FastifyInstance, config: AuthCoreConfig, transport: typeof fetch = fetch) {
  if (!config.enabled) return;
  function origin(value: string) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error();
      return value;
    } catch { throw new Error('Auth Core requires exact configured HTTPS origins'); }
  }
  const authOrigin = origin(config.origin);
  const appOrigin = origin(config.appOrigin);
  if (config.clientSecret.length < 32 || !config.viewerIds.every(id => subject.safeParse(id).success)) {
    throw new Error('Invalid Auth Core client configuration');
  }
  const viewers = new Set(config.viewerIds);
  const callback = `${appOrigin}/auth/callback`;
  const sessions = new Map<string, Session>();
  const pending = new Map<string, { verifier: string; expires: number }>();
  const operators = new Map<string, { csrf: string; expires: number }>();
  const actors = new WeakMap<FastifyRequest, Session>();
  const prune = () => {
    for (const map of [sessions, pending, operators]) {
      for (const [id, value] of map) if (value.expires <= Date.now()) map.delete(id);
    }
  };
  const clear = (request: FastifyRequest, reply: FastifyReply) => {
    sessions.delete(key(cookie(request, sessionCookie)));
    setCookie(reply, sessionCookie, '', 0);
  };
  const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ ok: false, error });
  async function call(endpoint: 'exchange' | 'introspect' | 'revoke', body: Record<string, string>): Promise<unknown> {
    try {
      const response = await transport(`${authOrigin}/api/sso/${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', origin: authOrigin, authorization: `Bearer ${config.clientSecret}` },
        body: JSON.stringify({ client_id: clientId, ...body })
      });
      if (!response.ok) throw new Unavailable();
      return await response.json();
    } catch { throw new Unavailable(); }
  }
  async function introspect(session: Session) {
    const payload = await call('introspect', { token: session.token });
    if (z.object({ active: z.literal(false) }).safeParse(payload).success) return undefined;
    const parsed = infoSchema.safeParse(payload);
    if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) throw new Unavailable();
    const info = parsed.data;
    if (session.userId && session.userId !== info.user.id) throw new Unavailable();
    session.expires = Math.min(session.expires, Date.parse(info.expiresAt));
    session.userId = info.user.id;
    return info;
  }
  function csrf(request: FastifyRequest, expected: string) {
    return request.headers.origin === appOrigin && same(request.headers['x-csrf-token'], expected);
  }

  // Basic Auth runs first for the explicit /operator namespace. An SSO request
  // never falls back to Basic, even when it carries a valid Authorization header.
  app.addHook('onRequest', async (request, reply) => {
    prune();
    reply.header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/favicon.ico') return;
    if (isOperatorPath(path)) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        const session = operators.get(key(cookie(request, operatorCookie)));
        if (!operatorMutations.has(path) || !session || !csrf(request, session.csrf)) return fail(reply, 403, 'operator_csrf_rejected');
      }
      return;
    }
    if (['/auth/login', '/auth/callback'].includes(path) && request.method === 'GET') return;
    if (path === '/auth/logout' && request.method === 'POST') return;
    const session = sessions.get(key(cookie(request, sessionCookie)));
    if (!session) { clear(request, reply); return fail(reply, 401, 'not_authenticated'); }
    try {
      const info = await introspect(session);
      if (!info) { clear(request, reply); return fail(reply, 401, 'not_authenticated'); }
      if (!viewers.has(info.user.id)) { clear(request, reply); return fail(reply, 403, 'viewer_not_authorized'); }
      const safeAsset = /^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(path);
      if (!['GET', 'HEAD'].includes(request.method) ||
          !(viewerPaths.has(path) || path === '/' || path === '/auth/session' || safeAsset)) {
        return fail(reply, 403, 'viewer_operation_denied');
      }
      actors.set(request, session);
    } catch { return fail(reply, 503, 'auth_unavailable'); }
  });

  app.get('/auth/login', async (request, reply) => {
    pending.delete(key(cookie(request, loginCookie)));
    if (pending.size >= 1000) return fail(reply, 503, 'auth_capacity');
    const state = opaque();
    const verifier = opaque();
    pending.set(key(state), { verifier, expires: Date.now() + 600000 });
    setCookie(reply, loginCookie, state, 600);
    const target = new URL(authOrigin);
    target.searchParams.set('sso_client', clientId);
    target.searchParams.set('redirect_uri', callback);
    target.searchParams.set('state', state);
    target.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    return reply.code(303).redirect(target.href);
  });
  app.get('/auth/callback', async (request, reply) => {
    const query = z.object({ code: token, state: token }).strict().safeParse(request.query);
    if (!query.success) return fail(reply, 400, 'invalid_login');
    const { state, code } = query.data;
    const transaction = pending.get(key(state));
    if (!transaction || !same(cookie(request, loginCookie), state)) return fail(reply, 400, 'invalid_login');
    pending.delete(key(state)); // consumed before asynchronous exchange, including failed attempts
    setCookie(reply, loginCookie, '', 0);
    try {
      const result = exchangeSchema.safeParse(await call('exchange', { code, code_verifier: transaction.verifier, redirect_uri: callback }));
      if (!result.success || Date.parse(result.data.expiresAt) <= Date.now()) throw new Unavailable();
      const session: Session = { token: result.data.token, expires: Math.min(Date.parse(result.data.expiresAt), Date.now() + 28800000), csrf: opaque() };
      const info = await introspect(session);
      if (!info || !viewers.has(info.user.id)) {
        await call('revoke', { token: session.token }).catch(() => undefined);
        clear(request, reply);
        return fail(reply, 403, 'viewer_not_authorized');
      }
      if (sessions.size >= 1000) {
        await call('revoke', { token: session.token }).catch(() => undefined);
        throw new Unavailable();
      }
      clear(request, reply);
      const id = opaque();
      sessions.set(key(id), session);
      setCookie(reply, sessionCookie, id, (session.expires - Date.now()) / 1000);
      return reply.code(303).redirect('/');
    } catch { clear(request, reply); return fail(reply, 503, 'auth_unavailable'); }
  });
  app.get('/auth/session', async (request) => {
    const session = actors.get(request)!;
    return { authenticated: true, role: 'viewer', actor: { issuer: authOrigin, subject: session.userId }, csrfToken: session.csrf };
  });
  app.post('/auth/logout', async (request, reply) => {
    const session = sessions.get(key(cookie(request, sessionCookie)));
    if (!session) { clear(request, reply); return fail(reply, 401, 'not_authenticated'); }
    if (!csrf(request, session.csrf)) return fail(reply, 403, 'csrf_rejected');
    clear(request, reply);
    let introspectionAvailable = true;
    try { await introspect(session); } catch { introspectionAvailable = false; }
    let revoked = false;
    try { revoked = z.object({ ok: z.literal(true) }).safeParse(await call('revoke', { token: session.token })).success; } catch {}
    return reply.code(revoked ? 200 : 503).send({ ok: true, localLoggedOut: true, revoked, introspectionAvailable });
  });
  app.get('/operator/auth/session', async (request, reply) => {
    operators.delete(key(cookie(request, operatorCookie)));
    if (operators.size >= 1000) return fail(reply, 503, 'auth_capacity');
    const id = opaque();
    const session = { csrf: opaque(), expires: Date.now() + 3600000 };
    operators.set(key(id), session);
    setCookie(reply, operatorCookie, id, 3600);
    return { role: 'operator', csrfToken: session.csrf };
  });
  app.addHook('onClose', async () => { sessions.clear(); pending.clear(); operators.clear(); });
}
