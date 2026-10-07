// Mobile chrome layered on AppShell: top app bar (menu / title / AI / more),
// the files drawer with app settings, a touch-first home screen, and bottom
// sheets for file actions and downloads. All editing logic stays in AppShell.
import type { ShellApi, ShellChrome } from '../shell/AppShell';
import type { FileRecord } from '../store/types';
import { icon } from '../ui/icons';
import { telemetryEnabled, setTelemetryEnabled, appVersion, reportFailure } from '../telemetry';

interface SheetItem { label: string; icon?: string; danger?: boolean; run: () => void }

const ICONS = {
  more: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export class MobileChrome implements ShellChrome {
  private titleBtn!: HTMLButtonElement;
  private homeHost: HTMLElement | null = null;

  constructor(private api: ShellApi) {
    this.mount();
  }

  // ---- Shell hooks --------------------------------------------------------

  renderHome(host: HTMLElement): void {
    this.homeHost = host;
    this.setTitle(null);
    host.innerHTML = `
      <div class="m-home">
        <h2 class="m-home-title">What do you want to make?</h2>
        <div class="m-new-grid" role="list"></div>
        <button type="button" class="m-open-btn">${icon('upload', 20)}<span>Open a file from your device</span></button>
        <div class="m-recent-wrap">
          <h3 class="m-section-title">Recent</h3>
          <div class="m-recent" role="list"></div>
        </div>
        <p class="m-home-foot">Files stay on this device unless you share them.
          <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a> ·
          <button type="button" class="m-link" data-act="feedback">Report a problem</button></p>
      </div>`;
    const grid = host.querySelector('.m-new-grid') as HTMLElement;
    for (const t of this.api.templates()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-new-tile';
      b.setAttribute('role', 'listitem');
      b.innerHTML = `<span class="m-new-icon">${this.api.iconForKind(t.kind)}</span><span class="m-new-label"></span>`;
      (b.querySelector('.m-new-label') as HTMLElement).textContent = t.label;
      b.addEventListener('click', () => void this.api.createFromTemplate(t.id));
      grid.appendChild(b);
    }
    host.querySelector('.m-open-btn')!.addEventListener('click', () => this.api.upload());
    host.querySelector('[data-act="feedback"]')!.addEventListener('click', () => this.api.openFeedback());
    void this.paintRecent();
  }

  onFileOpened(record: FileRecord): void {
    this.homeHost = null;
    this.setTitle(record);
  }

  onLibraryChanged(): void {
    void this.api.currentFile().then((r) => { if (r) this.setTitle(r); });
    if (this.homeHost?.isConnected) void this.paintRecent();
  }

  // ---- Mount ---------------------------------------------------------------

  private mount(): void {
    const root = this.api.root;
    const shell = root.querySelector('.app-shell') as HTMLElement;

    const bar = document.createElement('header');
    bar.className = 'm-appbar';
    bar.innerHTML = `
      <button type="button" class="m-icon-btn" data-act="menu" aria-label="Open menu">${icon('menu', 22)}</button>
      <button type="button" class="m-title" data-act="title" aria-label="Rename file"></button>
      <button type="button" class="m-icon-btn" data-act="ai" aria-label="AI assistant">${icon('sparkles', 20)}</button>
      <button type="button" class="m-icon-btn" data-act="more" aria-label="More actions">${ICONS.more}</button>`;
    shell.prepend(bar);
    this.titleBtn = bar.querySelector('.m-title') as HTMLButtonElement;
    bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'menu') this.api.openDrawer();
      else if (act === 'title') void this.api.currentFile().then((r) => { if (r) this.api.rename(r); });
      else if (act === 'ai') this.api.toggleAi();
      else if (act === 'more') void this.openMoreSheet();
    });

    // Editor-specific commands (Format, Find, Preview…) live in the hidden
    // desktop ribbon; surface them as a scrollable strip under the app bar.
    const tools = document.createElement('div');
    tools.className = 'm-tools';
    const group = root.querySelector('[data-role="edit-group"]');
    if (group) tools.appendChild(group);
    bar.after(tools);

    this.mountDrawer();

    // Exit button while in full-screen editing (the app bar is hidden then).
    const exitFs = document.createElement('button');
    exitFs.type = 'button';
    exitFs.className = 'm-exit-fs';
    exitFs.setAttribute('aria-label', 'Exit full screen');
    exitFs.innerHTML = icon('x', 20);
    exitFs.addEventListener('click', () => this.api.toggleFullscreen());
    shell.appendChild(exitFs);
  }

  private mountDrawer(): void {
    const root = this.api.root;
    const panel = root.querySelector('.files-panel') as HTMLElement;

    const head = document.createElement('div');
    head.className = 'm-drawer-head';
    head.innerHTML = `
      <span class="m-brand"><span class="brand-mark">Gz</span><span>GenZ Editor</span></span>
      <button type="button" class="m-icon-btn" aria-label="Close menu">${icon('x', 20)}</button>`;
    head.querySelector('button')!.addEventListener('click', () => this.api.closeDrawer());
    panel.prepend(head);

    const quick = document.createElement('div');
    quick.className = 'm-drawer-quick';
    quick.innerHTML = `
      <button type="button" data-act="new">${icon('filePlus', 20)}<span>New</span></button>
      <button type="button" data-act="open">${icon('upload', 20)}<span>Open</span></button>`;
    quick.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      this.api.closeDrawer();
      if (act === 'new') this.api.openNewFileModal();
      else if (act === 'open') this.api.upload();
    });
    head.after(quick);

    const menu = document.createElement('div');
    menu.className = 'm-drawer-menu';
    menu.innerHTML = `
      <div class="m-account" data-slot="account"></div>
      <button type="button" class="m-menu-row" data-act="theme">${icon('palette', 20)}<span>Theme</span></button>
      <button type="button" class="m-menu-row" data-act="feedback">${icon('info', 20)}<span>Report a problem / feedback</span></button>
      <label class="m-menu-row m-switch-row">
        <span class="m-switch-label">Send anonymous error reports</span>
        <input type="checkbox" class="m-switch" data-act="telemetry">
      </label>
      <a class="m-menu-row" href="/privacy.html" target="_blank" rel="noopener">${icon('hardDrive', 20)}<span>Privacy</span></a>
      <a class="m-menu-row" href="https://genzeditor.com/?desktop=1">${icon('maximize', 20)}<span>Use desktop version</span></a>
      <p class="m-version"></p>`;
    (menu.querySelector('.m-version') as HTMLElement).textContent = `Version ${appVersion()}`;
    const auth = root.querySelector('[data-role="auth-bar"]');
    if (auth) menu.querySelector('[data-slot="account"]')!.appendChild(auth);
    const tele = menu.querySelector('[data-act="telemetry"]') as HTMLInputElement;
    tele.checked = telemetryEnabled();
    tele.addEventListener('change', () => setTelemetryEnabled(tele.checked));
    menu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'theme') this.api.openTheme(btn);
      else if (btn.dataset.act === 'feedback') { this.api.closeDrawer(); this.api.openFeedback(); }
    });
    panel.appendChild(menu);

    // Swipe left on the drawer to close it.
    let x0 = 0, y0 = 0;
    panel.addEventListener('touchstart', (e) => { x0 = e.touches[0]!.clientX; y0 = e.touches[0]!.clientY; }, { passive: true });
    panel.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0]!;
      if (x0 - t.clientX > 70 && Math.abs(t.clientY - y0) < 60) this.api.closeDrawer();
    });

    // Long-press a file row → Open / Rename / Delete sheet.
    const list = root.querySelector('[data-role="file-drawer"]') as HTMLElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fired = false;
    const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
    list.addEventListener('pointerdown', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
      if (!li || (e.target as HTMLElement).closest('.delete-btn')) return;
      fired = false;
      cancel();
      timer = setTimeout(() => { fired = true; void this.openFileSheet(li.dataset.id!); }, 500);
    });
    list.addEventListener('pointerup', cancel);
    list.addEventListener('pointercancel', cancel);
    list.addEventListener('pointermove', (e) => { if (Math.abs(e.movementY) > 4) cancel(); });
    list.addEventListener('contextmenu', (e) => e.preventDefault());
    // Swallow the click that follows a long-press so the file doesn't also open.
    list.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
  }

  // ---- Helpers ---------------------------------------------------------------

  private setTitle(record: FileRecord | null): void {
    this.titleBtn.textContent = record ? record.name : 'GenZ Editor';
    this.titleBtn.disabled = !record;
    this.titleBtn.classList.toggle('is-brand', !record);
  }

  private async paintRecent(): Promise<void> {
    const host = this.homeHost;
    if (!host) return;
    const wrap = host.querySelector('.m-recent-wrap') as HTMLElement | null;
    const list = host.querySelector('.m-recent') as HTMLElement | null;
    if (!wrap || !list) return;
    const files = (await this.api.listFiles())
      .slice()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 12);
    wrap.hidden = files.length === 0;
    list.innerHTML = '';
    for (const f of files) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-recent-card';
      b.setAttribute('role', 'listitem');
      b.innerHTML = `<span class="m-recent-icon">${this.api.iconForKind(f.kind)}</span>
        <span class="m-recent-text"><span class="m-recent-name">${esc(f.name)}</span>
        <span class="m-recent-meta">${esc(ago(f.updatedAt))} · ${esc(this.api.formatBytes(f.size))}</span></span>`;
      b.addEventListener('click', () => void this.api.openFile(f.id));
      list.appendChild(b);
    }
  }

  /** Generic bottom action sheet. */
  private sheet(opts: { title?: string; subtitle?: string; items: SheetItem[] }): void {
    const overlay = document.createElement('div');
    overlay.className = 'm-sheet-overlay';
    overlay.innerHTML = `<div class="m-sheet" role="dialog" aria-modal="true">
      <div class="m-sheet-handle" aria-hidden="true"></div>
      <div class="m-sheet-head"><strong class="m-sheet-title"></strong><span class="m-sheet-sub"></span></div>
      <div class="m-sheet-list"></div>
      <button type="button" class="m-sheet-cancel">Cancel</button></div>`;
    const panel = overlay.querySelector('.m-sheet') as HTMLElement;
    (overlay.querySelector('.m-sheet-title') as HTMLElement).textContent = opts.title ?? '';
    (overlay.querySelector('.m-sheet-sub') as HTMLElement).textContent = opts.subtitle ?? '';
    if (!opts.title && !opts.subtitle) (overlay.querySelector('.m-sheet-head') as HTMLElement).hidden = true;
    const list = overlay.querySelector('.m-sheet-list') as HTMLElement;
    const close = this.wireSheet(overlay, panel);
    for (const it of opts.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-sheet-item' + (it.danger ? ' danger' : '');
      b.innerHTML = `<span class="m-sheet-icon">${it.icon ?? ''}</span><span></span>`;
      (b.lastElementChild as HTMLElement).textContent = it.label;
      b.addEventListener('click', () => { close(); it.run(); });
      list.appendChild(b);
    }
    overlay.querySelector('.m-sheet-cancel')!.addEventListener('click', close);
    this.api.root.appendChild(overlay);
  }

  // Tap outside / swipe the handle down to dismiss. Returns the close function.
  private wireSheet(overlay: HTMLElement, panel: HTMLElement): () => void {
    const close = () => {
      panel.classList.add('leaving');
      overlay.classList.add('leaving');
      setTimeout(() => overlay.remove(), 180);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    let y0 = 0, dy = 0;
    panel.addEventListener('touchstart', (e) => {
      if (panel.scrollTop > 0) { y0 = -1; return; }
      y0 = e.touches[0]!.clientY; dy = 0;
    }, { passive: true });
    panel.addEventListener('touchmove', (e) => {
      if (y0 < 0) return;
      dy = Math.max(0, e.touches[0]!.clientY - y0);
      panel.style.transform = dy ? `translateY(${dy}px)` : '';
    }, { passive: true });
    panel.addEventListener('touchend', () => {
      if (y0 < 0) return;
      if (dy > 90) close(); else panel.style.transform = '';
    });
    return close;
  }

  private async openMoreSheet(): Promise<void> {
    const record = await this.api.currentFile();
    if (!record) {
      this.sheet({
        title: 'GenZ Editor',
        items: [
          { label: 'New file', icon: icon('filePlus', 20), run: () => this.api.openNewFileModal() },
          { label: 'Open a file', icon: icon('upload', 20), run: () => this.api.upload() },
          { label: 'All actions', icon: icon('menu', 20), run: () => this.api.openPalette() },
          { label: 'Report a problem', icon: icon('info', 20), run: () => this.api.openFeedback() },
        ],
      });
      return;
    }
    const hasShares = !!record.shares?.length;
    const items: SheetItem[] = [
      { label: 'Download…', icon: ICONS.download, run: () => void this.openDownloadSheet(record) },
      { label: 'Share link (view only)', icon: ICONS.link, run: () => void this.api.share(false) },
      { label: 'Share editable link', icon: ICONS.edit, run: () => void this.api.share(true) },
    ];
    if (hasShares) {
      items.push({ label: 'Update shared copies', icon: ICONS.share, run: () => void this.api.saveShares() });
      items.push({ label: 'Stop sharing', icon: ICONS.link, danger: true, run: () => void this.api.stopSharing() });
    }
    items.push(
      { label: 'Compare with…', icon: icon('compare', 20), run: () => this.api.compare() },
      { label: 'Rename', icon: ICONS.edit, run: () => this.api.rename(record) },
      { label: 'Full screen', icon: icon('maximize', 20), run: () => this.api.toggleFullscreen() },
      { label: 'All actions', icon: icon('menu', 20), run: () => this.api.openPalette() },
      { label: 'Delete', icon: ICONS.trash, danger: true, run: () => void this.api.deleteFile(record) },
    );
    this.sheet({ title: record.name, subtitle: `${record.kind} · ${this.api.formatBytes(record.size)}`, items });
  }

  private async openFileSheet(id: string): Promise<void> {
    const record = (await this.api.listFiles()).find((f) => f.id === id);
    if (!record) return;
    this.sheet({
      title: record.name,
      subtitle: `${record.kind} · ${this.api.formatBytes(record.size)}`,
      items: [
        { label: 'Open', icon: icon('folder', 20), run: () => void this.api.openFile(id) },
        { label: 'Rename', icon: ICONS.edit, run: () => this.api.rename(record) },
        { label: 'Delete', icon: ICONS.trash, danger: true, run: () => void this.api.deleteFile(record) },
      ],
    });
  }

  // ---- Download sheet --------------------------------------------------------

  private async openDownloadSheet(record: FileRecord): Promise<void> {
    type Fmt = { id: string; label: string; ext: string; type?: string };
    const base = record.name.replace(/\.[^.]+$/, '');
    const origExt = /\.([^.]+)$/.exec(record.name)?.[1] ?? '';
    const kind = this.api.currentKind();
    const formats: Fmt[] =
      kind === 'image' ? [{ id: 'png', label: 'PNG', ext: 'png', type: 'image/png' }, { id: 'jpeg', label: 'JPEG', ext: 'jpg', type: 'image/jpeg' }]
      : kind === 'document' ? [{ id: 'orig', label: 'Word (.docx)', ext: origExt || 'docx' }, { id: 'pdf', label: 'PDF', ext: 'pdf', type: 'application/pdf' }]
      : [{ id: 'orig', label: `Original (.${origExt || 'file'})`, ext: origExt }];
    let fmt = formats[0]!;
    const canShareFiles = typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });

    const overlay = document.createElement('div');
    overlay.className = 'm-sheet-overlay';
    overlay.innerHTML = `<div class="m-sheet m-download" role="dialog" aria-modal="true" aria-label="Download">
      <div class="m-sheet-handle" aria-hidden="true"></div>
      <div class="m-sheet-head"><strong class="m-sheet-title">Download</strong>
        <span class="m-sheet-sub">Saved to your device. Nothing is uploaded.</span></div>
      <label class="m-field"><span>File name</span>
        <span class="m-name-row"><input type="text" class="m-name" autocomplete="off" spellcheck="false"><span class="m-ext"></span></span></label>
      <div class="m-field" data-slot="formats"><span>Format</span><div class="m-chips"></div></div>
      <p class="m-dl-error" role="alert"></p>
      <div class="m-dl-actions">
        <button type="button" class="m-btn m-btn-primary" data-act="save">${ICONS.download}<span>Save to device</span></button>
        <button type="button" class="m-btn" data-act="share">${ICONS.share}<span>Share to…</span></button>
      </div>
      <button type="button" class="m-sheet-cancel">Cancel</button></div>`;
    const panel = overlay.querySelector('.m-sheet') as HTMLElement;
    const close = this.wireSheet(overlay, panel);
    overlay.querySelector('.m-sheet-cancel')!.addEventListener('click', close);
    const nameIn = overlay.querySelector('.m-name') as HTMLInputElement;
    const extEl = overlay.querySelector('.m-ext') as HTMLElement;
    const errEl = overlay.querySelector('.m-dl-error') as HTMLElement;
    nameIn.value = base;
    const chips = overlay.querySelector('.m-chips') as HTMLElement;
    const paintExt = () => { extEl.textContent = fmt.ext ? `.${fmt.ext}` : ''; };
    for (const f of formats) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'm-chip' + (f === fmt ? ' selected' : '');
      c.textContent = f.label;
      c.addEventListener('click', () => {
        fmt = f;
        chips.querySelectorAll('.m-chip').forEach((el) => el.classList.remove('selected'));
        c.classList.add('selected');
        paintExt();
      });
      chips.appendChild(c);
    }
    if (formats.length < 2) (overlay.querySelector('[data-slot="formats"]') as HTMLElement).hidden = true;
    paintExt();
    const shareBtn = overlay.querySelector('[data-act="share"]') as HTMLButtonElement;
    shareBtn.hidden = !canShareFiles;

    const build = async (): Promise<File | null> => {
      errEl.textContent = '';
      const name = `${(nameIn.value.trim() || base).replace(/[\\/:*?"<>|]/g, '_')}${fmt.ext ? `.${fmt.ext}` : ''}`;
      try {
        let blob: Blob | null;
        if (fmt.id === 'pdf') blob = await this.api.docxPdf();
        else {
          const cur = await this.api.getCurrentBlob();
          blob = cur?.blob ?? null;
          if (blob && fmt.id === 'jpeg' && blob.type !== 'image/jpeg') blob = await toJpeg(blob);
          if (blob && fmt.id === 'png' && blob.type === 'image/jpeg') blob = await toPng(blob);
        }
        if (!blob) { errEl.textContent = 'Nothing to download yet.'; return null; }
        return new File([blob], name, { type: fmt.type ?? (blob.type || 'application/octet-stream') });
      } catch (e) {
        reportFailure('download', e, kind);
        errEl.textContent = `Couldn't prepare the file: ${e instanceof Error ? e.message : String(e)}`;
        return null;
      }
    };
    const busy = (b: HTMLButtonElement, on: boolean) => { b.disabled = on; b.classList.toggle('busy', on); };

    overlay.querySelector('[data-act="save"]')!.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      busy(btn, true);
      const file = await build();
      busy(btn, false);
      if (!file) return;
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      close();
      this.api.toast(`Saved “${file.name}”`, 'success', 2500);
    });
    shareBtn.addEventListener('click', async () => {
      busy(shareBtn, true);
      const file = await build();
      busy(shareBtn, false);
      if (!file) return;
      try {
        await navigator.share({ files: [file], title: file.name });
        close();
      } catch (e) {
        if ((e as DOMException)?.name !== 'AbortError') {
          reportFailure('share-sheet', e, kind);
          errEl.textContent = "This app can't share that file type — use Save to device instead.";
        }
      }
    });

    this.api.root.appendChild(overlay);
  }
}

async function reencode(blob: Blob, type: 'image/jpeg' | 'image/png'): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d')!;
  if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.92));
}
const toJpeg = (b: Blob) => reencode(b, 'image/jpeg');
const toPng = (b: Blob) => reencode(b, 'image/png');
