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
  const headers: Record<string, string> = { 'content-type': 'application/json' };
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
