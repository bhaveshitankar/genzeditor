import { describe, it, expect, vi } from 'vitest';
import { normalizeEmail, isValidSyntax, domainOf, hasMx } from '../src/email/validate';

describe('email validate', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeEmail('  Bob@GMAIL.com ')).toBe('bob@gmail.com');
  });
  it('validates syntax', () => {
    expect(isValidSyntax('nope')).toBe(false);
    expect(isValidSyntax('a@b.co')).toBe(true);
  });
  it('extracts domain', () => {
    expect(domainOf('a@b.co')).toBe('b.co');
  });
  it('hasMx true when DoH returns MX answers', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Answer: [{ type: 15 }] }) }) as unknown as typeof fetch;
    expect(await hasMx('gmail.com', f)).toBe(true);
  });
  it('hasMx false when no MX answers', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await hasMx('nope.invalid', f)).toBe(false);
  });
  it('hasMx fails open on DoH error', async () => {
    const f = vi.fn().mockRejectedValue(new Error('net')) as unknown as typeof fetch;
    expect(await hasMx('gmail.com', f)).toBe(true);
  });
});
