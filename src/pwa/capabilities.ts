// Client half of the PWA capabilities declared in the manifest / service worker.

/** Extract a share token from a `web+genz:` link (web+genz:<token>, web+genz://<token>, or a full share URL). */
export function tokenFromProtocolUrl(raw: string): string | null {
  let s = raw.trim();
  try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
  s = s.replace(/^web\+genz:(\/\/)?/i, '');
  const fromUrl = /[#?&]t=([A-Za-z0-9_-]+)/.exec(s);
  if (fromUrl) return fromUrl[1]!;
  const bare = /^([A-Za-z0-9_-]{16,})\/?$/.exec(s);
  return bare ? bare[1]! : null;
}

/** Handle /?protocol=web+genz:<token> by turning it into the normal #t=<token> share hash. */
export function handleProtocolLaunch(): boolean {
  const raw = new URLSearchParams(location.search).get('protocol');
  if (!raw) return false;
  const token = tokenFromProtocolUrl(raw);
  history.replaceState(null, '', location.pathname + (token ? `#t=${token}` : location.hash));
  return !!token;
}

/** Register periodic shell refresh (Chrome, installed PWAs with permission). Silent no-op elsewhere. */
export async function registerPeriodicSync(reg: ServiceWorkerRegistration): Promise<void> {
  try {
    const ps = (reg as unknown as { periodicSync?: { register(tag: string, o: { minInterval: number }): Promise<void> } }).periodicSync;
    if (!ps) return;
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName });
    if (status.state === 'granted') await ps.register('gz-refresh-shell', { minInterval: 24 * 60 * 60 * 1000 });
  } catch { /* unsupported or not installed */ }
}

/** Ask the SW to wake the app once connectivity returns so a failed save can be retried. */
export async function requestRetrySync(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (reg as unknown as { sync?: { register(tag: string): Promise<void> } } | undefined)?.sync;
    if (!sync) return false;
    await sync.register('gz-retry-save');
    return true;
  } catch { return false; }
}

/** Run `cb` when the SW (background sync) or a ?retry=save launch asks to retry a failed save. */
export function onRetrySave(cb: () => void): void {
  navigator.serviceWorker?.addEventListener('message', (e) => { if ((e.data as { type?: string } | null)?.type === 'gz-retry-save') cb(); });
  if (new URLSearchParams(location.search).get('retry') === 'save') {
    history.replaceState(null, '', location.pathname + location.hash);
    cb();
  }
}
