import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

const EMBED_MAX = 8 * 1024;

function u8ToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToU8(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeEmbedded(text: string): string {
  return u8ToB64url(deflateSync(strToU8(text)));
}
export function decodeEmbedded(fragment: string): string {
  return strFromU8(inflateSync(b64urlToU8(fragment)));
}
export function fitsEmbedded(text: string): boolean {
  return deflateSync(strToU8(text)).length <= EMBED_MAX;
}
