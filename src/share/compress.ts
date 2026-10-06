// Compression utilities for Filebase storage optimization.
// Uses gzip via pako library for reducing file sizes.

const COMPRESSION_THRESHOLD = 1024; // Only compress files > 1KB
const COMPRESSED_MARKER = 'X-Gzip-Compressed'; // Header to indicate compression

/** Compress a blob using gzip and add metadata */
export async function compressBlob(blob: Blob): Promise<Blob> {
  // Skip compression for small files
  if (blob.size < COMPRESSION_THRESHOLD) {
    return blob;
  }

  try {
    const { compress } = await import('pako');
    const buffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    const compressed = compress(uint8);

    // Only use compression if it actually reduces size
    if (compressed.length < blob.size) {
      return new Blob([compressed], { type: `${blob.type}; ${COMPRESSED_MARKER}` });
    }
  } catch (err) {
    console.warn('Compression failed, uploading uncompressed', err);
  }

  return blob;
}

/** Decompress a blob if it was compressed, otherwise return as-is */
export async function decompressBlob(blob: Blob): Promise<Blob> {
  // Check if blob type indicates compression
  if (!blob.type.includes(COMPRESSED_MARKER)) {
    return blob;
  }

  try {
    const { decompress } = await import('pako');
    const buffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    const decompressed = decompress(uint8);

    // Restore original content type (remove the marker)
    const originalType = blob.type.replace(`; ${COMPRESSED_MARKER}`, '');
    return new Blob([decompressed], { type: originalType });
  } catch (err) {
    console.error('Decompression failed', err);
    throw err;
  }
}

/** Check if blob is compressed */
export function isCompressed(blob: Blob): boolean {
  return blob.type.includes(COMPRESSED_MARKER);
}

/** Get compression ratio as percentage */
export function getCompressionRatio(original: number, compressed: number): number {
  if (original === 0) return 0;
  return Math.round(((original - compressed) / original) * 100);
}
