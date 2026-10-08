import { describe, it, expect, vi } from 'vitest';
import { actionForKey, runAction } from '../../src/editors/editCommands';

const key = (k: string, o: Partial<KeyboardEventInit> = {}) => new KeyboardEvent('keydown', { key: k, ...o });

describe('edit command shortcuts', () => {
  it('maps standard shortcuts', () => {
    expect(actionForKey(key('z', { ctrlKey: true }))).toBe('undo');
    expect(actionForKey(key('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(actionForKey(key('y', { ctrlKey: true }))).toBe('redo');
    expect(actionForKey(key('x', { metaKey: true }))).toBe('cut');
    expect(actionForKey(key('c', { ctrlKey: true }))).toBe('copy');
    expect(actionForKey(key('v', { ctrlKey: true }))).toBe('paste');
    expect(actionForKey(key('d', { ctrlKey: true }))).toBe('duplicate');
    expect(actionForKey(key('Delete'))).toBe('delete');
    expect(actionForKey(key('Backspace'))).toBe('delete');
    expect(actionForKey(key('a'))).toBeNull();
    expect(actionForKey(key('k', { ctrlKey: true }))).toBeNull();
  });
  it('skips selection actions when nothing is selected', () => {
    const del = vi.fn();
    expect(runAction({ delete: del, hasSelection: () => false }, 'delete')).toBe(false);
    expect(runAction({ delete: del, hasSelection: () => true }, 'delete')).toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
    expect(runAction({}, 'undo')).toBe(false);
  });
});
