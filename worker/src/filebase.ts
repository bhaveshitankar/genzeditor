// worker/src/filebase.ts
import type { Env } from './env';
import { presignS3 } from './sigv4';

export async function presignPut(env: Env, key: string, contentLength: number, now = new Date()): Promise<string> {
  return presignS3({
    method: 'PUT',
    endpoint: env.FILEBASE_ENDPOINT,
    region: env.FILEBASE_REGION,
    bucket: env.FILEBASE_BUCKET,
    key,
    accessKey: env.FILEBASE_KEY,
    secretKey: env.FILEBASE_SECRET,
    expiresSeconds: 60,
    now,
    contentLength,
  });
}

export async function presignGet(env: Env, key: string, now = new Date()): Promise<string> {
  return presignS3({
    method: 'GET',
    endpoint: env.FILEBASE_ENDPOINT,
    region: env.FILEBASE_REGION,
    bucket: env.FILEBASE_BUCKET,
    key,
    accessKey: env.FILEBASE_KEY,
    secretKey: env.FILEBASE_SECRET,
    expiresSeconds: 60,
    now,
  });
}

// True only when the object is confirmed gone (2xx, or 404 = already absent).
export async function deleteObject(env: Env, key: string): Promise<boolean> {
  const url = await presignS3({
    method: 'DELETE',
    endpoint: env.FILEBASE_ENDPOINT,
    region: env.FILEBASE_REGION,
    bucket: env.FILEBASE_BUCKET,
    key,
    accessKey: env.FILEBASE_KEY,
    secretKey: env.FILEBASE_SECRET,
    expiresSeconds: 60,
    now: new Date(),
  });
  try {
    const res = await fetch(url, { method: 'DELETE' });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
