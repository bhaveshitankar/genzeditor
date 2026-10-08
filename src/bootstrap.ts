import { FileStore, OpfsAdapter } from './store/opfs';
import { AppShell, type ShellApi, type ShellChrome } from './shell/AppShell';
import { openFromHash, saveBackShared } from './share/openShared';
import { deriveBaseName, versionedName } from './store/naming';
import { getMe } from './api/client';
import { initTheme } from './theme/themes';
import { reportFailure } from './telemetry';

// Shared startup for the desktop (index.html) and mobile (mobile.html) apps:
// open share links, restore the last file, accept OS "Open with" launches.
export async function bootstrap(
  root: HTMLElement,
  opts: { mobile?: boolean; chrome?: (api: ShellApi) => ShellChrome } = {},
): Promise<AppShell> {
  initTheme();
  const adapter = new OpfsAdapter();
  const store = new FileStore(adapter);
  // Reclaim space from interrupted saves in the background (never blocks load).
  setTimeout(() => { void adapter.cleanupOrphans().catch(() => {}); }, 5000);
  const shell = new AppShell(root, store, { mobile: !!opts.mobile, chrome: opts.chrome });

  // Open a shared link from the current hash. Runs on initial load and again
  // whenever the hash changes, so pasting a share URL into the same tab opens
  // it immediately without a manual reload. Returns true if a link was opened.
  const openShared = async (): Promise<boolean> => {
    if (typeof location === 'undefined' || !location.hash) return false;
    try {
      const shared = await openFromHash(location.hash, { askPassword: (retry) => askSharePassword(root, retry) });
      if (shared) {
        const blob = shared.blob ?? new Blob([shared.text ?? ''], { type: shared.contentType });
        // Dedupe by share token: re-opening the same link must reuse the local
        // file we already imported (refreshing its content so saved-back edits
        // show up) instead of piling up a new versioned duplicate every refresh.
        const token = shared.token ?? new URLSearchParams(location.hash.replace(/^#/, '')).get('t') ?? undefined;
        const files = await store.list();
        const prior = token ? files.find((f) => f.sourceShareToken === token) : undefined;
        let rec;
        if (prior) {
          await store.update(prior.id, blob);
          rec = prior;
        } else {
          const base = deriveBaseName(shared.title, shared.text);
          const name = versionedName(base, files.map((f) => f.name));
          rec = await store.save(name, blob, shared.kind);
          if (token) await store.updateMeta(rec.id, { sourceShareToken: token });
        }
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
              await saveBackShared(token, current.blob, { csrfToken, password: shared.password, name: shared.title });
              status.textContent = ' Saved back to shared file.';
            } catch (err) {
              reportFailure('save-back', err);
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
      reportFailure('open-shared-link', err);
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

  // Installed app (Chrome/Edge): files opened via the OS "Open with GenZ Editor"
  // arrive through the Launch Queue declared by manifest file_handlers.
  const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files?: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    for (const handle of params.files ?? []) {
      try { await shell.ingestFile(await handle.getFile()); }
      catch (err) { console.error('Failed to open launched file:', err); reportFailure('launch-file', err); }
    }
  });

  // Clearing the hash after opening avoids re-triggering on refresh; but we
  // still listen so a link pasted into this tab opens live.
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => { void openShared(); });
  }
  return shell;
}

// Password prompt for protected share links. Resolves null when cancelled.
function askSharePassword(root: HTMLElement, retry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal share-modal" role="dialog" aria-modal="true">
        <h3>This shared file is password protected</h3>
        <p>Enter the password the sender gave you. It's decrypted in your browser.</p>
        <input type="password" data-role="pw" placeholder="Password" autocomplete="current-password">
        <p class="share-pw-error" data-role="err"></p>
        <div class="modal-actions">
          <button type="button" class="btn-cancel">Cancel</button>
          <button type="button" class="btn-confirm">Open</button>
        </div>
      </div>`;
    const input = overlay.querySelector('[data-role="pw"]') as HTMLInputElement;
    if (retry) (overlay.querySelector('[data-role="err"]') as HTMLElement).textContent = 'Wrong password — try again.';
    const close = (v: string | null) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.btn-cancel')!.addEventListener('click', () => close(null));
    overlay.querySelector('.btn-confirm')!.addEventListener('click', () => { if (input.value) close(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value) close(input.value);
      if (e.key === 'Escape') close(null);
    });
    root.appendChild(overlay);
    input.focus();
  });
}
