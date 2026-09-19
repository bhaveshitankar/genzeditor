import { describe, it, expect } from 'vitest';
import { encodeEmbedded, decodeEmbedded, fitsEmbedded } from '../../src/share/embedded';

describe('embedded codec', () => {
  it('round-trips text through deflate + base64url', () => {
    const text = '# Hello\n\nSome **markdown** content.';
    const enc = encodeEmbedded(text);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeEmbedded(enc)).toBe(text);
  });
  it('detects small text fits and large text does not', () => {
    expect(fitsEmbedded('tiny')).toBe(true);
    // Generate random-ish text that won't compress well
    const large = Array.from({ length: 20000 }, (_, i) => `line ${i} ${Math.random()}`).join('\n');
    expect(fitsEmbedded(large)).toBe(false);
  });
});
