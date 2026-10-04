import './styles/app.css';
import { FileStore, OpfsAdapter } from './store/opfs';
import { AppShell } from './shell/AppShell';
import { openFromHash, saveBackShared } from './share/openShared';
import { deriveBaseName, versionedName } from './store/naming';
import { getMe } from './api/client';
import { initTheme } from './theme/themes';

export async function mount(root: HTMLElement): Promise<void> {
  initTheme();
  const store = new FileStore(new OpfsAdapter());
  const shell = new AppShell(root, store);

  // Open a shared link from the current hash. Runs on initial load and again
  // whenever the hash changes, so pasting a share URL into the same tab opens
  // it immediately without a manual reload. Returns true if a link was opened.
  const openShared = async (): Promise<boolean> => {
    if (typeof location === 'undefined' || !location.hash) return false;
    try {
      const shared = await openFromHash(location.hash);
      if (shared) {
        // Save the shared file to the store, deriving a meaningful name and a
        // version suffix so re-opening the same link doesn't pile up identical
        // duplicates.
        const blob = shared.blob ?? new Blob([shared.text ?? ''], { type: shared.contentType });
        const existing = (await store.list()).map((f) => f.name);
        const base = deriveBaseName(shared.title, shared.text);
        const name = versionedName(base, existing);
        const rec = await store.save(name, blob, shared.kind);
        await shell.refreshLibrary();
        await shell.openFile(rec.id);

        const editorArea = root.querySelector('.editor-area');

        // Read-only shares need no banner: the footer already states files are
        // stored locally. Editable (rw) shares still get a save-back affordance.
        if (shared.access === 'rw' && shared.token) {
          // rw share: offer save-back to replace the Filebase snapshot in place.
          // The PUT is presigned per-save against the actual edited size.
          const token = shared.token;
          const me = await getMe();
          const csrfToken = me.csrfToken;
          const banner = document.createElement('div');
          banner.className = 'rw-banner';
          const label = document.createElement('span');
          label.textContent = 'Editable shared file — save your changes back for everyone.';
          const status = document.createElement('span');
          status.setAttribute('data-role', 'save-back-status');
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save back to share';
          saveBtn.setAttribute('data-role', 'save-back-btn');
          saveBtn.addEventListener('click', async () => {
            status.textContent = '';
            try {
              const current = await shell.getCurrentBlob();
              if (!current) return;
              await saveBackShared(token, current.blob, { csrfToken });
              status.textContent = ' Saved back to shared file.';
            } catch (err) {
              const code = err instanceof Error ? err.message : String(err);
              const msg = code === 'quota_exceeded'
                ? 'storage quota exceeded'
                : code === 'forbidden'
                  ? 'not permitted'
                  : code === 'file_too_large'
                    ? 'file too large'
                    : code;
              status.textContent = ` Save back failed: ${msg}`;
            }
          });
          banner.append(label, saveBtn, status);
          editorArea?.prepend(banner);
        }
        return true;
      }
    } catch (err) {
      console.error('Failed to open shared link:', err);
    }
    return false;
  };

  const opened = await openShared();
  if (!opened) {
    await shell.refreshLibrary();
    // No share link: reopen the file that was open before the refresh so work
    // resumes in place instead of dropping to the empty state.
    await shell.restoreLastFile();
  }

  // Clearing the hash after opening avoids re-triggering on refresh; but we
  // still listen so a link pasted into this tab opens live.
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => { void openShared(); });
  }
}

const el = typeof document !== 'undefined' && document.getElementById('app');
if (el) mount(el);
