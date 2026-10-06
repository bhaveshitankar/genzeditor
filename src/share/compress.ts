// Gzip blobs before they go to Filebase and restore them on download.
// The marker lives in the bytes (not the MIME type), because storage and the
// presigned PUT/GET don't preserve a custom blob type.

const MAGIC = new TextEncoder().encode('GZE1');
const MIN_SIZE = 1024;
// Already-compressed formats: gzip gains nothing, so skip the CPU cost.
const INCOMPRESSIBLE = /^(image\/(jpeg|png|webp|gif|avif)|video\/|audio\/|application\/(zip|gzip|x-7z|x-rar|pdf|vnd\.openxmlformats|epub))/;

async function pipe(blob: Blob, stream: CompressionStream | DecompressionStream): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(stream)).blob();
}

export async function compressBlob(blob: Blob): Promise<Blob> {
  if (blob.size < MIN_SIZE || INCOMPRESSIBLE.test(blob.type) || typeof CompressionStream === 'undefined') return blob;
  try {
    const gz = await pipe(blob, new CompressionStream('gzip'));
    // Keep it only when it saves at least 5%.
    if (gz.size + MAGIC.length > blob.size * 0.95) return blob;
    return new Blob([MAGIC, gz], { type: blob.type });
  } catch {
    return blob;
  }
}

export async function decompressBlob(blob: Blob, type = blob.type): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, MAGIC.length).arrayBuffer());
  if (head.length !== MAGIC.length || !head.every((b, i) => b === MAGIC[i])) return blob;
  const raw = await pipe(blob.slice(MAGIC.length), new DecompressionStream('gzip'));
  return new Blob([raw], { type });
}
