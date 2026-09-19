// worker/src/sigv4.ts
const enc = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return hex(new Uint8Array(buf));
}
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

export interface PresignOpts {
  method: 'PUT' | 'GET' | 'DELETE';
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKey: string;
  secretKey: string;
  expiresSeconds: number;
  now: Date;
  contentLength?: number;
}

export async function presignS3(opts: PresignOpts): Promise<string> {
  const host = new URL(opts.endpoint).host;
  const amzDate = opts.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${opts.region}/s3/aws4_request`;

  const signedHeaderNames = opts.method === 'PUT' && opts.contentLength !== undefined
    ? ['content-length', 'host']
    : ['host'];
  const canonicalHeaders = signedHeaderNames
    .map((h) => (h === 'host' ? `host:${host}\n` : `content-length:${opts.contentLength}\n`))
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${opts.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(opts.expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k]!)}`)
    .join('&');

  const canonicalUri = `/${opts.bucket}/${encodeKeyPath(opts.key)}`;
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(enc.encode('AWS4' + opts.secretKey), dateStamp);
  const kRegion = await hmac(kDate, opts.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(new Uint8Array(await hmac(kSigning, stringToSign)));

  return `${opts.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
