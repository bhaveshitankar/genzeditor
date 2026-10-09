export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  ALLOWED_ORIGIN: string;
  API_BASE_URL: string;
  IP_HASH_SECRET: string;
  FILEBASE_KEY: string;
  FILEBASE_SECRET: string;
  FILEBASE_BUCKET: string;
  FILEBASE_ENDPOINT: string;
  FILEBASE_REGION: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  KV_BLOCKED_EMAIL_DOMAINS: KVNamespace;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  TURNSTILE_SECRET_KEY: string;
  // AI edit feature.
  AI: Ai;
  // Optional server-side fallback provider keys (used when Workers AI errors).
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // MCP API keys for external agents: "name:secret,name2:secret2" (wrangler secret).
  MCP_API_KEYS?: string;
}
