// worker/src/turnstile.ts
import type { Env } from './env';

// Verify a Cloudflare Turnstile token (single-use) against siteverify.
export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  const res = await fetchImpl(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body },
  );
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}
