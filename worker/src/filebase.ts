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
