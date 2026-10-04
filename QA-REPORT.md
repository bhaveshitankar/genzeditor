# GenZ Editor — QA Report

**Date:** 2026-10-04
**Tested build:** live — https://anyedits-aay.pages.dev/
**Method:** Playwright automation (desktop 1280×800 + mobile 390×780), driving the app
like an end user across 23 sample file types plus interaction flows (new-file kinds,
command palette, theme, select mode, spreadsheet editing). Screenshots + console/page
errors captured for each.

**Coverage:** text, json, xml, 1 MB text, docx, xlsx, pptx, odt, png, jpg, svg,
animated gif, tiff, ai, mp3, flac, mp4, avi, pdf, html, css, js, zip; plus New-file
for markdown/csv/game/floorplan/sketch.

Legend — severity: 🔴 critical (broken/data-loss/dead-end) · 🟠 major (blocks a normal
task) · 🟡 minor (polish / friction).

---

## 1. Bugs

### 🔴 B1 — SVG files open a blank, dead editor
Uploading `image.svg` routes to the **image editor**, which throws
`InvalidStateError: The source image could not be decoded.` The canvas is blank, **no
toast, no error message, and the inspector stays collapsed so there is no Download
button** — the user is stuck with a white screen and no way out.
*Fix:* SVG is text — route `.svg` to the text editor (editable XML) with an optional
rendered preview, or at minimum catch the decode failure and fall back to the binary
preview card with a Download.

### 🔴 B2 — TIFF files open a blank, dead editor
Same failure as SVG: `.tiff` → image editor → `source image could not be decoded`
(browsers can't natively decode TIFF). Blank canvas, no message, no actions.
*Fix:* Detect undecodable images and fall back to the binary preview ("can't preview —
download") instead of a blank editor. Consider a client-side TIFF decoder if TIFF
editing is a goal.

### 🟠 B3 — `.xml` is misclassified as binary (not previewable)
XML is plain text but opens the **"This file type can't be previewed or edited here"**
card. Users can't read or edit XML, which is a core text format. (Likely affects other
text-ish extensions too — e.g. `rss.xml`, `.xsd`.)
*Fix:* Add `xml` (and `svg`, `xsd`, etc.) to the text editor routing in the file-kind
detector.

### 🟠 B4 — AVI opens the video editor but is unplayable → looks broken
`sample.avi` loads the full video editor, but the preview is black and the timeline
reads `0:00 / 0:00` (AVI isn't a browser-playable container). The user sees a complete
editing UI that does nothing.
*Fix:* On `loadedmetadata`/error with 0 duration or unsupported codec, show a clear
"This video format can't be played in the browser — download to view" state instead of
a dead editor. (Same risk for `.wmv`, `.flv`, `.mpg`, `.mkv`, `.mov` depending on codec.)

### 🟡 B5 — Stray empty "EDIT" ribbon group on most editors
The ribbon shows an **"EDIT" group label with no buttons under it** for every editor
that keeps its tools in its own body toolbar (image, docx, xlsx, pdf, audio, video,
game, floorplan, sketch). Only text/markdown/mermaid actually populate it. The empty
label is visual noise and implies missing controls.
*Fix:* Only reveal the EDIT group when `editor-tools` actually has children.

### 🟡 B6 — Toasts stack / linger across file switches
Rapidly opening files leaves old toasts visible (observed "Opened sample.pdf | Opened
sample.html" at once). Minor, but looks glitchy during quick navigation.
*Fix:* Cap concurrent toasts or dismiss the previous "Opened…" toast on a new open.

---

## 2. Design issues (over-complicated / inconsistent)

### 🟠 D1 — Editor toolbars get clipped behind the inspector
Wide in-editor toolbars overflow **underneath the right inspector panel**. The PDF
toolbar's "Circle" button is half-hidden; Excalidraw's right-edge tool strip (library /
lock / hand) is clipped. The toolbars don't know the inspector is occupying space.
*Fix:* Make editor body toolbars horizontally scrollable, or ensure the editor area
reserves width for the open inspector (it's a flex sibling, so the third-party canvases
that position their own absolute toolbars need the available width recomputed).

### 🟠 D2 — Two competing "properties" panels (inspector vs. editor's own)
The floorplan editor ships its **own "Properties" column** (Wall defaults, etc.) while
the global **Inspector** sits right beside it showing file actions. Two property-looking
panels side by side is confusing after the Power BI redesign — the user can't tell which
is "the" panel. Sketch has a similar collision (its right rail vs. the inspector).
*Fix:* Decide one home for contextual properties. Ideally editors push their
context controls **into the global inspector** (that was the Power BI promise), so there
is a single right-hand properties surface instead of nested ones.

### 🟡 D3 — Inconsistent placement of file actions
Text/image/doc editors put **Save/Download/Share in the inspector**, but
**binary-preview files put a lone "Download" button in a top bar** and leave the
inspector collapsed/empty. Same action, two different locations depending on file type.
*Fix:* Route binary files' Download (and Share, if applicable) through the inspector too,
for one consistent actions location.

### 🟡 D4 — Unsupported office formats are a hard dead-end
`.odt`, `.ods`, `.odp`, `.doc`, `.ppt`, `.xls` (older/OpenDocument) all fall to "can't
preview." For an "edit anything" tool that's a notable gap and gives no hint that the
`.docx/.xlsx/.pptx` equivalents *are* supported.
*Fix:* At least message "Open-Document / legacy Office formats aren't supported yet — try
.docx/.xlsx/.pptx," or add conversion.

---

## 3. Missing features

### 🔴 M1 — Spreadsheet has no formulas
Typing `=1+2` stores the literal text `=1+2`; it is never evaluated. For anything
spreadsheet-shaped this is the #1 expectation. No `=SUM()`, no cell references, no
recalculation.
*Fix:* Add a formula engine (at least arithmetic + SUM/AVERAGE/COUNT and A1 references).

### 🟠 M2 — Spreadsheet: no "Select all" / range / row-column selection
(The user's explicit example.) `Ctrl+A` does nothing; clicking a column header (A/B/C)
or row number doesn't select the column/row; there's no drag-to-select range, no
copy/paste of a block, no fill-down. Editing is strictly one cell at a time.
*Fix:* Add range selection (drag + Shift+arrows), `Ctrl+A` select-all, header-click to
select whole column/row, and block copy/paste.

### 🟠 M3 — File list: no "Select all" in Select mode
Select mode only offers "0 selected / Cancel / Delete" — there is **no Select-all**
checkbox, so deleting many files means ticking each one.
*Fix:* Add a "Select all" control to the selection bar.

### 🟠 M4 — No way to rename a file
Files can be opened and deleted, but **not renamed** — not from the list, not from the
inspector (which shows the name as static text). Users are stuck with "Untitled.txt".
*Fix:* Make the inspector's file name editable (or add a Rename action / double-click to
rename in the list).

### 🟡 M5 — Spreadsheet: no formatting / sort / filter / resize
No bold/number formats/cell color, no sort or filter, no column/row resize, no
visible undo/redo. Expected for a tool compared to Excel.

### 🟡 M6 — Command palette is thin
`⌘K` offers only: New file, Upload, Find, Format JSON, Toggle preview, Compare. Missing
obvious high-value commands: **Save, Download, Share, Delete, Rename, Switch theme,
Toggle fullscreen, jump-to-file by name.** The palette is the natural "power user" entry
point and under-delivers.
*Fix:* Register the file actions + navigation (open file by fuzzy name) as palette
commands.

### 🟡 M7 — No file organization
No folders, tags, sort (by name/size/date), or file metadata (created/modified date) in
the list. Fine for a few files, painful as the library grows.

---

## Priority recommendation

1. **Fix the dead-ends first (B1, B2, B3, B4):** blank/unusable screens are the worst UX
   — a user who drops an SVG, TIFF, XML, or AVI currently hits a wall with no exit.
2. **Spreadsheet credibility (M1, M2):** formulas + select-all/range are table stakes if
   the tool wants to be taken seriously for data.
3. **Core file management (M3, M4):** select-all + rename are cheap, high-impact wins.
4. **Inspector consistency (D1, D2, D3):** finish the Power BI promise — one properties
   surface, no clipped toolbars, consistent action placement.
5. **Polish (B5, B6, M6):** empty EDIT label, toast stacking, richer palette.

---

*Screenshots for every case are in `/tmp/qa/` (per-file `<tag>.png`, interactions
`i-*.png`). Console/page errors were clean except the SVG/TIFF decode errors noted in
B1/B2.*

---

# Appendix A — Deep pass: undo/redo + PDF editor (2026-10-04)

Second, deeper pass focused on `Ctrl/Cmd+Z` across every editor and the PDF editor
(clarity + OCR). Behavior verified live and root-caused against source.

## 4. Undo / redo (🔴 inconsistent across the whole app)

`Ctrl/Cmd+Z` is wired per-editor with no shared convention, so a user can't trust it
anywhere. Verified matrix:

| Editor | Cmd+Z (keyboard) | Undo button | Notes |
|---|---|---|---|
| Text / JSON / code / Markdown / Mermaid | ✅ works | — | CodeMirror native |
| Sketch (Excalidraw) | ✅ works | ✅ | library native |
| DOCX | ⚠️ typing only | — | contenteditable native; **formatting (B/I/U, headings, lists) is not reliably undoable** |
| PDF | ⚠️ **intermittent** | ✅ | see B9 |
| Image | ❌ **ignored** | ✅ | keyboard not wired — must use the Undo button |
| Audio | ❌ **ignored** | ✅ | keyboard not wired |
| Floor plan | ❌ **ignored** | ✅ | keyboard not wired |
| Game | ❌ **ignored** | ✅ | keyboard not wired |
| Spreadsheet | ❌ **none** | ❌ **none** | no history at all — see B7 |
| Video | ❌ none | ❌ none | destructive/export model |

### 🔴 B7 — Spreadsheet has no undo of any kind
There is no history stack. A mistaken edit, or **Delete Row / Delete Col, is
unrecoverable** — `Cmd+Z` does nothing and there is no Undo button. (A single focused
cell may native-undo its own text while still being edited, which misleadingly *looks*
like undo, but committing with Enter or clicking away loses that.) For a spreadsheet this
is a data-loss risk.
*Fix:* Add an undo/redo stack covering cell edits and structural row/col operations.

### 🟠 B8 — Image / Audio / Floor plan / Game ignore `Cmd+Z`
These editors ship an Undo button but **never listen for the keyboard shortcut**, so the
muscle-memory `Cmd+Z` silently does nothing. This is the user-reported "in some cases
Ctrl/Cmd+Z doesn't work."
*Fix:* Wire `Cmd/Ctrl+Z` (and `Cmd/Ctrl+Shift+Z` / `Ctrl+Y` for redo) to the existing
undo/redo methods in each editor. Best solved with one shared keyboard helper so every
editor behaves identically.

### 🟠 B9 — PDF undo/redo is focus-scoped and drops out
PDF *does* wire `Cmd+Z` / `Cmd+Shift+Z`, but the listener is attached to the PDF host
element (`tabIndex=0`), not the window. After you click a toolbar button or the page
loses focus, keystrokes no longer reach the handler and `Cmd+Z` stops working until you
click back into the page area — intermittent and confusing.
*Fix:* Listen at window level while the editor is mounted (and still ignore when a text
field is focused), or refocus the host after toolbar actions.

### 🟡 B10 — DOCX formatting actions aren't undoable
Typing can be undone (browser native), but applying Bold/Heading/List via the toolbar
often can't be reversed with `Cmd+Z`.
*Fix:* Route formatting through `document.execCommand` consistently (so it joins the
native undo stack) or maintain an explicit history.

## 5. PDF editor — clarity & OCR

### 🟠 B11 — PDF pages render blurry on hi-DPI / Retina screens
`paintPage()` sizes the canvas backing store to CSS pixels
(`canvas.width = viewport.width`) with **no `devicePixelRatio` multiplier**, then
displays it at the same CSS width. On a DPR-2 display every page (and its text) is
upscaled ~2× → soft/blurry. Zooming in re-renders at the new width but still at DPR 1, so
it never gets crisp.
*Fix:* Render at `width * devicePixelRatio` for the backing store and set the canvas CSS
width to the logical width (standard pdf.js hi-DPI pattern). Apply the same to the
thumbnail and OCR render paths.

### 🟠 B12 — OCR re-OCRs pages that already have real text
`OCR text` runs Tesseract on any page with no guard for an existing text layer. On a
normal (already-selectable) PDF it **overlays a second, OCR-generated copy of the text**
on top of the real text — duplicated/misaligned words and a heavier file. (Observed: OCR
reported "✓" on a vector PDF with no text, silently adding empty annotations.)
*Fix:* Skip or warn when `getTextContent()` already returns text; reserve OCR for
image-only/scanned pages.

### 🟡 B13 — OCR is English-only, per-page, and renders at a low cap
The worker is hardcoded to `eng` (no language picker), OCR is one page at a time (no
"OCR all pages"), and the OCR render is capped at `scale = min(2.0, 2000/pageWidth)`,
which for large or dense scans can be too low-res for accurate recognition.
*Fix:* Add a language selector, an all-pages option, and raise/auto-tune the OCR render
resolution for better accuracy.

### 🟡 B14 — PDF toolbar overflows under the inspector (re: D1)
Re-confirmed at multiple zoom levels: the "Circle" tool (and anything past it) is clipped
behind the open inspector because the toolbar row neither wraps nor scrolls. Same clash
hits the Excalidraw right-edge tool strip.
*Fix:* as D1 — make editor toolbars scroll/wrap within the available width.

## Updated priority

The undo/redo inconsistency (B7–B10) is the highest-impact addition — it breaks a
universal expectation across most editors and risks real data loss in the spreadsheet.
Then PDF clarity (B11) and OCR correctness (B12), which are the user-reported PDF pains.
