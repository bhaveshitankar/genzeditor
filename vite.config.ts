import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { seoPages } from './scripts/seo-pages.mjs';

// Build-time app version (package version + short git sha) for telemetry/feedback.
const pkgVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;
let gitSha = '';
try { gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
const APP_VERSION = gitSha ? `${pkgVersion}+${gitSha}` : pkgVersion;

// Cache version for service worker (bumped on every build to invalidate old caches).
const CACHE_VERSION = `gz-static-${Date.now()}`;

// Mirror the deployed public/_headers CSP so `vite preview` (used by the e2e
// suite) exercises the same policy the sandboxed mermaid frame runs under.
const DEPLOYED_CSP =
  "default-src 'self'; img-src 'self' data: blob:; script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-eval' https://cdn.jsdelivr.net https://esm.sh https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline'; media-src 'self' blob:; font-src 'self' data:; frame-src 'self' blob: https://challenges.cloudflare.com; worker-src 'self' blob:; " +
  "connect-src 'self' blob: https://api.genzeditor.com wss://api.genzeditor.com https://anyedits-api.skillmesh.workers.dev wss://anyedits-api.skillmesh.workers.dev https://s3.filebase.io https://cdn.jsdelivr.net https://esm.sh https://staticimgly.com https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  "object-src 'none'; base-uri 'none'";

const cacheBustPlugin = {
  name: 'cache-bust-sw',
  apply: 'build' as const,
  closeBundle() {
    // After build finishes, inject cache version into dist/sw.js.
    const swPath = resolve(__dirname, 'dist/sw.js');
    try {
      let code = readFileSync(swPath, 'utf8');
      code = code.replace(/const STATIC = 'gz-static-v\d+';/, `const STATIC = '${CACHE_VERSION}';`);
      writeFileSync(swPath, code);
    } catch (err) { console.warn('Failed to update sw.js cache version:', err); }
  },
};

export default defineConfig({
  plugins: [seoPages(), cacheBustPlugin],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
        // Mobile app (served as the root of mobile.genzeditor.com).
        mobile: resolve(__dirname, 'mobile.html'),
        // Standalone same-origin frame document for isolated mermaid rendering.
        mermaidFrame: resolve(__dirname, 'mermaid-frame.html'),
        // Isolated frame that runs the background-removal model (needs 'unsafe-eval').
        bgRemovalFrame: resolve(__dirname, 'bg-removal-frame.html'),
      },
    },
  },
});
