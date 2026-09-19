import { describe, it, expect, vi } from 'vitest';
import { renderAuthBar, loginIncentive } from '../../src/auth/authUi';

describe('authUi', () => {
  it('shows provider links when signed out', () => {
    const host = document.createElement('div');
    renderAuthBar(host, { authenticated: false }, { onLogout: () => {} });
    expect(host.querySelector('a[data-provider="google"]')).toBeTruthy();
    expect(host.querySelector('a[data-provider="github"]')).toBeTruthy();
  });

  it('shows email and logout when signed in', () => {
    const host = document.createElement('div');
    const onLogout = vi.fn();
    renderAuthBar(host, { authenticated: true, email: 'a@b.co', csrfToken: 'c' }, { onLogout });
    expect(host.textContent).toContain('a@b.co');
    (host.querySelector('button[data-role="logout"]') as HTMLButtonElement).click();
    expect(onLogout).toHaveBeenCalled();
  });

  it('provides incentive copy for each friction point', () => {
    expect(loginIncentive('retention')).toContain('longer');
    expect(loginIncentive('rw')).toContain('edit');
    expect(loginIncentive('cross-device')).toContain('phone');
  });
});
