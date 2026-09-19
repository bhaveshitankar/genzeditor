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
