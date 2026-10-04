// worker/src/email/disposable.ts
// Blocklist of disposable/temp-mail domains: a large bundled list plus a
// KV-backed override list so new temp-mail domains can be blocked without a
// redeploy.
import list from 'disposable-email-domains';
import type { Env } from '../env';

const BUNDLED = new Set<string>(list as unknown as string[]);

export async function isDisposableDomain(env: Env, domain: string): Promise<boolean> {
  if (BUNDLED.has(domain)) return true;
  const custom = await env.KV_BLOCKED_EMAIL_DOMAINS.get(domain);
  return custom !== null;
}
