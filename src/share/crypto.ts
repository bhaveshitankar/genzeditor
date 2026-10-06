// Optional password protection for shared files. Encryption happens in the
// browser (PBKDF2-SHA256 → AES-256-GCM); the server only ever stores ciphertext
// and never sees the password. The real file name travels inside the ciphertext.
//
// Layout: "AEP1" | salt(16) | iv(12) | AES-GCM( nameLen(u16) | name utf8 | payload )

import { readBytes } from './compress';

const MAGIC = new TextEncoder().encode('AEP1');
const ITERATIONS = 250_000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBlob(blob: Blob, password: string, name: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const nameBytes = new TextEncoder().encode(name).slice(0, 1024);
  const head = new Uint8Array(2 + nameBytes.length);
  new DataView(head.buffer).setUint16(0, nameBytes.length);
  head.set(nameBytes, 2);
  const plain = await readBytes(new Blob([head, blob]));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return new Blob([MAGIC, salt, iv, ct], { type: 'application/octet-stream' });
}

export async function isEncrypted(blob: Blob): Promise<boolean> {
  const head = await readBytes(blob.slice(0, MAGIC.length));
  return head.length === MAGIC.length && head.every((b, i) => b === MAGIC[i]);
}

/** Throws Error('bad_password') when the password is wrong. */
export async function decryptBlob(blob: Blob, password: string): Promise<{ blob: Blob; name: string }> {
  const buf = await readBytes(blob);
  const salt = buf.slice(4, 20);
  const iv = buf.slice(20, 32);
  const key = await deriveKey(password, salt);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf.slice(32));
  } catch {
    throw new Error('bad_password');
  }
  const bytes = new Uint8Array(plain);
  const n = new DataView(plain).getUint16(0);
  const name = new TextDecoder().decode(bytes.slice(2, 2 + n));
  return { blob: new Blob([bytes.slice(2 + n)]), name };
}
