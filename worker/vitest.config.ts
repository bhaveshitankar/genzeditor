import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['DB'],
          bindings: {
            ALLOWED_ORIGIN: 'https://anyedits-aay.pages.dev',
            API_BASE_URL: 'https://anyedits-aay.pages.dev',
            IP_HASH_SECRET: 'test-ip-secret',
            FILEBASE_KEY: 'AKIATEST',
            FILEBASE_SECRET: 'testsecret',
            FILEBASE_BUCKET: 'anyedits-test',
            FILEBASE_ENDPOINT: 'https://s3.filebase.io',
            FILEBASE_REGION: 'us-east-1',
            GOOGLE_CLIENT_ID: 'gid',
            GOOGLE_CLIENT_SECRET: 'gsecret',
            GITHUB_CLIENT_ID: 'hid',
            GITHUB_CLIENT_SECRET: 'hsecret',
          },
        },
      },
    },
  },
});
