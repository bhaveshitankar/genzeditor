// worker/test/identity.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { ipHash, ownerRef } from '../src/identity';

describe('identity', () => {
  it('ipHash is deterministic 64-hex and secret-dependent', async () => {
    const a = await ipHash('1.2.3.4', 'secret');
    const b = await ipHash('1.2.3.4', 'secret');
    const c = await ipHash('1.2.3.4', 'other');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('ownerRef prefers userId, falls back to hashed IP', async () => {
    const req = new Request('https://x/', { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
    expect(await ownerRef(req, env, 'user-1')).toBe('user-1');
    const anon = await ownerRef(req, env, null);
    expect(anon).toBe(await ipHash('9.9.9.9', env.IP_HASH_SECRET));
  });
});
