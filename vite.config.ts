import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Mirror the deployed public/_headers CSP so `vite preview` (used by the e2e
// suite) exercises the same policy the sandboxed mermaid frame runs under.
const DEPLOYED_CSP =
  "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; frame-src 'self'; " +
  "connect-src 'self' https://anyedits-api.skillmesh.workers.dev https://s3.filebase.io; " +
  "object-src 'none'; base-uri 'none'";

export default defineConfig({
  server: {
    port: 3000,
  },
  preview: {
    headers: {
      'Content-Security-Policy': DEPLOYED_CSP,
      // The isolated mermaid frame runs in an opaque origin, so it fetches the
      // bundled module script cross-origin; allow it to read same-site assets.
      'Access-Control-Allow-Origin': '*',
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Standalone same-origin frame document for isolated mermaid rendering.
        mermaidFrame: resolve(__dirname, 'mermaid-frame.html'),
      },
    },
  },
});
