# Better Auth + Email OTP — Design

Date: 2026-10-04
Status: Approved design (pending spec review)

## Intent

As a new platform, prospective users hesitate to sign up with Google/GitHub
OAuth (they don't want to connect those accounts to an unknown app). We need a
low-trust-barrier **email signup** so people can register with just an email,
while keeping Google/GitHub for those who prefer it.

Success criteria:
- A user can sign up / sign in with **email + a 6-digit OTP code** (no password).
- Google and GitHub OAuth continue to work.
- Fake / mistyped / disposable emails are blocked **as much as practical** at our
  level.
- Sessions persist reliably across all mainstream browsers (no reliance on
  third-party cookies).

Non-goals: password login, social providers beyond Google/GitHub, multi-tenant
orgs, migrating existing user rows (new platform — clean cutover).

## Decisions (agreed)

- **Library:** Better Auth (full adoption — replaces custom `oauth.ts` +
  `sessions.ts`). Approach A.
- **Email method:** Email OTP (6-digit code), passwordless.
- **Email sender:** Resend (REST API from the Worker; free tier 3k/mo).
- **API domain:** move Worker to `api.genzeditor.com` for same-site cookies.
- **Bot/abuse:** Cloudflare Turnstile (free) + disposable-domain blocklist + MX
  check + rate limiting.

## Architecture

### Components
- **Worker (`api.genzeditor.com`)** — hosts Better Auth handler at
  `/api/auth/*`, plus existing app endpoints (`/api/share*`, `/api/health`).
- **Better Auth** — owns auth tables in D1, manages sessions/CSRF, Google +
  GitHub social, Email-OTP plugin.
- **Resend** — transactional email delivery for OTP codes.
- **Cloudflare Turnstile** — bot check on the OTP-request step.
- **SPA (`genzeditor.com`)** — Better Auth client for sign-in UI.

### Data model (D1)
Better Auth generates/owns: `user`, `session`, `account`, `verification`
(via its migration/CLI output committed as a new SQL migration).

Existing schema changes:
- **Drop** custom `users` and `sessions` tables (clean cutover).
- **Keep** `shares`, `quota_ledger`, `rate_limits` unchanged. `owner_ref` now
  stores Better Auth's `user.id`; `ownerRef()` logic in `identity.ts` unchanged
  (userId when logged in, IP-hash when anon).
- No `blocked_email_domains` table — disposable list is bundled; custom
  overrides live in a KV namespace (`BLOCKED_EMAIL_DOMAINS`) for redeploy-free
  additions.

### Endpoints
- `/api/auth/*` → Better Auth handler (replaces custom
  `/api/auth/{provider}/start|callback`, `/api/me`, `/api/logout`).
- App endpoints read the session via Better Auth's server `getSession` helper
  instead of custom cookie parsing / `getSession`.
- `requireCsrf` / double-submit retired (Better Auth handles CSRF + session
  tokens).
- `shares.ts`, `quota.ts`, `retention.ts`, `ratelimit.ts` unchanged except how
  they obtain `userId`.

## Email-OTP flow + temp-mail defenses

On OTP request (email entered), the Worker runs this pipeline **before**
generating any OTP (fail fast, cheapest checks first):

1. **Normalize** — trim + lowercase.
2. **Syntax** — basic RFC-ish shape validation.
3. **Turnstile verify** — POST token to Turnstile siteverify; reject on fail.
4. **Disposable-domain blocklist** — in-memory Set from the
   `disposable-email-domains` package (~60k domains), unioned with a custom
   KV list (`BLOCKED_EMAIL_DOMAINS`) editable without redeploy.
5. **MX record check** — DNS-over-HTTPS query to `https://cloudflare-dns.com/
   dns-query?type=MX` for the domain; reject if no MX records.
6. **Rate limit** — reuse `rate_limits`: max 3 OTP requests / 10 min per IP and
   per email.

Only if all pass: Better Auth Email-OTP plugin generates a 6-digit code
(TTL ~5 min, max ~3 verify attempts), stores it in `verification`, and
`sendVerificationOTP({ email, otp })` calls Resend to send it.

On verify: Better Auth checks the code → creates `user` (emailVerified=true),
`session`, `account` (type `email-otp`).

Known limitation: disposable-email blocking is cat-and-mouse; this stops the
large majority but cannot be 100%. The KV override list is the mechanism to
block newly discovered temp-mail domains quickly.

## Cookie / domain / OAuth

- Worker served at `api.genzeditor.com` (Workers custom domain binding).
- Better Auth config: `baseURL=https://api.genzeditor.com`; cookies
  `Domain=.genzeditor.com; SameSite=Lax; Secure; HttpOnly`;
  `trustedOrigins=[https://genzeditor.com, https://www.genzeditor.com,
  https://anyedits-aay.pages.dev, http://localhost:4173]`.
- Google/GitHub OAuth app redirect URIs updated to
  `https://api.genzeditor.com/api/auth/callback/{google|github}`.
- Client `API_BASE` → `https://api.genzeditor.com` (via `VITE_API_BASE`).
- Existing multi-origin CORS allowlist retained.

## Frontend

- Replace `src/auth/authUi.ts` sign-in modal with Better Auth client
  (`better-auth/client` + emailOTP + social plugins):
  `emailOtp.sendVerificationOtp(email)`, `signIn.emailOtp({ email, otp })`,
  `signIn.social('google'|'github')`, `signOut()`, `getSession()`.
- Modal UX: email field → "Send code" (renders Turnstile) → 6-digit code input
  → verify; plus "Continue with Google/GitHub" buttons.
- `AppShell.initAuth`/auth bar read the Better Auth session instead of custom
  `/api/me`.

## Error handling

- Each defense-layer rejection returns a distinct, user-safe error code
  (`disposable_email`, `no_mx`, `rate_limited`, `turnstile_failed`,
  `invalid_email`) surfaced as friendly copy in the modal.
- OTP verify failures: `invalid_code`, `expired_code`, `too_many_attempts`.
- Resend send failure → generic "couldn't send code, try again" + logged.

## Testing

- **Worker unit:** each defense layer (syntax, blocklist hit/miss, mocked MX
  response, rate limit, mocked Turnstile), OTP request + verify happy/failure
  paths. Keep share/quota tests; update session acquisition.
- **E2E (Playwright):** email-OTP signup using a test OTP hook / captured mail;
  assert OAuth buttons present.
- **Manual:** real Resend send once DNS verifies.

## Config / secrets

New Worker secrets: `RESEND_API_KEY`, `BETTER_AUTH_SECRET`,
`TURNSTILE_SECRET_KEY`. New client env: `VITE_TURNSTILE_SITE_KEY`,
`VITE_API_BASE=https://api.genzeditor.com`. New binding: KV
`BLOCKED_EMAIL_DOMAINS`. Resend DNS (SPF/DKIM) added on genzeditor.com.

## Rollout order

1. DNS: Resend SPF/DKIM + `api.genzeditor.com` Worker route.
2. D1 migration (Better Auth tables; drop old `users`/`sessions`).
3. Worker: Better Auth + Email-OTP + defense pipeline + Resend + Turnstile.
4. Update OAuth redirect URIs.
5. Frontend sign-in modal + client base URL.
6. Deploy worker + pages; verify flows.
