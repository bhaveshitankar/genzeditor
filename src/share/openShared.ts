import type { FileKind } from '../store/types';
import { decodeEmbedded } from './embedded';
import { detectKind } from '../detect/fileKind';
import * as defaultApi from '../api/client';

export interface OpenedShare {
  title: string; contentType: string; kind: FileKind;
  text?: string; blob?: Blob; access: 'ro' | 'rw';
  // Present only for rw shares: a content-length-bound presigned PUT the holder
  // can use to replace the Filebase snapshot in place.
  uploadUrl?: string;
}

async function defaultUploadPut(url: string, blob: Blob): Promise<void> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-length': String(blob.size) }, body: blob });
  if (!res.ok) throw new Error('save_back_failed');
}

// Write an edited snapshot back to an rw share using the presigned PUT returned
// by resolveShare. ro shares never receive an uploadUrl, so save-back is
// impossible for them.
export async function saveBackShared(
  uploadUrl: string,
  blob: Blob,
  deps?: { uploadPut?: (url: string, blob: Blob) => Promise<void> },
): Promise<void> {
  const uploadPut = deps?.uploadPut ?? defaultUploadPut;
  await uploadPut(uploadUrl, blob);
}

function inferKindFromContentType(contentType: string): FileKind {
  if (contentType === 'text/markdown') return 'markdown';
  if (contentType === 'application/json') return 'json';
  if (contentType.startsWith('text/')) return 'text';
  if (contentType.startsWith('image/')) return 'image';
  return 'binary';
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
    const kind = inferKindFromContentType(contentType);
    return { title: 'Shared document', contentType, kind, text, access: 'ro' };
  }

  const t = params.get('t');
  if (t) {
    const r = await api.resolveShare(t);
    const contentType = r.contentType ?? 'application/octet-stream';
    const kind = r.title ? detectKind(r.title, contentType) : inferKindFromContentType(contentType);
    if (r.storageKind === 'filebase' && r.downloadUrl) {
      const blob = await fetchBlob(r.downloadUrl);
      return { title: r.title ?? 'Shared file', contentType, kind, blob, access: r.access, uploadUrl: r.uploadUrl };
    }
    return { title: r.title ?? 'Shared', contentType, kind, access: r.access, uploadUrl: r.uploadUrl };
  }
  return null;
}
