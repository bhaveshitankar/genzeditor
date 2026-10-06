// Clipboard utilities for cross-browser, cross-platform copy/paste
// Supports both system clipboard API and fallback text selection

/** Copy text to clipboard */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for older browsers
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    throw new Error('Copy failed');
  }
}

/** Copy blob (image/file) to clipboard */
export async function copyBlob(blob: Blob): Promise<void> {
  try {
    if (navigator.clipboard?.write) {
      const item = new ClipboardItem({ [blob.type]: blob });
      await navigator.clipboard.write([item]);
    } else {
      throw new Error('Blob copy not supported in this browser');
    }
  } catch (err) {
    console.error('Failed to copy blob to clipboard:', err);
    throw new Error('Copy blob failed');
  }
}

/** Paste text from clipboard */
export async function pasteText(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    } else {
      throw new Error('readText not supported');
    }
  } catch (err) {
    console.error('Failed to paste from clipboard:', err);
    throw new Error('Paste failed');
  }
}

/** Paste blob (image/file) from clipboard */
export async function pasteBlob(): Promise<Blob | null> {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            return await item.getType(type);
          }
        }
      }
    }
    return null;
  } catch (err) {
    console.error('Failed to paste blob from clipboard:', err);
    return null;
  }
}

/** Check if paste content is available */
export async function canPaste(): Promise<boolean> {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      return items.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** Show temporary toast notification for copy/paste feedback */
export function showClipboardFeedback(message: string, duration: number = 2000): void {
  const toast = document.createElement('div');
  toast.className = 'clipboard-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--brand-500);
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 10000;
    animation: slideIn 0.2s ease-out;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.2s ease-out';
    setTimeout(() => document.body.removeChild(toast), 200);
  }, duration);
}
