import './styles/app.css';
import { bootstrap } from './bootstrap';
import { initTelemetry } from './telemetry';

export async function mount(root: HTMLElement): Promise<void> {
  initTelemetry('web');
  await bootstrap(root);
  maybeShowMobileBanner(root);
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
    <a href="https://mobile.genzeditor.com" class="mobile-app-open">Open</a>
    <button type="button" class="mobile-app-close" aria-label="Dismiss">✕</button>`;
  bar.querySelector('.mobile-app-close')!.addEventListener('click', () => {
    bar.remove();
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
  });
  root.appendChild(bar);
}

const el = typeof document !== 'undefined' && document.getElementById('app');
if (el) void mount(el);
