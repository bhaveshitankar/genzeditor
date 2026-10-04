import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { checkThrottle, recordStrike, clearThrottle } from '../src/throttle';

const K = 'otp:email:a@b.co';

beforeEach(async () => {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS auth_throttle (key TEXT PRIMARY KEY, strikes INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)',
  ).run();
  await env.DB.prepare('DELETE FROM auth_throttle').run();
});

describe('throttle backoff', () => {
  it('allows when no strikes', async () => {
    expect((await checkThrottle(env.DB, K)).allowed).toBe(true);
  });

  it('blocks and doubles cooldown per strike, capped at 1h', async () => {
    const t0 = 1_000_000;
    await recordStrike(env.DB, K, t0); // 30s
    let r = await checkThrottle(env.DB, K, t0 + 1000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(25);

    await recordStrike(env.DB, K, t0 + 1000); // 60s
    r = await checkThrottle(env.DB, K, t0 + 2000);
    expect(r.retryAfter).toBeGreaterThan(50);

    for (let i = 0; i < 12; i++) await recordStrike(env.DB, K, t0 + 2000);
    r = await checkThrottle(env.DB, K, t0 + 3000);
    expect(r.retryAfter).toBeLessThanOrEqual(3600);
  });

  it('clears on success', async () => {
    await recordStrike(env.DB, K, 1);
    await clearThrottle(env.DB, K);
    expect((await checkThrottle(env.DB, K, 2)).allowed).toBe(true);
  });
});
