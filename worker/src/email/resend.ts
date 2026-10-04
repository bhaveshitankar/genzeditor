// worker/src/email/resend.ts
import type { Env } from '../env';

// Send a one-time passcode via the Resend REST API. Throws on non-2xx so the
// caller surfaces a send failure.
export async function sendOtpEmail(
  env: Env,
  to: string,
  otp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: `Your GenZ Editor code: ${otp}`,
      text: `Your sign-in code is ${otp}. It expires in 5 minutes. If you didn't request this, ignore this email.`,
    }),
  });
  if (!res.ok) throw new Error(`resend_failed_${res.status}`);
}
