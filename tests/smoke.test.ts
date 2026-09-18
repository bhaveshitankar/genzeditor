import { describe, it, expect } from 'vitest';
import { mount } from '../src/main';

describe('app bootstrap', () => {
  it('mounts a header with the app name', () => {
    const root = document.createElement('div');
    mount(root);
    expect(root.querySelector('header')?.textContent).toContain('AnyEdits');
  });
});
