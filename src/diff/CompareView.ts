// Live, side-by-side compare + merge for text documents (desktop). Two editable
// panes each back onto a real file; a center gutter lists change hunks with
// ◀ / ▶ buttons that move a change from one side to the other, git-merge style.
// Edits autosave to the backing file and the diff recomputes (debounced).
import type { FileStore } from '../store/opfs';
import type { FileRecord } from '../store/types';
import { TextEditor, type DiffLine } from '../editors/TextEditor';
import { editorKindFor } from '../editors/registry';
import { diffHunks, applyToA, applyToB, type Hunk } from './hunks';

interface Pane {
  fileId?: string;
  editor?: TextEditor;
  host: HTMLElement;
  select: HTMLSelectElement;
}

export class CompareView {
  private el: HTMLElement;
  private left: Pane;
  private right: Pane;
  private center: HTMLElement;
  private recomputeTimer?: number;

  constructor(
    private parent: HTMLElement,
    private store: FileStore,
    private files: FileRecord[],
    private opts: { initialLeftId?: string; onClose: () => void; onFilesChanged: () => void },
  ) {
    this.el = document.createElement('div');
    this.el.className = 'compare-split';
    this.el.innerHTML = `
      <div class="compare-split-head">
        <span class="compare-split-title">⇄ Compare & merge</span>
        <button type="button" class="compare-split-close" aria-label="Close compare">✕ Close</button>
      </div>
      <div class="compare-split-body">
        <div class="compare-pane" data-role="left">
          <div class="compare-pane-head"><select data-role="sel"></select></div>
          <div class="compare-pane-host" data-role="host"></div>
        </div>
        <div class="compare-gutter" data-role="gutter"></div>
        <div class="compare-pane" data-role="right">
          <div class="compare-pane-head"><select data-role="sel"></select></div>
          <div class="compare-pane-host" data-role="host"></div>
        </div>
      </div>`;

    const leftEl = this.el.querySelector('[data-role="left"]') as HTMLElement;
    const rightEl = this.el.querySelector('[data-role="right"]') as HTMLElement;
    this.left = {
      host: leftEl.querySelector('[data-role="host"]') as HTMLElement,
      select: leftEl.querySelector('[data-role="sel"]') as HTMLSelectElement,
    };
    this.right = {
      host: rightEl.querySelector('[data-role="host"]') as HTMLElement,
      select: rightEl.querySelector('[data-role="sel"]') as HTMLSelectElement,
    };
    this.center = this.el.querySelector('[data-role="gutter"]') as HTMLElement;

    this.el.querySelector('.compare-split-close')?.addEventListener('click', () => this.close());
    this.populateSelect(this.left);
    this.populateSelect(this.right);

    this.parent.appendChild(this.el);

    // Left defaults to the currently-open file; right to the next text file.
    const textFiles = this.files.filter((f) => editorKindFor(f.kind) === 'text');
    const leftId = this.opts.initialLeftId && textFiles.some((f) => f.id === this.opts.initialLeftId)
      ? this.opts.initialLeftId
      : textFiles[0]?.id;
    const rightId = textFiles.find((f) => f.id !== leftId)?.id ?? leftId;
    if (leftId) void this.loadInto(this.left, leftId);
    if (rightId) void this.loadInto(this.right, rightId);
  }

  private populateSelect(pane: Pane) {
    pane.select.innerHTML = '';
    for (const f of this.files) {
      if (editorKindFor(f.kind) !== 'text') continue;
      pane.select.appendChild(new Option(f.name, f.id));
    }
    pane.select.appendChild(new Option('＋ New file…', '__new__'));
    pane.select.addEventListener('change', () => {
      if (pane.select.value === '__new__') {
        void this.createAndLoad(pane);
      } else {
        void this.loadInto(pane, pane.select.value);
      }
    });
  }

  private async createAndLoad(pane: Pane) {
    const name = (prompt('New file name', 'Untitled.txt') || '').trim();
    if (!name) { this.syncSelect(pane); return; }
    const rec = await this.store.save(/\.[^.]+$/.test(name) ? name : `${name}.txt`, new Blob([''], { type: 'text/plain' }), 'text');
    this.files = await this.store.list();
    this.populateSelect(this.left);
    this.populateSelect(this.right);
    this.opts.onFilesChanged();
    await this.loadInto(pane, rec.id);
    this.syncSelect(this.other(pane));
  }

  private other(pane: Pane): Pane {
    return pane === this.left ? this.right : this.left;
  }

  private syncSelect(pane: Pane) {
    if (pane.fileId) pane.select.value = pane.fileId;
  }

  private async loadInto(pane: Pane, fileId: string) {
    const rec = this.files.find((f) => f.id === fileId);
    if (!rec) return;
    const blob = await this.store.read(fileId);
    const text = await blob.text();
    pane.editor?.destroy();
    pane.host.innerHTML = '';
    pane.fileId = fileId;
    pane.select.value = fileId;
    pane.editor = new TextEditor(pane.host, {
      doc: text,
      language: rec.kind,
      filename: rec.name,
      onChange: () => {
        this.scheduleAutosave(pane);
        this.scheduleRecompute();
      },
    });
    this.recompute();
  }

  private autosaveTimers = new WeakMap<Pane, number>();
  private scheduleAutosave(pane: Pane) {
    const prev = this.autosaveTimers.get(pane);
    if (prev) clearTimeout(prev);
    const t = window.setTimeout(async () => {
      if (!pane.fileId || !pane.editor) return;
      await this.store.update(pane.fileId, new Blob([pane.editor.getValue()], { type: 'text/plain' }));
      this.opts.onFilesChanged();
    }, 400);
    this.autosaveTimers.set(pane, t);
  }

  private scheduleRecompute() {
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
    this.recomputeTimer = window.setTimeout(() => this.recompute(), 250);
  }

  private recompute() {
    const a = this.left.editor?.getValue();
    const b = this.right.editor?.getValue();
    this.center.innerHTML = '';
    if (a === undefined || b === undefined) return;
    const hunks = diffHunks(a, b);

    // Paint whole-line highlights in each pane. A hunk with lines on both sides
    // is a change (chg); a pure deletion/insertion is del/add.
    const leftLines: DiffLine[] = [];
    const rightLines: DiffLine[] = [];
    for (const h of hunks) {
      const both = h.aLines.length > 0 && h.bLines.length > 0;
      for (let i = h.aStart; i < h.aEnd; i++) leftLines.push({ line: i + 1, kind: both ? 'chg' : 'del' });
      for (let i = h.bStart; i < h.bEnd; i++) rightLines.push({ line: i + 1, kind: both ? 'chg' : 'add' });
    }
    this.left.editor?.setDiffLines(leftLines);
    this.right.editor?.setDiffLines(rightLines);

    if (hunks.length === 0) {
      const ok = document.createElement('div');
      ok.className = 'compare-identical';
      ok.textContent = 'No differences ✓';
      this.center.appendChild(ok);
      return;
    }
    for (const h of hunks) this.center.appendChild(this.renderHunk(h));
  }

  private renderHunk(h: Hunk): HTMLElement {
    const row = document.createElement('div');
    row.className = 'compare-hunk';

    const toLeft = document.createElement('button');
    toLeft.type = 'button';
    toLeft.className = 'compare-apply';
    toLeft.textContent = '◀';
    toLeft.title = 'Use right side here (copy into left)';
    toLeft.addEventListener('click', () => {
      if (!this.left.editor) return;
      this.left.editor.setValue(applyToA(this.left.editor.getValue(), h));
      this.scheduleAutosave(this.left);
      this.recompute();
    });

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'compare-hunk-label';
    const del = h.aLines.length;
    const add = h.bLines.length;
    label.textContent = `−${del} / +${add}`;
    label.title = 'Jump to this change';
    label.addEventListener('click', () => {
      this.left.editor?.scrollToLine(h.aStart + 1);
      this.right.editor?.scrollToLine(h.bStart + 1);
    });

    const toRight = document.createElement('button');
    toRight.type = 'button';
    toRight.className = 'compare-apply';
    toRight.textContent = '▶';
    toRight.title = 'Use left side here (copy into right)';
    toRight.addEventListener('click', () => {
      if (!this.right.editor) return;
      this.right.editor.setValue(applyToB(this.right.editor.getValue(), h));
      this.scheduleAutosave(this.right);
      this.recompute();
    });

    row.append(toLeft, label, toRight);
    return row;
  }

  close() {
    this.left.editor?.destroy();
    this.right.editor?.destroy();
    this.el.remove();
    this.opts.onClose();
  }
}
