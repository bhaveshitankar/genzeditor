// worker/test/sessions.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createSession, getSession, deleteSession, parseCookies, sessionCookie, csrfCookie, clearCookie,
} from '../src/sessions';

describe('sessions', () => {
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
    `;
    const statements = migration
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }
  });

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
      'INSERT INTO users (id, oauth_provider, oauth_subject, email, created_at) VALUES (?,?,?,?,?)',
    ).bind('u2', 'google', 'sub2', 'b@c.co', Date.now()).run();
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?,?,?,?)',
    ).bind('sExp', 'u2', 'tok', Date.now() - 1000).run();
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
