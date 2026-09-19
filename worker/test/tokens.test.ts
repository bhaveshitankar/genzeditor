// worker/test/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { generateToken, hashToken } from '../src/tokens';

describe('tokens', () => {
  it('generates unique 128-bit base64url tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes -> 22 base64url chars
  });

  it('hashes deterministically to 64-hex', async () => {
    const t = 'abc';
    expect(await hashToken(t)).toBe(await hashToken(t));
    expect(await hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken('abc')).not.toBe(await hashToken('abd'));
  });
});
