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

export class AppShell {
  private currentEditor?: TextEditor | ImageEditor;
  private currentPreview?: MermaidPreview;
  private currentFileId?: string;
  private currentFileKind?: string;
  private saveTimer?: number;
  private editorHost!: HTMLElement;
  private drawer!: HTMLElement;
  private uploadInput!: HTMLInputElement;
  private palette!: CommandPalette;

  constructor(private root: HTMLElement, private store: FileStore) {
    this.render();
    this.wireUpload();
    this.wirePalette();
    this.wireKeyboard();
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

  private findInEditor() {
    if (this.currentEditor instanceof TextEditor) {
      // Focus the editor and trigger search - CodeMirror search is activated via Ctrl/Cmd+F
      const cmEditor = this.editorHost.querySelector('.cm-editor') as HTMLElement;
      if (cmEditor) {
        cmEditor.focus();
        // Dispatch Ctrl/Cmd+F to open search
        const searchEvent = new KeyboardEvent('keydown', {
          key: 'f',
          ctrlKey: !navigator.platform.includes('Mac'),
          metaKey: navigator.platform.includes('Mac'),
          bubbles: true,
        });
        cmEditor.dispatchEvent(searchEvent);
      }
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
          await this.store.remove(file.id);
          await this.refreshLibrary();
          if (this.currentFileId === file.id) {
            this.clearEditor();
          }
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

    this.clearEditor();
    this.currentFileId = id;
    this.currentFileKind = record.kind;

    const blob = await this.store.read(id);
    const editorType = editorKindFor(record.kind);

    if (editorType === 'text') {
      const text = await this.blobToText(blob);
      const editor = new TextEditor(this.editorHost, { doc: text, language: record.kind });
      this.currentEditor = editor;

      // Set up autosave
      this.editorHost.addEventListener('input', () => this.scheduleAutosave());
      this.editorHost.addEventListener('keydown', () => this.scheduleAutosave());

      // Add preview for markdown
      if (record.kind === 'markdown') {
        const previewPane = document.createElement('div');
        previewPane.setAttribute('data-role', 'preview');
        previewPane.className = 'preview-pane';
        this.editorHost.appendChild(previewPane);
        this.updateMarkdownPreview(editor, previewPane);
        this.editorHost.addEventListener('input', () => this.updateMarkdownPreview(editor, previewPane));
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
        });
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
    this.saveTimer = window.setTimeout(() => this.autosave(), 250);
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
    this.saveTimer = window.setTimeout(async () => {
      if (!this.currentFileId) return;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
      });
      await this.store.update(this.currentFileId, blob);
    }, 250);
  }

  private clearEditor() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
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
