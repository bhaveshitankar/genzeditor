// Sticky modifier dock for touch screens. Desktop editors rely on Shift / Ctrl /
// Alt (extend selection, toggle-select, constrain, duplicate-drag…). On touch
// there is no keyboard, so this dock arms a modifier for the next tap/drag
// (double-tap a chip to lock it). While armed, every pointer/mouse/key event is
// stamped so any editor that reads e.shiftKey / e.ctrlKey / e.metaKey / e.altKey
// gets the desktop behaviour without knowing about the dock.
type Mod = 'shiftKey' | 'ctrlKey' | 'altKey';

const CHIPS: { mod: Mod; label: string; title: string }[] = [
  { mod: 'shiftKey', label: '⇧', title: 'Shift — tap to extend selection (double-tap to lock)' },
  { mod: 'ctrlKey', label: '⌘', title: 'Ctrl/⌘ — tap to add to selection (double-tap to lock)' },
  { mod: 'altKey', label: '⌥', title: 'Alt — tap for alternate action (double-tap to lock)' },
];
const EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchmove', 'touchend', 'keydown', 'keyup', 'wheel'];

export function initModifierDock(isActive: () => boolean): void {
  if (typeof matchMedia !== 'function') return;
  if (document.getElementById('modifier-dock')) return;
  const armed = new Set<Mod>();
  const locked = new Set<Mod>();
  const dock = document.createElement('div');
  dock.id = 'modifier-dock';
  dock.setAttribute('role', 'toolbar');
  dock.setAttribute('aria-label', 'Modifier keys');
  const btns = new Map<Mod, HTMLButtonElement>();
  const paint = (): void => {
    for (const [m, b] of btns) {
      b.classList.toggle('on', armed.has(m));
      b.classList.toggle('lock', locked.has(m));
      b.setAttribute('aria-pressed', String(armed.has(m)));
    }
  };
  const release = (): void => {
    for (const m of [...armed]) if (!locked.has(m)) armed.delete(m);
    paint();
  };
  for (const c of CHIPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.label;
    b.title = c.title;
    b.setAttribute('aria-label', c.title);
    let last = 0;
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep editor focus / selection
    b.addEventListener('click', () => {
      const now = Date.now();
      if (armed.has(c.mod) && locked.has(c.mod)) { armed.delete(c.mod); locked.delete(c.mod); }
      else if (armed.has(c.mod) && now - last < 450) locked.add(c.mod);
      else if (armed.has(c.mod)) armed.delete(c.mod);
      else armed.add(c.mod);
      last = now;
      paint();
      navigator.vibrate?.(8);
    });
    btns.set(c.mod, b);
    dock.appendChild(b);
  }
  document.body.appendChild(dock);

  const stamp = (e: Event): void => {
    if (!armed.size || dock.contains(e.target as Node)) return;
    for (const m of armed) {
      Object.defineProperty(e, m, { value: true, configurable: true });
      if (m === 'ctrlKey') Object.defineProperty(e, 'metaKey', { value: true, configurable: true });
    }
  };
  for (const t of EVENTS) window.addEventListener(t, stamp, { capture: true, passive: true });

  // One-shot: drop non-locked modifiers once the gesture has completed.
  let fallback = 0;
  window.addEventListener('click', (e) => { if (!dock.contains(e.target as Node)) setTimeout(release, 0); }, true);
  window.addEventListener('pointerup', (e) => {
    if (dock.contains(e.target as Node) || !armed.size) return;
    clearTimeout(fallback);
    fallback = window.setTimeout(release, 600);
  }, true);
  window.addEventListener('keydown', (e) => {
    if (!armed.size || dock.contains(e.target as Node) || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    setTimeout(release, 0);
  }, true);

  // Only on touch-first screens, and only while a document is open.
  const coarse = matchMedia('(pointer: coarse)');
  const sync = (): void => {
    const show = (coarse.matches || innerWidth < 700) && isActive();
    dock.style.display = show ? 'flex' : 'none';
    if (!show && armed.size) { armed.clear(); locked.clear(); paint(); }
  };
  setInterval(sync, 400);
  sync();
}
