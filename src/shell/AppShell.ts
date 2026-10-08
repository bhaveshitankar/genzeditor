import { FileStore } from '../store/opfs';
import type { FileRecord, FileKind } from '../store/types';
import { handleUpload } from '../upload/uploadHandler';
import { TextEditor } from '../editors/TextEditor';
import type { ImageEditor } from '../editors/ImageEditor';
import { renderMarkdown } from '../editors/MarkdownPreview';
import { MermaidPreview } from '../editors/MermaidPreview';
import { formatJson } from '../editors/JsonTools';
import { editorKindFor, type DocEditor } from '../editors/registry';
import type { SpreadsheetEditor } from '../editors/SpreadsheetEditor';
import type { PdfEditor } from '../editors/PdfEditor';
import type { PresentationEditor } from '../editors/PresentationEditor';
import type { VideoEditor } from '../editors/VideoEditor';
import type { AudioEditor } from '../editors/AudioEditor';
import type { DocxEditor } from '../editors/DocxEditor';
import type { SketchEditor } from '../editors/SketchEditor';
import type { GameEditor } from '../editors/GameEditor';
import type { FloorPlanEditor } from '../editors/FloorPlanEditor';
import { CommandPalette } from '../ui/CommandPalette';
import { lineDiff } from '../diff/lineDiff';
import { getMe, signOut, type MeState, deleteShare } from '../api/client';
import { renderAuthBar, openSignInModal } from '../auth/authUi';
import { shareFile } from '../share/shareFlow';
import { saveBackShared } from '../share/openShared';
import type { ShareLink } from '../store/types';
import { CompareView } from '../diff/CompareView';
import { THEMES, applyTheme, getSavedTheme } from '../theme/themes';
import { validatorFor } from '../editors/validate';
import { AiPanel, type AiTarget } from '../ui/AiPanel';
import { reportFailure, telemetryEnabled, setTelemetryEnabled } from '../telemetry';
import { openFeedbackSheet } from '../ui/FeedbackSheet';
import type { AiEditResult } from '../api/client';
import { icon, iconNameForKind } from '../ui/icons';
import { actionForKey, runAction, isNativeTextTarget, editOverride, showEditMenu, bindLongPress, type EditCommands } from '../editors/editCommands';

/** Hooks a mobile chrome implements to mirror shell state (title, home screen). */
export interface ShellChrome {
  renderHome(host: HTMLElement): void;
  onFileOpened(record: FileRecord): void;
  onLibraryChanged(): void;
}

/** Narrow facade over AppShell for the mobile chrome (keeps internals private). */
export interface ShellApi {
  root: HTMLElement;
  listFiles(): Promise<FileRecord[]>;
  currentFile(): Promise<FileRecord | undefined>;
  currentKind(): FileKind | undefined;
  openFile(id: string): Promise<void>;
  templates(): ReadonlyArray<{ id: string; label: string; kind: FileKind; ext: string }>;
  createFromTemplate(id: string): Promise<void>;
  openNewFileModal(): void;
  iconForKind(kind: string): string;
  upload(): void;
  rename(record: FileRecord): void;
  deleteFile(record: FileRecord): Promise<void>;
  getCurrentBlob(): Promise<{ blob: Blob; contentType: string } | null>;
  docxPdf(): Promise<Blob | null>;
  share(editable: boolean): Promise<void>;
  saveShares(): Promise<void>;
  stopSharing(): Promise<void>;
  compare(): void;
  toggleFullscreen(): void;
  openPalette(): void;
  toggleAi(): void;
  openTheme(anchor: HTMLElement): void;
  openFeedback(): void;
  toast(message: string, kind?: 'success' | 'error' | 'info', ms?: number): void;
  confirm(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  openDrawer(): void;
  closeDrawer(): void;
  formatBytes(n: number): string;
}

export class AppShell {
  // localStorage key holding the id of the last-opened file, so a refresh can
  // reopen it rather than landing on the empty state.
  private static readonly LAST_FILE_KEY = 'anyedits:lastFileId';

  private currentEditor?: TextEditor;
  private currentDoc?: DocEditor;
  // Which lazy-loaded editor class currentDoc is (editors load on demand).
  private currentDocKind?: string;
  private currentPreview?: MermaidPreview;
  private currentFileId?: string;
  private currentFileKind?: string;
  private currentObjectUrl?: string;
  private saveTimer?: number;
  // Closure that performs the currently-scheduled save (text or image), so a
  // pending debounced save can be flushed synchronously before teardown.
  private pendingSave?: () => Promise<void>;
  // Aborted on every teardown to remove all editor-scoped event listeners.
  private editorAbort?: AbortController;
  private editorHost!: HTMLElement;
  private editorTools!: HTMLElement;
  private compareView?: CompareView;
  private sheetCompare?: { close(): void };
  private drawer!: HTMLElement;
  private uploadInput!: HTMLInputElement;
  private palette!: CommandPalette;
  private authBar!: HTMLElement;
  private toastRegion!: HTMLElement;
  private closeDrawer: () => void = () => {};
  private meState: MeState = { authenticated: false };
  private aiPanel?: AiPanel;
  // Multi-select delete: when on, file rows show a checkbox and a selection bar
  // offers "Delete (n)". Tracks which file ids are ticked.
  private selectMode = false;
  private selectedIds = new Set<string>();
  // Live search filter for the files panel (lowercased substring of the name).
  private fileFilter = '';

  private readonly isMobile: boolean;
  private chrome?: ShellChrome;

  constructor(
    private root: HTMLElement,
    private store: FileStore,
    opts: { mobile?: boolean; chrome?: (api: ShellApi) => ShellChrome } = {},
  ) {
    this.isMobile = !!opts.mobile;
    if (this.isMobile) document.documentElement.classList.add('is-mobile');
    this.render();
    this.aiPanel = new AiPanel({
      isAuthed: () => this.meState.authenticated,
      onSignIn: () => openSignInModal(),
      resolve: () => this.resolveAiTarget(),
    });
    this.wireUpload();
    this.wirePalette();
    this.wireKeyboard();
    void this.initAuth();
    if (opts.chrome) {
      this.chrome = opts.chrome(this.api());
      if (!this.currentFileId) this.renderEmptyState();
    }
  }

  private api(): ShellApi {
    const aside = () => this.root.querySelector('.files-panel') as HTMLElement;
    const backdrop = () => this.root.querySelector('[data-role="drawer-backdrop"]') as HTMLElement;
    const current = async () => (this.currentFileId ? (await this.store.list()).find((f) => f.id === this.currentFileId) : undefined);
    return {
      root: this.root,
      listFiles: () => this.store.list(),
      currentFile: current,
      currentKind: () => this.currentFileKind as FileKind | undefined,
      openFile: (id) => this.openFile(id),
      templates: () => AppShell.NEW_FILE_TEMPLATES,
      createFromTemplate: async (id) => {
        if (id === 'scan') { void this.openScanner(); return; }
        const t = AppShell.NEW_FILE_TEMPLATES.find((x) => x.id === id);
        if (!t) return;
        const names = new Set((await this.store.list()).map((f) => f.name));
        let name = `Untitled.${t.ext}`;
        for (let i = 2; names.has(name); i++) name = `Untitled ${i}.${t.ext}`;
        await this.createNewFile(name, t.kind, t.content, t.ext);
      },
      openNewFileModal: () => this.openNewFileModal(),
      iconForKind: (k) => this.iconForKind(k),
      upload: () => this.uploadInput.click(),
      rename: (r) => void this.handleRename(r),
      deleteFile: (r) => this.confirmDeleteFile(r),
      getCurrentBlob: () => this.getCurrentBlob(),
      docxPdf: () => this.currentPdf(),
      share: (rw) => this.handleShare(rw),
      saveShares: () => this.handleSaveShares(),
      stopSharing: () => this.handleStopSharing(),
      compare: () => void this.startCompare(),
      toggleFullscreen: () => this.palette.run('fullscreen'),
      openPalette: () => this.palette.open(),
      toggleAi: () => this.aiPanel?.toggle(),
      openTheme: (a) => this.openThemePopover(a),
      openFeedback: () => this.openFeedback(),
      toast: (m, k, ms) => this.toast(m, k, ms),
      confirm: (o) => this.confirmModal(o),
      openDrawer: () => { aside().classList.add('open'); backdrop().classList.add('show'); },
      closeDrawer: () => this.closeDrawer(),
      formatBytes: (n) => this.formatBytes(n),
    };
  }

  private openFeedback(): void {
    openFeedbackSheet({
      root: this.root,
      app: this.isMobile ? 'mobile' : 'web',
      fileKind: this.currentFileKind,
      toast: (m, k) => this.toast(m, k),
    });
  }

  private async confirmDeleteFile(record: FileRecord): Promise<void> {
    const ok = await this.confirmModal({
      title: 'Delete file?',
      message: `“${record.name}” will be permanently removed from this browser.${this.shareNote([record])}`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    if (this.currentFileId === record.id) await this.clearEditor();
    await this.removeFile(record.id);
    await this.refreshLibrary();
    this.toast(`Deleted “${record.name}”`, 'info', 2500);
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
        <header class="app-ribbon">
          <div class="ribbon-brand">
            <button class="hamburger" aria-label="Toggle files">${icon('menu')}</button>
            <h1 class="brand-name">
              <span class="brand-mark">Gz</span>
              <span class="brand-text">GenZ<span class="brand-accent"> Editor</span></span>
            </h1>
          </div>
          <div class="ribbon-commands">
            <div class="cmd-group" data-role="edit-group" hidden>
              <span class="cmd-group-label">Edit</span>
              <div class="editor-tools cmd-group-items" data-role="editor-tools" aria-label="Editor actions"></div>
            </div>
          </div>
          <div class="ribbon-global">
            <button type="button" class="icon-btn" data-role="fullscreen-btn" aria-label="Full screen editing" title="Full screen (Esc to exit)">${icon('maximize', 18)}</button>
            <button type="button" class="icon-btn" data-role="theme-btn" aria-label="Change theme" title="Theme">${icon('palette', 18)}</button>
            <button type="button" class="header-btn" data-role="compare-btn">${icon('compare', 16)}<span>Compare</span></button>
            <div data-role="auth-bar" class="auth-bar"></div>
          </div>
        </header>
        <div class="app-body">
          <nav class="rail" aria-label="Primary">
            <button type="button" class="rail-btn" data-role="rail-files" aria-label="Toggle files panel" title="Files">
              <span class="rail-icon">${icon('folder')}</span><span class="rail-label">Files</span>
            </button>
            <button type="button" class="rail-btn" data-role="new-btn" aria-label="Create new file" title="New file">
              <span class="rail-icon">${icon('filePlus')}</span><span class="rail-label">New</span>
            </button>
            <button type="button" class="rail-btn" data-role="rail-scan" aria-label="Scan document to PDF" title="Scan document">
              <span class="rail-icon">${icon('camera')}</span><span class="rail-label">Scan</span>
            </button>
            <label class="rail-btn" data-role="rail-upload" aria-label="Upload file" title="Upload">
              <input type="file">
              <span class="rail-icon">${icon('upload')}</span><span class="rail-label">Upload</span>
            </label>
            <button type="button" class="rail-btn" data-role="rail-ai" aria-label="AI edit" title="AI edit">
              <span class="rail-icon">${icon('sparkles')}</span><span class="rail-label">AI</span>
            </button>
            <span class="rail-spacer"></span>
            <button type="button" class="rail-btn" data-role="rail-feedback" aria-label="Report a problem or send feedback" title="Feedback">
              <span class="rail-icon">${icon('info')}</span><span class="rail-label">Feedback</span>
            </button>
            <button type="button" class="rail-btn" data-role="rail-inspector" aria-label="Toggle inspector" title="Details">
              <span class="rail-icon">${icon('info')}</span><span class="rail-label">Details</span>
            </button>
          </nav>
          <aside class="panel files-panel" data-role="files-panel">
            <div class="panel-head">
              <span class="panel-title">Files</span>
              <button type="button" class="select-btn" data-role="select-btn" aria-label="Select files to delete">Select</button>
            </div>
            <div class="panel-search">
              <input type="search" data-role="file-search" placeholder="Search files…" aria-label="Search files" autocomplete="off" spellcheck="false">
            </div>
            <div class="selection-bar" data-role="selection-bar" hidden>
              <span data-role="selection-count">0 selected</span>
              <div class="selection-bar-actions">
                <button type="button" class="btn-select-all" data-role="selection-select-all">Select all</button>
                <button type="button" class="btn-cancel" data-role="selection-cancel">Cancel</button>
                <button type="button" class="btn-danger" data-role="selection-delete">Delete</button>
              </div>
            </div>
            <ul data-role="file-drawer"></ul>
            <div class="storage-hint" data-role="storage-hint">
              <span class="storage-hint-icon">${icon('hardDrive', 16)}</span><span>Stored locally in your browser</span>
            </div>
          </aside>
          <div class="sidebar-resizer" data-role="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"></div>
          <main class="editor-area">
            <div data-role="editor-host"></div>
          </main>
          <aside class="panel inspector" data-role="inspector">
            <div class="panel-head">
              <span class="panel-title">Inspector</span>
              <button type="button" class="panel-collapse" data-role="inspector-collapse" aria-label="Collapse inspector" title="Collapse">${icon('x', 16)}</button>
            </div>
            <section class="file-actions" data-role="file-actions" aria-label="Actions for the open file" hidden></section>
            <div class="inspector-empty" data-role="inspector-empty">
              <span class="inspector-empty-icon">ℹ︎</span>
              <p>Open a file to see its details and actions here.</p>
            </div>
          </aside>
          <div class="drop-overlay">Drop file to open</div>
          <div class="drawer-backdrop" data-role="drawer-backdrop"></div>
        </div>
      </div>
      <div class="toast-region" data-role="toast-region" aria-live="polite"></div>
    `;

    this.editorHost = this.root.querySelector('[data-role="editor-host"]')!;
    this.editorTools = this.root.querySelector('[data-role="editor-tools"]')!;
    this.drawer = this.root.querySelector('[data-role="file-drawer"]')!;
    this.uploadInput = this.root.querySelector('input[type="file"]')!;
    this.authBar = this.root.querySelector('[data-role="auth-bar"]')!;
    this.toastRegion = this.root.querySelector('[data-role="toast-region"]')!;

    const aside = this.root.querySelector('.files-panel') as HTMLElement;
    const shellEl = this.root.querySelector('.app-shell') as HTMLElement;
    const backdrop = this.root.querySelector('[data-role="drawer-backdrop"]') as HTMLElement;
    const closeDrawer = () => { aside.classList.remove('open'); backdrop.classList.remove('show'); };
    this.closeDrawer = closeDrawer;
    this.root.querySelector('.hamburger')?.addEventListener('click', () => {
      const open = aside.classList.toggle('open');
      backdrop.classList.toggle('show', open);
    });

    // Power BI–style dockable panels. The left rail toggles the files panel and
    // the right inspector on desktop; on phones the files panel is the off-canvas
    // drawer (hamburger) and the inspector drops to a bottom sheet.
    const isNarrow = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 719px)').matches;
    this.root.querySelector('[data-role="rail-files"]')?.addEventListener('click', () => {
      if (isNarrow()) {
        const open = aside.classList.toggle('open');
        backdrop.classList.toggle('show', open);
      } else {
        shellEl.classList.toggle('files-collapsed');
      }
      this.syncRailState();
    });
    const toggleInspector = () => {
      const isCollapsed = shellEl.classList.contains('inspector-collapsed');
      shellEl.classList.toggle('inspector-collapsed');
      // If opening inspector, close AI panel
      if (isCollapsed && this.aiPanel) {
        this.aiPanel.close?.();
      }
      this.syncRailState();
    };
    this.root.querySelector('[data-role="rail-inspector"]')?.addEventListener('click', toggleInspector);
    this.root.querySelector('[data-role="inspector-collapse"]')?.addEventListener('click', toggleInspector);

    this.root.querySelector('[data-role="rail-scan"]')?.addEventListener('click', () => void this.openScanner());

    // AI panel toggle with mutual exclusivity
    this.root.querySelector('[data-role="rail-ai"]')?.addEventListener('click', () => {
      if (this.aiPanel?.toggle) {
        this.aiPanel.toggle();
        // If AI panel is open, collapse inspector
        const isInspectorOpen = !shellEl.classList.contains('inspector-collapsed');
        if (isInspectorOpen) {
          shellEl.classList.add('inspector-collapsed');
          this.syncRailState();
        }
      }
    });

    // Live filter of the file list.
    const search = this.root.querySelector('[data-role="file-search"]') as HTMLInputElement | null;
    search?.addEventListener('input', () => {
      this.fileFilter = search.value.trim().toLowerCase();
      void this.refreshLibrary();
    });

    // Inspector starts collapsed until a file is open (nothing to inspect yet).
    shellEl.classList.add('inspector-collapsed');
    this.syncRailState();

    // Full-screen editing: hides the sidebar so the document fills the width.
    // A SINGLE toggle button (in the header) swaps between enter/exit — only one
    // state is shown at a time, always in the same place. Esc also exits.
    const shell = this.root.querySelector('.app-shell') as HTMLElement;
    const fsBtn = this.root.querySelector('[data-role="fullscreen-btn"]') as HTMLElement | null;
    const setFullscreen = (on: boolean) => {
      shell.classList.toggle('fullscreen', on);
      if (fsBtn) {
        fsBtn.textContent = on ? '⤢' : '⛶';
        fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen editing');
        fsBtn.setAttribute('title', on ? 'Exit full screen (Esc)' : 'Full screen');
        fsBtn.setAttribute('aria-pressed', String(on));
      }
    };
    fsBtn?.addEventListener('click', () => {
      setFullscreen(!shell.classList.contains('fullscreen'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && shell.classList.contains('fullscreen')) setFullscreen(false);
    });

    // Draggable sidebar width (desktop). Updates the --sidebar-w custom property
    // the .file-drawer reads; clamped to a sane range.
    const sidebarResizer = this.root.querySelector('[data-role="sidebar-resizer"]') as HTMLElement | null;
    if (sidebarResizer) {
      this.setupResizer(sidebarResizer, (e) => {
        const panel = this.root.querySelector('.files-panel') as HTMLElement;
        const panelLeft = panel.getBoundingClientRect().left;
        const w = Math.max(200, Math.min(e.clientX - panelLeft, 520));
        document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
      });
    }
    backdrop.addEventListener('click', closeDrawer);
    this.root.querySelector('[data-role="compare-btn"]')?.addEventListener('click', () => void this.startCompare());
    this.root.querySelector('[data-role="theme-btn"]')?.addEventListener('click', (e) => this.openThemePopover(e.currentTarget as HTMLElement));
    this.root.querySelector('[data-role="new-btn"]')?.addEventListener('click', () => void this.openNewFileModal());
    this.root.querySelector('[data-role="rail-feedback"]')?.addEventListener('click', () => this.openFeedback());

    this.root.querySelector('[data-role="select-btn"]')?.addEventListener('click', () => this.toggleSelectMode());
    this.root.querySelector('[data-role="selection-cancel"]')?.addEventListener('click', () => this.toggleSelectMode(false));
    this.root.querySelector('[data-role="selection-delete"]')?.addEventListener('click', () => void this.deleteSelected());
    this.root.querySelector('[data-role="selection-select-all"]')?.addEventListener('click', () => void this.toggleSelectAll());

    this.wireDragAndDrop();
    this.renderEmptyState();
  }

  // Reflect panel dock state on the rail toggle buttons (active = panel open).
  private syncRailState() {
    const shell = this.root.querySelector('.app-shell') as HTMLElement | null;
    if (!shell) return;
    const filesBtn = this.root.querySelector('[data-role="rail-files"]') as HTMLElement | null;
    const inspBtn = this.root.querySelector('[data-role="rail-inspector"]') as HTMLElement | null;
    const filesOpen = !shell.classList.contains('files-collapsed');
    const inspOpen = !shell.classList.contains('inspector-collapsed');
    filesBtn?.classList.toggle('active', filesOpen);
    filesBtn?.setAttribute('aria-pressed', String(filesOpen));
    inspBtn?.classList.toggle('active', inspOpen);
    inspBtn?.setAttribute('aria-pressed', String(inspOpen));
  }

  /** Premium empty state with a drag-and-drop zone, shown when no file is open. */
  private renderEmptyState() {
    if (this.chrome) { this.chrome.renderHome(this.editorHost); return; }
    this.editorHost.innerHTML = `
      <div class="empty-state">
        <div class="dropzone" data-role="dropzone">
          <div class="drop-icon">✦</div>
          <h2>drop it like it's hot 🔥</h2>
          <p>Toss a file in here — text, code, images, docs, sketches, even games. It opens instantly, stays on your device, and needs zero signup.</p>
          <button class="browse-btn" type="button">Pick a file</button>
          <div class="kbd-hint">psst — hit <kbd>⌘</kbd> <kbd>K</kbd> for the command palette</div>
        </div>
        <p class="oss-note">✦ 100% open source &amp; free — <a href="https://github.com/bhaveshitankar/genzeditor" target="_blank" rel="noopener noreferrer">star or contribute on GitHub</a> 💜</p>
      </div>
    `;
    const dz = this.editorHost.querySelector('[data-role="dropzone"]') as HTMLElement;
    dz.querySelector('.browse-btn')?.addEventListener('click', () => this.uploadInput.click());
    dz.addEventListener('click', (e) => {
      if (e.target === dz) this.uploadInput.click();
    });
  }

  private wireDragAndDrop() {
    const body = this.root.querySelector('.app-body') as HTMLElement;
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      body.classList.add('drag-active');
    };
    const onLeave = () => { depth = Math.max(0, depth - 1); if (depth === 0) body.classList.remove('drag-active'); };
    body.addEventListener('dragenter', onEnter);
    body.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    body.addEventListener('dragleave', onLeave);
    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      body.classList.remove('drag-active');
      const file = e.dataTransfer?.files?.[0];
      if (file) await this.ingestFile(file);
    });
  }

  async ingestFile(file: File) {
    const result = await handleUpload(file, this.store);
    if (result.ok) {
      await this.refreshLibrary();
      await this.openFile(result.record.id);
      this.toast(`Opened “${file.name}”`, 'success');
    } else {
      this.toast(result.error, 'error');
    }
  }

  private wireUpload() {
    this.uploadInput.addEventListener('change', async () => {
      const file = this.uploadInput.files?.[0];
      if (!file) return;
      await this.ingestFile(file);
      this.uploadInput.value = '';
    });
  }

  // Normalize the model's JSON ops: accept a bare array, {key:[...]}, or — when
  // the model mangles the key — the first array-valued property anywhere.
  private aiArray(ops: unknown, key: string): any[] {
    if (Array.isArray(ops)) return ops;
    const o = ops as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return [];
    if (Array.isArray(o[key])) return o[key] as any[];
    for (const v of Object.values(o)) if (Array.isArray(v)) return v as any[];
    return [];
  }
  private aiObject(ops: unknown, key: string): Record<string, unknown> {
    const o = ops as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return {};
    const v = o[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    // Mangled key: if there's exactly one nested object, use it; else use o.
    const nested = Object.values(o).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (nested.length === 1) return nested[0] as Record<string, unknown>;
    return o;
  }

  /** Describe the current editor to the AI panel, or null if its kind is unsupported. */
  private resolveAiTarget(): AiTarget | null {
    const kind = this.currentFileKind as FileKind | undefined;
    if (!kind) return null;
    const save = () => this.scheduleSaveDoc();

    if (this.currentEditor instanceof TextEditor) {
      const ed = this.currentEditor;
      return {
        kind: kind === 'json' ? 'form' : 'text',
        label: kind === 'json' ? 'JSON' : kind === 'code' ? 'code' : 'text',
        meta: { language: kind },
        getText: () => ed.getValue(),
        apply: (r: AiEditResult) => { if (r.text != null) ed.setValue(r.text); return 'updated'; },
        onChanged: () => this.scheduleAutosave(),
      };
    }
    if (this.currentDocKind === 'ImageEditor') {
      const ed = this.currentDoc as ImageEditor;
      return { kind: 'image', label: 'image', apply: (r) => ed.applyAiOps(this.aiArray(r.ops, 'ops')), onChanged: save };
    }
    if (this.currentDocKind === 'VideoEditor') {
      const ed = this.currentDoc as VideoEditor;
      // Non-destructive video edits persist on explicit export, not autosave.
      return { kind: 'video', label: 'video', apply: (r) => ed.applyAiPatch(this.aiObject(r.ops, 'patch')) };
    }
    if (this.currentDocKind === 'AudioEditor') {
      const ed = this.currentDoc as AudioEditor;
      return { kind: 'audio', label: 'audio', apply: (r) => ed.applyAiOps(this.aiArray(r.ops, 'ops')), onChanged: save };
    }
    if (this.currentDocKind === 'DocxEditor') {
      const ed = this.currentDoc as DocxEditor;
      return { kind: 'docx', label: 'document', getText: () => ed.getHtml(), apply: (r) => (r.text != null ? ed.setHtml(r.text) : 'no changes'), onChanged: save };
    }
    if (this.currentDocKind === 'SpreadsheetEditor') {
      const ed = this.currentDoc as SpreadsheetEditor;
      return { kind: 'spreadsheet', label: 'spreadsheet', getText: () => ed.getCsv(), apply: (r) => (r.text != null ? ed.setCsv(r.text) : 'no changes'), onChanged: save };
    }
    if (this.currentDocKind === 'PdfEditor') {
      const ed = this.currentDoc as PdfEditor;
      return { kind: 'pdf', label: 'PDF', apply: (r) => ed.applyAiAnnotations(this.aiArray(r.ops, 'annotations')), onChanged: save };
    }
    if (this.currentDocKind === 'GameEditor') {
      const ed = this.currentDoc as GameEditor;
      return { kind: 'game', label: 'game', meta: { doc: ed.aiDoc() }, apply: (r) => ed.applyAiOps(this.aiArray(r.ops, 'ops')), onChanged: save };
    }
    if (this.currentDocKind === 'FloorPlanEditor') {
      const ed = this.currentDoc as FloorPlanEditor;
      return { kind: 'floorplan', label: 'floor plan', getText: () => ed.getPlanJson(), apply: (r) => (r.text != null ? ed.applyAiPlan(r.text) : 'no changes'), onChanged: save };
    }
    if (this.currentDocKind === 'SketchEditor') {
      const ed = this.currentDoc as SketchEditor;
      return { kind: 'sketch', label: 'sketch', getText: () => ed.getSceneJson(), apply: (r) => ed.applyAiScene(JSON.stringify(r.ops ?? {})), onChanged: save };
    }
    return null;
  }

  /** Lightweight, auto-dismissing toast — replaces alert() for non-blocking feedback. */
  private toast(message: string, kind: 'success' | 'error' | 'info' = 'info', ms = 3800) {
    // Cap concurrent toasts to 3: remove oldest if we're at the limit
    while (this.toastRegion.children.length >= 3) {
      this.toastRegion.children[0]?.remove();
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    this.toastRegion.appendChild(el);
    const remove = () => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };
    window.setTimeout(remove, ms);
    el.addEventListener('click', remove);
  }

  /** Promise-based confirm modal — replaces the native confirm() dialog. */
  private confirmModal(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h3></h3>
          <p></p>
          <div class="modal-actions">
            <button type="button" class="btn-cancel">Cancel</button>
            <button type="button" class="${opts.danger ? 'btn-danger' : 'btn-confirm'}"></button>
          </div>
        </div>`;
      (overlay.querySelector('h3') as HTMLElement).textContent = opts.title;
      (overlay.querySelector('p') as HTMLElement).textContent = opts.message;
      const confirmBtn = overlay.querySelector('.modal-actions button:last-child') as HTMLButtonElement;
      confirmBtn.textContent = opts.confirmLabel ?? 'Confirm';
      const close = (v: boolean) => { overlay.remove(); resolve(v); };
      overlay.querySelector('.btn-cancel')?.addEventListener('click', () => close(false));
      confirmBtn.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
      });
      this.root.appendChild(overlay);
      confirmBtn.focus();
    });
  }

  /** Explain the upload + retention before sharing; optionally collect a password. */
  private shareConsentModal(wantRw: boolean): Promise<{ password?: string } | null> {
    const days = this.meState.authenticated ? 30 : 7;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal share-modal" role="dialog" aria-modal="true">
          <h3></h3>
          <p class="share-note"></p>
          <ul class="share-facts">
            <li data-f="where"></li>
            <li data-f="keep"></li>
            <li data-f="who"></li>
            <li data-f="data"></li>
          </ul>
          <label class="share-pw-toggle"><input type="checkbox" data-role="pw-on"> Protect with a password</label>
          <div class="share-pw" hidden>
            <input type="password" data-role="pw" placeholder="Password (min 4 characters)" autocomplete="new-password">
            <input type="password" data-role="pw2" placeholder="Confirm password" autocomplete="new-password">
            <p class="share-pw-hint">Encrypted in your browser before upload — we never see the password and can't recover it. Share it separately from the link.</p>
            <p class="share-pw-error" data-role="pw-err"></p>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-cancel">Cancel</button>
            <button type="button" class="btn-confirm">Upload &amp; copy link</button>
          </div>
        </div>`;
      const q = <T extends HTMLElement>(sel: string) => overlay.querySelector(sel) as T;
      q('h3').textContent = wantRw ? 'Create an editable share link?' : 'Create a share link?';
      q('.share-note').textContent = 'Sharing uploads a copy of this file to our server so it can be opened from a link.';
      q('[data-f="where"]').textContent = 'Your file leaves this device and is stored on our cloud storage.';
      q('[data-f="keep"]').textContent = `We keep it for ${days} days${this.meState.authenticated ? '' : ' (30 days when signed in)'}, then delete it automatically.`;
      q('[data-f="data"]').innerHTML = 'Max 20 MB, 10 new links per day. We store only the file, its type/size and an anonymised (hashed) IP/device ID to prevent abuse — no tracking. Delete it anytime with “Stop sharing”. <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a>';
      q('[data-f="who"]').textContent = wantRw
        ? 'Anyone with the link can open and edit it.'
        : 'Anyone with the link can open it (public).';
      const on = q<HTMLInputElement>('[data-role="pw-on"]');
      const box = q('.share-pw');
      const pw = q<HTMLInputElement>('[data-role="pw"]');
      const pw2 = q<HTMLInputElement>('[data-role="pw2"]');
      const err = q('[data-role="pw-err"]');
      on.addEventListener('change', () => { box.hidden = !on.checked; if (on.checked) pw.focus(); });
      const close = (v: { password?: string } | null) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(v); };
      const submit = () => {
        if (!on.checked) { close({}); return; }
        if (pw.value.length < 4) { err.textContent = 'Use at least 4 characters.'; return; }
        if (pw.value !== pw2.value) { err.textContent = 'Passwords do not match.'; return; }
        close({ password: pw.value });
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') close(null);
        else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') submit();
      };
      document.addEventListener('keydown', onKey);
      q('.btn-cancel').addEventListener('click', () => close(null));
      q('.btn-confirm').addEventListener('click', submit);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      this.root.appendChild(overlay);
      q<HTMLButtonElement>('.btn-confirm').focus();
    });
  }

  // Templates for the "New file" flow. Each entry maps to a FileKind plus a
  // default extension and starter content (Mermaid ships a ready-to-edit graph).
  private static readonly NEW_FILE_TEMPLATES: Array<{
    id: string; label: string; icon: string; kind: FileKind; ext: string; content: string;
  }> = [
    { id: 'text', label: 'Text', icon: '📄', kind: 'text', ext: 'txt', content: '' },
    { id: 'markdown', label: 'Markdown', icon: '📝', kind: 'markdown', ext: 'md', content: '# Title\n\nStart writing…\n' },
    { id: 'mermaid', label: 'Mermaid diagram', icon: '🕸', kind: 'mermaid', ext: 'mmd',
      content: 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do this]\n  B -->|No| D[Do that]\n  C --> E[End]\n  D --> E\n' },
    { id: 'json', label: 'JSON', icon: '{ }', kind: 'json', ext: 'json', content: '{\n  \n}\n' },
    { id: 'csv', label: 'Spreadsheet (CSV)', icon: '📊', kind: 'spreadsheet', ext: 'csv', content: 'Column A,Column B,Column C\n,,\n' },
    { id: 'code', label: 'Code', icon: '⌘', kind: 'code', ext: 'txt', content: '' },
    { id: 'document', label: 'Word document', icon: '📘', kind: 'document', ext: 'docx', content: '' },
    { id: 'presentation', label: 'Presentation', icon: '📽', kind: 'presentation', ext: 'pptx', content: '' },
    { id: 'scan', label: 'Scan document → PDF', icon: '📷', kind: 'pdf', ext: 'pdf', content: '' },
    { id: 'image', label: 'Image (blank)', icon: '🖼', kind: 'image', ext: 'png', content: '' },
    { id: 'audio', label: 'Audio (record)', icon: '🎙', kind: 'audio', ext: 'wav', content: '' },
    { id: 'sketch', label: 'Sketch', icon: '✏️', kind: 'sketch', ext: 'excalidraw', content: '' },
    { id: 'floorplan', label: 'Interior design', icon: '🏠', kind: 'floorplan', ext: 'floorplan', content: '' },
    { id: 'game', label: 'Game (build & play)', icon: '🎮', kind: 'game', ext: 'game', content: '' },
  ];

  /** Modal to pick a file type + name, then create and open a blank document. */
  private openNewFileModal(): void {
    const templates = AppShell.NEW_FILE_TEMPLATES;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal new-file-modal" role="dialog" aria-modal="true">
        <h3>Create a new file</h3>
        <div class="new-file-types" role="listbox" aria-label="File type"></div>
        <label class="new-file-name-label">Name
          <input type="text" class="new-file-name" autocomplete="off" spellcheck="false">
        </label>
        <div class="modal-actions">
          <button type="button" class="btn-cancel">Cancel</button>
          <button type="button" class="btn-confirm">Create</button>
        </div>
      </div>`;
    const typesEl = overlay.querySelector('.new-file-types') as HTMLElement;
    const nameInput = overlay.querySelector('.new-file-name') as HTMLInputElement;
    let selected = templates[0]!;

    const applyName = () => { nameInput.value = `Untitled.${selected.ext}`; };
    for (const t of templates) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-file-type' + (t === selected ? ' selected' : '');
      b.setAttribute('role', 'option');
      b.innerHTML = `<span class="nf-icon"></span><span class="nf-label"></span>`;
      (b.querySelector('.nf-icon') as HTMLElement).innerHTML = this.iconForKind(t.id === 'scan' ? 'scan' : t.kind);
      (b.querySelector('.nf-label') as HTMLElement).textContent = t.label;
      b.addEventListener('click', () => {
        selected = t;
        typesEl.querySelectorAll('.new-file-type').forEach((el) => el.classList.remove('selected'));
        b.classList.add('selected');
        applyName();
        nameInput.focus();
      });
      typesEl.appendChild(b);
    }
    applyName();

    const close = () => overlay.remove();
    overlay.querySelector('.btn-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); }
    });
    const confirm = overlay.querySelector('.btn-confirm') as HTMLButtonElement;
    const submit = () => {
      const name = (nameInput.value.trim() || `Untitled.${selected.ext}`);
      close();
      if (selected.id === 'scan') { void this.openScanner(); return; }
      void this.createNewFile(name, selected.kind, selected.content, selected.ext);
    };
    confirm.addEventListener('click', submit);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    this.root.appendChild(overlay);
    nameInput.focus();
    nameInput.setSelectionRange(0, nameInput.value.lastIndexOf('.'));
  }

  private async createNewFile(name: string, kind: FileKind, content: string, ext: string): Promise<void> {
    // Ensure the name carries an extension so re-detection on reload is stable.
    if (!/\.[^.]+$/.test(name)) name = `${name}.${ext}`;

    // Blank image: generate a real white PNG so the image editor has a canvas.
    if (kind === 'image') {
      const blob = await this.blankPng(1280, 720);
      const rec = await this.store.save(name, blob, kind);
      await this.refreshLibrary();
      await this.openFile(rec.id);
      this.toast(`Created “${name}”`, 'success', 2500);
      return;
    }
    // Audio (record) and Word document start empty — their editors handle a
    // zero-byte blob (show a Record prompt / a blank editable page).
    // A blank sketch is also an empty blob — SketchEditor starts an empty scene
    // for zero-byte input and writes real .excalidraw JSON on first save.
    if (kind === 'audio' || kind === 'document' || kind === 'sketch' || kind === 'floorplan' || kind === 'presentation') {
      const type = kind === 'audio' ? 'audio/wav'
        : kind === 'sketch' || kind === 'floorplan' ? 'application/json'
        : 'application/octet-stream';
      const blob = new Blob([], { type });
      const rec = await this.store.save(name, blob, kind);
      await this.refreshLibrary();
      await this.openFile(rec.id);
      this.toast(`Created “${name}”`, 'success', 2500);
      return;
    }

    const type = kind === 'spreadsheet' ? 'text/csv' : 'text/plain';
    const blob = new Blob([content], { type });
    const rec = await this.store.save(name, blob, kind);
    await this.refreshLibrary();
    await this.openFile(rec.id);
    this.toast(`Created “${name}”`, 'success', 2500);
  }

  // PDF rendition of the open doc (Word / presentation), for "Download as PDF".
  private async currentPdf(): Promise<Blob | null> {
    if (this.currentDocKind === 'DocxEditor') return (this.currentDoc as DocxEditor).pdfBlob();
    if (this.currentDocKind === 'PresentationEditor') return (this.currentDoc as PresentationEditor).pdfBlob();
    return null;
  }

  // Full-screen document scanner (camera / uploads → perspective-corrected PDF).
  private async openScanner(): Promise<void> {
    this.closeDrawer();
    const { openDocScanner } = await import('../tools/DocScanner');
    openDocScanner({
      root: this.root,
      toast: (m, k) => this.toast(m, k),
      onSave: async (pdf, name) => {
        const rec = await this.store.save(await this.uniqueName(name), pdf, 'pdf');
        await this.refreshLibrary();
        await this.openFile(rec.id);
        this.toast(`Saved “${rec.name}”`, 'success', 2500);
      },
      onSaveImages: async (images, baseName) => {
        for (let i = 0; i < images.length; i++) {
          const ext = images[i]!.type === 'image/png' ? 'png' : 'jpg';
          await this.store.save(await this.uniqueName(`${baseName} p${i + 1}.${ext}`), images[i]!, 'image');
        }
        await this.refreshLibrary();
        this.toast(`Saved ${images.length} image${images.length === 1 ? '' : 's'}`, 'success', 2500);
      },
    });
  }

  // Name not already used in the library ("a.png" → "a (2).png").
  private async uniqueName(name: string): Promise<string> {
    const names = new Set((await this.store.list()).map((f) => f.name));
    if (!names.has(name)) return name;
    const m = /^(.*?)(\.[^.]+)?$/.exec(name)!;
    for (let i = 2; ; i++) {
      const n = `${m[1]} (${i})${m[2] ?? ''}`;
      if (!names.has(n)) return n;
    }
  }

  // Generate a blank white PNG blob for a new image document.
  private async blankPng(w: number, h: number): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png'));
  }

  private wirePalette() {
    this.palette = new CommandPalette(this.root, [
      {
        id: 'new-file',
        label: 'New file',
        run: () => void this.openNewFileModal(),
      },
      {
        id: 'upload',
        label: 'Upload',
        run: () => this.uploadInput.click(),
      },
      {
        id: 'scan-document',
        label: 'Scan document to PDF',
        run: () => void this.openScanner(),
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
      {
        id: 'compare',
        label: 'Compare documents',
        run: () => void this.startCompare(),
      },
      {
        id: 'save',
        label: 'Save',
        run: () => void this.handleSaveShares(),
      },
      {
        id: 'download',
        label: 'Download current file',
        run: async () => {
          const files = await this.store.list();
          const record = files.find(f => f.id === this.currentFileId);
          if (record) void this.handleDownload(record);
          else this.toast('No file open to download', 'info');
        },
      },
      {
        id: 'share-readonly',
        label: 'Share link (read-only)',
        run: () => {
          if (this.currentFileId) void this.handleShare(false);
          else this.toast('No file open to share', 'info');
        },
      },
      {
        id: 'share-editable',
        label: 'Share link (editable)',
        run: () => {
          if (this.currentFileId) void this.handleShare(true);
          else this.toast('No file open to share', 'info');
        },
      },
      {
        id: 'rename',
        label: 'Rename current file',
        run: async () => {
          const files = await this.store.list();
          const record = files.find(f => f.id === this.currentFileId);
          if (record) void this.handleRename(record);
          else this.toast('No file open to rename', 'info');
        },
      },
      {
        id: 'delete',
        label: 'Delete current file',
        run: async () => {
          if (!this.currentFileId) { this.toast('No file open to delete', 'info'); return; }
          const files = await this.store.list();
          const record = files.find(f => f.id === this.currentFileId);
          if (!record) return;
          const ok = await this.confirmModal({
            title: 'Delete file?',
            message: `"${record.name}" will be permanently removed from this browser.${this.shareNote([record])}`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (ok) {
            await this.clearEditor();
            await this.removeFile(record.id);
            await this.refreshLibrary();
            this.toast(`Deleted "${record.name}"`, 'info', 2500);
          }
        },
      },
      {
        id: 'fullscreen',
        label: 'Toggle full screen',
        run: () => {
          const shell = this.root.querySelector('.app-shell') as HTMLElement | null;
          if (!shell) return;
          const isFullscreen = shell.classList.contains('fullscreen');
          shell.classList.toggle('fullscreen');
          const fsBtn = this.root.querySelector('[data-role="fullscreen-btn"]') as HTMLElement | null;
          if (fsBtn) {
            fsBtn.textContent = !isFullscreen ? '⤢' : '⛶';
            fsBtn.setAttribute('aria-label', !isFullscreen ? 'Exit full screen' : 'Full screen editing');
            fsBtn.setAttribute('title', !isFullscreen ? 'Exit full screen (Esc)' : 'Full screen');
            fsBtn.setAttribute('aria-pressed', String(!isFullscreen));
          }
        },
      },
      {
        id: 'feedback',
        label: 'Report a problem / send feedback',
        run: () => this.openFeedback(),
      },
      {
        id: 'error-reports',
        label: 'Toggle anonymous error reports',
        run: () => {
          const on = !telemetryEnabled();
          setTelemetryEnabled(on);
          this.toast(on ? 'Anonymous error reports on' : 'Anonymous error reports off', 'info', 2200);
        },
      },
      {
        id: 'theme',
        label: 'Switch theme',
        run: () => {
          const btn = this.root.querySelector('[data-role="theme-btn"]') as HTMLElement | null;
          if (btn) this.openThemePopover(btn);
        },
      },
    ]);
  }

  // Compare entry point: on laptop/desktop open the live side-by-side split with
  // git-style merge; on narrow screens fall back to the compact diff modal.
  private async startCompare() {
    // Spreadsheets (CSV / Excel) get a cell-level compare at any screen width.
    if (this.currentFileKind === 'spreadsheet' || this.sheetCompare) {
      if (this.sheetCompare) { this.sheetCompare.close(); return; }
      const files = (await this.store.list()).filter((f) => f.kind === 'spreadsheet');
      if (files.length < 1) { this.toast('Add a spreadsheet to compare', 'info', 4000); return; }
      const { SheetCompare } = await import('../diff/SheetCompare');
      const area = this.root.querySelector('.editor-area') as HTMLElement;
      this.sheetCompare = new SheetCompare(area, this.store, files, {
        initialLeftId: this.currentFileId,
        onClose: () => { this.sheetCompare = undefined; },
        toast: (m, k) => this.toast(m, k),
      });
      return;
    }
    const wide = typeof matchMedia !== 'undefined' && matchMedia('(min-width: 720px)').matches;
    if (!wide) return this.openCompare();

    if (this.compareView) { this.compareView.close(); return; }
    const files = await this.store.list();
    const textFiles = files.filter((f) => editorKindFor(f.kind) === 'text');
    if (textFiles.length < 1) {
      this.toast('Add a text document to compare', 'info', 4000);
      return;
    }
    const area = this.root.querySelector('.editor-area') as HTMLElement;
    this.compareView = new CompareView(area, this.store, files, {
      initialLeftId: this.currentFileId,
      onClose: () => { this.compareView = undefined; },
      onFilesChanged: () => void this.refreshLibrary(),
    });
  }

  // Small popover of theme swatches anchored under the header 🎨 button.
  private openThemePopover(anchor: HTMLElement) {
    const existing = this.root.querySelector('.theme-popover');
    if (existing) { existing.remove(); return; }

    const pop = document.createElement('div');
    pop.className = 'theme-popover';
    pop.setAttribute('role', 'listbox');
    const current = getSavedTheme();
    for (const t of THEMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-option' + (t.id === current ? ' selected' : '');
      b.setAttribute('role', 'option');
      b.innerHTML =
        `<span class="theme-swatch" style="background:linear-gradient(135deg, ${t.swatch[0]} 40%, ${t.swatch[1]} 100%)"></span>` +
        `<span class="theme-label"></span>` +
        (t.animated ? '<span class="theme-anim" title="Animated">✦</span>' : '');
      (b.querySelector('.theme-label') as HTMLElement).textContent = t.label;
      b.addEventListener('click', () => {
        applyTheme(t.id);
        pop.remove();
        this.toast(`Theme: ${t.label}`, 'info', 1800);
      });
      pop.appendChild(b);
    }
    const tele = document.createElement('label');
    tele.className = 'theme-telemetry';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = telemetryEnabled();
    cb.addEventListener('change', () => setTelemetryEnabled(cb.checked));
    tele.append(cb, document.createTextNode(' Send anonymous error reports'));
    pop.appendChild(tele);
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.right = `${window.innerWidth - rect.right}px`;
    this.root.appendChild(pop);

    // Dismiss on outside click / Escape.
    const onDoc = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && e.target !== anchor) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { pop.remove(); document.removeEventListener('keydown', onKey); }
    });
  }

  /** Open a modal to pick two text documents and view a line-level diff. */
  private async openCompare() {
    const files = (await this.store.list()).filter((f) => editorKindFor(f.kind) === 'text');
    if (files.length < 2) {
      this.toast('Need at least two text documents to compare', 'info', 4000);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal wide" role="dialog" aria-modal="true">
        <div class="compare-head">
          <h3>Compare documents</h3>
          <button type="button" class="modal-close" aria-label="Close">✕</button>
        </div>
        <div class="compare-selects">
          <select data-role="cmp-a"></select>
          <span class="compare-vs">vs</span>
          <select data-role="cmp-b"></select>
        </div>
        <div class="diff-view" data-role="diff-view"></div>
      </div>`;

    const selA = overlay.querySelector('[data-role="cmp-a"]') as HTMLSelectElement;
    const selB = overlay.querySelector('[data-role="cmp-b"]') as HTMLSelectElement;
    for (const f of files) {
      selA.appendChild(new Option(f.name, f.id));
      selB.appendChild(new Option(f.name, f.id));
    }
    selA.selectedIndex = 0;
    selB.selectedIndex = Math.min(1, files.length - 1);

    const view = overlay.querySelector('[data-role="diff-view"]') as HTMLElement;
    const render = async () => {
      const a = await this.blobToText(await this.store.read(selA.value));
      const b = await this.blobToText(await this.store.read(selB.value));
      view.innerHTML = '';
      const ops = lineDiff(a, b);
      if (ops.every((o) => o.type === 'eq')) {
        const same = document.createElement('div');
        same.className = 'diff-identical';
        same.textContent = 'The two documents are identical.';
        view.appendChild(same);
        return;
      }
      for (const op of ops) {
        const line = document.createElement('div');
        line.className = `diff-line diff-${op.type}`;
        const gutter = op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' ';
        line.textContent = `${gutter} ${op.text}`;
        view.appendChild(line);
      }
    };

    selA.addEventListener('change', () => void render());
    selB.addEventListener('change', () => void render());
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); }
    });

    this.root.appendChild(overlay);
    void render();
  }

  private wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.palette.open();
      }
    });
    this.wireEditCommands();
  }

  // Commands of whatever has focus: an open tool overlay, else the open editor.
  private activeCommands(target: EventTarget | null): EditCommands | null {
    const ov = editOverride();
    if (ov) return ov.root.contains(target as Node) || target === document.body ? ov.cmds : null;
    const cmds = this.currentDoc?.commands?.();
    if (!cmds) return null;
    const el = target as HTMLElement | null;
    // Only when the editor (or nothing in particular) has focus — not the file
    // list, a modal, or the AI panel.
    if (el && el !== document.body && !this.editorHost.contains(el)) return null;
    if (this.root.querySelector('.modal-overlay')) return null;
    return cmds;
  }

  // Shared shortcuts for every editor (web) + long-press edit menu (touch).
  private wireEditCommands() {
    let pendingPaste = 0;
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.isComposing || isNativeTextTarget(e.target)) return;
      const action = actionForKey(e);
      if (!action) return;
      const cmds = this.activeCommands(e.target);
      if (!cmds) return;
      if (action === 'paste') {
        // Let the native paste event deliver clipboard files/images; fall back
        // to a data-less paste if the browser doesn't fire one.
        if (!cmds.paste) return;
        clearTimeout(pendingPaste);
        pendingPaste = window.setTimeout(() => runAction(cmds, 'paste'), 80);
        return;
      }
      if (runAction(cmds, action)) e.preventDefault();
    });
    document.addEventListener('paste', (e) => {
      if (isNativeTextTarget(e.target)) return;
      const cmds = this.activeCommands(e.target);
      if (!cmds?.paste) return;
      clearTimeout(pendingPaste);
      e.preventDefault();
      runAction(cmds, 'paste', e.clipboardData);
    });

    const inScope = (t: EventTarget | null): boolean => {
      const ov = editOverride();
      const node = t as Node;
      return ov ? ov.root.contains(node) : this.editorHost.contains(node);
    };
    bindLongPress((e) => {
      if (!inScope(e.target) || isNativeTextTarget(e.target)) return;
      const cmds = this.activeCommands(e.target);
      if (cmds) showEditMenu(cmds, e.clientX, e.clientY);
    });
    // Suppress the OS "save image / copy" callout where our menu takes over.
    document.addEventListener('contextmenu', (e) => {
      const pe = e as PointerEvent;
      const touch = pe.pointerType ? pe.pointerType !== 'mouse' : matchMedia('(pointer: coarse)').matches;
      if (touch && inScope(e.target) && !isNativeTextTarget(e.target) && this.activeCommands(e.target)) e.preventDefault();
    });
  }

  private async initAuth() {
    try {
      this.meState = await getMe();
    } catch {
      this.meState = { authenticated: false };
    }
    this.paintAuthBar();
  }

  private paintAuthBar() {
    renderAuthBar(this.authBar, this.meState, {
      onLogout: () => void this.handleLogout(),
      onSignIn: () => openSignInModal(),
    });
  }

  private async handleLogout() {
    try {
      await signOut();
      this.meState = { authenticated: false };
      this.paintAuthBar();
      this.toast('Signed out', 'info');
    } catch (err) {
      reportFailure('logout', err);
      this.toast(`Logout failed: ${err}`, 'error');
    }
  }

  // The editor's kind-specific buttons (Format, Find, image ops, view toggle…)
  // live in the single top header now — not a second toolbar row — so the editing
  // surface reclaims that vertical space. Returns the cleared header slot; every
  // openFile branch fills it in place of the old per-editor `.toolbar` element.
  // Thin position indicator under a top-bar tool strip that scrolls sideways, so
  // users can tell there's more. Click the bar to jump; removed with the editor.
  private watchStripScroll(strip: HTMLElement): void {
    const group = this.root.querySelector('[data-role="edit-group"]') as HTMLElement | null;
    if (!group) return;
    group.querySelector('.scroll-hint')?.remove();
    const bar = document.createElement('div');
    bar.className = 'scroll-hint';
    const thumb = document.createElement('span');
    bar.appendChild(thumb);
    group.appendChild(bar);
    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      bar.hidden = max <= 2;
      if (bar.hidden) return;
      const w = Math.max(0.12, strip.clientWidth / strip.scrollWidth);
      thumb.style.width = `${w * 100}%`;
      thumb.style.left = `${(strip.scrollLeft / max) * (1 - w) * 100}%`;
    };
    strip.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(strip);
    for (const c of Array.from(strip.children)) ro.observe(c);
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      const f = (e.clientX - r.left) / r.width;
      strip.scrollTo({ left: f * (strip.scrollWidth - strip.clientWidth), behavior: 'smooth' });
    });
    this.editorAbort?.signal.addEventListener('abort', () => { ro.disconnect(); bar.remove(); });
    requestAnimationFrame(update);
  }

  private editorToolbar(): HTMLElement {
    this.editorTools.innerHTML = '';
    this.editorTools.classList.add('active');
    // Reveal the ribbon "Edit" command group only if editors actually add buttons.
    // Since editors add buttons AFTER calling editorToolbar(), check via a microtask.
    const group = this.root.querySelector('[data-role="edit-group"]') as HTMLElement | null;
    if (group) {
      group.hidden = true; // Start hidden
      requestAnimationFrame(() => {
        // Reveal only if editorTools has children
        group.hidden = this.editorTools.childElementCount === 0;
      });
    }
    return this.editorTools;
  }

  // Render the per-file actions (Save, Download, Share link, Share editable) into
  // the left sidebar panel — grouped with New/Upload — rather than the editor
  // toolbar, so the editing surface stays uncluttered. Called on every openFile.
  // The `toolbar` argument is retained for call-site compatibility but unused.
  private addToolbarActions(_toolbar: HTMLElement, record: FileRecord) {
    const panel = this.root.querySelector('[data-role="file-actions"]') as HTMLElement | null;
    if (!panel) return;
    panel.innerHTML = '';
    panel.hidden = false;
    // Reveal the inspector (dock it open) and hide its empty placeholder.
    const empty = this.root.querySelector('[data-role="inspector-empty"]') as HTMLElement | null;
    if (empty) empty.hidden = true;
    // Dock the inspector open on desktop; on phones leave it as a closed bottom
    // sheet so opening a file doesn't cover the document (tap Details to reveal).
    const narrow = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 719px)').matches;
    const shell = this.root.querySelector('.app-shell') as HTMLElement | null;
    if (!narrow) shell?.classList.remove('inspector-collapsed');
    this.syncRailState();

    const heading = document.createElement('p');
    heading.className = 'file-actions-title';
    heading.textContent = record.name;
    heading.title = record.name;
    heading.style.cursor = 'pointer';
    heading.addEventListener('click', () => void this.handleRename(record));

    // Lightweight metadata row (kind · size) — Power BI-style properties.
    const meta = document.createElement('p');
    meta.className = 'file-actions-meta';
    meta.textContent = `${record.kind} · ${this.formatBytes(record.size)}`;

    const grid = document.createElement('div');
    grid.className = 'file-actions-grid';

    const mk = (label: string, icon: string, role: string, onClick: () => void, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `file-action ${cls}`.trim();
      b.setAttribute('data-role', role);
      b.innerHTML = `<span class="file-action-icon" aria-hidden="true">${icon}</span><span>${label}</span>`;
      b.addEventListener('click', onClick);
      return b;
    };

    // Crisp stroke icons (feather-style, inherit currentColor) instead of emoji,
    // which render inconsistently across platforms and look out of place.
    const ic = (paths: string) =>
      `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const ICON = {
      save: ic('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
      download: ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
      link: ic('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
      edit: ic('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
    };

    // "Save" pushes the current content to every live share link for this file
    // (both read-only and editable). Only shown once the file has tracked links.
    const save = mk('Save', ICON.save, 'save-shares-btn', () => void this.handleSaveShares(), 'is-primary');
    if (!record.shares || record.shares.length === 0) save.hidden = true;

    const download = mk('Download', ICON.download, 'download-btn', () => void this.handleDownload(record));
    const shareRo = mk('Share link', ICON.link, 'share-btn', () => void this.handleShare(false));
    const shareRw = mk('Share editable', ICON.edit, 'share-rw-btn', () => void this.handleShare(true), 'is-accent');

    const stop = mk('Stop sharing', ICON.link, 'stop-share-btn', () => void this.handleStopSharing(), 'is-danger');
    if (!record.shares || record.shares.length === 0) stop.hidden = true;

    grid.append(save, download, shareRo, shareRw, stop);
    if (this.currentDocKind === 'PresentationEditor') {
      const pdf = mk('Export PDF', ICON.download, 'export-pdf-btn', async () => {
        const blob = await this.currentPdf();
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = record.name.replace(/\.[^.]+$/, '') + '.pdf'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      });
      grid.insertBefore(pdf, shareRo);
    }
    panel.append(heading, meta, grid);
  }

  // Reveal/hide the Save button in the current toolbar based on whether the file
  // has tracked share links (called after a share is first created).
  private syncSaveButton(hasShares: boolean) {
    const btn = this.root.querySelector<HTMLButtonElement>('[data-role="save-shares-btn"]');
    if (btn) btn.hidden = !hasShares;
    const stop = this.root.querySelector<HTMLButtonElement>('[data-role="stop-share-btn"]');
    if (stop) stop.hidden = !hasShares;
  }

  // Serialize the current editor's content once, in the shape shareFile wants.
  private async currentShareContent(kind: FileKind): Promise<{ text?: string; blob?: Blob; contentType: string } | null> {
    let contentType = kind === 'image' ? 'image/png' : 'text/plain';
    if (this.currentDoc) {
      const current = await this.getCurrentBlob();
      if (!current) return null;
      return { blob: current.blob, contentType: current.contentType };
    }
    if (this.currentEditor instanceof TextEditor) {
      return { text: this.currentEditor.getValue(), contentType };
    }
    return null;
  }

  private async handleDownload(record: FileRecord) {
    let current: { blob: Blob; contentType: string } | null;
    try {
      current = await this.getCurrentBlob();
    } catch (err) {
      reportFailure('export', err, record.kind);
      this.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    if (!current) return;
    let name = record.name;
    // Images can export PNG (transparency / bg-removal) or JPEG (jpg source);
    // align the download extension with whatever the editor actually produced.
    if (this.currentFileKind === 'image') {
      const ext = current.contentType === 'image/jpeg' ? 'jpg' : 'png';
      if (!new RegExp(`\\.${ext}$`, 'i').test(name)) name = name.replace(/\.[^.]+$/, '') + '.' + ext;
    }
    const url = URL.createObjectURL(current.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.toast(`Downloading “${name}”`, 'success', 2000);
  }

  // Serialize the currently-open editor's content as a Blob, for save-back to an
  // rw share. Returns null when nothing is open.
  async getCurrentBlob(): Promise<{ blob: Blob; contentType: string } | null> {
    if (this.currentDoc) {
      const ex = await this.currentDoc.export();
      if (ex) return ex;
      // View-only doc (e.g. presentation): fall back to the original bytes.
      if (this.currentFileId) {
        const blob = await this.store.read(this.currentFileId);
        return { blob, contentType: blob.type || 'application/octet-stream' };
      }
      return null;
    }
    if (!this.currentEditor) return null;
    const contentType = this.currentFileKind === 'image' ? 'image/png' : 'text/plain';
    if (this.currentEditor instanceof TextEditor) {
      return { blob: new Blob([this.currentEditor.getValue()], { type: contentType }), contentType };
    }
    return null;
  }

  private async handleShare(wantRw = false) {
    if (!this.currentFileId) return;

    const files = await this.store.list();
    const record = files.find(f => f.id === this.currentFileId);
    if (!record) return;

    const access: 'ro' | 'rw' = wantRw ? 'rw' : 'ro';

    // Reuse an existing link for this access level instead of minting a new doc.
    const existing = record.shares?.find(s => s.access === access);
    if (existing) {
      // Push the latest content to the existing link so the copied URL is fresh,
      // then copy it. This keeps "Share" idempotent per access level.
      await this.pushToShares([existing]);
      await navigator.clipboard.writeText(existing.url);
      this.toast(
        wantRw ? 'Editable link copied (existing link updated)' : 'Read-only link copied (existing link updated)',
        'success',
      );
      return;
    }

    const content = await this.currentShareContent(record.kind);
    if (!content) return;

    // The Worker rejects zero-byte shares (invalid_size); catch that here with a
    // friendly message instead of a raw error toast.
    const byteLen = content.blob
      ? content.blob.size
      : new TextEncoder().encode(content.text ?? '').length;
    if (byteLen === 0) {
      this.toast('Add some content before sharing this file.', 'info');
      return;
    }

    if (wantRw && !this.meState.authenticated) {
      this.toast('Sign in to create editable (read-write) links.', 'info', 5000);
      return;
    }
    const consent = await this.shareConsentModal(wantRw);
    if (!consent) return;

    try {
      const result = await shareFile({
        password: consent.password,
        kind: record.kind,
        text: content.text,
        blob: content.blob,
        contentType: content.contentType,
        title: record.name,
        isLoggedIn: this.meState.authenticated,
        wantRw,
        csrfToken: this.meState.csrfToken,
      });

      if ('needLogin' in result) {
        this.toast(result.needLogin, 'info', 5000);
        return;
      }

      const link: ShareLink = { access: result.access, token: result.token, shareId: result.shareId, url: result.url, password: consent.password };
      const shares = [...(record.shares ?? []).filter(s => s.access !== link.access), link];
      await this.store.updateMeta(record.id, { shares });
      this.syncSaveButton(true);

      await navigator.clipboard.writeText(result.url);
      this.toast(
        wantRw ? 'Editable share link copied to clipboard' : 'Read-only link copied to clipboard',
        'success',
      );
    } catch (err) {
      reportFailure('share', err, record.kind);
      this.toast(`Share failed: ${this.friendlyShareError(err)}`, 'error');
    }
  }

  // Delete a file from this browser, plus any uploaded share copies on our
  // server (best effort — server copies also expire on their own).
  private async removeFile(id: string): Promise<void> {
    const record = (await this.store.list()).find((f) => f.id === id);
    for (const sh of record?.shares ?? []) {
      await deleteShare(sh.shareId, this.meState.csrfToken).catch(() => {});
    }
    await this.store.remove(id);
  }

  private shareNote(records: { shares?: ShareLink[] }[]): string {
    return records.some((r) => r.shares?.length) ? ' Its share links will stop working and the uploaded copy is deleted from our server.' : '';
  }

  // Right to erasure: delete this file's uploaded copies from our server now.
  private async handleStopSharing() {
    const record = (await this.store.list()).find((f) => f.id === this.currentFileId);
    if (!record?.shares?.length) return;
    const ok = await this.confirmModal({
      title: 'Stop sharing?',
      message: 'This deletes the uploaded copy from our server right away. Existing links will stop working. Your local file stays.',
      confirmLabel: 'Delete from server',
      danger: true,
    });
    if (!ok) return;
    const left: ShareLink[] = [];
    for (const sh of record.shares) {
      try { await deleteShare(sh.shareId, this.meState.csrfToken); }
      catch { left.push(sh); }
    }
    await this.store.updateMeta(record.id, { shares: left });
    this.syncSaveButton(left.length > 0);
    if (left.length) reportFailure('stop-sharing', new Error(`${left.length} delete(s) failed`), record.kind);
    if (left.length) this.toast('Some links could not be deleted (sign in on the device that created them) — try again.', 'error', 5000);
    else this.toast('Share links deleted from our server', 'success');
  }

  // Map known Worker error codes to human-readable text.
  private friendlyShareError(err: unknown): string {
    const code = err instanceof Error ? err.message : String(err);
    switch (code) {
      case 'quota_exceeded': return 'storage quota exceeded — sign in for more, or delete a share';
      case 'file_too_large': return 'files up to 20 MB can be shared';
      case 'share_daily_limit': return 'daily limit reached (10 new links per day) — try again tomorrow';
      case 'rate_limited': return 'too many requests — wait a minute and try again';
      case 'invalid_size': return 'nothing to share (file is empty)';
      case 'rw_requires_login': return 'sign in to create editable links';
      case 'forbidden': return 'not permitted';
      default: return code.replace(/^Error:\s*/, '');
    }
  }

  // Push the current editor content to every live share link of this file, so a
  // single "Save" updates what all readers and collaborators see. The owner can
  // update both ro and rw links (the Worker authorizes ro save-back by owner).
  private async handleSaveShares() {
    if (!this.currentFileId) return;
    const files = await this.store.list();
    const record = files.find(f => f.id === this.currentFileId);
    if (!record?.shares?.length) return;

    try {
      const count = await this.pushToShares(record.shares);
      // Also persist the edit locally so the stored copy matches the shared one.
      const content = await this.getCurrentBlob();
      if (content) await this.store.update(record.id, content.blob);
      this.toast(`Saved to ${count} shared link${count === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      reportFailure('save-shares', err, this.currentFileKind);
      this.toast(`Save failed: ${err}`, 'error');
    }
  }

  // Upload the current content to each given share link. Returns how many were
  // updated. Throws on the first failure (surfaced by the caller).
  private async pushToShares(shares: ShareLink[]): Promise<number> {
    const content = await this.getCurrentBlob();
    if (!content) throw new Error('nothing to save');
    const blob = content.blob.type ? content.blob : new Blob([content.blob], { type: content.contentType });
    const name = (await this.store.list()).find((f) => f.id === this.currentFileId)?.name;
    let n = 0;
    for (const s of shares) {
      await saveBackShared(s.token, blob, { csrfToken: this.meState.csrfToken, password: s.password, name });
      n++;
    }
    return n;
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
        this.toast('JSON formatted', 'success', 2000);
      } else {
        this.toast(`Format error: ${result.error}`, 'error');
      }
    }
  }

  private togglePreview() {
    const preview = this.editorHost.querySelector('[data-role="preview"]') as HTMLElement;
    if (preview) {
      preview.style.display = preview.style.display === 'none' ? '' : 'none';
    }
  }

  private iconForKind(kind: string): string {
    return icon(iconNameForKind(kind), 18);
  }

  // Toggle multi-select mode. `on` omitted flips the current state.
  private toggleSelectMode(on?: boolean) {
    this.selectMode = on ?? !this.selectMode;
    if (!this.selectMode) this.selectedIds.clear();
    const bar = this.root.querySelector('[data-role="selection-bar"]') as HTMLElement | null;
    if (bar) bar.hidden = !this.selectMode;
    const btn = this.root.querySelector('[data-role="select-btn"]') as HTMLElement | null;
    if (btn) { btn.textContent = this.selectMode ? 'Done' : 'Select'; btn.classList.toggle('active', this.selectMode); }
    this.updateSelectionCount();
    void this.refreshLibrary();
  }

  private updateSelectionCount() {
    const count = this.selectedIds.size;
    const label = this.root.querySelector('[data-role="selection-count"]') as HTMLElement | null;
    if (label) label.textContent = `${count} selected`;
    const del = this.root.querySelector('[data-role="selection-delete"]') as HTMLButtonElement | null;
    if (del) del.disabled = count === 0;
    // Update Select all/Clear button
    const selectAllBtn = this.root.querySelector('[data-role="selection-select-all"]') as HTMLButtonElement | null;
    if (selectAllBtn) {
      const totalFiles = this.drawer.querySelectorAll('.file-item').length;
      const allSelected = count > 0 && count === totalFiles;
      selectAllBtn.textContent = allSelected ? 'Clear' : 'Select all';
    }
  }

  private async toggleSelectAll() {
    const files = await this.store.list();
    const filtered = this.fileFilter
      ? files.filter((f) => f.name.toLowerCase().includes(this.fileFilter))
      : files;
    const allSelected = this.selectedIds.size === filtered.length && filtered.length > 0;
    if (allSelected) {
      // Clear all
      this.selectedIds.clear();
    } else {
      // Select all visible files
      for (const f of filtered) {
        this.selectedIds.add(f.id);
      }
    }
    this.updateSelectionCount();
    void this.refreshLibrary();
  }

  private async deleteSelected() {
    const ids = [...this.selectedIds];
    if (ids.length === 0) return;
    const ok = await this.confirmModal({
      title: `Delete ${ids.length} file${ids.length === 1 ? '' : 's'}?`,
      message: `${ids.length} file${ids.length === 1 ? '' : 's'} will be permanently removed from this browser.${(await this.store.list()).some((f) => ids.includes(f.id) && f.shares?.length) ? ' Share links for them stop working and uploaded copies are deleted from our server.' : ''}`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    for (const id of ids) {
      if (this.currentFileId === id) await this.clearEditor();
      await this.removeFile(id);
    }
    this.toast(`Deleted ${ids.length} file${ids.length === 1 ? '' : 's'}`, 'info', 2500);
    this.toggleSelectMode(false);
  }

  private async handleRename(record: FileRecord) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>Rename file</h3>
        <label class="new-file-name-label">New name
          <input type="text" class="new-file-name" autocomplete="off" spellcheck="false">
        </label>
        <div class="modal-actions">
          <button type="button" class="btn-cancel">Cancel</button>
          <button type="button" class="btn-confirm">Rename</button>
        </div>
      </div>`;
    const nameInput = overlay.querySelector('.new-file-name') as HTMLInputElement;
    nameInput.value = record.name;

    const close = () => overlay.remove();
    overlay.querySelector('.btn-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); }
    });
    const confirm = overlay.querySelector('.btn-confirm') as HTMLButtonElement;
    const submit = async () => {
      const newName = nameInput.value.trim();
      if (!newName || newName === record.name) { close(); return; }
      close();
      try {
        await this.store.rename(record.id, newName);
        await this.refreshLibrary();
        // Update the inspector title if this file is currently open
        if (this.currentFileId === record.id) {
          const title = this.root.querySelector('.file-actions-title') as HTMLElement | null;
          if (title) {
            title.textContent = newName;
            title.title = newName;
          }
        }
        this.toast(`Renamed to "${newName}"`, 'success', 2500);
      } catch (err) {
        reportFailure('rename', err, record.kind);
        this.toast(`Rename failed: ${err}`, 'error');
      }
    };
    confirm.addEventListener('click', () => void submit());
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });

    this.root.appendChild(overlay);
    nameInput.focus();
    nameInput.setSelectionRange(0, nameInput.value.lastIndexOf('.') > 0 ? nameInput.value.lastIndexOf('.') : nameInput.value.length);
  }

  async refreshLibrary(): Promise<void> {
    await this.renderLibrary();
    this.chrome?.onLibraryChanged();
  }

  private async renderLibrary(): Promise<void> {
    const all = await this.store.list();
    this.drawer.innerHTML = '';

    if (all.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = 'No files yet. Upload one to get started.';
      this.drawer.appendChild(empty);
      return;
    }

    const files = this.fileFilter
      ? all.filter((f) => f.name.toLowerCase().includes(this.fileFilter))
      : all;

    if (files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = `No files match “${this.fileFilter}”.`;
      this.drawer.appendChild(empty);
      return;
    }

    for (const file of files) {
      const li = document.createElement('li');
      li.dataset.id = file.id;
      if (file.id === this.currentFileId) li.classList.add('active');
      if (this.selectMode) li.classList.add('selecting');

      // In select mode a checkbox replaces file-opening; clicking the row toggles.
      let checkbox: HTMLInputElement | undefined;
      if (this.selectMode) {
        checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'file-check';
        checkbox.checked = this.selectedIds.has(file.id);
        checkbox.setAttribute('aria-label', `Select ${file.name}`);
        checkbox.addEventListener('change', () => {
          if (checkbox!.checked) this.selectedIds.add(file.id);
          else this.selectedIds.delete(file.id);
          this.updateSelectionCount();
        });
        li.appendChild(checkbox);
      }

      const btn = document.createElement('button');
      btn.className = 'file-item';
      btn.innerHTML = `<span class="file-icon"></span><span class="file-name"></span>`;
      (btn.querySelector('.file-icon') as HTMLElement).innerHTML = this.iconForKind(file.kind);
      (btn.querySelector('.file-name') as HTMLElement).textContent = file.name;
      btn.addEventListener('click', () => {
        if (this.selectMode && checkbox) { checkbox.checked = !checkbox.checked; checkbox.dispatchEvent(new Event('change')); return; }
        this.openFile(file.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '🗑';
      deleteBtn.className = 'delete-btn';
      deleteBtn.setAttribute('aria-label', `Delete ${file.name}`);
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await this.confirmModal({
          title: 'Delete file?',
          message: `“${file.name}” will be permanently removed from this browser.${this.shareNote([file])}`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) {
          if (this.currentFileId === file.id) {
            await this.clearEditor();
          }
          await this.removeFile(file.id);
          await this.refreshLibrary();
          this.toast(`Deleted “${file.name}”`, 'info', 2500);
        }
      });

      li.appendChild(btn);
      li.appendChild(deleteBtn);
      this.drawer.appendChild(li);
    }
  }

  // Segmented Edit / Split / Preview control for flows that have a live preview
  // pane (markdown, mermaid, html). Sets a data-view attribute on the editor host
  // that CSS uses to show the editor, the preview, or both. Split is the default
  // on wide screens; on phones CSS collapses Split to a stacked view, and the
  // Edit/Preview tabs give a full-screen single pane — far friendlier on mobile.
  private addPreviewToggle(toolbar: HTMLElement) {
    const host = this.editorHost;
    const wide = typeof matchMedia !== 'undefined' && matchMedia('(min-width: 720px)').matches;
    host.dataset.view = wide ? 'split' : 'edit';

    const seg = document.createElement('div');
    seg.className = 'view-toggle';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'View mode');
    const modes: Array<{ v: string; label: string }> = [
      { v: 'edit', label: 'Edit' },
      { v: 'split', label: 'Split' },
      { v: 'preview', label: 'Preview' },
    ];
    const buttons: HTMLButtonElement[] = [];
    for (const m of modes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.label;
      b.dataset.view = m.v;
      b.setAttribute('aria-pressed', String(host.dataset.view === m.v));
      b.addEventListener('click', () => {
        host.dataset.view = m.v;
        for (const x of buttons) x.setAttribute('aria-pressed', String(x.dataset.view === m.v));
        // Re-render mermaid on switch to preview (it may have been display:none).
        if (m.v !== 'edit') this.currentPreview?.render(
          this.currentEditor instanceof TextEditor ? this.currentEditor.getValue() : '',
        );
      });
      buttons.push(b);
      seg.appendChild(b);
    }
    toolbar.insertBefore(seg, toolbar.firstChild);

    // Draggable divider between the editor and the preview (visible in Split).
    // Placed in the grid's middle column; drag adjusts the --split-left width.
    const preview = host.querySelector('.preview-pane');
    if (preview && !host.querySelector('.pane-resizer')) {
      const resizer = document.createElement('div');
      resizer.className = 'pane-resizer';
      resizer.setAttribute('role', 'separator');
      resizer.setAttribute('aria-orientation', 'vertical');
      resizer.setAttribute('aria-label', 'Resize editor and preview');
      host.insertBefore(resizer, preview);
      this.setupResizer(resizer, (e) => {
        const rect = host.getBoundingClientRect();
        const left = Math.max(140, Math.min(e.clientX - rect.left, rect.width - 140 - 6));
        host.style.setProperty('--split-left', `${left}px`);
      });
    }
  }

  // Wire a pointer-drag resizer: `onMove` runs for every move while dragging.
  // Uses pointer capture so the drag keeps tracking outside the thin handle.
  private setupResizer(handle: HTMLElement, onMove: (e: PointerEvent) => void) {
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (dragging) onMove(e); });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // Reopen the file that was open before the last refresh, if it still exists.
  // Returns true when a file was reopened. Safe to call on startup.
  async restoreLastFile(): Promise<boolean> {
    let id: string | null = null;
    try { id = localStorage.getItem(AppShell.LAST_FILE_KEY); } catch { /* storage unavailable */ }
    if (!id) return false;
    const files = await this.store.list();
    if (!files.some(f => f.id === id)) {
      try { localStorage.removeItem(AppShell.LAST_FILE_KEY); } catch { /* ignore */ }
      return false;
    }
    await this.openFile(id);
    return true;
  }

  async openFile(id: string): Promise<void> {
    try {
      await this.openFileInner(id);
    } catch (err) {
      reportFailure('open-file', err, this.currentFileKind);
      this.toast(`Couldn't open this file: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
    }
  }

  private async openFileInner(id: string): Promise<void> {
    const files = await this.store.list();
    const record = files.find(f => f.id === id);
    if (!record) return;

    await this.clearEditor();
    this.editorHost.innerHTML = '';
    this.currentFileId = id;
    this.currentFileKind = record.kind;
    this.markActiveFile(id);
    this.chrome?.onFileOpened(record);
    // Remember the open file so a page refresh can reopen it instead of
    // dropping back to the empty state.
    try { localStorage.setItem(AppShell.LAST_FILE_KEY, id); } catch { /* storage unavailable */ }
    this.closeDrawer();

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
      // We still render a rich media preview (video/audio/pdf) where possible.
      this.renderBinaryPreview(record, blob);
      return;
    }

    if (editorType === 'text') {
      const text = await this.blobToText(blob);
      const editor = new TextEditor(this.editorHost, { doc: text, language: record.kind, filename: record.name });
      this.currentEditor = editor;

      // Kind-specific buttons live in the single top header (editor-tools slot).
      const toolbar = this.editorToolbar();

      if (record.kind === 'json') {
        const formatBtn = document.createElement('button');
        formatBtn.textContent = 'Format';
        formatBtn.className = 'format-btn';
        formatBtn.addEventListener('click', () => {
          const result = formatJson(editor.getValue());
          if (result.ok) {
            editor.setValue(result.text);
            this.toast('JSON formatted', 'success', 2000);
          } else {
            this.toast(`Format error: ${result.error}`, 'error');
          }
        });
        toolbar.appendChild(formatBtn);
      }

      const findBtn = document.createElement('button');
      findBtn.textContent = 'Find';
      findBtn.addEventListener('click', () => this.findInEditor());
      toolbar.appendChild(findBtn);

      // Validate button — only for kinds we can meaningfully check (JSON/HTML/XML).
      const validator = validatorFor(record.name);
      if (validator) {
        const validateBtn = document.createElement('button');
        validateBtn.textContent = 'Validate';
        validateBtn.addEventListener('click', () => {
          const result = validator(editor.getValue());
          this.toast(result.message, result.ok ? 'success' : 'error', result.ok ? 2200 : 5000);
        });
        toolbar.appendChild(validateBtn);
      }

      this.addToolbarActions(toolbar, record);

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
        this.addPreviewToggle(toolbar);
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
        this.addPreviewToggle(toolbar);
      }

    } else if (editorType === 'image') {
      const toolbar = this.editorToolbar();
      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);
      const { ImageEditor } = await import('../editors/ImageEditor');
      const doc = await ImageEditor.open(body, blob, record.name, () => this.scheduleSaveDoc());
      // Tools/panels go in the top bar instead of a second row over the canvas.
      const strip = doc.toolbarElement?.();
      if (strip) {
        strip.classList.add('in-ribbon');
        toolbar.appendChild(strip);
        // The editor loads async, so the rAF reveal in editorToolbar() already ran.
        const group = this.root.querySelector('[data-role="edit-group"]') as HTMLElement | null;
        if (group) group.hidden = false;
        this.watchStripScroll(strip);
      }
      this.currentDoc = doc;
      this.currentDocKind = 'ImageEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'spreadsheet') {
      const toolbar = this.editorToolbar();

      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);

      const { SpreadsheetEditor } = await import('../editors/SpreadsheetEditor');

      const doc = await SpreadsheetEditor.open(body, blob, record.name, () => this.scheduleSaveDoc());
      this.currentDoc = doc;
      this.currentDocKind = 'SpreadsheetEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'pdf') {
      const toolbar = this.editorToolbar();

      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);

      const { PdfEditor } = await import('../editors/PdfEditor');

      const doc = await PdfEditor.open(body, blob, () => this.scheduleSaveDoc(), record.name);
      this.currentDoc = doc;
      this.currentDocKind = 'PdfEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'presentation') {
      const toolbar = this.editorToolbar();

      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);

      const { PresentationEditor } = await import('../editors/PresentationEditor');

      const doc = await PresentationEditor.open(body, blob, record.name, () => this.scheduleSaveDoc());
      this.currentDoc = doc;
      this.currentDocKind = 'PresentationEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'document') {
      const toolbar = this.editorToolbar();
      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);
      const { DocxEditor } = await import('../editors/DocxEditor');
      const doc = await DocxEditor.open(body, blob, () => this.scheduleSaveDoc(), record.name);
      // Formatting toolbar goes in the top bar (more vertical room for the page).
      const strip = doc.toolbarElement();
      strip.classList.add('in-ribbon');
      toolbar.appendChild(strip);
      const editGroup = this.root.querySelector('[data-role="edit-group"]') as HTMLElement | null;
      if (editGroup) editGroup.hidden = false;
      this.watchStripScroll(strip);
      this.currentDoc = doc;
      this.currentDocKind = 'DocxEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'audio') {
      const toolbar = this.editorToolbar();
      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);
      const { AudioEditor } = await import('../editors/AudioEditor');
      const doc = await AudioEditor.open(body, blob, () => this.scheduleSaveDoc());
      this.currentDoc = doc;
      this.currentDocKind = 'AudioEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'sketch') {
      const toolbar = this.editorToolbar();
      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);
      const { SketchEditor } = await import('../editors/SketchEditor');
      const doc = await SketchEditor.open(body, blob, () => this.scheduleSaveDoc());
      this.currentDoc = doc;
      this.currentDocKind = 'SketchEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'video') {
      const toolbar = this.editorToolbar();
      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);
      // No onChange autosave: exporting a video re-runs ffmpeg, too heavy to fire
      // on every trim tweak. Persisting happens on Download/Share/Save instead.
      const { VideoEditor } = await import('../editors/VideoEditor');
      const doc = await VideoEditor.open(body, blob, record.name, {
        toast: (m, k) => this.toast(m, k),
        // Thumbnails / frames go into the library without leaving the video.
        saveImage: async (img, name) => {
          await this.store.save(await this.uniqueName(name), img, 'image');
          await this.refreshLibrary();
        },
      });
      this.currentDoc = doc;
      this.currentDocKind = 'VideoEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'game') {
      const toolbar = this.editorToolbar();
      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);
      const { GameEditor } = await import('../editors/GameEditor');
      const doc = await GameEditor.open(body, blob, record.name, () => this.scheduleSaveDoc());
      this.currentDoc = doc;
      this.currentDocKind = 'GameEditor';
      this.addToolbarActions(toolbar, record);
    } else if (editorType === 'floorplan') {
      const toolbar = this.editorToolbar();
      const body = document.createElement('div');
      body.className = 'doc-body';
      this.editorHost.appendChild(body);
      const { FloorPlanEditor } = await import('../editors/FloorPlanEditor');
      const doc = await FloorPlanEditor.open(body, blob, record.name, () => this.scheduleSaveDoc());
      this.currentDoc = doc;
      this.currentDocKind = 'FloorPlanEditor';
      this.addToolbarActions(toolbar, record);
    }

    // Keep the AI assistant's suggestions in sync with the newly-opened editor.
    if (this.aiPanel?.isOpen) this.aiPanel.refresh();
  }

  // Re-render the library so the currently-open file's row shows as active
  // (refreshLibrary reads this.currentFileId to apply the .active class).
  private markActiveFile(_id: string) {
    void this.refreshLibrary();
  }

  private formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
  }

  // Map an extension to a previewable media category. MIME isn't stored on the
  // record, so we infer from the filename.
  private mediaCategory(name: string): 'video' | 'audio' | 'pdf' | 'none' {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
    if (ext === 'pdf') return 'pdf';
    return 'none';
  }

  private renderBinaryPreview(record: FileRecord, blob: Blob): void {
    const category = this.mediaCategory(record.name);
    const url = URL.createObjectURL(blob);
    this.currentObjectUrl = url;

    const wrap = document.createElement('div');
    wrap.className = 'binary-preview';
    wrap.setAttribute('data-role', 'binary-notice');

    const header = document.createElement('div');
    header.className = 'binary-head';
    const meta = document.createElement('div');
    meta.className = 'binary-meta';
    meta.innerHTML = `<span class="file-icon"></span><span></span>`;
    (meta.querySelector('.file-icon') as HTMLElement).textContent =
      category === 'video' ? '🎬' : category === 'audio' ? '🎵' : category === 'pdf' ? '📕' : '📦';
    (meta.querySelector('span:last-child') as HTMLElement).textContent =
      `${record.name} · ${this.formatBytes(record.size)}`;

    const download = document.createElement('a');
    download.className = 'download-btn';
    download.href = url;
    download.download = record.name;
    download.textContent = 'Download';
    header.append(meta, download);

    const body = document.createElement('div');
    body.className = 'binary-body';

    if (category === 'video') {
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.className = 'media-el';
      body.appendChild(v);
    } else if (category === 'audio') {
      const a = document.createElement('audio');
      a.src = url; a.controls = true; a.className = 'media-el audio';
      body.appendChild(a);
    } else if (category === 'pdf') {
      const f = document.createElement('iframe');
      f.src = url; f.className = 'media-el pdf';
      f.title = record.name;
      body.appendChild(f);
    } else {
      const none = document.createElement('div');
      none.className = 'binary-none';
      none.innerHTML = `<div class="drop-icon">📦</div>`;
      const t = document.createElement('p');
      // Check for unsupported office formats and show helpful message
      const ext = record.name.split('.').pop()?.toLowerCase() ?? '';
      const legacyOffice = ['odt', 'ods', 'odp', 'doc', 'ppt', 'xls'];
      if (legacyOffice.includes(ext)) {
        t.textContent = "Open-Document / legacy Office files aren't supported yet — try the .docx / .xlsx / .pptx version.";
      } else {
        t.textContent = "This file type can't be previewed or edited here — download it to open in another app.";
      }
      none.appendChild(t);
      body.appendChild(none);
    }

    wrap.append(header, body);
    this.editorHost.appendChild(wrap);

    // Route actions through the inspector for consistency (D3 fix)
    this.addToolbarActions(this.editorToolbar(), record);
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

  private scheduleSaveDoc() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.pendingSave = async () => {
      if (!this.currentFileId || !this.currentDoc) return;
      const ex = await this.currentDoc.export();
      if (ex) await this.store.update(this.currentFileId, ex.blob);
    };
    this.saveTimer = window.setTimeout(() => { void this.flushPendingSave(); }, 400);
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
    if (this.currentDoc) {
      this.currentDoc.destroy();
      this.currentDoc = undefined;
      this.currentDocKind = undefined;
    }
    if (this.currentPreview) {
      this.currentPreview.destroy();
      this.currentPreview = undefined;
    }
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = undefined;
    }
    this.currentFileId = undefined;
    this.currentFileKind = undefined;
    try { localStorage.removeItem(AppShell.LAST_FILE_KEY); } catch { /* storage unavailable */ }
    const panel = this.root.querySelector('[data-role="file-actions"]') as HTMLElement | null;
    if (panel) { panel.innerHTML = ''; panel.hidden = true; }
    const empty = this.root.querySelector('[data-role="inspector-empty"]') as HTMLElement | null;
    if (empty) empty.hidden = false;
    const shell = this.root.querySelector('.app-shell') as HTMLElement | null;
    shell?.classList.add('inspector-collapsed');
    this.syncRailState();
    if (this.editorTools) { this.editorTools.innerHTML = ''; this.editorTools.classList.remove('active'); }
    const group = this.root.querySelector('[data-role="edit-group"]') as HTMLElement | null;
    if (group) group.hidden = true;
    this.renderEmptyState();
  }
}
