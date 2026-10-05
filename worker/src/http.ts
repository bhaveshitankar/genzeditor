// worker/src/http.ts
import type { Env } from './env';

// ALLOWED_ORIGIN is a comma-separated allowlist (e.g. the custom domain, the
// Pages URL, localhost). Parsed into exact-match origins.
export function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
}

export function isAllowedOrigin(origin: string | null, env: Env): boolean {
  return !!origin && allowedOrigins(env).includes(origin);
}

// Pick the Access-Control-Allow-Origin value: echo the request's Origin when it
// is in the allowlist (required because credentialed requests can't use "*"),
// otherwise fall back to the first configured origin.
export function pickOrigin(req: Request | undefined, env: Env): string {
  const origin = req?.headers.get('Origin') ?? null;
  if (origin && isAllowedOrigin(origin, env)) return origin;
  return allowedOrigins(env)[0] ?? env.ALLOWED_ORIGIN;
}

export function corsHeaders(env: Env, req?: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': pickOrigin(req, env),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-CSRF-Token',
    'Vary': 'Origin',
  };
}

export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
  };
}

export function json(
  body: unknown,
  env: Env,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(env),
      ...securityHeaders(),
      ...(init?.headers ?? {}),
    },
  });
}

export function error(code: string, env: Env, status: number): Response {
  return json({ error: code }, env, { status });
}

export function preflight(env: Env): Response {
  return new Response(null, { status: 204, headers: { ...corsHeaders(env), ...securityHeaders() } });
}

// Better Auth's handler returns its own Response with no CORS headers, so
// browser calls to /api/auth/* get blocked ("No 'Access-Control-Allow-Origin'").
// Re-emit the response with the CORS headers merged in (preserving Set-Cookie
// and every other header Better Auth set).
export function withCors(res: Response, env: Env, req?: Request): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env, req))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Constant-time string comparison using WebCrypto HMAC. Both inputs are HMAC'd
// with an ephemeral random key producing fixed-length (32-byte) digests, so the
// final byte-wise compare runs in time independent of the inputs — closing the
// timing side channel a naive `===` on the raw tokens would open.
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const da = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

// Reject cross-site browser-driven mutations: if the request carries an Origin
// (always sent by browsers on cross-origin POST) or Referer, it must match
// ALLOWED_ORIGIN. Absent both (non-browser / same-origin clients), allow — this
// is the anon counterpart to CSRF double-submit for logged-in users.
export function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (origin) return isAllowedOrigin(origin, env);
  const referer = req.headers.get('Referer');
  if (referer) {
    try {
      return isAllowedOrigin(new URL(referer).origin, env);
    } catch {
      return false;
    }
  }
  return true;
}

export async function requireCsrf(req: Request, sessionCsrf: string): Promise<boolean> {
  const token = req.headers.get('X-CSRF-Token');
  if (!token || sessionCsrf.length === 0) return false;
  return timingSafeEqual(token, sessionCsrf);
}
