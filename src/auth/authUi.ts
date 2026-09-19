import type { MeState } from '../api/client';
import { loginUrl } from '../api/client';

export function renderAuthBar(host: HTMLElement, me: MeState, handlers: { onLogout: () => void }): void {
  host.innerHTML = '';
  if (!me.authenticated) {
    const g = document.createElement('a');
    g.href = loginUrl('google'); g.textContent = 'Sign in with Google';
    g.setAttribute('data-provider', 'google'); g.className = 'auth-link';
    const h = document.createElement('a');
    h.href = loginUrl('github'); h.textContent = 'Sign in with GitHub';
    h.setAttribute('data-provider', 'github'); h.className = 'auth-link';
    host.append(g, h);
    return;
  }
  const email = document.createElement('span');
  email.textContent = me.email ?? 'Signed in';
  const out = document.createElement('button');
  out.type = 'button'; out.textContent = 'Log out';
  out.setAttribute('data-role', 'logout'); out.className = 'auth-link';
  out.addEventListener('click', handlers.onLogout);
  host.append(email, out);
}

export function loginIncentive(reason: 'retention' | 'rw' | 'cross-device'): string {
  switch (reason) {
    case 'retention': return 'Sign in to keep this file longer (30 days instead of 7) and get 700MB of storage.';
    case 'rw': return 'Sign in to share an editable (read-write) link others can change.';
    case 'cross-device': return 'Sign in to access this file on your phone and other devices.';
  }
}
