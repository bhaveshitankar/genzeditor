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
