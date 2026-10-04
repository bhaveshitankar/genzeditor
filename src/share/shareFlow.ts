import type { FileKind } from '../store/types';
import * as defaultApi from '../api/client';

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

// Create a tracked, updatable share link. Always uses filebase storage (never
// an embedded #s= fragment) so the same link can later be updated in place by
// "Save" — a point-in-time embedded snapshot cannot. Returns the token, shareId
// and access so the caller can persist the link on the file record and reuse it
// on repeat Share clicks instead of minting a new document each time.
export async function shareFile(
  ctx: ShareContext,
  deps?: { api?: typeof import('../api/client'); uploadPut?: (url: string, blob: Blob) => Promise<void> },
): Promise<{ url: string; token: string; shareId: string; access: 'ro' | 'rw' } | { needLogin: string }> {
  const api = deps?.api ?? defaultApi;
  const uploadPut = deps?.uploadPut ?? defaultUploadPut;
  const origin = typeof location !== 'undefined' ? location.origin : 'https://anyedits-aay.pages.dev';

  if (ctx.wantRw && !ctx.isLoggedIn) return { needLogin: 'Sign in to create editable (read-write) links.' };

  const access: 'ro' | 'rw' = ctx.wantRw ? 'rw' : 'ro';
  const blob = ctx.blob ?? new Blob([ctx.text ?? ''], { type: ctx.contentType });
  const created = await api.createShare(
    { access, storageKind: 'filebase', contentType: ctx.contentType, title: ctx.title, sizeBytes: blob.size },
    ctx.csrfToken,
  );
  if (!created.uploadUrl) throw new Error('no_upload_url');
  await uploadPut(created.uploadUrl, blob);
  await api.confirmShare(created.shareId, ctx.csrfToken);
  return { url: `${origin}/#t=${created.token}`, token: created.token, shareId: created.shareId, access };
}
