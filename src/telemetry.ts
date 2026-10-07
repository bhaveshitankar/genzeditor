// Anonymous error reporting shared by the desktop and mobile apps.
// Sends only what failed and where (no file contents, names or emails), batched
// and rate-capped, and can be switched off by the user (localStorage flag).
import { API_BASE } from './api/client';

export type AppKind = 'web' | 'mobile';
interface TelemetryEvent { type: 'error' | 'fail'; where: string; message: string; kind?: string; app: AppKind; version: string }

const OFF_KEY = 'gz-telemetry-off';
const MAX_PER_SESSION = 50;
const MAX_BATCH = 20;
const FLUSH_MS = 10_000;

let app: AppKind = 'web';
let queue: TelemetryEvent[] = [];
let sentCount = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const seen = new Set<string>();

export function appVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
}

export function telemetryEnabled(): boolean {
  try { return localStorage.getItem(OFF_KEY) !== '1'; } catch { return true; }
}

export function setTelemetryEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, '1');
  } catch { /* storage unavailable */ }
  if (!on) queue = [];
}

// Strip anything that could identify a file or person: URLs/blob ids, emails,
// quoted strings (often file names), long numbers. Keep it short.
function scrub(text: string): string {
  return text
    .replace(/(blob:)?https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/[“"'‘][^“"'‘”’]{1,200}[”"'’]/g, '<str>')
    .replace(/\b\d{6,}\b/g, '<n>')
    .slice(0, 500);
}

function enqueue(type: TelemetryEvent['type'], where: string, message: string, kind?: string): void {
  if (!telemetryEnabled() || sentCount >= MAX_PER_SESSION) return;
  const ev: TelemetryEvent = { type, where: scrub(where).slice(0, 120), message: scrub(message), app, version: appVersion() };
  if (kind) ev.kind = kind.slice(0, 40);
  const key = `${ev.type}|${ev.where}|${ev.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  queue.push(ev);
  sentCount++;
  if (queue.length >= MAX_BATCH) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

function flush(useBeacon = false): void {
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (!queue.length) return;
  const events = queue.splice(0, MAX_BATCH);
  const body = JSON.stringify({ events });
  const url = `${API_BASE}/api/telemetry`;
  try {
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    } else {
      void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* never let reporting break the app */ }
  if (queue.length) timer = setTimeout(flush, FLUSH_MS);
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Report a handled failure (e.g. share/export/open failed). */
export function reportFailure(where: string, err: unknown, kind?: string): void {
  enqueue('fail', where, messageOf(err), kind);
}

/** Install global handlers once per page. */
export function initTelemetry(kind: AppKind): void {
  app = kind;
  window.addEventListener('error', (e) => {
    const where = e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : 'window';
    enqueue('error', where, messageOf(e.error ?? e.message));
  });
  window.addEventListener('unhandledrejection', (e) => enqueue('error', 'promise', messageOf(e.reason)));
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
}
