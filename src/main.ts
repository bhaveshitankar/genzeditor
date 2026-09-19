import './styles/app.css';
import { FileStore, OpfsAdapter } from './store/opfs';
import { AppShell } from './shell/AppShell';
import { openFromHash, saveBackShared } from './share/openShared';

export async function mount(root: HTMLElement): Promise<void> {
  const store = new FileStore(new OpfsAdapter());
  const shell = new AppShell(root, store);

  // Check for shared link in hash
  if (typeof location !== 'undefined' && location.hash) {
    try {
      const shared = await openFromHash(location.hash);
      if (shared) {
        // Save the shared file to the store
        const blob = shared.blob ?? new Blob([shared.text ?? ''], { type: shared.contentType });
        const rec = await store.save(shared.title, blob, shared.kind);
        await shell.refreshLibrary();
        await shell.openFile(rec.id);

        // Show read-only banner if access is 'ro'
        if (shared.access === 'ro') {
          const banner = document.createElement('div');
          banner.className = 'ro-banner';
          banner.textContent = 'Read-only: This is a shared file. Changes will be saved locally only.';
          banner.style.cssText = 'background: #ffc; padding: 8px; text-align: center; border-bottom: 1px solid #dda;';
          root.querySelector('.app-shell')?.prepend(banner);
        } else if (shared.access === 'rw' && shared.uploadUrl) {
          // rw share: offer save-back to replace the Filebase snapshot in place.
          const uploadUrl = shared.uploadUrl;
          const banner = document.createElement('div');
          banner.className = 'rw-banner';
          banner.style.cssText = 'background: #dfd; padding: 8px; text-align: center; border-bottom: 1px solid #9c9;';
          const label = document.createElement('span');
          label.textContent = 'Editable shared file. ';
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save back to share';
          saveBtn.setAttribute('data-role', 'save-back-btn');
          saveBtn.addEventListener('click', async () => {
            try {
              const current = await shell.getCurrentBlob();
              if (!current) return;
              await saveBackShared(uploadUrl, current.blob);
              alert('Saved back to shared file.');
            } catch (err) {
              alert(`Save back failed: ${err}`);
            }
          });
          banner.append(label, saveBtn);
          root.querySelector('.app-shell')?.prepend(banner);
        }
        return;
      }
    } catch (err) {
      console.error('Failed to open shared link:', err);
    }
  }

  await shell.refreshLibrary();
}

const el = typeof document !== 'undefined' && document.getElementById('app');
if (el) mount(el);
