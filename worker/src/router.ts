// worker/src/router.ts
import type { Env } from './env';
import { json, error, preflight, requireCsrf, originAllowed, timingSafeEqual, isAllowedOrigin } from './http';
import { ownerRef } from './identity';
import { rateLimit } from './ratelimit';
import { createShare, confirmShare, resolveShare, initSaveBack } from './shares';
import { getSession, createSession, deleteSession, parseCookies, sessionCookie, csrfCookie, clearCookie } from './sessions';
import { pkcePair, buildAuthUrl, exchangeCode } from './oauth';

const WINDOW = 60_000;

function redirectUri(env: Env, provider: string): string {
  return `${env.API_BASE_URL}/api/auth/${provider}/callback`;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const cookies = parseCookies(req.headers.get('cookie'));

  if (req.method === 'OPTIONS') return preflight(env);

  if (req.method === 'GET' && path === '/api/health') return json({ ok: true }, env);

  // Live game rooms: WebSocket upgrade → GameRoom Durable Object. WS upgrades
  // can't use normal CORS, so validate the Origin header against ALLOWED_ORIGIN
  // (reject a mismatched browser origin; absent Origin = non-browser client).
  const room = path.match(/^\/rooms\/([A-Za-z0-9_-]{1,64})\/ws$/);
  if (room) {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const origin = req.headers.get('Origin');
    if (origin && !isAllowedOrigin(origin, env)) return error('bad_origin', env, 403);
    const id = env.GAME_ROOM.idFromName(room[1]!);
    return env.GAME_ROOM.get(id).fetch(req);
  }

  const session = await getSession(env.DB, cookies['sid'] ?? null);
  const userId = session?.userId ?? null;
  const owner = await ownerRef(req, env, userId);

  if (req.method === 'GET' && path === '/api/me') {
    if (!session) return json({ authenticated: false }, env);
    const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.userId).first<{ email: string | null }>();
    return json({ authenticated: true, email: u?.email ?? null, csrfToken: session.csrfToken }, env);
  }

  if (req.method === 'POST' && path === '/api/logout') {
    if (session && !(await requireCsrf(req, session.csrfToken))) return error('csrf', env, 403);
    if (cookies['sid']) await deleteSession(env.DB, cookies['sid']);
    return json({ ok: true }, env, { headers: { 'set-cookie': clearCookie('sid') } });
  }

  // OAuth start
  let m = path.match(/^\/api\/auth\/(google|github)\/start$/);
  if (req.method === 'GET' && m) {
    const provider = m[1] as 'google' | 'github';
    if (!(await rateLimit(env.DB, owner, 'auth', 20, WINDOW)).ok) return error('rate_limited', env, 429);
    const state = crypto.randomUUID();
    const { verifier, challenge } = await pkcePair();
    const authUrl = buildAuthUrl(provider, env, state, challenge, redirectUri(env, provider));
    const headers = new Headers({ location: authUrl });
    headers.append('set-cookie', `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    headers.append('set-cookie', `oauth_verifier=${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    return new Response(null, { status: 302, headers });
  }

  // OAuth callback
  m = path.match(/^\/api\/auth\/(google|github)\/callback$/);
  if (req.method === 'GET' && m) {
    const provider = m[1] as 'google' | 'github';
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (
      !code || !state || !cookies['oauth_state'] || !cookies['oauth_verifier'] ||
      !(await timingSafeEqual(state, cookies['oauth_state']))
    ) {
      return error('bad_oauth_state', env, 400);
    }
    const ex = await exchangeCode(provider, env, code, cookies['oauth_verifier'], redirectUri(env, provider), fetch);
    if (!ex.ok) return error(ex.error, env, 400);
    let user = await env.DB.prepare('SELECT id FROM users WHERE oauth_provider = ? AND oauth_subject = ?')
      .bind(provider, ex.subject).first<{ id: string }>();
    let userIdNew: string;
    if (user) { userIdNew = user.id; }
    else {
      userIdNew = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO users (id, oauth_provider, oauth_subject, email, created_at) VALUES (?,?,?,?,?)')
        .bind(userIdNew, provider, ex.subject, ex.email, Date.now()).run();
    }
    const s = await createSession(env.DB, userIdNew);
    const headers = new Headers({ location: env.ALLOWED_ORIGIN });
    headers.append('set-cookie', sessionCookie(s.id, 30 * 24 * 60 * 60));
    headers.append('set-cookie', csrfCookie(s.csrfToken, 30 * 24 * 60 * 60));
    headers.append('set-cookie', clearCookie('oauth_state'));
    headers.append('set-cookie', clearCookie('oauth_verifier'));
    return new Response(null, { status: 302, headers });
  }

  if (req.method === 'POST' && path === '/api/share') {
    if (session && !(await requireCsrf(req, session.csrfToken))) return error('csrf', env, 403);
    if (!session && !originAllowed(req, env)) return error('bad_origin', env, 403);
    if (!(await rateLimit(env.DB, owner, 'share', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    const b = await req.json<{ access: 'ro'|'rw'; storageKind: 'embedded'|'filebase'; contentType: string; title: string; sizeBytes: number }>();
    const r = await createShare(env, {
      ownerRef: owner, isLoggedIn: !!userId, access: b.access, storageKind: b.storageKind,
      contentType: b.contentType, title: b.title, sizeBytes: b.sizeBytes,
    });
    if (!r.ok) return error(r.error, env, 400);
    return json({ token: r.token, shareId: r.shareId, uploadUrl: r.uploadUrl, objectKey: r.objectKey }, env);
  }

  if (req.method === 'POST' && path === '/api/share/confirm') {
    if (session && !(await requireCsrf(req, session.csrfToken))) return error('csrf', env, 403);
    if (!session && !originAllowed(req, env)) return error('bad_origin', env, 403);
    if (!(await rateLimit(env.DB, owner, 'presign', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    const b = await req.json<{ shareId: string }>();
    const r = await confirmShare(env, b.shareId, owner);
    if (!r.ok) return error(r.error, env, 400);
    return json({ ok: true }, env);
  }

  m = path.match(/^\/api\/share\/([A-Za-z0-9_-]{22})\/save$/);
  if (req.method === 'POST' && m) {
    if (session && !(await requireCsrf(req, session.csrfToken))) return error('csrf', env, 403);
    if (!session && !originAllowed(req, env)) return error('bad_origin', env, 403);
    if (!(await rateLimit(env.DB, owner, 'presign', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    const b = await req.json<{ size: number }>();
    const r = await initSaveBack(env, m[1]!, b.size, owner, !!userId);
    if (!r.ok) return error(r.error, env, r.status);
    return json({ uploadUrl: r.uploadUrl }, env);
  }

  m = path.match(/^\/api\/share\/([A-Za-z0-9_-]{22})$/);
  if (req.method === 'GET' && m) {
    const r = await resolveShare(env, m[1]!);
    if (!r.ok) return error(r.error, env, 404);
    return json(r, env);
  }

  return error('not_found', env, 404);
}
