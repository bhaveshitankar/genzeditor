import './styles/app.css';
import { bootstrap } from './bootstrap';
import { initTelemetry } from './telemetry';
import { FileStore, OpfsAdapter } from './store/opfs';

export async function mount(root: HTMLElement): Promise<void> {
  initTelemetry('web');
  if (await maybeRedirectToMobile()) return;
  await bootstrap(root);
  maybeShowMobileBanner(root);
}

const isPhone = (): boolean => matchMedia('(pointer: coarse)').matches && window.innerWidth < 760;
const chosenDesktop = (): boolean =>
  new URLSearchParams(location.search).has('desktop') || /(?:^|;\s*)gz-view=desktop/.test(document.cookie);

// The server redirects new phone visitors. Here we cover the rest: phones with
// no local files on this site go to the mobile app; phones that already have
// files here get a cookie so they're never moved away from their files.
async function maybeRedirectToMobile(): Promise<boolean> {
  if (!/(^|\.)genzeditor\.com$/.test(location.hostname) || !isPhone() || chosenDesktop()) return false;
  let count = 0;
  try { count = (await new FileStore(new OpfsAdapter()).list()).length; } catch { /* storage unavailable */ }
  if (count > 0) {
    document.cookie = `gz-seen=1; Max-Age=${60 * 60 * 24 * 365}; Path=/; Secure; SameSite=Lax`;
    return false;
  }
  location.replace(`https://mobile.genzeditor.com/${location.search}${location.hash}`);
  return true;
}

// Phones landing on the desktop site get a dismissible pointer to the mobile app.
function maybeShowMobileBanner(root: HTMLElement): void {
  const KEY = 'gz-mobile-banner-dismissed';
  const params = new URLSearchParams(location.search);
  if (params.has('desktop')) { try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } return; }
  try { if (localStorage.getItem(KEY) === '1') return; } catch { /* ignore */ }
  if (!matchMedia('(pointer: coarse)').matches || window.innerWidth >= 760) return;
  const bar = document.createElement('div');
  bar.className = 'mobile-app-banner';
  bar.innerHTML = `<span>Try the GenZ Editor mobile app — built for touch.</span>
    <a href="https://genzeditor.com/?mobile=1" class="mobile-app-open">Open</a>
    <button type="button" class="mobile-app-close" aria-label="Dismiss">✕</button>`;
  bar.querySelector('.mobile-app-close')!.addEventListener('click', () => {
    bar.remove();
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
  });
  root.appendChild(bar);
}

const el = typeof document !== 'undefined' && document.getElementById('app');
if (el) void mount(el);
