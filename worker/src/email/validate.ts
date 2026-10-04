// worker/src/email/validate.ts
import type { Env } from '../env';
import { isDisposableDomain } from './disposable';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidSyntax(email: string): boolean {
  return RE.test(email);
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export async function isDisposable(env: Env, domain: string): Promise<boolean> {
  return isDisposableDomain(env, domain);
}

// DoH MX lookup via Cloudflare 1.1.1.1. Fails OPEN (returns true) on network
// error / non-OK so a DNS outage does not block all signups.
export async function hasMx(domain: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) return true;
    const data = (await res.json()) as { Answer?: Array<{ type: number }> };
    return Array.isArray(data.Answer) && data.Answer.some((a) => a.type === 15);
  } catch {
    return true;
  }
}
