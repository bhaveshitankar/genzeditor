// worker/src/auth.ts
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { D1Dialect } from 'kysely-d1';
import type { Env } from './env';
import { sendOtpEmail } from './email/resend';

// Let the concrete instance type infer; annotating as the generic
// Auth<BetterAuthOptions> widens and breaks structural assignability.
export function createAuth(env: Env) {
  const origins = env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.API_BASE_URL,
    basePath: '/api/auth',
    trustedOrigins: origins,
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: 'sqlite',
    },
    advanced: {
      crossSubDomainCookies: { enabled: true, domain: '.genzeditor.com' },
      defaultCookieAttributes: { sameSite: 'lax', secure: true, httpOnly: true },
    },
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        async sendVerificationOTP({ email, otp }) {
          await sendOtpEmail(env, email, otp);
        },
      }),
    ],
  });
}
