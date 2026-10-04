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
}
