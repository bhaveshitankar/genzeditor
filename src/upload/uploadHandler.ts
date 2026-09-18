import type { FileRecord } from '../store/types';
import { FileStore } from '../store/opfs';
import { detectKind } from '../detect/fileKind';

const MAX = 500 * 1024 * 1024;

export async function handleUpload(
  file: File,
  store: FileStore
): Promise<{ ok: true; record: FileRecord } | { ok: false; error: string }> {
  if (file.size > MAX) return { ok: false, error: 'File exceeds 500MB limit.' };
  const kind = detectKind(file.name, file.type);
  const record = await store.save(file.name, file, kind);
  return { ok: true, record };
}
