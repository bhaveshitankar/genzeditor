// worker/test/router.test.ts
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const ORIGIN = 'https://anyedits-aay.pages.dev';

describe('router integration', () => {
  beforeAll(async () => {
    const migration = `
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
  expires_at INTEGER NOT NULL,
  pending_expires_at INTEGER
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
    `;
    const statements = migration
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }
  });

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

  it('rejects an anon share mutation driven from a cross-site Origin', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/share`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': '5.5.5.9',
        'Origin': 'https://evil.example.com',
      },
      body: JSON.stringify({ access: 'ro', storageKind: 'embedded', contentType: 'text/plain', title: 'x', sizeBytes: 0 }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('bad_origin');
  });

  it('allows an anon share mutation from the allowed Origin', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/share`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': '5.5.5.10',
        'Origin': ORIGIN,
      },
      body: JSON.stringify({ access: 'ro', storageKind: 'embedded', contentType: 'text/plain', title: 'x', sizeBytes: 0 }),
    });
    expect(res.status).toBe(200);
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
