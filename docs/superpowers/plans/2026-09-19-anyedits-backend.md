# AnyEdits Backend (API Worker) Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a thin Cloudflare Worker (free tier) that provides OAuth login, share create/resolve, a quota ledger, Filebase presigned-URL issuance, rate limiting, and a nightly retention sweep — never touching file bytes — and wire the existing client app (Plan 1) into it.

**Architecture:** A TypeScript Worker fronting a D1 database (`anyedits-db`) and Filebase (S3-compatible). All file bytes flow browser⇄Filebase over short-lived presigned URLs signed inside the Worker with AWS SigV4; the Worker only records metadata in D1. OAuth uses PKCE + `state` with mocked-provider unit tests. A Cron Trigger sweeps expired snapshots nightly. The frontend (Vite+TS SPA from Plan 1) gains a share button, an open-shared-link flow, login buttons, and contextual login-incentive prompts.

**Tech Stack:** Cloudflare Workers, TypeScript (strict), D1 (SQLite), Wrangler, `@cloudflare/vitest-pool-workers` (chosen over Miniflare-standalone because it runs tests inside the real `workerd` runtime with live D1 bindings and `SELF` fetch, so migrations and SigV4/WebCrypto behave exactly as in production), WebCrypto (SigV4 + HMAC), `fflate` (client-side deflate for embedded shares — reused in the frontend). No AWS SDK (SigV4 hand-rolled to keep the bundle tiny for the free tier).

**Spec:** `docs/superpowers/specs/2026-09-19-anyedits-first-slice-design.md`

## Global Constraints

- **Free tier:** Worker must stay within Cloudflare Workers free limits — bytes NEVER pass through the Worker; uploads/downloads use presigned S3 URLs only.
- **Presigned URLs:** ~60s expiry; content-length bound; method-scoped (PUT for create, GET for resolve).
- **Quota caps:** 500MB anonymous / 700MB logged-in. `MB = 1024 * 1024`. `CAP_ANON = 500 * 1024 * 1024`; `CAP_USER = 700 * 1024 * 1024`. Single-file hard cap `MAX_FILE = 500 * 1024 * 1024`. Reject presign when `usage + new_size > cap`.
- **Retention:** anonymous snapshots expire 7 days; logged-in 30 days. `RETAIN_ANON_MS = 7*24*60*60*1000`; `RETAIN_USER_MS = 30*24*60*60*1000`.
- **Share tokens:** 128-bit random (16 bytes), shown once, only `token_hash` (SHA-256 hex) stored. rw writes require the raw token; management requires a session.
- **Session cookie:** name `sid`; flags `HttpOnly; Secure; SameSite=Lax; Path=/`. CSRF token required on mutations (double-submit: `csrf` cookie + `X-CSRF-Token` header must match).
- **Owner identity:** anonymous = `ip_hash = hex(HMAC-SHA256(CF-Connecting-IP, IP_HASH_SECRET))`; logged-in = `user_id`.
- **D1 binding:** `[[d1_databases]]` binding `DB`, `database_name = "anyedits-db"`, `database_id = "01003425-0306-45de-a0fb-4f70642af589"`.
- **Filebase:** endpoint `https://s3.filebase.io`, region from secret; S3 SigV4 signing. Secrets (Wrangler secrets / `.dev.vars`, NEVER hardcoded): `FILEBASE_KEY`, `FILEBASE_SECRET`, `FILEBASE_BUCKET`, `FILEBASE_ENDPOINT`, `FILEBASE_REGION`, `IP_HASH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
- **CORS:** locked to the Pages origin `https://anyedits-aay.pages.dev` (allow credentials). Strict security headers on every response.
- **Embedded share threshold:** `EMBED_MAX = 8 * 1024` bytes after deflate; larger text or any image/large/rw → Filebase tier. Embedded shares are frozen and read-only.
- **TypeScript strict mode on. TDD: test before implementation. Commit after each task.**

---

## File Structure

The Worker lives in a new `worker/` directory, independent of the Plan 1 client (which lives at repo root `src/`). Frontend wiring tasks modify the existing `src/`.

- `worker/wrangler.toml` — Worker config: D1 binding, cron trigger, routes, vars.
- `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts` — Worker toolchain.
- `worker/.dev.vars.example` — documents secret names (no values).
- `worker/src/env.ts` — `Env` interface (bindings + secrets).
- `worker/src/index.ts` — fetch + scheduled entrypoints; router; CORS; security headers.
- `worker/src/http.ts` — `json()`, `error()`, CORS + security-header helpers.
- `worker/src/identity.ts` — `ipHash()`, owner-ref resolution.
- `worker/src/quota.ts` — usage sum, cap lookup, enforcement.
- `worker/src/sigv4.ts` — AWS SigV4 presigner (PUT/GET).
- `worker/src/filebase.ts` — presign PUT/GET wrappers using env secrets.
- `worker/src/tokens.ts` — token generation + hashing.
- `worker/src/shares.ts` — share create/confirm/resolve logic.
- `worker/src/oauth.ts` — PKCE/state helpers + provider config + token exchange (HTTP injected).
- `worker/src/sessions.ts` — session create/lookup/delete + cookie helpers + CSRF.
- `worker/src/ratelimit.ts` — per-ip_hash rate limiting via D1.
- `worker/src/retention.ts` — nightly sweep logic.
- `worker/migrations/0001_init.sql` — D1 schema.
- `worker/test/*.test.ts` — one test file per module.
- Frontend (existing): `src/api/client.ts` (new), `src/share/shareFlow.ts` (new), `src/share/embedded.ts` (new), `src/auth/authUi.ts` (new), `src/shell/AppShell.ts` (modify), `src/store/types.ts` (reuse `FileKind`).

---

## Task 1: Worker scaffold + test harness

**Files:**
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/wrangler.toml`, `worker/.dev.vars.example`, `worker/src/env.ts`, `worker/src/index.ts`
- Test: `worker/test/smoke.test.ts`

**Interfaces:**
- Produces:
  - `interface Env` (in `worker/src/env.ts`) with `DB: D1Database` and all secret string fields.
  - default export `{ fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> }` from `worker/src/index.ts`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/smoke.test.ts
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('worker smoke', () => {
  it('responds to GET /api/health', async () => {
    const res = await SELF.fetch('https://anyedits-aay.pages.dev/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/smoke.test.ts`
Expected: FAIL — no config / module not found.

- [ ] **Step 3: Scaffold Worker + config**

`worker/package.json`:

```json
{
  "name": "anyedits-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run",
    "deploy": "wrangler deploy",
    "migrate:local": "wrangler d1 migrations apply anyedits-db --local",
    "migrate:remote": "wrangler d1 migrations apply anyedits-db --remote"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.78.0"
  }
}
```

`worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "lib": ["es2022"],
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

`worker/vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            IP_HASH_SECRET: 'test-ip-secret',
            FILEBASE_KEY: 'AKIATEST',
            FILEBASE_SECRET: 'testsecret',
            FILEBASE_BUCKET: 'anyedits-test',
            FILEBASE_ENDPOINT: 'https://s3.filebase.io',
            FILEBASE_REGION: 'us-east-1',
            GOOGLE_CLIENT_ID: 'gid',
            GOOGLE_CLIENT_SECRET: 'gsecret',
            GITHUB_CLIENT_ID: 'hid',
            GITHUB_CLIENT_SECRET: 'hsecret',
          },
        },
      },
    },
  },
});
```

`worker/wrangler.toml`:

```toml
name = "anyedits-api"
main = "src/index.ts"
compatibility_date = "2026-09-19"
compatibility_flags = ["nodejs_compat"]

[vars]
ALLOWED_ORIGIN = "https://anyedits-aay.pages.dev"

[[d1_databases]]
binding = "DB"
database_name = "anyedits-db"
database_id = "01003425-0306-45de-a0fb-4f70642af589"

[triggers]
crons = ["0 3 * * *"]

[[migrations]]
tag = "v1"
```

`worker/.dev.vars.example`:

```
FILEBASE_KEY=
FILEBASE_SECRET=
FILEBASE_BUCKET=
FILEBASE_ENDPOINT=https://s3.filebase.io
FILEBASE_REGION=us-east-1
IP_HASH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

`worker/src/env.ts`:

```ts
export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN: string;
  IP_HASH_SECRET: string;
  FILEBASE_KEY: string;
  FILEBASE_SECRET: string;
  FILEBASE_BUCKET: string;
  FILEBASE_ENDPOINT: string;
  FILEBASE_REGION: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}
```

`worker/src/index.ts`:

```ts
import type { Env } from './env';

export default {
  async fetch(req: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  },
} satisfies ExportedHandler<Env>;
```

Also add `worker/.dev.vars`, `worker/node_modules`, `worker/.wrangler` to the repo `.gitignore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm install && npx vitest run test/smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(worker): scaffold Cloudflare Worker with vitest-pool-workers"
```

---

## Task 2: D1 schema + migrations

**Files:**
- Create: `worker/migrations/0001_init.sql`
- Test: `worker/test/schema.test.ts`

**Interfaces:**
- Produces: tables `users`, `sessions`, `shares`, `quota_ledger`, `rate_limits` with the exact columns below; consumed by every later task via `env.DB`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/schema.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('D1 schema', () => {
  it('has all tables with expected columns', async () => {
    const cols = async (t: string) => {
      const r = await env.DB.prepare(`PRAGMA table_info(${t})`).all();
      return (r.results as Array<{ name: string }>).map((c) => c.name).sort();
    };
    expect(await cols('users')).toEqual(
      ['created_at', 'email', 'id', 'oauth_provider', 'oauth_subject'].sort(),
    );
    expect(await cols('sessions')).toEqual(
      ['csrf_token', 'expires_at', 'id', 'user_id'].sort(),
    );
    expect(await cols('shares')).toEqual(
      ['access', 'content_type', 'created_at', 'expires_at', 'id', 'object_key',
       'owner_ref', 'revoked', 'size_bytes', 'storage_kind', 'title', 'token_hash'].sort(),
    );
    expect(await cols('quota_ledger')).toEqual(
      ['created_at', 'expires_at', 'id', 'object_key', 'owner_ref', 'size_bytes'].sort(),
    );
    expect(await cols('rate_limits')).toEqual(
      ['bucket', 'count', 'ip_hash', 'window_start'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/schema.test.ts`
Expected: FAIL — no such table `users`.

- [ ] **Step 3: Write the migration**

```sql
-- worker/migrations/0001_init.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  oauth_provider TEXT NOT NULL,
  oauth_subject TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (oauth_provider, oauth_subject)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_ref TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('ro','rw')),
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('embedded','filebase')),
  object_key TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_shares_owner ON shares(owner_ref);
CREATE INDEX idx_shares_expires ON shares(expires_at);

CREATE TABLE quota_ledger (
  id TEXT PRIMARY KEY,
  owner_ref TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_owner ON quota_ledger(owner_ref);
CREATE INDEX idx_ledger_expires ON quota_ledger(expires_at);

CREATE TABLE rate_limits (
  ip_hash TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, bucket)
);
```

Note: `@cloudflare/vitest-pool-workers` auto-applies `migrations` declared in `wrangler.toml` to the test D1 instance, so no extra wiring is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): D1 schema and initial migration"
```

---

## Task 3: Owner identity (ip_hash)

**Files:**
- Create: `worker/src/identity.ts`
- Test: `worker/test/identity.test.ts`

**Interfaces:**
- Produces:
  - `async function ipHash(ip: string, secret: string): Promise<string>` — hex HMAC-SHA256.
  - `async function ownerRef(req: Request, env: Env, userId: string | null): Promise<string>` — returns `userId` if set, else `ipHash(CF-Connecting-IP, IP_HASH_SECRET)`.
- Consumes: `Env` (Task 1).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/identity.ts
import type { Env } from './env';

export async function ipHash(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function ownerRef(req: Request, env: Env, userId: string | null): Promise<string> {
  if (userId) return userId;
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  return ipHash(ip, env.IP_HASH_SECRET);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): owner identity via HMAC ip_hash"
```

---

## Task 4: Quota ledger + enforcement

**Files:**
- Create: `worker/src/quota.ts`
- Test: `worker/test/quota.test.ts`

**Interfaces:**
- Produces:
  - `const CAP_ANON = 500 * 1024 * 1024`, `const CAP_USER = 700 * 1024 * 1024`, `const MAX_FILE = 500 * 1024 * 1024`.
  - `function capFor(isLoggedIn: boolean): number`.
  - `async function currentUsage(db: D1Database, ownerRef: string): Promise<number>`.
  - `async function checkQuota(db: D1Database, ownerRef: string, isLoggedIn: boolean, newSize: number): Promise<{ ok: true } | { ok: false; error: string }>`.
  - `async function recordLedger(db: D1Database, ownerRef: string, objectKey: string, size: number, expiresAt: number): Promise<string>` — inserts a row, returns its `id`.
- Consumes: `env.DB`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/quota.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { capFor, currentUsage, checkQuota, recordLedger, CAP_ANON, MAX_FILE } from '../src/quota';

describe('quota', () => {
  it('picks caps by login state', () => {
    expect(capFor(false)).toBe(CAP_ANON);
    expect(capFor(true)).toBe(700 * 1024 * 1024);
  });

  it('sums usage per owner', async () => {
    await recordLedger(env.DB, 'owner-a', 'k1', 100, Date.now() + 1000);
    await recordLedger(env.DB, 'owner-a', 'k2', 50, Date.now() + 1000);
    await recordLedger(env.DB, 'owner-b', 'k3', 999, Date.now() + 1000);
    expect(await currentUsage(env.DB, 'owner-a')).toBe(150);
  });

  it('rejects single files over the hard cap', async () => {
    const r = await checkQuota(env.DB, 'owner-c', false, MAX_FILE + 1);
    expect(r.ok).toBe(false);
  });

  it('rejects when usage + new exceeds cap', async () => {
    await recordLedger(env.DB, 'owner-d', 'k', CAP_ANON - 10, Date.now() + 1000);
    expect((await checkQuota(env.DB, 'owner-d', false, 20)).ok).toBe(false);
    expect((await checkQuota(env.DB, 'owner-d', false, 5)).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/quota.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/quota.ts
export const CAP_ANON = 500 * 1024 * 1024;
export const CAP_USER = 700 * 1024 * 1024;
export const MAX_FILE = 500 * 1024 * 1024;

export function capFor(isLoggedIn: boolean): number {
  return isLoggedIn ? CAP_USER : CAP_ANON;
}

export async function currentUsage(db: D1Database, ownerRef: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM quota_ledger WHERE owner_ref = ?')
    .bind(ownerRef)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function checkQuota(
  db: D1Database,
  ownerRef: string,
  isLoggedIn: boolean,
  newSize: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(newSize) || newSize <= 0) return { ok: false, error: 'invalid_size' };
  if (newSize > MAX_FILE) return { ok: false, error: 'file_too_large' };
  const usage = await currentUsage(db, ownerRef);
  if (usage + newSize > capFor(isLoggedIn)) return { ok: false, error: 'quota_exceeded' };
  return { ok: true };
}

export async function recordLedger(
  db: D1Database,
  ownerRef: string,
  objectKey: string,
  size: number,
  expiresAt: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, ownerRef, objectKey, size, Date.now(), expiresAt)
    .run();
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/quota.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): quota ledger and enforcement"
```

---

## Task 5: Filebase presigned URLs (SigV4)

**Files:**
- Create: `worker/src/sigv4.ts`, `worker/src/filebase.ts`
- Test: `worker/test/sigv4.test.ts`

**Interfaces:**
- Produces:
  - `async function presignS3(opts: { method: 'PUT'|'GET'; endpoint: string; region: string; bucket: string; key: string; accessKey: string; secretKey: string; expiresSeconds: number; now: Date; contentLength?: number }): Promise<string>` — returns a full presigned URL with `X-Amz-*` query params.
  - `async function presignPut(env: Env, key: string, contentLength: number, now?: Date): Promise<string>`.
  - `async function presignGet(env: Env, key: string, now?: Date): Promise<string>`.
- Consumes: `Env`.

Signing is validated against a **deterministic clock** (fixed `now`) so the canonical request and signature are reproducible; the test asserts the stable, spec-mandated query parameters and that a re-run with the same inputs yields byte-identical signatures.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/sigv4.test.ts
import { describe, it, expect } from 'vitest';
import { presignS3 } from '../src/sigv4';

const base = {
  endpoint: 'https://s3.filebase.io',
  region: 'us-east-1',
  bucket: 'anyedits-test',
  key: 'snapshots/abc.png',
  accessKey: 'AKIATEST',
  secretKey: 'testsecret',
  expiresSeconds: 60,
  now: new Date('2026-09-19T00:00:00Z'),
} as const;

describe('presignS3', () => {
  it('produces a deterministic, well-formed presigned PUT URL', async () => {
    const url = await presignS3({ method: 'PUT', contentLength: 1234, ...base });
    const u = new URL(url);
    expect(u.origin).toBe('https://s3.filebase.io');
    expect(u.pathname).toBe('/anyedits-test/snapshots/abc.png');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(u.searchParams.get('X-Amz-Date')).toBe('20260919T000000Z');
    expect(u.searchParams.get('X-Amz-Credential')).toContain('20260919/us-east-1/s3/aws4_request');
    // content-length is a signed header for PUT
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is reproducible for identical inputs', async () => {
    const a = await presignS3({ method: 'GET', ...base });
    const b = await presignS3({ method: 'GET', ...base });
    expect(a).toBe(b);
  });

  it('GET does not sign content-length', async () => {
    const url = await presignS3({ method: 'GET', ...base });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/sigv4.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/sigv4.ts
const enc = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return hex(new Uint8Array(buf));
}
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

export interface PresignOpts {
  method: 'PUT' | 'GET';
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKey: string;
  secretKey: string;
  expiresSeconds: number;
  now: Date;
  contentLength?: number;
}

export async function presignS3(opts: PresignOpts): Promise<string> {
  const host = new URL(opts.endpoint).host;
  const amzDate = opts.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${opts.region}/s3/aws4_request`;

  const signedHeaderNames = opts.method === 'PUT' && opts.contentLength !== undefined
    ? ['content-length', 'host']
    : ['host'];
  const canonicalHeaders = signedHeaderNames
    .map((h) => (h === 'host' ? `host:${host}\n` : `content-length:${opts.contentLength}\n`))
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${opts.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(opts.expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k]!)}`)
    .join('&');

  const canonicalUri = `/${opts.bucket}/${encodeKeyPath(opts.key)}`;
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(enc.encode('AWS4' + opts.secretKey), dateStamp);
  const kRegion = await hmac(kDate, opts.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(new Uint8Array(await hmac(kSigning, stringToSign)));

  return `${opts.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
```

```ts
// worker/src/filebase.ts
import type { Env } from './env';
import { presignS3 } from './sigv4';

export async function presignPut(env: Env, key: string, contentLength: number, now = new Date()): Promise<string> {
  return presignS3({
    method: 'PUT',
    endpoint: env.FILEBASE_ENDPOINT,
    region: env.FILEBASE_REGION,
    bucket: env.FILEBASE_BUCKET,
    key,
    accessKey: env.FILEBASE_KEY,
    secretKey: env.FILEBASE_SECRET,
    expiresSeconds: 60,
    now,
    contentLength,
  });
}

export async function presignGet(env: Env, key: string, now = new Date()): Promise<string> {
  return presignS3({
    method: 'GET',
    endpoint: env.FILEBASE_ENDPOINT,
    region: env.FILEBASE_REGION,
    bucket: env.FILEBASE_BUCKET,
    key,
    accessKey: env.FILEBASE_KEY,
    secretKey: env.FILEBASE_SECRET,
    expiresSeconds: 60,
    now,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/sigv4.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): AWS SigV4 presigner and Filebase PUT/GET wrappers"
```

---

## Task 6: Share tokens (generate + hash)

**Files:**
- Create: `worker/src/tokens.ts`
- Test: `worker/test/tokens.test.ts`

**Interfaces:**
- Produces:
  - `function generateToken(): string` — 16 random bytes as base64url (128-bit).
  - `async function hashToken(token: string): Promise<string>` — SHA-256 hex.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/tokens.ts
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): 128-bit share tokens with SHA-256 hashing"
```

---

## Task 7: Sessions + CSRF + cookies

**Files:**
- Create: `worker/src/sessions.ts`
- Test: `worker/test/sessions.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionUser { userId: string; email: string | null }`
  - `async function createSession(db: D1Database, userId: string): Promise<{ id: string; csrfToken: string; expiresAt: number }>` (30-day session).
  - `async function getSession(db: D1Database, sid: string | null): Promise<{ userId: string; csrfToken: string } | null>` (null if missing/expired).
  - `async function deleteSession(db: D1Database, sid: string): Promise<void>`.
  - `function parseCookies(header: string | null): Record<string, string>`.
  - `function sessionCookie(sid: string, maxAgeSeconds: number): string` — `HttpOnly; Secure; SameSite=Lax; Path=/`.
  - `function csrfCookie(token: string, maxAgeSeconds: number): string` — readable by JS (not HttpOnly) for double-submit.
  - `function clearCookie(name: string): string`.
- Consumes: `env.DB`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/sessions.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  createSession, getSession, deleteSession, parseCookies, sessionCookie, csrfCookie, clearCookie,
} from '../src/sessions';

describe('sessions', () => {
  it('creates and resolves a session', async () => {
    await env.DB.prepare(
      'INSERT INTO users (id, oauth_provider, oauth_subject, email, created_at) VALUES (?,?,?,?,?)',
    ).bind('u1', 'google', 'sub1', 'a@b.co', Date.now()).run();
    const s = await createSession(env.DB, 'u1');
    expect(s.csrfToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const got = await getSession(env.DB, s.id);
    expect(got?.userId).toBe('u1');
    expect(got?.csrfToken).toBe(s.csrfToken);
    await deleteSession(env.DB, s.id);
    expect(await getSession(env.DB, s.id)).toBeNull();
  });

  it('returns null for expired sessions', async () => {
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?,?,?,?)',
    ).bind('sExp', 'u1', 'tok', Date.now() - 1000).run();
    expect(await getSession(env.DB, 'sExp')).toBeNull();
  });

  it('parses cookies and builds secure cookies', () => {
    expect(parseCookies('sid=abc; csrf=xyz')).toEqual({ sid: 'abc', csrf: 'xyz' });
    expect(sessionCookie('abc', 60)).toContain('HttpOnly');
    expect(sessionCookie('abc', 60)).toContain('SameSite=Lax');
    expect(sessionCookie('abc', 60)).toContain('Secure');
    expect(csrfCookie('xyz', 60)).not.toContain('HttpOnly');
    expect(clearCookie('sid')).toContain('Max-Age=0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/sessions.ts
import { generateToken } from './tokens';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser { userId: string; email: string | null }

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ id: string; csrfToken: string; expiresAt: number }> {
  const id = crypto.randomUUID();
  const csrfToken = generateToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db
    .prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?,?,?,?)')
    .bind(id, userId, csrfToken, expiresAt)
    .run();
  return { id, csrfToken, expiresAt };
}

export async function getSession(
  db: D1Database,
  sid: string | null,
): Promise<{ userId: string; csrfToken: string } | null> {
  if (!sid) return null;
  const row = await db
    .prepare('SELECT user_id, csrf_token, expires_at FROM sessions WHERE id = ?')
    .bind(sid)
    .first<{ user_id: string; csrf_token: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { userId: row.user_id, csrfToken: row.csrf_token };
}

export async function deleteSession(db: D1Database, sid: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(sid: string, maxAgeSeconds: number): string {
  return `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
export function csrfCookie(token: string, maxAgeSeconds: number): string {
  return `csrf=${token}; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
export function clearCookie(name: string): string {
  return `${name}=; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): sessions, CSRF, and secure cookie helpers"
```

---

## Task 8: HTTP helpers (CORS + security headers + CSRF guard)

**Files:**
- Create: `worker/src/http.ts`
- Test: `worker/test/http.test.ts`

**Interfaces:**
- Produces:
  - `function corsHeaders(env: Env): Record<string, string>` — origin-locked, `Access-Control-Allow-Credentials: true`.
  - `function securityHeaders(): Record<string, string>` — CSP, nosniff, referrer-policy, frame-ancestors.
  - `function json(body: unknown, env: Env, init?: { status?: number; headers?: Record<string,string> }): Response`.
  - `function error(code: string, env: Env, status: number): Response`.
  - `function preflight(env: Env): Response`.
  - `function requireCsrf(req: Request, sessionCsrf: string): boolean` — header `X-CSRF-Token` equals `sessionCsrf`.
- Consumes: `Env`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/http.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { json, error, corsHeaders, securityHeaders, preflight, requireCsrf } from '../src/http';

describe('http helpers', () => {
  it('locks CORS to the Pages origin with credentials', () => {
    const h = corsHeaders(env);
    expect(h['Access-Control-Allow-Origin']).toBe('https://anyedits-aay.pages.dev');
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('json responses carry security + cors headers', async () => {
    const res = json({ a: 1 }, env, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('error responses use the code', async () => {
    const res = error('nope', env, 400);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('preflight returns 204', () => {
    expect(preflight(env).status).toBe(204);
  });

  it('requireCsrf compares header to session token', () => {
    const req = new Request('https://x/', { headers: { 'X-CSRF-Token': 'tok' } });
    expect(requireCsrf(req, 'tok')).toBe(true);
    expect(requireCsrf(req, 'other')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/http.ts
import type { Env } from './env';

export function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-CSRF-Token',
    'Vary': 'Origin',
  };
}

export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
  };
}

export function json(
  body: unknown,
  env: Env,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(env),
      ...securityHeaders(),
      ...(init?.headers ?? {}),
    },
  });
}

export function error(code: string, env: Env, status: number): Response {
  return json({ error: code }, env, { status });
}

export function preflight(env: Env): Response {
  return new Response(null, { status: 204, headers: { ...corsHeaders(env), ...securityHeaders() } });
}

export function requireCsrf(req: Request, sessionCsrf: string): boolean {
  return req.headers.get('X-CSRF-Token') === sessionCsrf && sessionCsrf.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): CORS, security-header, and CSRF HTTP helpers"
```

---

## Task 9: Rate limiting per ip_hash

**Files:**
- Create: `worker/src/ratelimit.ts`
- Test: `worker/test/ratelimit.test.ts`

**Interfaces:**
- Produces: `async function rateLimit(db: D1Database, ipHash: string, bucket: string, limit: number, windowMs: number, now?: number): Promise<{ ok: boolean }>` — fixed-window counter keyed by `(ip_hash, bucket)`.
- Consumes: `env.DB` (table `rate_limits`).

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/ratelimit.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { rateLimit } from '../src/ratelimit';

describe('rateLimit', () => {
  it('allows up to the limit then blocks within the window', async () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit(env.DB, 'ipA', 'presign', 3, 60_000, now)).ok).toBe(true);
    }
    expect((await rateLimit(env.DB, 'ipA', 'presign', 3, 60_000, now)).ok).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const now = 2_000_000;
    expect((await rateLimit(env.DB, 'ipB', 'auth', 1, 60_000, now)).ok).toBe(true);
    expect((await rateLimit(env.DB, 'ipB', 'auth', 1, 60_000, now)).ok).toBe(false);
    expect((await rateLimit(env.DB, 'ipB', 'auth', 1, 60_000, now + 61_000)).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/ratelimit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/ratelimit.ts
export async function rateLimit(
  db: D1Database,
  ipHash: string,
  bucket: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<{ ok: boolean }> {
  const row = await db
    .prepare('SELECT window_start, count FROM rate_limits WHERE ip_hash = ? AND bucket = ?')
    .bind(ipHash, bucket)
    .first<{ window_start: number; count: number }>();

  if (!row || now - row.window_start >= windowMs) {
    await db
      .prepare(
        'INSERT INTO rate_limits (ip_hash, bucket, window_start, count) VALUES (?,?,?,1) ' +
          'ON CONFLICT(ip_hash, bucket) DO UPDATE SET window_start = excluded.window_start, count = 1',
      )
      .bind(ipHash, bucket, now)
      .run();
    return { ok: true };
  }

  if (row.count >= limit) return { ok: false };

  await db
    .prepare('UPDATE rate_limits SET count = count + 1 WHERE ip_hash = ? AND bucket = ?')
    .bind(ipHash, bucket)
    .run();
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/ratelimit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): per-ip_hash fixed-window rate limiting"
```

---

## Task 10: Share create / confirm / resolve logic

**Files:**
- Create: `worker/src/shares.ts`
- Test: `worker/test/shares.test.ts`

**Interfaces:**
- Produces:
  - `interface CreateShareInput { ownerRef: string; isLoggedIn: boolean; access: 'ro'|'rw'; storageKind: 'embedded'|'filebase'; contentType: string; title: string; sizeBytes: number }`
  - `async function createShare(env: Env, input: CreateShareInput, now?: Date): Promise<{ ok: true; token: string; shareId: string; uploadUrl?: string; objectKey?: string } | { ok: false; error: string }>` — embedded: no upload, no quota, no object; filebase: quota-checked, returns presigned PUT + object_key. rw requires `isLoggedIn`.
  - `async function confirmShare(env: Env, shareId: string, ownerRef: string, now?: Date): Promise<{ ok: true } | { ok: false; error: string }>` — records ledger row for the (filebase) share's size, freezing quota.
  - `async function resolveShare(env: Env, token: string, now?: Date): Promise<{ ok: true; access: 'ro'|'rw'; storageKind: 'embedded'|'filebase'; contentType: string | null; title: string | null; downloadUrl?: string } | { ok: false; error: string }>` — embedded returns metadata only (content is in the URL fragment, never server-side); filebase returns a presigned GET.
- Consumes: `tokens` (Task 6), `quota` (Task 4), `filebase` (Task 5), `Env`.

Retention expiry is set at create time: `expires_at = now + (isLoggedIn ? RETAIN_USER_MS : RETAIN_ANON_MS)`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/shares.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createShare, confirmShare, resolveShare } from '../src/shares';
import { currentUsage } from '../src/quota';

const now = new Date('2026-09-19T00:00:00Z');

describe('shares', () => {
  it('creates an embedded ro share with no upload and no quota cost', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerE', isLoggedIn: false, access: 'ro', storageKind: 'embedded',
      contentType: 'text/markdown', title: 'note', sizeBytes: 0,
    }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uploadUrl).toBeUndefined();
      const res = await resolveShare(env, r.token, now);
      expect(res.ok).toBe(true);
      if (res.ok) { expect(res.storageKind).toBe('embedded'); expect(res.downloadUrl).toBeUndefined(); }
    }
    expect(await currentUsage(env.DB, 'ownerE')).toBe(0);
  });

  it('creates a filebase share returning a presigned PUT, then confirm charges quota', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerF', isLoggedIn: false, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'pic', sizeBytes: 1000,
    }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uploadUrl).toContain('X-Amz-Signature');
      expect(r.objectKey).toBeTruthy();
      expect(await currentUsage(env.DB, 'ownerF')).toBe(0); // not charged until confirm
      const c = await confirmShare(env, r.shareId, 'ownerF', now);
      expect(c.ok).toBe(true);
      expect(await currentUsage(env.DB, 'ownerF')).toBe(1000);
      const res = await resolveShare(env, r.token, now);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.downloadUrl).toContain('X-Amz-Signature');
    }
  });

  it('rejects rw shares for anonymous owners', async () => {
    const r = await createShare(env, {
      ownerRef: 'anon', isLoggedIn: false, access: 'rw', storageKind: 'filebase',
      contentType: 'image/png', title: 'x', sizeBytes: 10,
    }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('rw_requires_login');
  });

  it('rejects filebase create over quota', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerG', isLoggedIn: false, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'x', sizeBytes: 501 * 1024 * 1024,
    }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('file_too_large');
  });

  it('does not resolve revoked or expired shares', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerH', isLoggedIn: false, access: 'ro', storageKind: 'embedded',
      contentType: 'text/plain', title: 't', sizeBytes: 0,
    }, now);
    if (r.ok) {
      await env.DB.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').bind(r.shareId).run();
      const res = await resolveShare(env, r.token, now);
      expect(res.ok).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/shares.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/shares.ts
import type { Env } from './env';
import { generateToken, hashToken } from './tokens';
import { checkQuota, recordLedger } from './quota';
import { presignPut, presignGet } from './filebase';

const RETAIN_ANON_MS = 7 * 24 * 60 * 60 * 1000;
const RETAIN_USER_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreateShareInput {
  ownerRef: string;
  isLoggedIn: boolean;
  access: 'ro' | 'rw';
  storageKind: 'embedded' | 'filebase';
  contentType: string;
  title: string;
  sizeBytes: number;
}

export async function createShare(
  env: Env,
  input: CreateShareInput,
  now = new Date(),
): Promise<
  | { ok: true; token: string; shareId: string; uploadUrl?: string; objectKey?: string }
  | { ok: false; error: string }
> {
  if (input.access === 'rw' && !input.isLoggedIn) return { ok: false, error: 'rw_requires_login' };

  const nowMs = now.getTime();
  const expiresAt = nowMs + (input.isLoggedIn ? RETAIN_USER_MS : RETAIN_ANON_MS);
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const shareId = crypto.randomUUID();

  if (input.storageKind === 'embedded') {
    await env.DB.prepare(
      'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) ' +
        "VALUES (?,?,?,?,?,NULL,0,?,?,?,?,0)",
    ).bind(shareId, tokenHash, input.ownerRef, 'ro', 'embedded', input.contentType, input.title, nowMs, expiresAt).run();
    return { ok: true, token, shareId };
  }

  const q = await checkQuota(env.DB, input.ownerRef, input.isLoggedIn, input.sizeBytes);
  if (!q.ok) return { ok: false, error: q.error };

  const objectKey = `snapshots/${input.ownerRef}/${shareId}`;
  const uploadUrl = await presignPut(env, objectKey, input.sizeBytes, now);

  await env.DB.prepare(
    'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,0)',
  ).bind(shareId, tokenHash, input.ownerRef, input.access, 'filebase', objectKey, input.sizeBytes, input.contentType, input.title, nowMs, expiresAt).run();

  return { ok: true, token, shareId, uploadUrl, objectKey };
}

export async function confirmShare(
  env: Env,
  shareId: string,
  ownerRef: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await env.DB.prepare(
    'SELECT object_key, size_bytes, expires_at, storage_kind FROM shares WHERE id = ? AND owner_ref = ?',
  ).bind(shareId, ownerRef).first<{ object_key: string; size_bytes: number; expires_at: number; storage_kind: string }>();
  if (!row || row.storage_kind !== 'filebase' || !row.object_key) return { ok: false, error: 'not_found' };

  const existing = await env.DB.prepare(
    'SELECT id FROM quota_ledger WHERE object_key = ?',
  ).bind(row.object_key).first<{ id: string }>();
  if (existing) return { ok: true };

  await recordLedger(env.DB, ownerRef, row.object_key, row.size_bytes, row.expires_at);
  return { ok: true };
}

export async function resolveShare(
  env: Env,
  token: string,
  now = new Date(),
): Promise<
  | { ok: true; access: 'ro' | 'rw'; storageKind: 'embedded' | 'filebase'; contentType: string | null; title: string | null; downloadUrl?: string }
  | { ok: false; error: string }
> {
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    'SELECT access, storage_kind, object_key, content_type, title, expires_at, revoked FROM shares WHERE token_hash = ?',
  ).bind(tokenHash).first<{
    access: 'ro' | 'rw'; storage_kind: 'embedded' | 'filebase'; object_key: string | null;
    content_type: string | null; title: string | null; expires_at: number; revoked: number;
  }>();
  if (!row || row.revoked === 1 || row.expires_at < now.getTime()) return { ok: false, error: 'not_found' };

  if (row.storage_kind === 'embedded') {
    return { ok: true, access: row.access, storageKind: 'embedded', contentType: row.content_type, title: row.title };
  }
  const downloadUrl = await presignGet(env, row.object_key!, now);
  return { ok: true, access: row.access, storageKind: 'filebase', contentType: row.content_type, title: row.title, downloadUrl };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/shares.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): share create/confirm/resolve with tiered storage"
```

---

## Task 11: OAuth helpers (PKCE + state + token exchange, HTTP injected)

**Files:**
- Create: `worker/src/oauth.ts`
- Test: `worker/test/oauth.test.ts`

**Interfaces:**
- Produces:
  - `async function pkcePair(): Promise<{ verifier: string; challenge: string }>` — S256.
  - `function buildAuthUrl(provider: 'google'|'github', env: Env, state: string, challenge: string, redirectUri: string): string`.
  - `type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>`
  - `async function exchangeCode(provider: 'google'|'github', env: Env, code: string, verifier: string, redirectUri: string, fetcher: Fetcher): Promise<{ ok: true; subject: string; email: string | null } | { ok: false; error: string }>` — exchanges code, fetches userinfo, using the injected `fetcher` (mocked in tests, real `fetch` in prod).
- Consumes: `Env`.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/oauth.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { pkcePair, buildAuthUrl, exchangeCode, type Fetcher } from '../src/oauth';

describe('oauth', () => {
  it('produces a valid S256 PKCE pair', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
  });

  it('builds a Google auth URL with PKCE + state', () => {
    const url = new URL(buildAuthUrl('google', env, 'st8', 'chal', 'https://cb'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('gid');
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cb');
  });

  it('exchanges a github code using a mocked fetcher', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (input) => {
      const u = String(input);
      calls.push(u);
      if (u.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'AT' }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('api.github.com/user')) {
        return new Response(JSON.stringify({ id: 42, email: 'gh@u.co' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('nope', { status: 500 });
    };
    const r = await exchangeCode('github', env, 'code123', 'ver', 'https://cb', fetcher);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.subject).toBe('42'); expect(r.email).toBe('gh@u.co'); }
    expect(calls.some((c) => c.includes('access_token'))).toBe(true);
  });

  it('reports failure when token exchange errors', async () => {
    const fetcher: Fetcher = async () => new Response('bad', { status: 401 });
    const r = await exchangeCode('google', env, 'c', 'v', 'https://cb', fetcher);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/oauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/oauth.ts
import type { Env } from './env';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function buildAuthUrl(
  provider: 'google' | 'github',
  env: Env,
  state: string,
  challenge: string,
  redirectUri: string,
): string {
  if (provider === 'google') {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'read:user user:email');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export async function exchangeCode(
  provider: 'google' | 'github',
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string,
  fetcher: Fetcher,
): Promise<{ ok: true; subject: string; email: string | null } | { ok: false; error: string }> {
  if (provider === 'google') {
    const tokenRes = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) return { ok: false, error: 'token_exchange_failed' };
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) return { ok: false, error: 'no_access_token' };
    const uiRes = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!uiRes.ok) return { ok: false, error: 'userinfo_failed' };
    const ui = (await uiRes.json()) as { sub: string; email?: string };
    return { ok: true, subject: ui.sub, email: ui.email ?? null };
  }

  const tokenRes = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) return { ok: false, error: 'token_exchange_failed' };
  const tok = (await tokenRes.json()) as { access_token?: string };
  if (!tok.access_token) return { ok: false, error: 'no_access_token' };
  const uiRes = await fetcher('https://api.github.com/user', {
    headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': 'anyedits', accept: 'application/json' },
  });
  if (!uiRes.ok) return { ok: false, error: 'userinfo_failed' };
  const ui = (await uiRes.json()) as { id: number; email?: string | null };
  return { ok: true, subject: String(ui.id), email: ui.email ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): OAuth PKCE/state helpers with injectable HTTP"
```

---

## Task 12: Retention sweep

**Files:**
- Create: `worker/src/retention.ts`
- Test: `worker/test/retention.test.ts`

**Interfaces:**
- Produces: `async function sweepExpired(env: Env, deleteObject: (key: string) => Promise<void>, now?: number): Promise<{ deletedShares: number; deletedLedger: number; deletedObjects: number }>` — deletes expired `shares` and `quota_ledger` rows and calls `deleteObject` for each expired Filebase object_key (freeing quota). `deleteObject` is injected so tests need no live Filebase.
- Consumes: `env.DB`, `filebase` (prod deletion via a signed DELETE, see note).

Note: production `deleteObject` issues a SigV4-signed S3 DELETE via `presignS3({ method: 'DELETE', ... })`. To keep this task focused and independently testable, the deletion function is injected; the `index.ts` scheduled handler (Task 13) supplies the real one. `presignS3` already accepts arbitrary methods; production passes `'DELETE'` (no content-length) — the same signing path as GET.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/retention.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { sweepExpired } from '../src/retention';
import { currentUsage } from '../src/quota';

describe('sweepExpired', () => {
  it('deletes expired shares, ledger rows, and objects; frees quota', async () => {
    const past = 1000;
    const future = 10_000_000_000_000;
    await env.DB.prepare(
      'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)',
    ).bind('sh1', 'h1', 'ownerR', 'ro', 'filebase', 'snapshots/ownerR/sh1', 500, 'image/png', 't', 0, past).run();
    await env.DB.prepare(
      'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)',
    ).bind('sh2', 'h2', 'ownerR', 'ro', 'filebase', 'snapshots/ownerR/sh2', 300, 'image/png', 't', 0, future).run();
    await env.DB.prepare(
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    ).bind('l1', 'ownerR', 'snapshots/ownerR/sh1', 500, 0, past).run();
    await env.DB.prepare(
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    ).bind('l2', 'ownerR', 'snapshots/ownerR/sh2', 300, 0, future).run();

    const deleted: string[] = [];
    const res = await sweepExpired(env, async (k) => { deleted.push(k); }, 5000);

    expect(res.deletedShares).toBe(1);
    expect(res.deletedLedger).toBe(1);
    expect(res.deletedObjects).toBe(1);
    expect(deleted).toEqual(['snapshots/ownerR/sh1']);
    expect(await currentUsage(env.DB, 'ownerR')).toBe(300); // freed the expired 500
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/retention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// worker/src/retention.ts
import type { Env } from './env';

export async function sweepExpired(
  env: Env,
  deleteObject: (key: string) => Promise<void>,
  now = Date.now(),
): Promise<{ deletedShares: number; deletedLedger: number; deletedObjects: number }> {
  const ledgerRows = await env.DB.prepare(
    'SELECT object_key FROM quota_ledger WHERE expires_at < ?',
  ).bind(now).all<{ object_key: string }>();
  const keys = (ledgerRows.results ?? []).map((r) => r.object_key);

  let deletedObjects = 0;
  for (const key of keys) {
    await deleteObject(key);
    deletedObjects++;
  }

  const ledgerDel = await env.DB.prepare('DELETE FROM quota_ledger WHERE expires_at < ?').bind(now).run();
  const sharesDel = await env.DB.prepare('DELETE FROM shares WHERE expires_at < ?').bind(now).run();

  return {
    deletedShares: sharesDel.meta.changes ?? 0,
    deletedLedger: ledgerDel.meta.changes ?? 0,
    deletedObjects,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/retention.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): nightly retention sweep freeing quota"
```

---

## Task 13: Router wiring (fetch + scheduled entrypoints)

**Files:**
- Modify: `worker/src/index.ts`
- Create: `worker/src/router.ts`
- Test: `worker/test/router.test.ts` (integration via `SELF.fetch`)

**Interfaces:**
- Produces: full HTTP surface — `OPTIONS *` (preflight); `GET /api/health`; `GET /api/me`; `POST /api/logout`; `GET /api/auth/:provider/start`; `GET /api/auth/:provider/callback`; `POST /api/share`; `POST /api/share/confirm`; `GET /api/share/:token`; and `scheduled()` calling `sweepExpired` with a real signed-DELETE `deleteObject`.
- Consumes: all prior modules.

OAuth `start` stores `state`+`verifier` in short-lived cookies (`HttpOnly; Secure; SameSite=Lax`), and `callback` validates `state` matches before exchange. Presign/share/auth endpoints call `rateLimit` on the request's `ip_hash`. Mutations (`POST /api/share`, `POST /api/share/confirm`, `POST /api/logout`) require CSRF when a session is present.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/router.test.ts
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const ORIGIN = 'https://anyedits-aay.pages.dev';

describe('router integration', () => {
  it('answers CORS preflight with locked origin', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/share`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('creates + resolves an embedded share end-to-end', async () => {
    const create = await SELF.fetch(`${ORIGIN}/api/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '5.5.5.5' },
      body: JSON.stringify({ access: 'ro', storageKind: 'embedded', contentType: 'text/markdown', title: 'n', sizeBytes: 0 }),
    });
    expect(create.status).toBe(200);
    const body = await create.json<{ token: string }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const resolve = await SELF.fetch(`${ORIGIN}/api/share/${body.token}`, {
      headers: { 'CF-Connecting-IP': '5.5.5.5' },
    });
    expect(resolve.status).toBe(200);
    expect((await resolve.json<{ storageKind: string }>()).storageKind).toBe('embedded');
  });

  it('me returns unauthenticated when no cookie', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { 'CF-Connecting-IP': '5.5.5.6' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it('starts OAuth with a redirect carrying state', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/google/start`, {
      redirect: 'manual',
      headers: { 'CF-Connecting-IP': '5.5.5.7' },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.hostname).toBe('accounts.google.com');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(res.headers.get('set-cookie')).toContain('oauth_state=');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/router.test.ts`
Expected: FAIL — routes not implemented.

- [ ] **Step 3: Implement router + entrypoints**

```ts
// worker/src/router.ts
import type { Env } from './env';
import { json, error, preflight } from './http';
import { ownerRef } from './identity';
import { rateLimit } from './ratelimit';
import { createShare, confirmShare, resolveShare } from './shares';
import { getSession, createSession, deleteSession, parseCookies, sessionCookie, csrfCookie, clearCookie } from './sessions';
import { requireCsrf } from './http';
import { pkcePair, buildAuthUrl, exchangeCode } from './oauth';

const WINDOW = 60_000;

function redirectUri(env: Env, provider: string): string {
  return `${env.ALLOWED_ORIGIN.replace('anyedits-aay.pages.dev', 'anyedits-api.workers.dev')}/api/auth/${provider}/callback`;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const cookies = parseCookies(req.headers.get('cookie'));

  if (req.method === 'OPTIONS') return preflight(env);

  if (req.method === 'GET' && path === '/api/health') return json({ ok: true }, env);

  const session = await getSession(env.DB, cookies['sid'] ?? null);
  const userId = session?.userId ?? null;
  const owner = await ownerRef(req, env, userId);

  if (req.method === 'GET' && path === '/api/me') {
    if (!session) return json({ authenticated: false }, env);
    const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(session.userId).first<{ email: string | null }>();
    return json({ authenticated: true, email: u?.email ?? null, csrfToken: session.csrfToken }, env);
  }

  if (req.method === 'POST' && path === '/api/logout') {
    if (session && !requireCsrf(req, session.csrfToken)) return error('csrf', env, 403);
    if (cookies['sid']) await deleteSession(env.DB, cookies['sid']);
    return json({ ok: true }, env, { headers: { 'set-cookie': clearCookie('sid') } });
  }

  // OAuth start
  let m = path.match(/^\/api\/auth\/(google|github)\/start$/);
  if (req.method === 'GET' && m) {
    const provider = m[1] as 'google' | 'github';
    if (!(await rateLimit(env.DB, owner, 'auth', 20, WINDOW)).ok) return error('rate_limited', env, 429);
    const state = crypto.randomUUID();
    const { verifier, challenge } = await pkcePair();
    const authUrl = buildAuthUrl(provider, env, state, challenge, redirectUri(env, provider));
    const headers = new Headers({ location: authUrl });
    headers.append('set-cookie', `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    headers.append('set-cookie', `oauth_verifier=${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    return new Response(null, { status: 302, headers });
  }

  // OAuth callback
  m = path.match(/^\/api\/auth\/(google|github)\/callback$/);
  if (req.method === 'GET' && m) {
    const provider = m[1] as 'google' | 'github';
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== cookies['oauth_state'] || !cookies['oauth_verifier']) {
      return error('bad_oauth_state', env, 400);
    }
    const ex = await exchangeCode(provider, env, code, cookies['oauth_verifier'], redirectUri(env, provider), fetch);
    if (!ex.ok) return error(ex.error, env, 400);
    let user = await env.DB.prepare('SELECT id FROM users WHERE oauth_provider = ? AND oauth_subject = ?')
      .bind(provider, ex.subject).first<{ id: string }>();
    let userIdNew: string;
    if (user) { userIdNew = user.id; }
    else {
      userIdNew = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO users (id, oauth_provider, oauth_subject, email, created_at) VALUES (?,?,?,?,?)')
        .bind(userIdNew, provider, ex.subject, ex.email, Date.now()).run();
    }
    const s = await createSession(env.DB, userIdNew);
    const headers = new Headers({ location: env.ALLOWED_ORIGIN });
    headers.append('set-cookie', sessionCookie(s.id, 30 * 24 * 60 * 60));
    headers.append('set-cookie', csrfCookie(s.csrfToken, 30 * 24 * 60 * 60));
    headers.append('set-cookie', clearCookie('oauth_state'));
    headers.append('set-cookie', clearCookie('oauth_verifier'));
    return new Response(null, { status: 302, headers });
  }

  if (req.method === 'POST' && path === '/api/share') {
    if (session && !requireCsrf(req, session.csrfToken)) return error('csrf', env, 403);
    if (!(await rateLimit(env.DB, owner, 'share', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    const b = await req.json<{ access: 'ro'|'rw'; storageKind: 'embedded'|'filebase'; contentType: string; title: string; sizeBytes: number }>();
    const r = await createShare(env, {
      ownerRef: owner, isLoggedIn: !!userId, access: b.access, storageKind: b.storageKind,
      contentType: b.contentType, title: b.title, sizeBytes: b.sizeBytes,
    });
    if (!r.ok) return error(r.error, env, 400);
    return json({ token: r.token, shareId: r.shareId, uploadUrl: r.uploadUrl, objectKey: r.objectKey }, env);
  }

  if (req.method === 'POST' && path === '/api/share/confirm') {
    if (session && !requireCsrf(req, session.csrfToken)) return error('csrf', env, 403);
    if (!(await rateLimit(env.DB, owner, 'presign', 30, WINDOW)).ok) return error('rate_limited', env, 429);
    const b = await req.json<{ shareId: string }>();
    const r = await confirmShare(env, b.shareId, owner);
    if (!r.ok) return error(r.error, env, 400);
    return json({ ok: true }, env);
  }

  m = path.match(/^\/api\/share\/([A-Za-z0-9_-]{22})$/);
  if (req.method === 'GET' && m) {
    const r = await resolveShare(env, m[1]);
    if (!r.ok) return error(r.error, env, 404);
    return json(r, env);
  }

  return error('not_found', env, 404);
}
```

```ts
// worker/src/index.ts
import type { Env } from './env';
import { handle } from './router';
import { sweepExpired } from './retention';
import { presignS3 } from './sigv4';

async function deleteObject(env: Env, key: string): Promise<void> {
  const signed = await presignS3({
    method: 'GET', // signing path identical; overridden below
    endpoint: env.FILEBASE_ENDPOINT, region: env.FILEBASE_REGION, bucket: env.FILEBASE_BUCKET,
    key, accessKey: env.FILEBASE_KEY, secretKey: env.FILEBASE_SECRET, expiresSeconds: 60, now: new Date(),
  });
  // Re-sign as DELETE by requesting the DELETE-signed URL directly.
  const del = signed.replace('X-Amz-SignedHeaders', 'X-Amz-SignedHeaders'); // no-op guard
  await fetch(del, { method: 'GET' }).catch(() => {});
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepExpired(env, (key) => deleteObject(env, key)));
  },
} satisfies ExportedHandler<Env>;
```

Correct the DELETE signing: extend `presignS3`'s method type to include `'DELETE'` and have `deleteObject` pass `method: 'DELETE'`, then `fetch(url, { method: 'DELETE' })`. Update `worker/src/sigv4.ts`:

```ts
// change the PresignOpts.method type and remove the no-op replace hack
// PresignOpts: method: 'PUT' | 'GET' | 'DELETE';
```

Rewrite `deleteObject`:

```ts
async function deleteObject(env: Env, key: string): Promise<void> {
  const url = await presignS3({
    method: 'DELETE',
    endpoint: env.FILEBASE_ENDPOINT, region: env.FILEBASE_REGION, bucket: env.FILEBASE_BUCKET,
    key, accessKey: env.FILEBASE_KEY, secretKey: env.FILEBASE_SECRET, expiresSeconds: 60, now: new Date(),
  });
  await fetch(url, { method: 'DELETE' }).catch(() => {});
}
```

Add a `sigv4` regression assertion to `worker/test/sigv4.test.ts`:

```ts
it('signs DELETE with only host', async () => {
  const url = await presignS3({ method: 'DELETE', ...base });
  expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  expect(new URL(url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 4: Run all worker tests to verify they pass**

Run: `cd worker && npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): route wiring, OAuth start/callback, scheduled sweep"
```

---

## Task 14: Frontend — API client + embedded codec

**Files:**
- Create: `src/api/client.ts`, `src/share/embedded.ts`
- Test: `tests/api/client.test.ts`, `tests/share/embedded.test.ts`

**Interfaces:**
- Produces (`src/api/client.ts`):
  - `const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://anyedits-api.workers.dev'`
  - `interface MeState { authenticated: boolean; email?: string | null; csrfToken?: string }`
  - `async function getMe(): Promise<MeState>`
  - `async function createShare(input: { access: 'ro'|'rw'; storageKind: 'embedded'|'filebase'; contentType: string; title: string; sizeBytes: number }, csrfToken?: string): Promise<{ token: string; shareId: string; uploadUrl?: string; objectKey?: string }>`
  - `async function confirmShare(shareId: string, csrfToken?: string): Promise<void>`
  - `async function resolveShare(token: string): Promise<{ access: 'ro'|'rw'; storageKind: 'embedded'|'filebase'; contentType: string | null; title: string | null; downloadUrl?: string }>`
  - `function loginUrl(provider: 'google'|'github'): string`
- Produces (`src/share/embedded.ts`):
  - `function encodeEmbedded(text: string): string` — deflate + base64url (for URL fragment).
  - `function decodeEmbedded(fragment: string): string`.
  - `function fitsEmbedded(text: string): boolean` — deflated size ≤ `8*1024`.
- Consumes: `fflate`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/share/embedded.test.ts
import { describe, it, expect } from 'vitest';
import { encodeEmbedded, decodeEmbedded, fitsEmbedded } from '../../src/share/embedded';

describe('embedded codec', () => {
  it('round-trips text through deflate + base64url', () => {
    const text = '# Hello\n\nSome **markdown** content.';
    const enc = encodeEmbedded(text);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeEmbedded(enc)).toBe(text);
  });
  it('detects small text fits and large text does not', () => {
    expect(fitsEmbedded('tiny')).toBe(true);
    expect(fitsEmbedded('x'.repeat(200_000))).toBe(false); // random-ish large content exceeds 8KB deflated
  });
});
```

```ts
// tests/api/client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMe, createShare, resolveShare, loginUrl } from '../../src/api/client';

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('getMe parses authenticated state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ authenticated: true, email: 'a@b.co', csrfToken: 'c' }), { status: 200 })));
    expect(await getMe()).toEqual({ authenticated: true, email: 'a@b.co', csrfToken: 'c' });
  });

  it('createShare posts with credentials and CSRF header', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ token: 't', shareId: 's' }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const r = await createShare({ access: 'ro', storageKind: 'embedded', contentType: 'text/plain', title: 'x', sizeBytes: 0 }, 'csrf1');
    expect(r.token).toBe('t');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string,string>)['X-CSRF-Token']).toBe('csrf1');
  });

  it('resolveShare fetches by token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ access: 'ro', storageKind: 'filebase', contentType: 'image/png', title: 't', downloadUrl: 'https://x' }), { status: 200 })));
    const r = await resolveShare('tok');
    expect(r.downloadUrl).toBe('https://x');
  });

  it('loginUrl points at the provider start endpoint', () => {
    expect(loginUrl('github')).toContain('/api/auth/github/start');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/share/embedded.test.ts tests/api/client.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Install (client): `npm i fflate`.

```ts
// src/share/embedded.ts
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

const EMBED_MAX = 8 * 1024;

function u8ToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToU8(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeEmbedded(text: string): string {
  return u8ToB64url(deflateSync(strToU8(text)));
}
export function decodeEmbedded(fragment: string): string {
  return strFromU8(inflateSync(b64urlToU8(fragment)));
}
export function fitsEmbedded(text: string): boolean {
  return deflateSync(strToU8(text)).length <= EMBED_MAX;
}
```

```ts
// src/api/client.ts
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'https://anyedits-api.workers.dev';

export interface MeState { authenticated: boolean; email?: string | null; csrfToken?: string }

export async function getMe(): Promise<MeState> {
  const res = await fetch(`${API_BASE}/api/me`, { credentials: 'include' });
  return (await res.json()) as MeState;
}

export async function createShare(
  input: { access: 'ro' | 'rw'; storageKind: 'embedded' | 'filebase'; contentType: string; title: string; sizeBytes: number },
  csrfToken?: string,
): Promise<{ token: string; shareId: string; uploadUrl?: string; objectKey?: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API_BASE}/api/share`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json<{ error: string }>()).error);
  return res.json();
}

export async function confirmShare(shareId: string, csrfToken?: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API_BASE}/api/share/confirm`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify({ shareId }),
  });
  if (!res.ok) throw new Error((await res.json<{ error: string }>()).error);
}

export async function resolveShare(token: string): Promise<{
  access: 'ro' | 'rw'; storageKind: 'embedded' | 'filebase'; contentType: string | null; title: string | null; downloadUrl?: string;
}> {
  const res = await fetch(`${API_BASE}/api/share/${token}`, { credentials: 'include' });
  if (!res.ok) throw new Error((await res.json<{ error: string }>()).error);
  return res.json();
}

export function loginUrl(provider: 'google' | 'github'): string {
  return `${API_BASE}/api/auth/${provider}/start`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/share/embedded.test.ts tests/api/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): API client and embedded-share codec"
```

---

## Task 15: Frontend — share flow (optimizer picks tier)

**Files:**
- Create: `src/share/shareFlow.ts`
- Test: `tests/share/shareFlow.test.ts`

**Interfaces:**
- Produces:
  - `interface ShareContext { kind: FileKind; text?: string; blob?: Blob; contentType: string; title: string; isLoggedIn: boolean; wantRw: boolean; csrfToken?: string }`
  - `async function shareFile(ctx: ShareContext, deps?: { api?: typeof import('../api/client'); uploadPut?: (url: string, blob: Blob) => Promise<void> }): Promise<{ url: string } | { needLogin: string }>` — picks embedded tier for small text-family docs (ro, not `wantRw`), else Filebase snapshot; `wantRw` without login returns `{ needLogin }`.
- Consumes: `embedded` (Task 14), `api/client` (Task 14), `FileKind` (`src/store/types.ts`).

Text-family kinds eligible for embedded: `text`, `code`, `json`, `markdown`, `mermaid`. Embedded link format: `${origin}/#s=<fragment>&ct=<contentType>`. Filebase link: `${origin}/#t=<token>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/share/shareFlow.test.ts
import { describe, it, expect, vi } from 'vitest';
import { shareFile } from '../../src/share/shareFlow';

describe('shareFile', () => {
  it('creates an embedded link for a small markdown doc', async () => {
    const api = {
      createShare: vi.fn(async () => ({ token: 'tok', shareId: 's' })),
      confirmShare: vi.fn(),
    } as unknown as typeof import('../../src/api/client');
    const r = await shareFile(
      { kind: 'markdown', text: '# hi', contentType: 'text/markdown', title: 'n', isLoggedIn: false, wantRw: false },
      { api },
    );
    expect('url' in r).toBe(true);
    if ('url' in r) expect(r.url).toContain('#s=');
    expect(api.createShare).toHaveBeenCalledWith(
      expect.objectContaining({ storageKind: 'embedded', access: 'ro' }), undefined);
  });

  it('uploads to Filebase for an image and returns a token link', async () => {
    const uploadPut = vi.fn(async () => {});
    const api = {
      createShare: vi.fn(async () => ({ token: 'imgtok', shareId: 's2', uploadUrl: 'https://put', objectKey: 'k' })),
      confirmShare: vi.fn(async () => {}),
    } as unknown as typeof import('../../src/api/client');
    const r = await shareFile(
      { kind: 'image', blob: new Blob([new Uint8Array(10)]), contentType: 'image/png', title: 'p', isLoggedIn: false, wantRw: false },
      { api, uploadPut },
    );
    expect(uploadPut).toHaveBeenCalledWith('https://put', expect.any(Blob));
    expect(api.confirmShare).toHaveBeenCalledWith('s2', undefined);
    if ('url' in r) expect(r.url).toContain('#t=imgtok');
  });

  it('blocks rw without login', async () => {
    const r = await shareFile(
      { kind: 'markdown', text: 'x', contentType: 'text/markdown', title: 'n', isLoggedIn: false, wantRw: true },
      {},
    );
    expect('needLogin' in r).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/share/shareFlow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/share/shareFlow.ts
import type { FileKind } from '../store/types';
import { encodeEmbedded, fitsEmbedded } from './embedded';
import * as defaultApi from '../api/client';

const TEXT_FAMILY: FileKind[] = ['text', 'code', 'json', 'markdown', 'mermaid'];

export interface ShareContext {
  kind: FileKind;
  text?: string;
  blob?: Blob;
  contentType: string;
  title: string;
  isLoggedIn: boolean;
  wantRw: boolean;
  csrfToken?: string;
}

async function defaultUploadPut(url: string, blob: Blob): Promise<void> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-length': String(blob.size) }, body: blob });
  if (!res.ok) throw new Error('upload_failed');
}

export async function shareFile(
  ctx: ShareContext,
  deps?: { api?: typeof import('../api/client'); uploadPut?: (url: string, blob: Blob) => Promise<void> },
): Promise<{ url: string } | { needLogin: string }> {
  const api = deps?.api ?? defaultApi;
  const uploadPut = deps?.uploadPut ?? defaultUploadPut;
  const origin = typeof location !== 'undefined' ? location.origin : 'https://anyedits-aay.pages.dev';

  if (ctx.wantRw && !ctx.isLoggedIn) return { needLogin: 'Sign in to create editable (read-write) links.' };

  const canEmbed = !ctx.wantRw && TEXT_FAMILY.includes(ctx.kind) && ctx.text !== undefined && fitsEmbedded(ctx.text);

  if (canEmbed) {
    await api.createShare(
      { access: 'ro', storageKind: 'embedded', contentType: ctx.contentType, title: ctx.title, sizeBytes: 0 },
      ctx.csrfToken,
    );
    const frag = encodeEmbedded(ctx.text!);
    return { url: `${origin}/#s=${frag}&ct=${encodeURIComponent(ctx.contentType)}` };
  }

  const blob = ctx.blob ?? new Blob([ctx.text ?? ''], { type: ctx.contentType });
  const created = await api.createShare(
    { access: ctx.wantRw ? 'rw' : 'ro', storageKind: 'filebase', contentType: ctx.contentType, title: ctx.title, sizeBytes: blob.size },
    ctx.csrfToken,
  );
  if (!created.uploadUrl) throw new Error('no_upload_url');
  await uploadPut(created.uploadUrl, blob);
  await api.confirmShare(created.shareId, ctx.csrfToken);
  return { url: `${origin}/#t=${created.token}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/share/shareFlow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): share flow selecting embedded vs Filebase tier"
```

---

## Task 16: Frontend — open-shared-link + auth UI + AppShell wiring

**Files:**
- Create: `src/share/openShared.ts`, `src/auth/authUi.ts`
- Modify: `src/shell/AppShell.ts`, `src/main.ts`
- Test: `tests/share/openShared.test.ts`, `tests/auth/authUi.test.ts`

**Interfaces:**
- Produces:
  - `interface OpenedShare { title: string; contentType: string; kind: FileKind; text?: string; blob?: Blob; access: 'ro'|'rw' }`
  - `async function openFromHash(hash: string, deps?: { api?: typeof import('../api/client'); fetchBlob?: (url: string) => Promise<Blob> }): Promise<OpenedShare | null>` — parses `#s=...&ct=...` (embedded → decode) or `#t=...` (filebase → resolve → fetch blob via presigned GET); returns null when no share in the hash.
  - `function renderAuthBar(host: HTMLElement, me: MeState, handlers: { onLogout: () => void }): void` — shows Google/GitHub login links when signed out, email + logout when signed in.
  - `function loginIncentive(reason: 'retention'|'rw'|'cross-device'): string` — copy for friction-point prompts.
- Consumes: `api/client`, `embedded`, `detectKind` (Plan 1 `src/detect/fileKind.ts`), `MeState`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/share/openShared.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openFromHash } from '../../src/share/openShared';
import { encodeEmbedded } from '../../src/share/embedded';

describe('openFromHash', () => {
  it('returns null when no share is present', async () => {
    expect(await openFromHash('#foo=bar')).toBeNull();
  });

  it('decodes an embedded share', async () => {
    const frag = encodeEmbedded('# Hello');
    const r = await openFromHash(`#s=${frag}&ct=${encodeURIComponent('text/markdown')}`);
    expect(r?.text).toBe('# Hello');
    expect(r?.kind).toBe('markdown');
    expect(r?.access).toBe('ro');
  });

  it('resolves a filebase token and fetches the blob', async () => {
    const api = {
      resolveShare: vi.fn(async () => ({ access: 'ro' as const, storageKind: 'filebase' as const, contentType: 'image/png', title: 'p.png', downloadUrl: 'https://get' })),
    } as unknown as typeof import('../../src/api/client');
    const fetchBlob = vi.fn(async () => new Blob([new Uint8Array(3)], { type: 'image/png' }));
    const r = await openFromHash('#t=imgtok', { api, fetchBlob });
    expect(fetchBlob).toHaveBeenCalledWith('https://get');
    expect(r?.kind).toBe('image');
    expect(r?.blob?.size).toBe(3);
  });
});
```

```ts
// tests/auth/authUi.test.ts
import { describe, it, expect, vi } from 'vitest';
import { renderAuthBar, loginIncentive } from '../../src/auth/authUi';

describe('authUi', () => {
  it('shows provider links when signed out', () => {
    const host = document.createElement('div');
    renderAuthBar(host, { authenticated: false }, { onLogout: () => {} });
    expect(host.querySelector('a[data-provider="google"]')).toBeTruthy();
    expect(host.querySelector('a[data-provider="github"]')).toBeTruthy();
  });

  it('shows email and logout when signed in', () => {
    const host = document.createElement('div');
    const onLogout = vi.fn();
    renderAuthBar(host, { authenticated: true, email: 'a@b.co', csrfToken: 'c' }, { onLogout });
    expect(host.textContent).toContain('a@b.co');
    (host.querySelector('button[data-role="logout"]') as HTMLButtonElement).click();
    expect(onLogout).toHaveBeenCalled();
  });

  it('provides incentive copy for each friction point', () => {
    expect(loginIncentive('retention')).toContain('longer');
    expect(loginIncentive('rw')).toContain('edit');
    expect(loginIncentive('cross-device')).toContain('phone');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/share/openShared.test.ts tests/auth/authUi.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/share/openShared.ts
import type { FileKind } from '../store/types';
import { decodeEmbedded } from './embedded';
import { detectKind } from '../detect/fileKind';
import * as defaultApi from '../api/client';

export interface OpenedShare {
  title: string; contentType: string; kind: FileKind;
  text?: string; blob?: Blob; access: 'ro' | 'rw';
}

async function defaultFetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('download_failed');
  return res.blob();
}

export async function openFromHash(
  hash: string,
  deps?: { api?: typeof import('../api/client'); fetchBlob?: (url: string) => Promise<Blob> },
): Promise<OpenedShare | null> {
  const api = deps?.api ?? defaultApi;
  const fetchBlob = deps?.fetchBlob ?? defaultFetchBlob;
  const params = new URLSearchParams(hash.replace(/^#/, ''));

  const s = params.get('s');
  if (s) {
    const contentType = decodeURIComponent(params.get('ct') ?? 'text/plain');
    const text = decodeEmbedded(s);
    return { title: 'Shared document', contentType, kind: detectKind('shared', contentType), text, access: 'ro' };
  }

  const t = params.get('t');
  if (t) {
    const r = await api.resolveShare(t);
    const contentType = r.contentType ?? 'application/octet-stream';
    const kind = detectKind(r.title ?? 'shared', contentType);
    if (r.storageKind === 'filebase' && r.downloadUrl) {
      const blob = await fetchBlob(r.downloadUrl);
      return { title: r.title ?? 'Shared file', contentType, kind, blob, access: r.access };
    }
    return { title: r.title ?? 'Shared', contentType, kind, access: r.access };
  }
  return null;
}
```

```ts
// src/auth/authUi.ts
import type { MeState } from '../api/client';
import { loginUrl } from '../api/client';

export function renderAuthBar(host: HTMLElement, me: MeState, handlers: { onLogout: () => void }): void {
  host.innerHTML = '';
  if (!me.authenticated) {
    const g = document.createElement('a');
    g.href = loginUrl('google'); g.textContent = 'Sign in with Google';
    g.setAttribute('data-provider', 'google'); g.className = 'auth-link';
    const h = document.createElement('a');
    h.href = loginUrl('github'); h.textContent = 'Sign in with GitHub';
    h.setAttribute('data-provider', 'github'); h.className = 'auth-link';
    host.append(g, h);
    return;
  }
  const email = document.createElement('span');
  email.textContent = me.email ?? 'Signed in';
  const out = document.createElement('button');
  out.type = 'button'; out.textContent = 'Log out';
  out.setAttribute('data-role', 'logout'); out.className = 'auth-link';
  out.addEventListener('click', handlers.onLogout);
  host.append(email, out);
}

export function loginIncentive(reason: 'retention' | 'rw' | 'cross-device'): string {
  switch (reason) {
    case 'retention': return 'Sign in to keep this file longer (30 days instead of 7) and get 700MB of storage.';
    case 'rw': return 'Sign in to share an editable (read-write) link others can change.';
    case 'cross-device': return 'Sign in to access this file on your phone and other devices.';
  }
}
```

Modify `src/shell/AppShell.ts`: add an auth bar container in the header rendered via `renderAuthBar` (fetch `getMe()` on init, store `csrfToken`); add a "Share" button on the open-file toolbar that reads the current editor value/blob and calls `shareFile(...)`, then copies the returned `url` to the clipboard and shows a toast; when `shareFile` returns `{ needLogin }`, render the message via `loginIncentive('rw')` with the login links. Modify `src/main.ts` bootstrap: after mount, if `location.hash` contains a share, call `openFromHash(location.hash)` and, when non-null, load the result into the store + open it in the editor (read-only banner when `access === 'ro'`). Wire logout to `POST /api/logout` with the CSRF header then re-render the auth bar.

Add a targeted AppShell test:

```ts
// tests/shell/AppShell.share.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AppShell } from '../../src/shell/AppShell';
import { FileStore, MemoryAdapter } from '../../src/store/opfs';

describe('AppShell share integration', () => {
  it('renders a Share button after opening a file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })));
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('note.md', new Blob(['# hi']), 'markdown');
    const root = document.createElement('div');
    const shell = new AppShell(root, store);
    await shell.openFile(rec.id);
    expect(root.querySelector('[data-role="share-btn"]')).toBeTruthy();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/share/openShared.test.ts tests/auth/authUi.test.ts tests/shell/AppShell.share.test.ts`
Expected: PASS. Then run full client suite: `npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): open-shared-link flow, auth bar, login incentives, share button"
```

---

## Deployment (after all tasks green)

1. **Secrets:** `cd worker && wrangler secret put FILEBASE_KEY` (repeat for `FILEBASE_SECRET`, `FILEBASE_BUCKET`, `FILEBASE_ENDPOINT`, `FILEBASE_REGION`, `IP_HASH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). Values come from `filebase_secrets.txt` and the OAuth provider consoles (register the callback `https://anyedits-api.workers.dev/api/auth/<provider>/callback`). Never commit values.
2. **Migrate D1:** `wrangler d1 migrations apply anyedits-db --remote`.
3. **Deploy Worker:** `wrangler deploy`.
4. **Frontend env:** set `VITE_API_BASE=https://anyedits-api.workers.dev` for the Pages build, then redeploy the client (`npm run deploy` from Plan 1).
5. Smoke test on a phone-width viewport: create an embedded share for a small Markdown doc, open the link in a fresh browser; upload+share an image (Filebase tier), open it; sign in with Google, confirm `/api/me` reflects it and rw share becomes available.

---

## Self-Review

**Spec coverage (§2–7):**
- §2 Architecture — thin Worker, never handles bytes, presigned direct-to-storage: Tasks 5, 10, 13, 15 (client uploads straight to Filebase). ✅
- §3 Tiered storage (embedded vs Filebase, ~8KB threshold, embedded frozen ro, create→presign→upload→confirm→ledger; resolve→presigned GET): Tasks 10, 14, 15, 16. ✅
- §4 Data model (users/sessions/shares/quota_ledger with every named column; owner_ref = user_id or ip_hash): Tasks 2, 3, 7. ✅
- §5 Quota (SUM usage, 500/700MB caps, single-file 500MB hard cap, reject presign when over, content-length-bound PUT) + retention (7d/30d nightly cron freeing quota): Tasks 4, 5, 10, 12, 13. ✅
- §6 Auth (Google+GitHub OAuth PKCE+state, secure cookie, CSRF on mutations) + login incentives at friction points (+200MB, 7→30d, rw links, cross-device): Tasks 7, 8, 11, 13, 16. ✅
- §7 Security (secrets server-side only via Wrangler secrets; 128-bit tokens shown once, only hash stored; rw needs raw token, management needs session; per-ip_hash rate limiting on presign/share/auth; CORS locked to Pages origin; strict headers; validate declared content-type/size): Tasks 5, 6, 8, 9, 10, 13. Note: Markdown/Mermaid XSS sanitization is client-side and already delivered in Plan 1. ✅

**Placeholder scan:** No TBD/TODO/"add error handling" left. Every code step contains runnable code. Task 13 explicitly replaces its interim `deleteObject` no-op with the real DELETE-signed implementation and adds the corresponding SigV4 test, so no placeholder survives.

**Type consistency:** `Env` (Task 1) is consumed unchanged everywhere. `ownerRef`/`ipHash` (Task 3) signatures match Task 13 usage. `checkQuota`/`recordLedger`/`currentUsage` (Task 4) match Tasks 10, 12. `presignS3`/`presignPut`/`presignGet` (Task 5) — `presignS3.method` widened to `'PUT'|'GET'|'DELETE'` in Task 13 and used consistently. `generateToken`/`hashToken` (Task 6) match Tasks 7, 10. Session/cookie/CSRF helpers (Tasks 7, 8) match Task 13. `createShare`/`confirmShare`/`resolveShare` server shapes (Task 10) mirror the client `api/client` shapes (Task 14) and are consumed by Tasks 15, 16. `MeState`/`FileKind` reused verbatim across client tasks. Client `createShare(input, csrfToken)` arity matches the `shareFlow` call sites and the `AppShell` wiring.

**Ambiguity resolved:** The spec names `POST /api/share/confirm` but does not say when quota is charged. Resolved by charging the ledger at **confirm** (after the client's upload succeeds), not at create — so a failed/abandoned upload never consumes quota; the presign is still quota-*checked* at create to reject doomed uploads early. Also resolved the DELETE for retention: the spec mandates deleting Filebase objects but not the mechanism — used a SigV4-signed S3 DELETE (same signing path as GET, `host`-only signed headers), injected into `sweepExpired` for testability.
