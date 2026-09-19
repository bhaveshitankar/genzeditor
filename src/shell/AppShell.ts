import { FileStore } from '../store/opfs';
import type { FileRecord } from '../store/types';
import { handleUpload } from '../upload/uploadHandler';
import { TextEditor } from '../editors/TextEditor';
import { ImageEditor } from '../editors/ImageEditor';
import { renderMarkdown } from '../editors/MarkdownPreview';
import { MermaidPreview } from '../editors/MermaidPreview';
import { formatJson } from '../editors/JsonTools';
import { editorKindFor } from '../editors/registry';
import { CommandPalette } from '../ui/CommandPalette';
import { getMe, API_BASE, type MeState } from '../api/client';
import { renderAuthBar } from '../auth/authUi';
import { shareFile } from '../share/shareFlow';

export class AppShell {
  private currentEditor?: TextEditor | ImageEditor;
  private currentPreview?: MermaidPreview;
  private currentFileId?: string;
  private currentFileKind?: string;
  private saveTimer?: number;
  // Closure that performs the currently-scheduled save (text or image), so a
  // pending debounced save can be flushed synchronously before teardown.
  private pendingSave?: () => Promise<void>;
  // Aborted on every teardown to remove all editor-scoped event listeners.
  private editorAbort?: AbortController;
  private editorHost!: HTMLElement;
  private drawer!: HTMLElement;
  private uploadInput!: HTMLInputElement;
  private palette!: CommandPalette;
  private authBar!: HTMLElement;
  private meState: MeState = { authenticated: false };

  constructor(private root: HTMLElement, private store: FileStore) {
    this.render();
    this.wireUpload();
    this.wirePalette();
    this.wireKeyboard();
    void this.initAuth();
  }

  private async blobToText(blob: Blob): Promise<string> {
    if (blob.text) return blob.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(blob);
    });
  }

  private render() {
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <button class="hamburger" aria-label="Toggle menu">☰</button>
          <h1>AnyEdits</h1>
          <div data-role="auth-bar" class="auth-bar"></div>
        </header>
        <aside class="file-drawer">
          <div class="drawer-header">
            <h2>Files</h2>
            <label class="upload-btn" aria-label="Upload file">
              <input type="file">
              <span>Upload</span>
            </label>
          </div>
          <ul data-role="file-drawer"></ul>
        </aside>
        <main class="editor-area">
          <div data-role="editor-host"></div>
        </main>
      </div>
    `;

    this.editorHost = this.root.querySelector('[data-role="editor-host"]')!;
    this.drawer = this.root.querySelector('[data-role="file-drawer"]')!;
    this.uploadInput = this.root.querySelector('input[type="file"]')!;
    this.authBar = this.root.querySelector('[data-role="auth-bar"]')!;

    // Wire hamburger toggle
    const hamburger = this.root.querySelector('.hamburger') as HTMLButtonElement;
    const aside = this.root.querySelector('.file-drawer') as HTMLElement;
    hamburger?.addEventListener('click', () => {
      aside?.classList.toggle('open');
    });
  }

  private wireUpload() {
    this.uploadInput.addEventListener('change', async () => {
      const file = this.uploadInput.files?.[0];
      if (!file) return;
      const result = await handleUpload(file, this.store);
      if (result.ok) {
        await this.refreshLibrary();
        await this.openFile(result.record.id);
      } else {
        alert(result.error);
      }
      this.uploadInput.value = '';
    });
  }

  private wirePalette() {
    this.palette = new CommandPalette(this.root, [
      {
        id: 'upload',
        label: 'Upload',
        run: () => this.uploadInput.click(),
      },
      {
        id: 'find',
        label: 'Find',
        run: () => this.findInEditor(),
      },
      {
        id: 'format-json',
        label: 'Format JSON',
        run: () => this.formatCurrentJson(),
      },
      {
        id: 'toggle-preview',
        label: 'Toggle preview',
        run: () => this.togglePreview(),
      },
    ]);
  }

  private wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.palette.open();
      }
    });
  }

  private async initAuth() {
    try {
      this.meState = await getMe();
    } catch {
      this.meState = { authenticated: false };
    }
    renderAuthBar(this.authBar, this.meState, { onLogout: () => void this.handleLogout() });
  }

  private async handleLogout() {
    try {
      await fetch(`${API_BASE}/api/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: this.meState.csrfToken ? { 'X-CSRF-Token': this.meState.csrfToken } : {},
      });
      this.meState = { authenticated: false };
      renderAuthBar(this.authBar, this.meState, { onLogout: () => void this.handleLogout() });
    } catch (err) {
      alert(`Logout failed: ${err}`);
    }
  }

  private addShareButton() {
    const toolbar = this.editorHost.querySelector('.toolbar') || (() => {
      const t = document.createElement('div');
      t.className = 'toolbar';
      this.editorHost.insertBefore(t, this.editorHost.firstChild);
      return t;
    })();

    const shareBtn = document.createElement('button');
    shareBtn.textContent = 'Share';
    shareBtn.className = 'share-btn';
    shareBtn.setAttribute('data-role', 'share-btn');
    shareBtn.addEventListener('click', () => void this.handleShare());
    toolbar.appendChild(shareBtn);
  }

  // Serialize the currently-open editor's content as a Blob, for save-back to an
  // rw share. Returns null when nothing is open.
  async getCurrentBlob(): Promise<{ blob: Blob; contentType: string } | null> {
    if (!this.currentEditor) return null;
    const contentType = this.currentFileKind === 'image' ? 'image/png' : 'text/plain';
    if (this.currentEditor instanceof TextEditor) {
      return { blob: new Blob([this.currentEditor.getValue()], { type: contentType }), contentType };
    }
    if (this.currentEditor instanceof ImageEditor) {
      const canvas = this.editorHost.querySelector('canvas') as HTMLCanvasElement;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
      });
      return { blob, contentType: 'image/png' };
    }
    return null;
  }

  private async handleShare() {
    if (!this.currentFileId || !this.currentEditor || !this.currentFileKind) return;

    const files = await this.store.list();
    const record = files.find(f => f.id === this.currentFileId);
    if (!record) return;

    let text: string | undefined;
    let blob: Blob | undefined;
    const contentType = record.kind === 'image' ? 'image/png' : 'text/plain';

    if (this.currentEditor instanceof TextEditor) {
      text = this.currentEditor.getValue();
    } else if (this.currentEditor instanceof ImageEditor) {
      const canvas = this.editorHost.querySelector('canvas') as HTMLCanvasElement;
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
      });
    }

    try {
      const result = await shareFile(
        {
          kind: record.kind,
          text,
          blob,
          contentType,
          title: record.name,
          isLoggedIn: this.meState.authenticated,
          wantRw: false,
          csrfToken: this.meState.csrfToken,
        }
      );

      if ('needLogin' in result) {
        alert(result.needLogin);
        return;
      }

      await navigator.clipboard.writeText(result.url);
      alert(`Share link copied to clipboard!`);
    } catch (err) {
      alert(`Share failed: ${err}`);
    }
  }

  private findInEditor() {
    if (this.currentEditor instanceof TextEditor) {
      // Call CodeMirror's search command directly instead of dispatching a
      // synthetic Ctrl/Cmd+F KeyboardEvent (which is unreliable).
      this.currentEditor.openSearch();
    }
  }

  private formatCurrentJson() {
    if (this.currentFileKind === 'json' && this.currentEditor instanceof TextEditor) {
      const result = formatJson(this.currentEditor.getValue());
      if (result.ok) {
        this.currentEditor.setValue(result.text);
      } else {
        alert(`Format error: ${result.error}`);
      }
    }
  }

  private togglePreview() {
    const preview = this.editorHost.querySelector('[data-role="preview"]') as HTMLElement;
    if (preview) {
      preview.style.display = preview.style.display === 'none' ? '' : 'none';
    }
  }

  async refreshLibrary(): Promise<void> {
    const files = await this.store.list();
    this.drawer.innerHTML = '';
    for (const file of files) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = file.name;
      btn.className = 'file-item';
      btn.addEventListener('click', () => this.openFile(file.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '🗑';
      deleteBtn.className = 'delete-btn';
      deleteBtn.setAttribute('aria-label', `Delete ${file.name}`);
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete ${file.name}?`)) {
          if (this.currentFileId === file.id) {
            await this.clearEditor();
          }
          await this.store.remove(file.id);
          await this.refreshLibrary();
        }
      });

      li.appendChild(btn);
      li.appendChild(deleteBtn);
      this.drawer.appendChild(li);
    }
  }

  async openFile(id: string): Promise<void> {
    const files = await this.store.list();
    const record = files.find(f => f.id === id);
    if (!record) return;

    await this.clearEditor();
    this.currentFileId = id;
    this.currentFileKind = record.kind;

    const blob = await this.store.read(id);
    const editorType = editorKindFor(record.kind);

    // Fresh listener scope for this file; abort()ed in clearEditor so stale
    // handlers from a previous file can never fire against a destroyed editor.
    const abort = new AbortController();
    this.editorAbort = abort;
    const signal = abort.signal;

    if (editorType === 'binary') {
      // Binary files are preview-only: never decode to text or wire autosave,
      // which would rewrite the original bytes from a lossy UTF-8 round-trip.
      const notice = document.createElement('div');
      notice.className = 'binary-notice';
      notice.setAttribute('data-role', 'binary-notice');
      notice.textContent = `${record.name} — ${record.size} bytes — binary file, preview only (not editable)`;
      this.editorHost.appendChild(notice);
      return;
    }

    if (editorType === 'text') {
      const text = await this.blobToText(blob);
      const editor = new TextEditor(this.editorHost, { doc: text, language: record.kind });
      this.currentEditor = editor;

      // Add share button
      this.addShareButton();

      // Set up autosave
      this.editorHost.addEventListener('input', () => this.scheduleAutosave(), { signal });
      this.editorHost.addEventListener('keydown', () => this.scheduleAutosave(), { signal });

      // Add preview for markdown
      if (record.kind === 'markdown') {
        const previewPane = document.createElement('div');
        previewPane.setAttribute('data-role', 'preview');
        previewPane.className = 'preview-pane';
        this.editorHost.appendChild(previewPane);
        this.updateMarkdownPreview(editor, previewPane);
        this.editorHost.addEventListener('input', () => this.updateMarkdownPreview(editor, previewPane), { signal });
      }

      // Add preview for mermaid
      if (record.kind === 'mermaid') {
        const previewPane = document.createElement('div');
        previewPane.setAttribute('data-role', 'preview');
        previewPane.className = 'preview-pane';
        this.editorHost.appendChild(previewPane);
        const mermaid = new MermaidPreview(previewPane);
        this.currentPreview = mermaid;
        mermaid.render(text);
        this.editorHost.addEventListener('input', () => {
          const src = editor.getValue();
          mermaid.render(src);
        }, { signal });
      }

      // Add format button for JSON
      if (record.kind === 'json') {
        const toolbar = document.createElement('div');
        toolbar.className = 'toolbar';
        const formatBtn = document.createElement('button');
        formatBtn.textContent = 'Format';
        formatBtn.className = 'format-btn';
        formatBtn.addEventListener('click', () => {
          const result = formatJson(editor.getValue());
          if (result.ok) {
            editor.setValue(result.text);
          } else {
            alert(`Format error: ${result.error}`);
          }
        });
        toolbar.appendChild(formatBtn);
        this.editorHost.insertBefore(toolbar, this.editorHost.firstChild);
      }
    } else if (editorType === 'image') {
      const canvas = document.createElement('canvas');
      canvas.className = 'image-canvas';
      this.editorHost.appendChild(canvas);
      const img = await createImageBitmap(blob);
      const editor = new ImageEditor(canvas);
      editor.load(img);
      this.currentEditor = editor;

      // Add share button
      this.addShareButton();

      // Add image controls
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';

      const rotate90 = document.createElement('button');
      rotate90.textContent = 'Rotate 90°';
      rotate90.addEventListener('click', () => {
        editor.rotate(90);
        this.scheduleSaveImage(canvas);
      });

      const rotate180 = document.createElement('button');
      rotate180.textContent = 'Rotate 180°';
      rotate180.addEventListener('click', () => {
        editor.rotate(180);
        this.scheduleSaveImage(canvas);
      });

      toolbar.appendChild(rotate90);
      toolbar.appendChild(rotate180);
      this.editorHost.insertBefore(toolbar, this.editorHost.firstChild);
    }
  }

  private updateMarkdownPreview(editor: TextEditor, pane: HTMLElement) {
    const src = editor.getValue();
    pane.innerHTML = renderMarkdown(src);
  }

  private scheduleAutosave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.pendingSave = () => this.autosave();
    this.saveTimer = window.setTimeout(() => { void this.flushPendingSave(); }, 250);
  }

  // Run any scheduled save immediately (synchronously awaited) and clear the
  // timer. Called on debounce fire AND before teardown so fast switch/delete
  // within the 250ms window never loses edits.
  private async flushPendingSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const save = this.pendingSave;
    this.pendingSave = undefined;
    if (save) await save();
  }

  private async autosave() {
    if (!this.currentFileId || !this.currentEditor) return;
    if (this.currentEditor instanceof TextEditor) {
      const text = this.currentEditor.getValue();
      await this.store.update(this.currentFileId, new Blob([text]));
    }
  }

  private scheduleSaveImage(canvas: HTMLCanvasElement) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.pendingSave = async () => {
      if (!this.currentFileId) return;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
      });
      await this.store.update(this.currentFileId, blob);
    };
    this.saveTimer = window.setTimeout(() => { void this.flushPendingSave(); }, 250);
  }

  private async clearEditor(): Promise<void> {
    // Flush any pending debounced save BEFORE destroying the editor, otherwise
    // edits made within the 250ms window are silently lost on switch/delete.
    await this.flushPendingSave();
    // Remove all editor-scoped listeners so stale handlers can't fire against a
    // destroyed CodeMirror view after another file is opened.
    if (this.editorAbort) {
      this.editorAbort.abort();
      this.editorAbort = undefined;
    }
    if (this.currentEditor) {
      if ('destroy' in this.currentEditor) {
        this.currentEditor.destroy();
      }
      this.currentEditor = undefined;
    }
    if (this.currentPreview) {
      this.currentPreview.destroy();
      this.currentPreview = undefined;
    }
    this.editorHost.innerHTML = '';
    this.currentFileId = undefined;
    this.currentFileKind = undefined;
  }
}
