import type { FileKind } from '../store/types';
import { decodeEmbedded } from './embedded';
import { detectKind } from '../detect/fileKind';
import * as defaultApi from '../api/client';
import { compressBlob, decompressBlob } from './compress';
import { decryptBlob, encryptBlob, isEncrypted } from './crypto';

export interface OpenedShare {
  title: string; contentType: string; kind: FileKind;
  text?: string; blob?: Blob; access: 'ro' | 'rw';
  // Present only for rw filebase shares: the raw share token the holder uses to
  // request a save-back PUT (presigned against the actual edited size) via
  // POST /api/share/:token/save. ro shares never carry a token.
  token?: string;
  // Set when the share was password protected; reused to re-encrypt save-backs.
  password?: string;
}

async function defaultUploadPut(url: string, blob: Blob, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-length': String(blob.size), 'content-type': contentType },
    body: blob,
  });
  if (!res.ok) throw new Error('save_back_failed');
}

// Write an edited snapshot back to an rw share. First asks the Worker to presign
// a PUT bound to the ACTUAL edited size (re-checking the owner's quota delta),
// then PUTs the blob. Throws the server error code (e.g. 'quota_exceeded',
// 'forbidden') so callers can surface it. ro shares have no token, so save-back
// is impossible for them.
export async function saveBackShared(
  token: string,
  blob: Blob,
  deps?: {
    api?: Pick<typeof import('../api/client'), 'initSaveBack'>;
    uploadPut?: (url: string, blob: Blob, contentType: string) => Promise<void>;
    csrfToken?: string;
    password?: string;
    name?: string;
  },
): Promise<void> {
  const api = deps?.api ?? defaultApi;
  const uploadPut = deps?.uploadPut ?? defaultUploadPut;

  let stored = await compressBlob(blob);
  if (deps?.password) stored = await encryptBlob(stored, deps.password, deps.name ?? 'file');
  const { uploadUrl } = await api.initSaveBack(token, stored.size, deps?.csrfToken);
  await uploadPut(uploadUrl, stored, blob.type);
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
  deps?: {
    api?: typeof import('../api/client');
    fetchBlob?: (url: string) => Promise<Blob>;
    // Asked for protected shares; resolve null to cancel. `retry` = previous attempt was wrong.
    askPassword?: (retry: boolean) => Promise<string | null>;
  },
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
    const token = r.access === 'rw' && r.storageKind === 'filebase' ? t : undefined;
    if (r.storageKind === 'filebase' && r.downloadUrl) {
      let raw = await fetchBlob(r.downloadUrl);
      let title = r.title ?? 'Shared file';
      let password: string | undefined;
      if (await isEncrypted(raw)) {
        if (!deps?.askPassword) throw new Error('password_required');
        for (let retry = false; ; retry = true) {
          const pw = await deps.askPassword(retry);
          if (pw === null) return null;
          try {
            const dec = await decryptBlob(raw, pw);
            raw = dec.blob;
            title = dec.name || title;
            password = pw;
            break;
          } catch (err) {
            if (!(err instanceof Error && err.message === 'bad_password')) throw err;
          }
        }
      }
      const blob = await decompressBlob(raw, contentType);
      const realKind = password ? detectKind(title, contentType) : kind;
      return { title, contentType, kind: realKind, blob, access: r.access, token, password };
    }
    return { title: r.title ?? 'Shared', contentType, kind, access: r.access, token };
  }
  return null;
}
