import { describe, it, expect, vi } from 'vitest';
import { renderAuthBar, loginIncentive, openSignInModal } from '../../src/auth/authUi';

describe('authUi', () => {
  it('shows a single Sign in button that opens the sign-in flow when signed out', () => {
    const host = document.createElement('div');
    const onSignIn = vi.fn();
    renderAuthBar(host, { authenticated: false }, { onLogout: () => {}, onSignIn });
    const btn = host.querySelector('button[data-role="signin"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('Sign in');
    btn.click();
    expect(onSignIn).toHaveBeenCalled();
  });

  it('shows email and logout when signed in', () => {
    const host = document.createElement('div');
    const onLogout = vi.fn();
    renderAuthBar(host, { authenticated: true, email: 'a@b.co', csrfToken: 'c' }, { onLogout, onSignIn: () => {} });
    expect(host.textContent).toContain('a@b.co');
    (host.querySelector('button[data-role="logout"]') as HTMLButtonElement).click();
    expect(onLogout).toHaveBeenCalled();
  });

  it('sign-in modal renders email OTP step and social buttons', () => {
    document.body.innerHTML = '';
    openSignInModal();
    expect(document.querySelector('[data-role="otp-email"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Send code');
    expect(document.querySelector('[data-role="oauth-google"]')).toBeTruthy();
    expect(document.querySelector('[data-role="oauth-github"]')).toBeTruthy();
  });

  it('provides incentive copy for each friction point', () => {
    expect(loginIncentive('retention')).toContain('longer');
    expect(loginIncentive('rw')).toContain('edit');
    expect(loginIncentive('cross-device')).toContain('phone');
  });
});
