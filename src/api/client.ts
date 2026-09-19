// Default points at the Worker host (which serves the API and OAuth callback),
// matching API_BASE_URL in worker/wrangler.toml. RECONCILE to the real deployed
// Worker URL (anyedits-api.<subdomain>.workers.dev) after `wrangler deploy`;
// must match the OAuth app redirect URIs registered in Google/GitHub.
export const API_BASE = (import.meta.env?.VITE_API_BASE) ?? 'https://anyedits-api.workers.dev';

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
