import { icon } from '../ui/icons';
// Shared edit commands (undo / redo / cut / copy / paste / delete / duplicate /
// select all) for every editor. Editors expose an EditCommands object; the shell
// owns the keyboard shortcuts (web) and the long-press menu (mobile), so each
// editor only implements the actions — never its own key handling for them.

export interface EditCommands {
  undo?(): void;
  redo?(): void;
  cut?(): void | Promise<void>;
  copy?(): void | Promise<void>;
  // `data` comes from a real paste event (files/images/text); absent when
  // triggered from the menu — then use the app clipboard or navigator.clipboard.
  paste?(data?: DataTransfer | null): void | Promise<void>;
  delete?(): void;
  duplicate?(): void;
  selectAll?(): void;
  // Enablement hints for the menu; missing = assume enabled.
  canUndo?(): boolean;
  canRedo?(): boolean;
  hasSelection?(): boolean;
  canPaste?(): boolean;
  // Return true while a tool owns touch input (brush, crop…): a held finger there is not a menu request.
  suppressLongPress?(): boolean;
}

// Modal tools (thumbnail maker, …) temporarily take over the commands while open.
// `root` scopes the mobile long-press menu to the tool's own UI.
let override: { root: HTMLElement; cmds: EditCommands } | null = null;
export function pushEditOverride(root: HTMLElement, cmds: EditCommands): () => void {
  const prev = override;
  const mine = { root, cmds };
  override = mine;
  return () => { if (override === mine) override = prev; };
}
export function editOverride(): { root: HTMLElement; cmds: EditCommands } | null {
  if (override && !override.root.isConnected) override = null;
  return override;
}

// In-app clipboard for objects (layers, clips, slide elements…). `kind` scopes
// it to the editor type that can paste it; data must be self-contained.
let appClip: { kind: string; data: unknown } | null = null;
export function setAppClipboard(kind: string, data: unknown): void { appClip = { kind, data }; }
export function getAppClipboard<T>(kind: string): T | null {
  return appClip && appClip.kind === kind ? (appClip.data as T) : null;
}

// Native text editing (inputs, CodeMirror, contentEditable) keeps the browser's
// own shortcuts and the OS long-press menu.
export function isNativeTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor')) return true;
  return !!el.isContentEditable;
}

export type Action = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'duplicate' | 'selectAll';

// Map a keydown to an action (null = not ours).
export function actionForKey(e: KeyboardEvent): Action | null {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey) {
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (k === 'y' && !e.shiftKey) return 'redo';
    if (e.shiftKey) return null;
    if (k === 'x') return 'cut';
    if (k === 'c') return 'copy';
    if (k === 'v') return 'paste';
    if (k === 'd') return 'duplicate';
    if (k === 'a') return 'selectAll';
    return null;
  }
  if (!mod && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) return 'delete';
  return null;
}

export function runAction(cmds: EditCommands, a: Action, data?: DataTransfer | null): boolean {
  const fn = cmds[a] as ((d?: DataTransfer | null) => void | Promise<void>) | undefined;
  if (!fn) return false;
  if (a === 'delete' || a === 'cut' || a === 'copy' || a === 'duplicate') {
    if (cmds.hasSelection && !cmds.hasSelection()) return false;
  }
  void Promise.resolve(fn.call(cmds, data)).catch((err) => console.error(`${a} failed`, err));
  return true;
}

// ---- Mobile long-press menu ---------------------------------------------------

const MENU: { a: Action; label: string; icon: string }[] = [
  { a: 'undo', label: 'Undo', icon: 'undo' }, { a: 'redo', label: 'Redo', icon: 'redo' },
  { a: 'cut', label: 'Cut', icon: 'scissors' }, { a: 'copy', label: 'Copy', icon: 'copy' }, { a: 'paste', label: 'Paste', icon: 'clipboard' },
  { a: 'duplicate', label: 'Duplicate', icon: 'plus' }, { a: 'delete', label: 'Delete', icon: 'trash' }, { a: 'selectAll', label: 'Select all', icon: 'boxSelect' },
];

let openMenu: HTMLElement | null = null;
export function closeEditMenu(): void { openMenu?.remove(); openMenu = null; }

export function showEditMenu(cmds: EditCommands, x: number, y: number): void {
  closeEditMenu();
  const sel = cmds.hasSelection ? cmds.hasSelection() : true;
  const enabled = (a: Action): boolean => {
    if (a === 'undo') return cmds.canUndo ? cmds.canUndo() : true;
    if (a === 'redo') return cmds.canRedo ? cmds.canRedo() : true;
    if (a === 'paste') return cmds.canPaste ? cmds.canPaste() : true;
    if (a === 'cut' || a === 'copy' || a === 'delete' || a === 'duplicate') return sel;
    return true;
  };
  const items = MENU.filter((m) => cmds[m.a]);
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.className = 'edit-menu';
  menu.setAttribute('role', 'menu');
  for (const m of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${icon(m.icon, 20)}<span>${m.label}</span>`;
    b.setAttribute('role', 'menuitem');
    b.disabled = !enabled(m.a);
    if (m.a === 'delete') b.classList.add('danger');
    b.addEventListener('click', (e) => { e.stopPropagation(); closeEditMenu(); runAction(cmds, m.a); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  openMenu = menu;
  // Above the finger when there is room, clamped to the viewport.
  const r = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x - r.width / 2, innerWidth - r.width - 8));
  const top = y - r.height - 24 > 8 ? y - r.height - 24 : Math.min(y + 24, innerHeight - r.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const dismiss = (e: Event): void => {
    if (menu.contains(e.target as Node)) return;
    document.removeEventListener('pointerdown', dismiss, true);
    closeEditMenu();
  };
  setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
  navigator.vibrate?.(12);
}

// Long-press detection on touch/pen: 500 ms hold without moving > 10 px.
export function bindLongPress(onPress: (e: PointerEvent) => void): () => void {
  let timer = 0, x0 = 0, y0 = 0, down: PointerEvent | null = null;
  const cancel = (): void => { clearTimeout(timer); timer = 0; down = null; };
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    cancel();
    down = e; x0 = e.clientX; y0 = e.clientY;
    timer = window.setTimeout(() => { if (down) onPress(down); cancel(); }, 500);
  };
  const onMove = (e: PointerEvent): void => {
    if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  return () => {
    cancel();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', cancel, true);
    document.removeEventListener('pointercancel', cancel, true);
  };
}
