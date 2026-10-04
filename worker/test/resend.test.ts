import { describe, it, expect, vi } from 'vitest';
import { sendOtpEmail } from '../src/email/resend';

const env = { RESEND_API_KEY: 'key', RESEND_FROM: 'GenZ <noreply@genzeditor.com>' } as never;

describe('sendOtpEmail', () => {
  it('posts to resend with the otp and from address', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await sendOtpEmail(env, 'a@b.co', '123456', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    expect(init.body).toContain('123456');
    expect(init.body).toContain('noreply@genzeditor.com');
  });
  it('throws on non-2xx', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad' });
    await expect(sendOtpEmail(env, 'a@b.co', '1', f as unknown as typeof fetch)).rejects.toThrow();
  });
});
