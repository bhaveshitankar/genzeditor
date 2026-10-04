// Shared keyboard undo/redo helper for editors.
// Attaches window-level Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (+ Ctrl+Y) listeners,
// ignoring events when the user is typing in an input/textarea/contentEditable.
// Returns a cleanup function to call in destroy().

export function bindUndoKeys(opts: {
  undo: () => void;
  redo: () => void;
  isActive?: () => boolean;
}): () => void {
  const handler = (e: KeyboardEvent): void => {
    // Check if this editor is active (if provided)
    if (opts.isActive && !opts.isActive()) return;

    // Ignore when typing in editable fields
    const target = e.target as HTMLElement;
    if (target.matches('input, textarea') || target.isContentEditable) return;

    const isMac = navigator.platform.toLowerCase().includes('mac');
    const mod = isMac ? e.metaKey : e.ctrlKey;

    // Cmd/Ctrl+Z → undo
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      opts.undo();
      return;
    }

    // Cmd/Ctrl+Shift+Z or Ctrl+Y → redo
    if ((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (!isMac && e.ctrlKey && e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      opts.redo();
    }
  };

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
