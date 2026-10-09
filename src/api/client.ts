// The Worker API host (serves /api/* incl. Better Auth at /api/auth/*). Served
// from a subdomain of the app so session cookies are same-site.
export const API_BASE = (import.meta.env?.VITE_API_BASE) ?? 'https://api.genzeditor.com';

export interface MeState { authenticated: boolean; email?: string | null; csrfToken?: string }

// Read the current session from Better Auth's get-session endpoint.
export async function getMe(): Promise<MeState> {
  const res = await fetch(`${API_BASE}/api/auth/get-session`, { credentials: 'include' });
  if (!res.ok) return { authenticated: false };
  const data = (await res.json().catch(() => null)) as { user?: { email?: string | null } } | null;
  if (!data?.user) return { authenticated: false };
  return { authenticated: true, email: data.user.email ?? null };
}

export interface OtpError { error: string; retryAfter?: number }

// Request an email OTP. Includes the Turnstile token for the Worker's defense
// pipeline. Throws an OtpError-shaped object on rejection.
export async function requestEmailOtp(email: string, turnstileToken: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, type: 'sign-in', turnstileToken }),
  });
  if (!res.ok) throw (await res.json().catch(() => ({ error: 'request_failed' }))) as OtpError;
}

// Verify an email OTP and establish a session.
export async function verifyEmailOtp(email: string, otp: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/sign-in/email-otp`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, otp }),
  });
  if (!res.ok) throw (await res.json().catch(() => ({ error: 'invalid_code' }))) as OtpError;
}

export async function signOut(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/sign-out`, { method: 'POST', credentials: 'include' });
}

// Start a social (OAuth) sign-in: ask Better Auth for the provider URL, then
// redirect the browser to it.
export async function startSocial(provider: 'google' | 'github'): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/sign-in/social`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, callbackURL: location.origin }),
  });
  const data = (await res.json().catch(() => null)) as { url?: string } | null;
  if (data?.url) location.href = data.url;
}

export async function createShare(
  input: { access: 'ro' | 'rw'; storageKind: 'embedded' | 'filebase'; contentType: string; title: string; sizeBytes: number },
  csrfToken?: string,
): Promise<{ token: string; shareId: string; uploadUrl?: string; objectKey?: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'X-Device-Id': deviceId() };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API_BASE}/api/share`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json() as { error: string }).error);
  return res.json();
}

export async function confirmShare(shareId: string, csrfToken?: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API_BASE}/api/share/confirm`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify({ shareId }),
  });
  if (!res.ok) throw new Error((await res.json() as { error: string }).error);
}

export async function resolveShare(token: string): Promise<{
  access: 'ro' | 'rw'; storageKind: 'embedded' | 'filebase'; contentType: string | null; title: string | null; downloadUrl?: string; uploadUrl?: string; sizeBytes?: number;
}> {
  const res = await fetch(`${API_BASE}/api/share/${token}`, { credentials: 'include' });
  if (!res.ok) throw new Error((await res.json() as { error: string }).error);
  return res.json();
}

// Ask the Worker to presign a PUT bound to the ACTUAL new blob size (with the
// owner's quota delta re-checked) before writing an rw snapshot back in place.
export async function initSaveBack(
  token: string,
  size: number,
  csrfToken?: string,
): Promise<{ uploadUrl: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API_BASE}/api/share/${token}/save`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify({ size }),
  });
  if (!res.ok) throw new Error((await res.json() as { error: string }).error);
  return res.json();
}

export function loginUrl(provider: 'google' | 'github'): string {
  return `${API_BASE}/api/auth/${provider}/start`;
}

// ---- AI edit -------------------------------------------------------------

export type AiKind =
  | 'text' | 'image' | 'video' | 'form'
  | 'docx' | 'spreadsheet' | 'pdf' | 'game' | 'floorplan' | 'sketch' | 'audio';

export interface AiEditInput {
  kind: AiKind;
  instruction: string;
  content?: string;
  meta?: Record<string, unknown>;
}

export interface AiEditResult {
  provider: 'workers-ai' | 'openai' | 'anthropic';
  text?: string;
  ops?: unknown;
}

// A bring-your-own-key value stored client-side only (localStorage), sent per
// request to unlock unlimited mode. Never persisted server-side.
export interface ByoKey { key: string; provider?: 'openai' | 'anthropic' }

export class AiError extends Error {
  constructor(public code: string, public limit?: number) { super(code); }
}

export async function aiEdit(input: AiEditInput, byok?: ByoKey | null): Promise<AiEditResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (byok?.key) {
    headers['X-AI-Key'] = byok.key;
    if (byok.provider) headers['X-AI-Provider'] = byok.provider;
  }
  const res = await fetch(`${API_BASE}/api/ai/edit`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: 'ai_failed' }))) as { error: string; limit?: number };
    throw new AiError(data.error, data.limit);
  }
  return res.json();
}

// ---- AI generate (image / audio / interior / storyboard) -----------------

export type GenKind = 'image' | 'audio' | 'describe' | 'interior' | 'storyboard';

export interface GenInput {
  kind: GenKind;
  prompt?: string; text?: string; lang?: string;
  images?: string[]; style?: string; roomType?: string;
  variants?: number; scenes?: number; frames?: boolean; question?: string;
}

export interface InteriorVariant { style: string; image: string | null; prompt: string; mode: 'img2img' | 'text2img' }
export interface StoryScene { prompt: string; narration: string; durationSec: number; motion: string; image: string | null }

export interface GenResult {
  provider: 'workers-ai' | 'openai';
  image?: string; audio?: string; mime?: string; description?: string;
  style?: string; palette?: string[]; floorplanText?: string; variants?: InteriorVariant[];
  title?: string; scenes?: StoryScene[]; note?: string;
}

// Approximate weighted-unit cost (mirrors worker/src/generate.ts COST) for UI hints.
export const GEN_DAILY_UNITS = 60;
export function genCost(i: GenInput): number {
  const n = Math.min(3, Math.max(1, i.variants ?? 2));
  switch (i.kind) {
    case 'image': return 4;
    case 'audio': return 2;
    case 'describe': return 3;
    case 'interior': return 3 + 5 * n;
    case 'storyboard': return 3 + (i.frames ? 4 * Math.min(4, Math.max(1, i.scenes ?? 3)) : 0);
  }
}

export async function aiGenerate(input: GenInput, byok?: ByoKey | null): Promise<GenResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (byok?.key) headers['X-AI-Key'] = byok.key;
  const res = await fetch(`${API_BASE}/api/ai/generate`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: 'generation_failed' }))) as { error: string; limit?: number };
    throw new AiError(data.error, data.limit);
  }
  return res.json();
}

// Random per-browser id used only for abuse limits (server stores an HMAC of it).
export function deviceId(): string {
  const KEY = 'gz-device-id';
  try {
    let id = localStorage.getItem(KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      const b = crypto.getRandomValues(new Uint8Array(18));
      id = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

export async function deleteShare(shareId: string, csrfToken?: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${API_BASE}/api/share/delete`, {
    method: 'POST', credentials: 'include', headers, body: JSON.stringify({ shareId }),
  });
  if (!res.ok && res.status !== 404) throw new Error((await res.json() as { error: string }).error);
}

export type FeedbackCategory = 'bug' | 'idea' | 'question' | 'other';
export async function sendFeedback(input: {
  category: FeedbackCategory;
  message: string;
  email?: string;
  context?: { app: string; version: string; fileKind?: string; platform?: string; path?: string };
}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/feedback`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', 'X-Device-Id': deviceId() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `http_${res.status}`);
  }
}
