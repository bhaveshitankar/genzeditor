# AnyEdits — First Slice Design (Text/Document + Image Editor)

**Date:** 2026-09-19
**Status:** Approved design, pre-implementation-plan
**Scope:** First slice of a larger platform. Later slices (audio, video, real-time
collaboration) reuse this foundation and get their own spec → plan → implementation cycle.

---

## 1. Goal & non-goals

**Goal:** A mobile-first web app where a user can upload and immediately edit
text-family documents and images in one place, with no login required to start,
and share them with read-only or read-write access. Backend stays featherlight
on the Cloudflare free tier; work is offloaded to the client wherever possible.

**In scope (this slice):**
- Editors: plain text, code (syntax highlight), JSON (format/validate/tree),
  Markdown (live sanitized preview), Mermaid diagrams (sandboxed preview), images
  (crop/rotate/resize/filters/annotate/convert).
- Editing UX: previews, expand/collapse (folding), find/search, full clipboard
  (cut/copy/paste), accessibility, mobile-first responsive layout.
- Local-first storage (OPFS/IndexedDB) as the working copy.
- Async share links (ro/rw) via embedded content or Filebase snapshots.
- OAuth login (Google/GitHub) with quota + retention + collaboration incentives.
- Quota: 500MB anonymous / 700MB logged-in (server-stored bytes only).

**Non-goals (this slice):**
- Real-time live editing / live cursors (deferred; data model left open for it).
- Audio/video editing.
- Email/password or passkey auth.
- Folder-tree cloud sync beyond a flat logged-in library.

---

## 2. Architecture

**Components**
- **Frontend SPA** — Cloudflare Pages, static, mobile-first. All editing runs here.
- **API Worker** — Cloudflare Workers. Thin: OAuth, share create/resolve, quota
  ledger, Filebase presigned URL issuance. Never handles file bytes.
- **D1 (SQLite)** — users, sessions, shares, quota ledger. No file bytes.
- **Filebase (S3-compatible)** — frozen snapshots too big to embed. Endpoint
  `https://s3.filebase.io`. Already provisioned.
- **Browser OPFS/IndexedDB** — working copy of every file, local-first, offline-capable.

**Rationale:** Direct-to-storage presigned uploads keep bytes out of the Worker,
avoiding CPU/duration limits on large files and preserving the free-tier request
budget. Editing is fully client-side. (Alternative: proxying uploads through the
Worker — rejected because streaming up to 500MB risks failures and burns the
request budget.)

---

## 3. Tiered storage (optimizer picks automatically)

| Tier | When | Where | Server cost |
|------|------|-------|-------------|
| Local-only | Editing, not shared | OPFS/IndexedDB on device | none |
| Embedded share | Sharing a small text-family doc (md/mermaid/json/code/txt), compressed size under threshold | Compressed content in the share URL fragment | none |
| Filebase snapshot | Sharing an image or large doc, or rw collaboration | Frozen snapshot object in Filebase; token + metadata in D1 | counts toward quota |

**Embedded threshold:** target ~a few KB after compression (exact byte limit set
in implementation, bounded well under URL length limits, e.g. ~8KB compressed).
Embedded shares are inherently frozen and read-only.

**Data flow — share an image / large doc:**
1. Browser freezes a snapshot of the current document.
2. Browser requests a presigned PUT from the Worker; Worker checks quota first.
3. Browser uploads straight to Filebase using the presigned URL.
4. Browser confirms success to the Worker.
5. Worker records size in `quota_ledger` and creates a share token in `shares`.

**Resolve:** reader opens token URL → Worker validates token → returns a presigned
GET (ro) or permits snapshot replacement (rw).

---

## 4. Data model (D1)

- **users** — `id`, `oauth_provider`, `oauth_subject`, `email`, `created_at`.
- **sessions** — `id` (random), `user_id`, `expires_at`. Delivered as httpOnly,
  Secure, SameSite=Lax cookie.
- **shares** — `id`, `token_hash`, `owner_ref` (user_id or ip_hash), `access`
  (`ro`|`rw`), `storage_kind` (`embedded`|`filebase`), `object_key`, `size_bytes`,
  `content_type`, `title`, `created_at`, `expires_at`, `revoked`.
- **quota_ledger** — `id`, `owner_ref`, `object_key`, `size_bytes`, `created_at`,
  `expires_at`. Current usage = `SUM(size_bytes)` where `owner_ref` matches.

**Owner identity:** anonymous = `ip_hash` = HMAC(`CF-Connecting-IP`, server secret).
Logged-in = `user_id`. (`CF-Connecting-IP` is trustworthy behind Cloudflare.)

---

## 5. Quota & retention

- **Enforcement:** before issuing a presigned PUT, Worker computes current usage
  for the owner and rejects if `usage + new_size > cap`. Caps: 500MB anonymous,
  700MB logged-in. Presigned URL carries a content-length cap so the client cannot
  exceed the declared size. Single-file hard cap of 500MB.
- **Retention (ephemeral):** anonymous snapshots expire in 7 days; logged-in in
  30 days. A scheduled Worker (Cron Trigger) deletes expired Filebase objects and
  `quota_ledger` / `shares` rows nightly, freeing quota.

---

## 6. Authentication & login incentives

**Auth:** OAuth (Google + GitHub) with PKCE and `state`. Session cookie is
httpOnly, Secure, SameSite=Lax. CSRF token required on mutations.

**Incentives (surfaced contextually, never a hard wall to start):**
- +200MB quota (500 → 700MB) and 7 → 30 day retention.
- Cross-device library (anon files are device-bound).
- rw share links + link management/revoke (anon can create ro embedded links only).
- Named files/folders and version history of frozen snapshots.

Prompts appear at natural friction points ("Sign in to keep this longer / share
for editing / access on your phone").

---

## 7. Security

- **Secrets** server-side only (Wrangler secrets / `.dev.vars`). Browser never sees
  Filebase keys — only short-lived presigned URLs (~60s expiry, content-length
  bound, method-scoped). Both `cloudflare_secrets.txt` and `filebase_secrets.txt`
  are `.gitignore`'d; rotate them before/after go-live since they were stored plaintext.
- **Share tokens:** 128-bit random, shown once; only a hash stored. rw writes
  require the raw token; management requires a session.
- **OAuth:** PKCE + `state`; secure session cookie; CSRF token on mutations.
- **Rate limiting:** per-`ip_hash` counters on presign/share/auth endpoints.
- **XSS:** Markdown sanitized (DOMPurify); Mermaid rendered in a sandboxed iframe;
  uploaded HTML/SVG never rendered inline in the app origin.
- **CORS** locked to the Pages origin; strict CSP headers.
- Validate declared content-type and size; single-file hard cap enforced.

---

## 8. Editors (client-side, mobile-first, accessible)

- **Text/code/JSON:** CodeMirror 6 — syntax highlighting, find/replace, folding,
  full clipboard. JSON adds format/validate + tree view.
- **Markdown:** CodeMirror + live sanitized preview (toggle/split), collapsible sections.
- **Mermaid:** source editor + live sandboxed diagram preview; export PNG/SVG.
- **Images:** Canvas-based — crop, rotate, resize, filters, annotate, format
  convert; heavy ops via WASM where needed.
- **Shared shell:** file drawer (OPFS library), command palette, global find,
  ARIA/keyboard nav, large touch targets, responsive layout.

---

## 9. Deployment

- Frontend → Cloudflare Pages. API → Workers (`wrangler`). D1 for metadata.
  Cron Trigger for expiry sweeps. Filebase as external S3.
- Config in `wrangler.toml`; secrets via `wrangler secret` / `.dev.vars`.
- `.gitignore` covers `cloudflare_secrets.txt`, `filebase_secrets.txt`, `.dev.vars`.

---

## 10. Deferred / future slices

- Real-time collaboration (CRDT + Durable Objects/WebSockets).
- Audio and video editing (ffmpeg.wasm).
- Additional auth (passkeys), richer folder sync, version-history UI.
