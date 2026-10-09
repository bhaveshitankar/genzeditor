// App-styled replacements for window.prompt / window.confirm. They reuse the
// shell's .modal styles so dialogs match the theme (and don't look like a
// browser alert, which is jarring on mobile and can't be themed).

interface BaseOpts { title: string; message?: string; confirmLabel?: string; danger?: boolean }

function mount(): { overlay: HTMLElement; modal: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  overlay.appendChild(modal);
  return { overlay, modal };
}

function open<T>(opts: BaseOpts, field: HTMLInputElement | null, cancelValue: T, okValue: () => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    const { overlay, modal } = mount();
    const h = document.createElement('h3');
    h.textContent = opts.title;
    modal.appendChild(h);
    if (opts.message) {
      const p = document.createElement('p');
      p.textContent = opts.message;
      modal.appendChild(p);
    }
    if (field) modal.appendChild(field);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn-cancel'; cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = opts.danger ? 'btn-danger' : 'btn-confirm'; ok.textContent = opts.confirmLabel ?? 'OK';
    actions.append(cancel, ok);
    modal.appendChild(actions);

    const done = (v: T) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); };
    const accept = () => { const v = okValue(); if (v !== undefined) done(v); else field?.focus(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(cancelValue); }
      else if (e.key === 'Enter' && field && document.activeElement === field) { e.preventDefault(); accept(); }
    };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => done(cancelValue));
    ok.addEventListener('click', accept);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(cancelValue); });
    document.body.appendChild(overlay);
    if (field) { field.focus(); field.select(); } else ok.focus();
  });
}

/** Ask for a line of text. Resolves null when cancelled. */
export function askText(opts: BaseOpts & { value?: string; placeholder?: string; inputMode?: 'text' | 'decimal' | 'numeric' | 'url' }): Promise<string | null> {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = opts.value ?? '';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.inputMode = opts.inputMode ?? 'text';
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.style.fontSize = '16px'; // stop iOS zooming on focus
  return open<string | null>(opts, input, null, () => input.value);
}

/** Ask for a number. Resolves null when cancelled or the input isn't a number. */
export async function askNumber(opts: BaseOpts & { value: number }): Promise<number | null> {
  const v = await askText({ ...opts, value: String(opts.value), inputMode: 'decimal' });
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** Themed yes/no confirmation. */
export function askConfirm(opts: BaseOpts): Promise<boolean> {
  return open<boolean>({ confirmLabel: 'Confirm', ...opts }, null, false, () => true);
}
