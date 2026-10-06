import type { MeState, OtpError } from '../api/client';
import { requestEmailOtp, verifyEmailOtp, startSocial } from '../api/client';

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

  // Create profile avatar with dropdown menu
  const email = me.email ?? 'User';
  const initials = email
    .split('@')[0]
    .split(/[._-]/)
    .map((part) => part[0]?.toUpperCase() || '')
    .slice(0, 2)
    .join('');

  const container = document.createElement('div');
  container.className = 'auth-profile';

  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'auth-avatar';
  avatar.title = email;
  avatar.setAttribute('data-role', 'profile-avatar');
  avatar.textContent = initials || '👤';
  avatar.setAttribute('aria-label', `Profile for ${email}`);

  const menu = document.createElement('div');
  menu.className = 'auth-menu';
  menu.innerHTML = `
    <div class="auth-menu-header">
      <div class="auth-avatar-large">${initials || '👤'}</div>
      <div class="auth-menu-info">
        <div class="auth-menu-email">${email}</div>
      </div>
    </div>
    <button type="button" class="auth-logout" data-role="logout">Sign out</button>
  `;

  const logout = menu.querySelector('[data-role="logout"]') as HTMLButtonElement;
  logout.addEventListener('click', () => {
    menu.classList.remove('active');
    handlers.onLogout();
  });

  avatar.addEventListener('click', () => {
    menu.classList.toggle('active');
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target as Node)) {
      menu.classList.remove('active');
    }
  }, { capture: true });

  container.append(avatar, menu);
  host.append(container);
}

const TURNSTILE_SITE_KEY = (import.meta.env?.VITE_TURNSTILE_SITE_KEY as string) ?? '';

// Friendly copy for each Worker rejection code.
function messageFor(err: OtpError): string {
  switch (err.error) {
    case 'invalid_email': return 'Please enter a valid email address.';
    case 'disposable_email': return 'Please use a non-disposable email address.';
    case 'no_mx': return "That email domain can't receive mail.";
    case 'turnstile_failed': return 'Please complete the verification challenge.';
    case 'rate_limited': return `Too many attempts. Try again in ${err.retryAfter ?? 60}s.`;
    case 'invalid_code':
    case 'expired_code': return 'That code is wrong or has expired.';
    default: return 'Something went wrong. Please try again.';
  }
}

function loadTurnstileScript(): void {
  if (document.querySelector('script[data-turnstile]')) return;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  s.async = true; s.defer = true;
  s.setAttribute('data-turnstile', '');
  document.head.append(s);
}

// Open a centered sign-in dialog: email OTP (passwordless) plus OAuth providers.
export function openSignInModal(): void {
  if (typeof document === 'undefined') return;
  loadTurnstileScript();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal signin-modal" role="dialog" aria-modal="true" aria-label="Sign in">
      <button class="modal-close" aria-label="Close">×</button>
      <h2 class="signin-title">Sign in or create an account</h2>
      <p class="signin-sub">Enter your email and we'll send you a 6-digit code — no password needed.</p>

      <div data-step="email">
        <input type="email" data-role="otp-email" class="signin-input" placeholder="you@example.com" autocomplete="email" />
        <div class="cf-turnstile" data-sitekey="${TURNSTILE_SITE_KEY}"></div>
        <button type="button" data-role="otp-send" class="signin-primary">Send code</button>
      </div>

      <div data-step="code" hidden>
        <p class="signin-sub">We sent a code to <span data-role="otp-dest"></span>.</p>
        <input type="text" inputmode="numeric" maxlength="6" data-role="otp-code" class="signin-input" placeholder="123456" autocomplete="one-time-code" />
        <button type="button" data-role="otp-verify" class="signin-primary">Verify &amp; sign in</button>
      </div>

      <p class="signin-error" data-role="otp-error" role="alert" hidden></p>

      <div class="signin-divider"><span>or</span></div>
      <div class="signin-providers">
        <button type="button" class="signin-provider" data-role="oauth-google">
          <span class="signin-provider-icon">G</span> Continue with Google
        </button>
        <button type="button" class="signin-provider" data-role="oauth-github">
          <span class="signin-provider-icon">⌥</span> Continue with GitHub
        </button>
      </div>
    </div>`;

  const q = <T extends HTMLElement>(sel: string) => overlay.querySelector(sel) as T;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  q('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  const errEl = q<HTMLParagraphElement>('[data-role="otp-error"]');
  const showErr = (msg: string) => { errEl.textContent = msg; errEl.hidden = false; };
  const clearErr = () => { errEl.hidden = true; };

  const emailInput = q<HTMLInputElement>('[data-role="otp-email"]');
  const sendBtn = q<HTMLButtonElement>('[data-role="otp-send"]');
  const codeStep = q<HTMLDivElement>('[data-step="code"]');
  const emailStep = q<HTMLDivElement>('[data-step="email"]');

  let countdown: ReturnType<typeof setInterval> | undefined;
  const lockSend = (seconds: number) => {
    sendBtn.disabled = true;
    let left = seconds;
    const tick = () => {
      sendBtn.textContent = `Try again in ${left}s`;
      if (left <= 0) { clearInterval(countdown); sendBtn.disabled = false; sendBtn.textContent = 'Send code'; }
      left -= 1;
    };
    tick();
    countdown = setInterval(tick, 1000);
  };

  sendBtn.addEventListener('click', async () => {
    clearErr();
    const email = emailInput.value.trim();
    const token = (overlay.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value ?? '';
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      await requestEmailOtp(email, token);
      emailStep.hidden = true;
      codeStep.hidden = false;
      q('[data-role="otp-dest"]').textContent = email;
      q<HTMLInputElement>('[data-role="otp-code"]').focus();
      sendBtn.textContent = 'Send code'; sendBtn.disabled = false;
    } catch (e) {
      const err = e as OtpError;
      showErr(messageFor(err));
      if (err.error === 'rate_limited') lockSend(err.retryAfter ?? 60);
      else { sendBtn.textContent = 'Send code'; sendBtn.disabled = false; }
    }
  });

  q('[data-role="otp-verify"]').addEventListener('click', async () => {
    clearErr();
    const email = emailInput.value.trim();
    const code = q<HTMLInputElement>('[data-role="otp-code"]').value.trim();
    try {
      await verifyEmailOtp(email, code);
      location.reload();
    } catch (e) {
      showErr(messageFor(e as OtpError));
    }
  });

  q('[data-role="oauth-google"]').addEventListener('click', () => void startSocial('google'));
  q('[data-role="oauth-github"]').addEventListener('click', () => void startSocial('github'));

  document.body.append(overlay);
}

export function loginIncentive(reason: 'retention' | 'rw' | 'cross-device'): string {
  switch (reason) {
    case 'retention': return 'Sign in to keep this file longer (30 days instead of 7) and get 700MB of storage.';
    case 'rw': return 'Sign in to share an editable (read-write) link others can change.';
    case 'cross-device': return 'Sign in to access this file on your phone and other devices.';
  }
}
