// @vitest-environment node
import { test, expect } from 'vitest';
import { encryptBlob, decryptBlob, isEncrypted } from '../../src/share/crypto';
test('encrypt roundtrip', async () => {
  const src = new Blob(['secret doc ✓']);
  const enc = await encryptBlob(src, 'pa55', 'notes.md');
  expect(await isEncrypted(enc)).toBe(true);
  const dec = await decryptBlob(enc, 'pa55');
  expect(dec.name).toBe('notes.md');
  expect(new TextDecoder().decode(new Uint8Array(await new Response(dec.blob).arrayBuffer()))).toBe('secret doc ✓');
  await expect(decryptBlob(enc, 'wrong')).rejects.toThrow('bad_password');
});
