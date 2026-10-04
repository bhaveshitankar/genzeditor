import { describe, it, expect, vi } from 'vitest';
import { verifyTurnstile } from '../src/turnstile';

const env = { TURNSTILE_SECRET_KEY: 's' } as never;

describe('verifyTurnstile', () => {
  it('true on success', async () => {
    const f = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) });
    expect(await verifyTurnstile(env, 'tok', '1.2.3.4', f as unknown as typeof fetch)).toBe(true);
  });
  it('false on failure', async () => {
    const f = vi.fn().mockResolvedValue({ json: async () => ({ success: false }) });
    expect(await verifyTurnstile(env, 'tok', '1.2.3.4', f as unknown as typeof fetch)).toBe(false);
  });
  it('false on empty token (no network call)', async () => {
    const f = vi.fn();
    expect(await verifyTurnstile(env, '', '1.2.3.4', f as unknown as typeof fetch)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
