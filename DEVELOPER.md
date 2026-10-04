# GenZ Editor — Developer Guide

A privacy-first, in-browser "edit anything" app. Files open and edit entirely on
the user's device (OPFS); an optional Cloudflare Worker backend powers sharing,
auth, and live collaboration. Front end is a dependency-light Vite + TypeScript
SPA; most heavy editor dependencies are lazy-loaded from a CDN.

---

## 1. Prerequisites

- **Node.js** 20+ and npm
- A **Cloudflare** account (only for deploying / running the Worker backend)
- Modern Chromium/Firefox/Safari for testing (OPFS + File System APIs)

## 2. Quick start

```bash
npm install
npm run dev          # Vite dev server (front end only; sharing/auth need the Worker)
```

Open the printed localhost URL. The front end works standalone — upload a file and
edit. Sharing, sign-in, and live game rooms require the Worker (see §6).

## 3. npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server (HMR) |
| `npm run build` | Production build to `dist/` (esbuild; does **not** type-check) |
| `npm run preview` | Serve the built `dist/` locally |
| `npm test` | Vitest unit tests |
| `npx tsc --noEmit` | Strict type-check (run this before pushing) |
| `npm run deploy` | Build + deploy to Cloudflare Pages |

> `tsc --noEmit` currently reports 3 pre-existing errors in
> `src/editors/floorplan/view3d.ts` — Three.js is loaded from a CDN with no local
> types. These are expected; everything else should be clean.

## 4. Project structure

```
src/
  main.ts                 # entry; mounts AppShell, imports app.css
  shell/AppShell.ts       # the app shell: ribbon, left rail, files panel,
                          #   inspector, file CRUD, editor dispatch, sharing
  detect/fileKind.ts      # extension/MIME → FileKind
  editors/
    registry.ts           # FileKind → EditorKind (editorKindFor) + DocEditor type
    TextEditor.ts         # CodeMirror text/code/json/markdown/mermaid
    ImageEditor.ts        # canvas image editor (crop/brush/filters/bg-removal)
    SpreadsheetEditor.ts  # grid + formula engine + selection/undo
    PdfEditor.ts          # pdf.js render + pdf-lib edit, OCR, Save as DOCX
    DocxEditor.ts         # contenteditable Word editor, Save as PDF
    AudioEditor.ts, VideoEditor.ts, SketchEditor.ts, GameEditor.ts,
    FloorPlanEditor.ts, PresentationView.ts
    undoKeys.ts           # shared Cmd/Ctrl+Z / redo keyboard helper
    styles/*.css          # one stylesheet per editor (imported by that editor)
  store/opfs.ts           # FileStore: Origin-Private File System persistence
  theme/themes.ts         # theme tokens + switcher
  share/, api/, auth/     # sharing flow, Worker API client, auth UI
  styles/app.css          # global tokens + shell + spreadsheet/docx styling
worker/
  src/index.ts, router.ts # Hono-style Worker: shares, auth, quota, game rooms
  src/gameRoom.ts         # GameRoom Durable Object (live co-build/play)
  wrangler.toml           # Worker config (public vars only; secrets via .dev.vars)
```

## 5. Core concepts

### The `DocEditor` contract (`src/editors/registry.ts`)
Every rich editor implements:

```ts
interface DocEditor {
  export(): Promise<{ blob: Blob; contentType: string } | null>;
  destroy(): void;
}
// plus a static: open(host, blob, onChange, name?) => Promise<Editor>
```

`AppShell.openFile()` maps a file's `kind` → `EditorKind` via `editorKindFor()`,
then mounts the matching editor into the editor host, or renders a text editor /
binary preview. `export()` is used for autosave, download, and share.

### Adding a new editor
1. Create `src/editors/MyEditor.ts` with `static open()` + `export()` + `destroy()`.
2. Add its CSS at `src/editors/styles/my.css` and `import './styles/my.css'` at the
   top of the editor (keeps styles scoped; `app.css` stays the shell's).
3. Add the `FileKind` in `src/store/types.ts`, map the extension in
   `src/detect/fileKind.ts`, and map kind → editor in `src/editors/registry.ts`.
4. Add a dispatch branch in `AppShell.openFile()` and (optionally) a
   `NEW_FILE_TEMPLATES` entry + icon in `AppShell`.
5. If the editor has undo/redo, wire keyboard via `bindUndoKeys()` from
   `editors/undoKeys.ts` and clean it up in `destroy()`.

### UI shell (Power BI–style)
`AppShell` renders a **ribbon** (brand + grouped command bar + global actions),
a **left icon rail** (Files/New/Upload/Details), a dockable **files panel** with
search, and a right **inspector** (file name/meta + Save/Download/Share). Panels
collapse via `.app-shell.files-collapsed` / `.inspector-collapsed`; mobile turns
the files panel into an off-canvas drawer and the inspector into a bottom sheet.
Styling is token-driven in `src/styles/app.css` (`--brand-500`, `--ink`, `--r-*`,
`--shadow-pop`, …) — retune tokens to re-skin the whole app.

### Lazy CDN dependencies & CSP
Heavy deps (ffmpeg.wasm, Three.js, tesseract.js, bg-removal, mp3 encoder, fonts)
are dynamically imported from CDNs (`esm.sh`, `cdn.jsdelivr.net`, `staticimg.ly`).
These hosts are allow-listed in `public/_headers` (`script-src` / `connect-src` /
`font-src`). **If you add a CDN import, update `public/_headers` or it will be
blocked by CSP.**

## 6. Worker backend (optional for local dev)

```bash
cd worker
cp .dev.vars.example .dev.vars    # fill in secret VALUES locally (gitignored)
npx wrangler dev                  # run the Worker locally
```

- Public config lives in `worker/wrangler.toml` (`ALLOWED_ORIGIN`, `API_BASE_URL`,
  D1 binding, GameRoom Durable Object).
- **Secrets are never committed.** Provide them via `worker/.dev.vars` locally and
  `wrangler secret put <NAME>` in production. Required names (see
  `.dev.vars.example`): `FILEBASE_KEY`, `FILEBASE_SECRET`, `FILEBASE_BUCKET`,
  `FILEBASE_ENDPOINT`, `FILEBASE_REGION`, `IP_HASH_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
- The client's API base is in `src/api/client.ts` and must match the Worker's
  `API_BASE_URL`.

## 7. Deployment

```bash
# Front end (Cloudflare Pages)
npm run build
npx wrangler pages deploy dist --project-name <project>

# Worker
cd worker && npx wrangler deploy
```

Deploys need `CLOUDFLARE_API_TOKEN` in the environment for non-interactive auth,
or a prior `wrangler login`. After deploying the Worker, reconcile `API_BASE_URL`
in `wrangler.toml` and the CSP `connect-src` in `public/_headers` with the real
Worker URL.

## 8. Testing

- Unit tests: `npm test` (Vitest) — see `tests/` and `worker/test/`.
- Before pushing: `npx tsc --noEmit` and `npm run build` should both pass.
- Manual/E2E: the app is easy to drive with Playwright against `npm run preview`
  (upload a sample file, exercise the editor). Keep throwaway scripts out of git.

## 9. Conventions

- Match surrounding code style; keep editor styles in the editor's own CSS file.
- No secrets in the repo. `cloudflare_secrets.txt`, `filebase_secrets.txt`,
  `.dev.vars`, and `.env.local` are gitignored — keep it that way.
- Prefer lazy-loading heavy editor deps; update `public/_headers` for new CDNs.
- Editors must clean up listeners/object URLs in `destroy()` (AppShell calls it on
  every file switch).
