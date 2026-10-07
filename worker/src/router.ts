// worker/src/router.ts
import type { Env } from './env';
import { json, error, preflight, originAllowed, isAllowedOrigin, withCors, corsHeaders, securityHeaders } from './http';
import { ownerRef, ipHash } from './identity';
import { rateLimit } from './ratelimit';
import { createShare, confirmShare, resolveShare, initSaveBack, deleteShare } from './shares';
import { deleteObject } from './filebase';
import { recordTelemetry, recordFeedback } from './feedback';
import { createAuth } from './auth';
import { normalizeEmail, isValidSyntax, domainOf, isDisposable, hasMx } from './email/validate';
import { checkThrottle, recordStrike, clearThrottle } from './throttle';
import { verifyTurnstile } from './turnstile';
import { runAiEdit, type AiKind } from './ai';

const WINDOW = 60_000;
const DAY = 86_400_000;
const SHARES_PER_DAY = 10;

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return preflight(env);

  if (req.method === 'GET' && path === '/api/health') return json({ ok: true }, env);

  // Live game rooms: WebSocket upgrade → GameRoom Durable Object.
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

  // --- Client failure telemetry: anonymous, no session lookup needed ---
  if (req.method === 'POST' && path === '/api/telemetry') {
    if (!originAllowed(req, env)) return error('bad_origin', env, 403);
    const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
    const key = await ipHash(ip, env.IP_HASH_SECRET);
    if (!(await rateLimit(env.DB, key, 'telemetry', 60, 3_600_000)).ok) return error('rate_limited', env, 429);
    const body = await req.json().catch(() => null);
    if (!(await recordTelemetry(env, req, body))) return error('bad_request', env, 400);
    return new Response(null, { status: 204, headers: { ...corsHeaders(env, req), ...securityHeaders() } });
  }

  const auth = createAuth(env);

  // --- Email-OTP request: defense pipeline BEFORE Better Auth sends a code ---
  if (req.method === 'POST' && path === '/api/auth/email-otp/send-verification-otp') {
    const raw = (await req.clone().json().catch(() => ({}))) as {
      email?: string;
      turnstileToken?: string;
    };
    const email = normalizeEmail(raw.email ?? '');
    const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
    const hashedIp = await ipHash(ip, env.IP_HASH_SECRET);
    const ipKey = `otp:ip:${hashedIp}`;
    const emailKey = `otp:email:${email}`;

    if (!isValidSyntax(email)) return error('invalid_email', env, 400);
    if (!(await verifyTurnstile(env, raw.turnstileToken ?? '', ip))) {
      return error('turnstile_failed', env, 400);
    }
    for (const key of [ipKey, emailKey]) {
      const t = await checkThrottle(env.DB, key);
      if (!t.allowed) return json({ error: 'rate_limited', retryAfter: t.retryAfter }, env, { status: 429 });
    }
    const domain = domainOf(email);
    if (await isDisposable(env, domain)) {
      await recordStrike(env.DB, emailKey);
      return error('disposable_email', env, 400);
    }
    if (!(await hasMx(domain))) {
      await recordStrike(env.DB, emailKey);
      return error('no_mx', env, 400);
    }
    if (!(await rateLimit(env.DB, hashedIp, 'otp_req', 3, 10 * 60_000)).ok) {
      await recordStrike(env.DB, ipKey);
      return json({ error: 'rate_limited', retryAfter: 600 }, env, { status: 429 });
    }
    // Passed all gates → let Better Auth generate + send the OTP.
    return withCors(await auth.handler(req), env, req);
  }

  // Successful OTP sign-in clears the email throttle.
  if (req.method === 'POST' && path === '/api/auth/sign-in/email-otp') {
    const raw = (await req.clone().json().catch(() => ({}))) as { email?: string };
    const res = await auth.handler(req);
    if (res.ok) await clearThrottle(env.DB, `otp:email:${normalizeEmail(raw.email ?? '')}`);
    return withCors(res, env, req);
  }

  // All other Better Auth routes (social sign-in, callbacks, get-session, sign-out).
  if (path.startsWith('/api/auth/')) {
    return withCors(await auth.handler(req), env, req);
  }

  // Identify the caller for owner-scoped endpoints below.
  const sessionData = await auth.api.getSession({ headers: req.headers });
  const userId = sessionData?.user?.id ?? null;
  const owner = await ownerRef(req, env, userId);

  // --- User feedback / "report a problem" ---
  if (req.method === 'POST' && path === '/api/feedback') {
    if (!originAllowed(req, env)) return error('bad_origin', env, 403);
    const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
    const key = await ipHash(ip, env.IP_HASH_SECRET);
    if (!(await rateLimit(env.DB, key, 'feedback', 5, 86_400_000)).ok) return error('rate_limited', env, 429);
    const body = await req.json().catch(() => null);
    const err = await recordFeedback(env, req, body, userId);
    if (err) return error(err, env, 400);
    return json({ ok: true }, env);
  }

  // --- AI edit: login-gated, 10 free edits/day (BYOK = unlimited) ---
  if (req.method === 'POST' && path === '/api/ai/edit') {
    if (!originAllowed(req, env)) return error('bad_origin', env, 403);
    if (!userId) return error('unauthorized', env, 401);
    const byokKey = req.headers.get('X-AI-Key');
    const byokProvider = req.headers.get('X-AI-Provider');
    // Free tier is capped at 10/day; a user key bypasses the daily quota.
    if (!byokKey) {
      if (!(await rateLimit(env.DB, owner, 'ai_edit', 10, 86_400_000)).ok) {
        return json({ error: 'daily_limit', limit: 10 }, env, { status: 429 });
      }
    }
    const b = await req.json<{ kind: AiKind; instruction: string; content?: string; meta?: Record<string, unknown> }>();
    if (!b?.kind || !b?.instruction) return error('bad_request', env, 400);
    if ((b.instruction?.length ?? 0) > 2000 || (b.content?.length ?? 0) > 200_000) {
      return error('too_large', env, 413);
    }
    try {
      const result = await runAiEdit(env, b, { byokKey, byokProvider });
      return json(result, env);
    } catch (e) {
      return json({ error: 'ai_failed', detail: (e as Error).message }, env, { status: 502 });
    }
  }

  // Same-site Lax cookies + strict CORS allowlist mean cross-site POSTs can't
  // carry the session cookie, so an Origin check is sufficient CSRF defense.
  if (req.method === 'POST' && path === '/api/share') {
    if (!originAllowed(req, env)) return error('bad_origin', env, 403);
    if (!(await rateLimit(env.DB, owner, 'share', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    // Daily cap per IP AND per device. Both keys are HMAC hashes — no raw IP or
    // device id is stored. The device key mixes a client random id with the
    // coarse platform, so clearing storage alone doesn't reset the IP cap.
    const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
    const ipKey = await ipHash(ip, env.IP_HASH_SECRET);
    const rawDev = req.headers.get('X-Device-Id') ?? '';
    const platform = req.headers.get('Sec-CH-UA-Platform') ?? (req.headers.get('User-Agent') ?? '').slice(0, 64);
    const devKey = /^[A-Za-z0-9_-]{16,64}$/.test(rawDev)
      ? await ipHash(`dev:${rawDev}|${platform}`, env.IP_HASH_SECRET)
      : `nodev:${ipKey}`;
    if (!(await rateLimit(env.DB, `ip:${ipKey}`, 'share-day', SHARES_PER_DAY, DAY)).ok) return error('share_daily_limit', env, 429);
    if (!(await rateLimit(env.DB, `dev:${devKey}`, 'share-day', SHARES_PER_DAY, DAY)).ok) return error('share_daily_limit', env, 429);
    const b = await req.json<{ access: 'ro'|'rw'; storageKind: 'embedded'|'filebase'; contentType: string; title: string; sizeBytes: number }>();
    const r = await createShare(env, {
      ownerRef: owner, isLoggedIn: !!userId, access: b.access, storageKind: b.storageKind,
      contentType: b.contentType, title: b.title, sizeBytes: b.sizeBytes,
    });
    if (!r.ok) return error(r.error, env, 400);
    return json({ token: r.token, shareId: r.shareId, uploadUrl: r.uploadUrl, objectKey: r.objectKey }, env);
  }

  if (req.method === 'POST' && path === '/api/share/confirm') {
    if (!originAllowed(req, env)) return error('bad_origin', env, 403);
    if (!(await rateLimit(env.DB, owner, 'presign', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    const b = await req.json<{ shareId: string }>();
    const r = await confirmShare(env, b.shareId, owner);
    if (!r.ok) return error(r.error, env, 400);
    return json({ ok: true }, env);
  }

  if (req.method === 'POST' && path === '/api/share/delete') {
    if (!originAllowed(req, env)) return error('bad_origin', env, 403);
    if (!(await rateLimit(env.DB, owner, 'presign', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    const b = await req.json<{ shareId: string }>();
    const r = await deleteShare(env, String(b.shareId ?? ''), owner, (key) => deleteObject(env, key));
    if (!r.ok) return error(r.error, env, r.status);
    return json({ ok: true }, env);
  }

  let m = path.match(/^\/api\/share\/([A-Za-z0-9_-]{22})\/save$/);
  if (req.method === 'POST' && m) {
    if (!originAllowed(req, env)) return error('bad_origin', env, 403);
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
