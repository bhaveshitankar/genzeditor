import type { MeState } from '../api/client';
import { loginUrl } from '../api/client';

export function renderAuthBar(
  host: HTMLElement,
  me: MeState,
  handlers: { onLogout: () => void; onSignIn: () => void },
): void {
  host.innerHTML = '';
  if (!me.authenticated) {
    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.textContent = 'Sign in';
    signIn.setAttribute('data-role', 'signin');
    signIn.className = 'auth-btn';
    signIn.addEventListener('click', handlers.onSignIn);
    host.append(signIn);
    return;
  }
  const email = document.createElement('span');
  email.className = 'auth-email';
  email.textContent = me.email ?? 'Signed in';
  const out = document.createElement('button');
  out.type = 'button'; out.textContent = 'Log out';
  out.setAttribute('data-role', 'logout'); out.className = 'auth-link';
  out.addEventListener('click', handlers.onLogout);
  host.append(email, out);
}

// Open a centered sign-in dialog offering the OAuth providers. Kept here so the
// provider list lives next to loginUrl(); AppShell only wires the trigger.
export function openSignInModal(): void {
  if (typeof document === 'undefined') return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal signin-modal" role="dialog" aria-modal="true" aria-label="Sign in">
      <button class="modal-close" aria-label="Close">×</button>
      <h2 class="signin-title">Welcome back</h2>
      <p class="signin-sub">Sign in to unlock editable links, more storage, and cross-device access.</p>
      <div class="signin-providers">
        <a class="signin-provider" data-provider="google" href="${loginUrl('google')}">
          <span class="signin-provider-icon">G</span> Continue with Google
        </a>
        <a class="signin-provider" data-provider="github" href="${loginUrl('github')}">
          <span class="signin-provider-icon">⌥</span> Continue with GitHub
        </a>
      </div>
      <p class="signin-fine">No password needed — we never see your credentials.</p>
    </div>`;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.append(overlay);
}

export function loginIncentive(reason: 'retention' | 'rw' | 'cross-device'): string {
  switch (reason) {
    case 'retention': return 'Sign in to keep this file longer (30 days instead of 7) and get 700MB of storage.';
    case 'rw': return 'Sign in to share an editable (read-write) link others can change.';
    case 'cross-device': return 'Sign in to access this file on your phone and other devices.';
  }
}
