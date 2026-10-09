import { describe, it, expect } from 'vitest';
import { tokenFromProtocolUrl } from '../src/pwa/capabilities';

describe('web+genz protocol links', () => {
  it('extracts a token from the supported shapes', () => {
    const t = 'AbCdEf0123456789_-xyz';
    expect(tokenFromProtocolUrl(`web+genz:${t}`)).toBe(t);
    expect(tokenFromProtocolUrl(`web+genz://${t}/`)).toBe(t);
    expect(tokenFromProtocolUrl(encodeURIComponent(`web+genz:${t}`))).toBe(t);
    expect(tokenFromProtocolUrl(`https://genzeditor.com/#t=${t}`)).toBe(t);
  });
  it('rejects junk', () => {
    expect(tokenFromProtocolUrl('web+genz:hi')).toBeNull();
    expect(tokenFromProtocolUrl('')).toBeNull();
  });
});
