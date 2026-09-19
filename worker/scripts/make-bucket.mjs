// One-off: create a Filebase S3 bucket via a SigV4-signed PUT. Not part of the
// app runtime. Reads FILEBASE_KEY/FILEBASE_SECRET from env, bucket name from argv.
import crypto from 'node:crypto';

const KEY = process.env.FILEBASE_KEY;
const SECRET = process.env.FILEBASE_SECRET;
const bucket = process.argv[2];
const host = 's3.filebase.io';
const region = 'us-east-1';
const service = 's3';
if (!KEY || !SECRET || !bucket) { console.error('missing env or bucket arg'); process.exit(2); }

const now = new Date();
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
const dateStamp = amzDate.slice(0, 8);
const method = 'PUT';
const canonicalUri = `/${bucket}`;
const payloadHash = crypto.createHash('sha256').update('').digest('hex');
const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
const scope = `${dateStamp}/${region}/${service}/aws4_request`;
const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
  crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const kDate = hmac('AWS4' + SECRET, dateStamp);
const kRegion = hmac(kDate, region);
const kService = hmac(kRegion, service);
const kSigning = hmac(kService, 'aws4_request');
const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
const authorization = `AWS4-HMAC-SHA256 Credential=${KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

const res = await fetch(`https://${host}${canonicalUri}`, {
  method,
  headers: { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, authorization },
});
const body = await res.text();
console.log('STATUS', res.status);
console.log(body.slice(0, 500));
process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
