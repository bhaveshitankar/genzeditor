# Better Auth + Email OTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users sign up/sign in with an email + 6-digit OTP (passwordless) alongside Google/GitHub, with layered temp-mail blocking and exponential-backoff lockout, using Better Auth on the Cloudflare Worker.

**Architecture:** Adopt Better Auth as the single auth system (Approach A), backed by D1 via its Kysely dialect. Better Auth owns `user/session/account/verification`; the custom `oauth.ts`/`sessions.ts` are retired. A defense pipeline (Turnstile → disposable blocklist → MX check → rate limit + exponential backoff) guards the OTP-request step before any code is sent via Resend. The Worker moves to `api.genzeditor.com` so session cookies are same-site.

**Tech Stack:** Cloudflare Workers, D1, Better Auth (+ emailOTP plugin, Kysely D1 dialect), Resend REST API, Cloudflare Turnstile, `disposable-email-domains`, Vite/TS frontend.

**Spec:** `docs/superpowers/specs/2026-10-04-better-auth-email-otp-design.md`

## Global Constraints

- Node 20 (Cloudflare Pages pinned). Worker `compatibility_flags = ["nodejs_compat"]`.
- `owner_ref` must remain Better Auth's `user.id` when logged in, IP-hash when anon. Do not change `shares`/`quota_ledger`/`rate_limits` schemas.
- All auth cookies: `Domain=.genzeditor.com; SameSite=Lax; Secure; HttpOnly`.
- `trustedOrigins` / CORS allowlist: `https://genzeditor.com,https://www.genzeditor.com,https://anyedits-aay.pages.dev,http://localhost:4173`.
- OTP: 6 digits, TTL 5 min, max 3 verify attempts.
- Rate limit: 3 OTP requests / 10 min per IP and per email.
- Backoff: cooldown doubles 30s→1m→2m→…, capped at 1h; resets after 1h quiet.
- Never commit secrets. New secrets set via `wrangler secret put`.
- Use the per-project git email (bhavesh.itankar@gmail.com) — already configured.

## Review Focus

- **Email case/whitespace:** `  Bob@GMAIL.com ` and `bob@gmail.com` must be treated as the same account (normalize before lookup/throttle keys), else duplicate users / bypassed throttle.
- **DoH failure (MX check):** if Cloudflare DNS is unreachable/times out, the MX check must fail-open (allow) rather than block all signups during a DNS outage.
- **Throttle key isolation:** IP throttle and email throttle are separate keys; one attacker email must not lock out an innocent IP's other users, and a shared NAT IP must not permanently lock a whole office — email-key backoff is the stricter gate.
- **Turnstile token replay:** a used/expired Turnstile token must be rejected (Turnstile siteverify is single-use); don't cache a success.
- **Concurrent OTP requests:** two rapid requests for the same email must not both pass the rate limit (atomic increment), and the latest OTP invalidates prior ones.

---

## File Structure

**Worker (create):**
- `worker/src/auth.ts` — Better Auth instance factory (`createAuth(env)`): Kysely D1 dialect, social providers, emailOTP plugin wiring.
- `worker/src/email/validate.ts` — `normalizeEmail`, `isValidSyntax`, `isDisposable`, `hasMx`.
- `worker/src/email/disposable.ts` — bundled blocklist Set + KV override lookup.
- `worker/src/email/resend.ts` — `sendOtpEmail(env, to, otp)`.
- `worker/src/throttle.ts` — exponential backoff state machine over `auth_throttle`.
- `worker/src/turnstile.ts` — `verifyTurnstile(env, token, ip)`.
- `worker/migrations/0003_better_auth.sql` — Better Auth tables + drop old + `auth_throttle`.

**Worker (modify):**
- `worker/src/env.ts` — add bindings/secrets.
- `worker/src/router.ts` — mount `/api/auth/*`, read session via Better Auth, remove custom auth routes, add OTP-request pre-handler.
- `worker/wrangler.toml` — KV binding, custom domain note, vars.
- `worker/src/index.ts` — unchanged except CORS already handled.

**Worker (delete):** `worker/src/oauth.ts`, `worker/src/sessions.ts` (after cutover).

**Frontend (modify):**
- `src/auth/authClient.ts` (create) — Better Auth client.
- `src/auth/authUi.ts` — sign-in modal: email OTP + social + Turnstile + retryAfter.
- `src/api/client.ts` — `API_BASE`, session via auth client.
- `src/shell/AppShell.ts` — `initAuth`/auth bar via auth client.

---

## Task 1: Dependencies + Better Auth config skeleton

**Files:**
- Modify: `worker/package.json`, `package.json`
- Create: `worker/src/auth.ts`, `worker/src/env.ts` (modify)
- Test: `worker/test/auth.test.ts`

**Interfaces:**
- Produces: `createAuth(env: Env): ReturnType<typeof betterAuth>` and `type Auth`.

- [ ] **Step 1: Install deps**

```bash
cd worker && npm i better-auth kysely && npm i -D @types/node
cd .. && npm i better-auth
```

- [ ] **Step 2: Extend Env**

Add to `worker/src/env.ts` interface:

```ts
  KV_BLOCKED_EMAIL_DOMAINS: KVNamespace;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;              // e.g. "GenZ Editor <noreply@genzeditor.com>"
  TURNSTILE_SECRET_KEY: string;
```

- [ ] **Step 3: Write failing test for createAuth**

```ts
// worker/test/auth.test.ts
import { describe, it, expect } from 'vitest';
import { createAuth } from '../src/auth';

const env = {
  DB: {} as any, BETTER_AUTH_SECRET: 'x'.repeat(32), API_BASE_URL: 'https://api.genzeditor.com',
  ALLOWED_ORIGIN: 'https://genzeditor.com,http://localhost:4173',
  GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs', GITHUB_CLIENT_ID: 'h', GITHUB_CLIENT_SECRET: 'hs',
  RESEND_API_KEY: 'r', RESEND_FROM: 'x', TURNSTILE_SECRET_KEY: 't', KV_BLOCKED_EMAIL_DOMAINS: {} as any,
} as any;

describe('createAuth', () => {
  it('builds an auth instance with a handler and trusted origins', () => {
    const auth = createAuth(env);
    expect(typeof auth.handler).toBe('function');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd worker && npx vitest run test/auth.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `worker/src/auth.ts`**

```ts
// worker/src/auth.ts
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1'; // if unavailable, use better-auth's built-in dialect
import type { Env } from './env';
import { sendOtpEmail } from './email/resend';

export type Auth = ReturnType<typeof betterAuth>;

export function createAuth(env: Env): Auth {
  const origins = env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.API_BASE_URL,
    trustedOrigins: origins,
    database: { db: new Kysely({ dialect: new D1Dialect({ database: env.DB }) }), type: 'sqlite' },
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
        allowedAttempts: 3,
        async sendVerificationOTP({ email, otp }) {
          await sendOtpEmail(env, email, otp);
        },
      }),
    ],
  });
}
```

Note: if `kysely-d1` is not installed, add `npm i kysely-d1` in Step 1, or use Better Auth's documented Cloudflare D1 adapter. Create a minimal `worker/src/email/resend.ts` stub exporting `export async function sendOtpEmail(){}` so this compiles; Task 4 fills it.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd worker && npx vitest run test/auth.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/package.json worker/package-lock.json package.json package-lock.json worker/src/auth.ts worker/src/env.ts worker/src/email/resend.ts worker/test/auth.test.ts
git commit -m "feat(auth): add Better Auth instance factory with email-otp + social"
```

---

## Task 2: D1 migration — Better Auth tables, drop old, auth_throttle

**Files:**
- Create: `worker/migrations/0003_better_auth.sql`
- Test: `worker/test/schema.test.ts` (extend)

**Interfaces:**
- Produces: tables `user`, `session`, `account`, `verification`, `auth_throttle`.

- [ ] **Step 1: Generate Better Auth schema**

Run: `cd worker && npx @better-auth/cli generate --config src/auth.ts --output migrations/_ba.sql`
(If the CLI can't load the Worker config, copy the standard Better Auth SQLite schema for user/session/account/verification into the migration manually.)

- [ ] **Step 2: Write the migration**

Create `worker/migrations/0003_better_auth.sql` containing: (a) the Better Auth `CREATE TABLE` statements from Step 1; (b) then:

```sql
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

CREATE TABLE auth_throttle (
  key TEXT PRIMARY KEY,
  strikes INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_throttle_updated ON auth_throttle(updated_at);
```

- [ ] **Step 3: Write failing test**

```ts
// worker/test/schema.test.ts — add a case
it('0003 creates auth_throttle and better-auth user table', async () => {
  // apply migrations to an in-memory D1 via the test harness, then:
  const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user','auth_throttle')").all();
  expect(r.results.map((x:any)=>x.name).sort()).toEqual(['auth_throttle','user']);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd worker && npx vitest run test/schema.test.ts`
Expected: FAIL.

- [ ] **Step 5: Apply migration locally**

Run: `cd worker && npx wrangler d1 migrations apply anyedits-db --local`

- [ ] **Step 6: Run to verify it passes**

Run: `cd worker && npx vitest run test/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/migrations/0003_better_auth.sql worker/test/schema.test.ts
git commit -m "feat(auth): D1 migration for Better Auth tables + auth_throttle"
```

---

## Task 3: Email validation (normalize, syntax, disposable, MX)

**Files:**
- Create: `worker/src/email/validate.ts`, `worker/src/email/disposable.ts`
- Test: `worker/test/email-validate.test.ts`

**Interfaces:**
- Produces:
  - `normalizeEmail(raw: string): string`
  - `isValidSyntax(email: string): boolean`
  - `isDisposable(env: Env, domain: string): Promise<boolean>`
  - `hasMx(domain: string, fetchImpl?: typeof fetch): Promise<boolean>`

- [ ] **Step 1: Install blocklist**

```bash
cd worker && npm i disposable-email-domains
```

- [ ] **Step 2: Write failing tests**

```ts
// worker/test/email-validate.test.ts
import { describe, it, expect, vi } from 'vitest';
import { normalizeEmail, isValidSyntax, hasMx } from '../src/email/validate';

describe('email validate', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeEmail('  Bob@GMAIL.com ')).toBe('bob@gmail.com');
  });
  it('rejects bad syntax', () => {
    expect(isValidSyntax('nope')).toBe(false);
    expect(isValidSyntax('a@b.co')).toBe(true);
  });
  it('hasMx true when DoH returns MX answers', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Answer: [{ type: 15 }] }) }) as any;
    expect(await hasMx('gmail.com', f)).toBe(true);
  });
  it('hasMx false when no MX answers', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;
    expect(await hasMx('nope.invalid', f)).toBe(false);
  });
  it('hasMx fails open on DoH error', async () => {
    const f = vi.fn().mockRejectedValue(new Error('net')) as any;
    expect(await hasMx('gmail.com', f)).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `cd worker && npx vitest run test/email-validate.test.ts` → FAIL.

- [ ] **Step 4: Implement `disposable.ts`**

```ts
// worker/src/email/disposable.ts
import list from 'disposable-email-domains';
import type { Env } from '../env';

const BUNDLED = new Set<string>(list as string[]);

export async function isDisposableDomain(env: Env, domain: string): Promise<boolean> {
  if (BUNDLED.has(domain)) return true;
  const custom = await env.KV_BLOCKED_EMAIL_DOMAINS.get(domain);
  return custom !== null;
}
```

- [ ] **Step 5: Implement `validate.ts`**

```ts
// worker/src/email/validate.ts
import type { Env } from '../env';
import { isDisposableDomain } from './disposable';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidSyntax(email: string): boolean {
  return RE.test(email);
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export async function isDisposable(env: Env, domain: string): Promise<boolean> {
  return isDisposableDomain(env, domain);
}

// DoH MX lookup. Fails OPEN (returns true) on network error so a DNS outage
// does not block all signups.
export async function hasMx(domain: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) return true;
    const data = await res.json() as { Answer?: Array<{ type: number }> };
    return Array.isArray(data.Answer) && data.Answer.some((a) => a.type === 15);
  } catch {
    return true;
  }
}
```

- [ ] **Step 6: Run to verify pass**

Run: `cd worker && npx vitest run test/email-validate.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/src/email/validate.ts worker/src/email/disposable.ts worker/test/email-validate.test.ts
git commit -m "feat(auth): email normalization, syntax, disposable + MX checks"
```

---

## Task 4: Resend sender

**Files:**
- Modify: `worker/src/email/resend.ts`
- Test: `worker/test/resend.test.ts`

**Interfaces:**
- Produces: `sendOtpEmail(env: Env, to: string, otp: string, fetchImpl?: typeof fetch): Promise<void>` (throws on non-2xx).

- [ ] **Step 1: Write failing tests**

```ts
// worker/test/resend.test.ts
import { describe, it, expect, vi } from 'vitest';
import { sendOtpEmail } from '../src/email/resend';
const env = { RESEND_API_KEY: 'key', RESEND_FROM: 'GenZ <noreply@genzeditor.com>' } as any;

describe('sendOtpEmail', () => {
  it('posts to resend with the otp and from address', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }) as any;
    await sendOtpEmail(env, 'a@b.co', '123456', f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer key');
    expect(init.body).toContain('123456');
    expect(init.body).toContain('noreply@genzeditor.com');
  });
  it('throws on non-2xx', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad' }) as any;
    await expect(sendOtpEmail(env, 'a@b.co', '1', f)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd worker && npx vitest run test/resend.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// worker/src/email/resend.ts
import type { Env } from '../env';

export async function sendOtpEmail(
  env: Env, to: string, otp: string, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: `Your GenZ Editor code: ${otp}`,
      text: `Your sign-in code is ${otp}. It expires in 5 minutes. If you didn't request this, ignore this email.`,
    }),
  });
  if (!res.ok) throw new Error(`resend_failed_${res.status}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && npx vitest run test/resend.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/email/resend.ts worker/test/resend.test.ts
git commit -m "feat(auth): Resend OTP email sender"
```

---

## Task 5: Exponential backoff throttle

**Files:**
- Create: `worker/src/throttle.ts`
- Test: `worker/test/throttle.test.ts`

**Interfaces:**
- Produces:
  - `checkThrottle(db, key, now?): Promise<{ allowed: boolean; retryAfter: number }>` — retryAfter in seconds.
  - `recordStrike(db, key, now?): Promise<void>` — increments strikes, sets blocked_until with doubling cooldown capped at 1h.
  - `clearThrottle(db, key): Promise<void>` — on success.

- [ ] **Step 1: Write failing tests**

```ts
// worker/test/throttle.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { checkThrottle, recordStrike, clearThrottle } from '../src/throttle';

const K = 'otp:email:a@b.co';
beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_throttle').run(); });

describe('throttle backoff', () => {
  it('allows when no strikes', async () => {
    expect((await checkThrottle(env.DB, K)).allowed).toBe(true);
  });
  it('doubles cooldown per strike, capped at 1h', async () => {
    const t0 = 1_000_000;
    await recordStrike(env.DB, K, t0);           // 30s
    expect((await checkThrottle(env.DB, K, t0 + 1000)).retryAfter).toBeGreaterThan(25);
    await recordStrike(env.DB, K, t0 + 1000);    // 60s
    const r = await checkThrottle(env.DB, K, t0 + 2000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(50);
    // many strikes -> cap 3600s
    for (let i = 0; i < 12; i++) await recordStrike(env.DB, K, t0 + 2000);
    expect((await checkThrottle(env.DB, K, t0 + 3000)).retryAfter).toBeLessThanOrEqual(3600);
  });
  it('clears on success', async () => {
    await recordStrike(env.DB, K, 1);
    await clearThrottle(env.DB, K);
    expect((await checkThrottle(env.DB, K, 2)).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd worker && npx vitest run test/throttle.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// worker/src/throttle.ts
const BASE_MS = 30_000;       // first cooldown
const CAP_MS = 60 * 60_000;   // 1h cap
const QUIET_RESET_MS = 60 * 60_000; // reset strikes after 1h quiet
const FREE_STRIKES = 1;       // first strike incurs BASE cooldown

export async function checkThrottle(
  db: D1Database, key: string, now = Date.now(),
): Promise<{ allowed: boolean; retryAfter: number }> {
  const row = await db.prepare('SELECT strikes, blocked_until, updated_at FROM auth_throttle WHERE key = ?')
    .bind(key).first<{ strikes: number; blocked_until: number; updated_at: number }>();
  if (!row) return { allowed: true, retryAfter: 0 };
  if (now - row.updated_at >= QUIET_RESET_MS) return { allowed: true, retryAfter: 0 };
  if (row.blocked_until > now) return { allowed: false, retryAfter: Math.ceil((row.blocked_until - now) / 1000) };
  return { allowed: true, retryAfter: 0 };
}

function cooldownFor(strikes: number): number {
  if (strikes <= FREE_STRIKES) return BASE_MS;
  return Math.min(BASE_MS * 2 ** (strikes - FREE_STRIKES), CAP_MS);
}

export async function recordStrike(db: D1Database, key: string, now = Date.now()): Promise<void> {
  const row = await db.prepare('SELECT strikes, updated_at FROM auth_throttle WHERE key = ?')
    .bind(key).first<{ strikes: number; updated_at: number }>();
  const prior = (!row || now - row.updated_at >= QUIET_RESET_MS) ? 0 : row.strikes;
  const strikes = prior + 1;
  const blockedUntil = now + cooldownFor(strikes);
  await db.prepare(
    'INSERT INTO auth_throttle (key, strikes, blocked_until, updated_at) VALUES (?,?,?,?) ' +
    'ON CONFLICT(key) DO UPDATE SET strikes=excluded.strikes, blocked_until=excluded.blocked_until, updated_at=excluded.updated_at',
  ).bind(key, strikes, blockedUntil, now).run();
}

export async function clearThrottle(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM auth_throttle WHERE key = ?').bind(key).run();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && npx vitest run test/throttle.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/throttle.ts worker/test/throttle.test.ts
git commit -m "feat(auth): exponential-backoff throttle over auth_throttle"
```

---

## Task 6: Turnstile verification

**Files:**
- Create: `worker/src/turnstile.ts`
- Test: `worker/test/turnstile.test.ts`

**Interfaces:**
- Produces: `verifyTurnstile(env, token, ip, fetchImpl?): Promise<boolean>`.

- [ ] **Step 1: Write failing tests**

```ts
// worker/test/turnstile.test.ts
import { describe, it, expect, vi } from 'vitest';
import { verifyTurnstile } from '../src/turnstile';
const env = { TURNSTILE_SECRET_KEY: 's' } as any;

describe('verifyTurnstile', () => {
  it('true on success', async () => {
    const f = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) }) as any;
    expect(await verifyTurnstile(env, 'tok', '1.2.3.4', f)).toBe(true);
  });
  it('false on failure or missing token', async () => {
    const f = vi.fn().mockResolvedValue({ json: async () => ({ success: false }) }) as any;
    expect(await verifyTurnstile(env, 'tok', '1.2.3.4', f)).toBe(false);
    expect(await verifyTurnstile(env, '', '1.2.3.4', f)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail** → `cd worker && npx vitest run test/turnstile.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// worker/src/turnstile.ts
import type { Env } from './env';

export async function verifyTurnstile(
  env: Env, token: string, ip: string, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const data = await res.json() as { success: boolean };
  return data.success === true;
}
```

- [ ] **Step 4: Run to verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/turnstile.ts worker/test/turnstile.test.ts
git commit -m "feat(auth): Cloudflare Turnstile verification"
```

---

## Task 7: Mount Better Auth + OTP-request defense pre-handler in router

**Files:**
- Modify: `worker/src/router.ts`
- Delete: `worker/src/oauth.ts`, `worker/src/sessions.ts`
- Test: `worker/test/router.test.ts` (extend), `worker/test/otp-guard.test.ts` (create)

**Interfaces:**
- Consumes: `createAuth` (T1), validate (T3), throttle (T5), turnstile (T6), `sendOtpEmail` (T4), `ipHash`/`ownerRef` (existing).
- Produces: `/api/auth/*` routed to Better Auth; `POST /api/auth/email-otp/send-verification-otp` gated by the defense pipeline; session read via `auth.api.getSession`.

- [ ] **Step 1: Write failing guard test**

```ts
// worker/test/otp-guard.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM auth_throttle').run();
  await env.DB.prepare('DELETE FROM rate_limits').run();
});

function reqOtp(email: string, token = 'good') {
  return new Request('https://api.genzeditor.com/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'https://genzeditor.com', 'CF-Connecting-IP': '9.9.9.9' },
    body: JSON.stringify({ email, type: 'sign-in', turnstileToken: token }),
  });
}

describe('OTP request guard', () => {
  it('rejects disposable domains with disposable_email', async () => {
    const r = await SELF.fetch(reqOtp('x@mailinator.com'));
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toBe('disposable_email');
  });
  it('rejects missing turnstile', async () => {
    const r = await SELF.fetch(reqOtp('x@gmail.com', ''));
    expect((await r.json() as any).error).toBe('turnstile_failed');
  });
});
```

(For these tests, stub Turnstile + MX + Resend via a test-only `env` flag or `vi.mock`. If `cloudflare:test` can't mock module fetch, inject via a `env.TEST_BYPASS_TURNSTILE` guard set only in `worker/vitest.config.ts`.)

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Rewrite router auth section**

In `worker/src/router.ts`:
- Remove imports of `./oauth` and `./sessions`; remove `/api/me`, `/api/logout`, `/api/auth/(google|github)/start|callback` blocks and the `createSession`/`getSession` cookie logic.
- Add near the top of `handle`:

```ts
import { createAuth } from './auth';
import { normalizeEmail, isValidSyntax, domainOf, isDisposable, hasMx } from './email/validate';
import { checkThrottle, recordStrike, clearThrottle } from './throttle';
import { verifyTurnstile } from './turnstile';
import { ipHash } from './identity';

// ... inside handle(), after `const url = new URL(req.url);`
const auth = createAuth(env);

// Defense pipeline for the OTP-request endpoint, BEFORE delegating to Better Auth.
if (req.method === 'POST' && path === '/api/auth/email-otp/send-verification-otp') {
  const raw = await req.clone().json().catch(() => ({})) as { email?: string; turnstileToken?: string };
  const email = normalizeEmail(raw.email ?? '');
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const ipKey = `otp:ip:${await ipHash(ip, env.IP_HASH_SECRET)}`;
  const emailKey = `otp:email:${email}`;

  if (!isValidSyntax(email)) return error('invalid_email', env, 400);
  if (!(await verifyTurnstile(env, raw.turnstileToken ?? '', ip))) return error('turnstile_failed', env, 400);

  for (const key of [ipKey, emailKey]) {
    const t = await checkThrottle(env.DB, key);
    if (!t.allowed) return json({ error: 'rate_limited', retryAfter: t.retryAfter }, env, { status: 429 });
  }
  const domain = domainOf(email);
  if (await isDisposable(env, domain)) { await recordStrike(env.DB, emailKey); return error('disposable_email', env, 400); }
  if (!(await hasMx(domain))) { await recordStrike(env.DB, emailKey); return error('no_mx', env, 400); }

  // sliding window rate limit (reuse rate_limits)
  const rl1 = await rateLimit(env.DB, await ipHash(ip, env.IP_HASH_SECRET), 'otp_req', 3, 10 * 60_000);
  if (!rl1.ok) { await recordStrike(env.DB, ipKey); return json({ error: 'rate_limited', retryAfter: 600 }, env, { status: 429 }); }
}

// Delegate all /api/auth/* to Better Auth.
if (path.startsWith('/api/auth/')) {
  return auth.handler(req);
}
```

- Replace the custom `const session = await getSession(...)` with:

```ts
const sessionData = await auth.api.getSession({ headers: req.headers });
const userId = sessionData?.user?.id ?? null;
const owner = await ownerRef(req, env, userId);
```

- Add a success hook to clear throttle after a verified OTP: Better Auth fires account creation; simplest is to clear on next authenticated share call — OR add `databaseHooks.verification.after` in `auth.ts` to call `clearThrottle`. Implement in `auth.ts`:

```ts
// in createAuth plugins/emailOTP: after successful verify, clear throttle
// Better Auth exposes onVerify via plugin hooks; if not available in version,
// clear in router on the verify endpoint success (200) for email+emailKey.
```

If the installed Better Auth version lacks a verify hook, add after the `/api/auth/*` delegation for the verify path:

```ts
if (req.method === 'POST' && path === '/api/auth/sign-in/email-otp') {
  const res = await auth.handler(req);
  if (res.ok) {
    const raw = await req.clone().json().catch(() => ({})) as { email?: string };
    const email = normalizeEmail(raw.email ?? '');
    await clearThrottle(env.DB, `otp:email:${email}`);
  }
  return res;
}
```

(Place this block BEFORE the generic `/api/auth/*` delegation.)

- [ ] **Step 4: Delete dead files**

```bash
git rm worker/src/oauth.ts worker/src/sessions.ts
```

Remove their imports in `router.ts` and any test that imported them (`worker/test/oauth.test.ts`, `worker/test/sessions.test.ts`) — delete or rewrite those tests against Better Auth where still meaningful.

- [ ] **Step 5: Run to verify pass**

Run: `cd worker && npx vitest run` → all green (fix any share/quota test that read `userId` from the old session shape).

- [ ] **Step 6: Commit**

```bash
git add -A worker/
git commit -m "feat(auth): mount Better Auth, add OTP defense pipeline, retire custom oauth/sessions"
```

---

## Task 8: Worker config — bindings, vars, custom domain

**Files:**
- Modify: `worker/wrangler.toml`
- Test: manual (`wrangler deploy --dry-run`)

- [ ] **Step 1: Add KV + vars**

In `worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV_BLOCKED_EMAIL_DOMAINS"
id = "<created-below>"

[vars]
ALLOWED_ORIGIN = "https://genzeditor.com,https://www.genzeditor.com,https://anyedits-aay.pages.dev,http://localhost:4173"
API_BASE_URL = "https://api.genzeditor.com"

[[routes]]
pattern = "api.genzeditor.com"
custom_domain = true
```

- [ ] **Step 2: Create KV + custom domain**

```bash
cd worker
npx wrangler kv namespace create KV_BLOCKED_EMAIL_DOMAINS   # paste id into wrangler.toml
```

- [ ] **Step 3: Set secrets**

```bash
cd worker
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put RESEND_API_KEY        # paste Resend key
npx wrangler secret put RESEND_FROM           # "GenZ Editor <noreply@genzeditor.com>"
npx wrangler secret put TURNSTILE_SECRET_KEY  # from Turnstile dashboard
```

- [ ] **Step 4: Dry-run deploy**

Run: `cd worker && npx wrangler deploy --dry-run` → Expected: no binding/var errors.

- [ ] **Step 5: Commit**

```bash
git add worker/wrangler.toml
git commit -m "chore(auth): wrangler bindings, vars, api.genzeditor.com route"
```

---

## Task 9: Frontend — auth client + sign-in modal

**Files:**
- Create: `src/auth/authClient.ts`
- Modify: `src/auth/authUi.ts`, `src/api/client.ts`, `src/shell/AppShell.ts`
- Test: `tests/auth/authUi.test.ts`

**Interfaces:**
- Consumes: Worker `/api/auth/*`.
- Produces: `authClient` with `signIn.social`, `emailOtp.sendVerificationOtp`, `signIn.emailOtp`, `signOut`, `getSession`.

- [ ] **Step 1: Set API base + Turnstile site key**

In `.env` / Pages env: `VITE_API_BASE=https://api.genzeditor.com`, `VITE_TURNSTILE_SITE_KEY=<site key>`. Update `src/api/client.ts` default `API_BASE` to `https://api.genzeditor.com`.

- [ ] **Step 2: Create auth client**

```ts
// src/auth/authClient.ts
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: (import.meta.env?.VITE_API_BASE as string) ?? 'https://api.genzeditor.com',
  plugins: [emailOTPClient()],
});
```

- [ ] **Step 3: Write failing UI test**

```ts
// tests/auth/authUi.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openSignInModal } from '../../src/auth/authUi';

describe('sign-in modal', () => {
  it('renders email step with Send code and social buttons', () => {
    document.body.innerHTML = '';
    openSignInModal();
    expect(document.body.textContent).toContain('Send code');
    expect(document.querySelector('[data-role="oauth-google"]')).toBeTruthy();
    expect(document.querySelector('[data-role="otp-email"]')).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run to verify fail** → `npx vitest run tests/auth/authUi.test.ts` → FAIL.

- [ ] **Step 5: Implement modal**

Rewrite `openSignInModal` in `src/auth/authUi.ts` to render two steps:
- Step A: email input (`data-role="otp-email"`), a Turnstile container (`<div class="cf-turnstile" data-sitekey=...>` loaded via the Turnstile script), "Send code" button, and "Continue with Google/GitHub" buttons (`data-role="oauth-google"`, `data-role="oauth-github"`).
- Step B: 6-digit code input, "Verify" button, and a live `retryAfter` countdown that disables submit when a `429 { retryAfter }` is returned.

Wire handlers:

```ts
import { authClient } from './authClient';
// Send code:
async function onSend(email: string, turnstileToken: string) {
  const res = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in', fetchOptions: { headers: {} }, /* pass token in body */ });
  // On 429, read retryAfter and start countdown; on 400 show mapped message.
}
// Verify:
async function onVerify(email: string, otp: string) {
  await authClient.signIn.emailOtp({ email, otp });
  location.reload();
}
// Social:
googleBtn.onclick = () => authClient.signIn.social({ provider: 'google', callbackURL: location.origin });
githubBtn.onclick = () => authClient.signIn.social({ provider: 'github', callbackURL: location.origin });
```

Map error codes to copy: `disposable_email`→"Please use a non-disposable email.", `no_mx`→"That email domain can't receive mail.", `rate_limited`→"Too many attempts. Try again in {retryAfter}s.", `turnstile_failed`→"Please complete the challenge.", `invalid_code`/`expired_code`→"That code is wrong or expired.".

- [ ] **Step 6: Update AppShell auth**

In `src/shell/AppShell.ts` `initAuth`: replace `getMe()` with `authClient.getSession()`; map to `{ authenticated, email }`. `handleLogout` → `authClient.signOut()` then repaint.

- [ ] **Step 7: Run to verify pass** → PASS. Run full `npm test`.

- [ ] **Step 8: Commit**

```bash
git add src/auth/authClient.ts src/auth/authUi.ts src/api/client.ts src/shell/AppShell.ts tests/auth/authUi.test.ts
git commit -m "feat(auth): Better Auth client + email-OTP/social sign-in modal"
```

---

## Task 10: DNS, OAuth redirects, deploy, verify (manual + E2E)

**Files:**
- Create: `tests/e2e/auth-otp.spec.ts`

- [ ] **Step 1: Resend domain + DNS**

In Resend dashboard add domain `genzeditor.com`; add the SPF + DKIM records it shows into Cloudflare DNS (proxy OFF / DNS-only). Wait for "Verified".

- [ ] **Step 2: Turnstile widget**

In Cloudflare Turnstile create a widget for `genzeditor.com`; copy site key → `VITE_TURNSTILE_SITE_KEY`, secret → `TURNSTILE_SECRET_KEY` (Task 8 Step 3).

- [ ] **Step 3: OAuth redirect URIs**

Google Cloud console + GitHub OAuth app: set redirect URI to `https://api.genzeditor.com/api/auth/callback/google` and `.../github` respectively. Keep client id/secret as existing Worker secrets.

- [ ] **Step 4: Apply D1 migration remotely**

```bash
cd worker && npx wrangler d1 migrations apply anyedits-db --remote
```

- [ ] **Step 5: Deploy**

```bash
cd worker && npx wrangler deploy
cd .. && npm run deploy
```

- [ ] **Step 6: E2E smoke**

```ts
// tests/e2e/auth-otp.spec.ts
import { test, expect } from '@playwright/test';
test('sign-in modal shows email + social options', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByPlaceholder(/email/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /send code/i })).toBeVisible();
});
```

Run: `npx playwright test tests/e2e/auth-otp.spec.ts`.

- [ ] **Step 7: Manual verification**

- Request OTP to a real inbox → code arrives via Resend → verify → session persists across refresh (same-site cookie).
- `curl` disposable: `POST /api/auth/email-otp/send-verification-otp` with `x@mailinator.com` → `disposable_email`.
- Trigger repeated failures → observe `rate_limited` with growing `retryAfter`.
- Google + GitHub sign-in round-trip.

- [ ] **Step 8: Commit + open PR**

```bash
git add tests/e2e/auth-otp.spec.ts
git commit -m "test(auth): e2e smoke for sign-in modal"
git push -u origin feat/better-auth-email-otp
```

Then open a PR to `main`.
