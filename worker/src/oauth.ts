// worker/src/oauth.ts
import type { Env } from './env';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function buildAuthUrl(
  provider: 'google' | 'github',
  env: Env,
  state: string,
  challenge: string,
  redirectUri: string,
): string {
  if (provider === 'google') {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'read:user user:email');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export async function exchangeCode(
  provider: 'google' | 'github',
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string,
  fetcher: Fetcher,
): Promise<{ ok: true; subject: string; email: string | null } | { ok: false; error: string }> {
  if (provider === 'google') {
    const tokenRes = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) return { ok: false, error: 'token_exchange_failed' };
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) return { ok: false, error: 'no_access_token' };
    const uiRes = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!uiRes.ok) return { ok: false, error: 'userinfo_failed' };
    const ui = (await uiRes.json()) as { sub: string; email?: string };
    return { ok: true, subject: ui.sub, email: ui.email ?? null };
  }

  const tokenRes = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) return { ok: false, error: 'token_exchange_failed' };
  const tok = (await tokenRes.json()) as { access_token?: string };
  if (!tok.access_token) return { ok: false, error: 'no_access_token' };
  const uiRes = await fetcher('https://api.github.com/user', {
    headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': 'anyedits', accept: 'application/json' },
  });
  if (!uiRes.ok) return { ok: false, error: 'userinfo_failed' };
  const ui = (await uiRes.json()) as { id: number; email?: string | null };
  return { ok: true, subject: String(ui.id), email: ui.email ?? null };
}
