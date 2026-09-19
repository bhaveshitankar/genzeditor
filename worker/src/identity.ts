// worker/src/identity.ts
import type { Env } from './env';

export async function ipHash(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function ownerRef(req: Request, env: Env, userId: string | null): Promise<string> {
  if (userId) return userId;
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  return ipHash(ip, env.IP_HASH_SECRET);
}
