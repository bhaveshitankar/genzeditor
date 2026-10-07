// "Report a problem / feedback" dialog shared by desktop (modal) and mobile
// (rendered as a bottom sheet by mobile.css). Posts to /api/feedback.
import { sendFeedback, type FeedbackCategory } from '../api/client';
import { appVersion, type AppKind } from '../telemetry';

const CATEGORIES: { id: FeedbackCategory; label: string }[] = [
  { id: 'bug', label: 'Something broke' },
  { id: 'idea', label: 'Idea' },
  { id: 'question', label: 'Question' },
  { id: 'other', label: 'Other' },
];

function platform(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'other';
  const touch = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
  return `${os}/${touch}/${window.innerWidth}x${window.innerHeight}`;
}

export function openFeedbackSheet(opts: {
  root: HTMLElement;
  app: AppKind;
  fileKind?: string;
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="fb-title">
      <h3 id="fb-title">Report a problem or share feedback</h3>
      <p>Tell us what happened or what you'd like to see. We read every message.</p>
      <div class="fb-chips" role="radiogroup" aria-label="Category"></div>
      <textarea class="fb-message" rows="5" maxlength="4000" placeholder="What happened? What did you expect?"></textarea>
      <input type="email" class="fb-email" placeholder="Email (optional — only if you want a reply)" autocomplete="email">
      <label class="fb-tech"><input type="checkbox" checked> Include technical info (app version, file type, device type)</label>
      <p class="fb-error" role="alert"></p>
      <div class="modal-actions">
        <button type="button" class="btn-cancel">Cancel</button>
        <button type="button" class="btn-confirm">Send</button>
      </div>
    </div>`;
  const chips = overlay.querySelector('.fb-chips') as HTMLElement;
  let category: FeedbackCategory = 'bug';
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fb-chip' + (c.id === category ? ' selected' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c.id === category));
    b.textContent = c.label;
    b.addEventListener('click', () => {
      category = c.id;
      chips.querySelectorAll('.fb-chip').forEach((el) => { el.classList.remove('selected'); el.setAttribute('aria-checked', 'false'); });
      b.classList.add('selected');
      b.setAttribute('aria-checked', 'true');
    });
    chips.appendChild(b);
  }
  const msg = overlay.querySelector('.fb-message') as HTMLTextAreaElement;
  const email = overlay.querySelector('.fb-email') as HTMLInputElement;
  const tech = overlay.querySelector('.fb-tech input') as HTMLInputElement;
  const err = overlay.querySelector('.fb-error') as HTMLElement;
  const send = overlay.querySelector('.btn-confirm') as HTMLButtonElement;

  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.btn-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  send.addEventListener('click', async () => {
    const message = msg.value.trim();
    if (message.length < 5) { err.textContent = 'Please describe it in a few words.'; msg.focus(); return; }
    const mail = email.value.trim();
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { err.textContent = 'That email looks off.'; email.focus(); return; }
    err.textContent = '';
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await sendFeedback({
        category,
        message,
        email: mail || undefined,
        context: tech.checked
          ? { app: opts.app, version: appVersion(), fileKind: opts.fileKind, platform: platform(), path: location.pathname }
          : undefined,
      });
      close();
      opts.toast('Thanks! Your feedback was sent.', 'success');
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      err.textContent = code === 'rate_limited'
        ? 'Too many messages today — please try again tomorrow.'
        : "Couldn't send right now. Check your connection and try again.";
      send.disabled = false;
      send.textContent = 'Send';
    }
  });

  opts.root.appendChild(overlay);
  msg.focus();
}
