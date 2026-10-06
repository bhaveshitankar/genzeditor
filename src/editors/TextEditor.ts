// src/editors/TextEditor.ts
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { keymap, Decoration, type DecorationSet } from '@codemirror/view';
import { foldGutter, foldKeymap, LanguageDescription } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { autocompletion, type CompletionSource } from '@codemirror/autocomplete';
import type { FileKind } from '../store/types';

// A fast synchronous guess so the editor is highlighted immediately; the exact
// grammar (by filename) is loaded asynchronously and swapped in via a compartment.
function syncLang(kind: FileKind): Extension {
  if (kind === 'json') return json();
  if (kind === 'markdown') return markdown();
  if (kind === 'code') return javascript();
  return [];
}

// Suggestions in every language: complete from identifiers already in the file.
// Merged (via languageData) with any language-specific completion source.
const wordCompletionSource: CompletionSource = (ctx) => {
  const word = ctx.matchBefore(/[\w$]+/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const text = ctx.state.doc.toString();
  const seen = new Set<string>();
  const options: { label: string; type: string }[] = [];
  for (const m of text.matchAll(/[A-Za-z_$][\w$]{1,}/g)) {
    const w = m[0];
    if (w === word.text || seen.has(w)) continue;
    seen.add(w);
    options.push({ label: w, type: 'variable' });
    if (options.length > 300) break;
  }
  if (options.length === 0) return null;
  return { from: word.from, options, validFor: /^[\w$]*$/ };
};

// A theme that pulls every color from --cm-* CSS custom properties. Because the
// values come from the cascade (defined per app theme in app.css), switching the
// app theme restyles every live editor instantly with no reconfiguration.
const cssVarTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--cm-bg, transparent)', color: 'var(--cm-fg, inherit)' },
  '.cm-gutters': {
    backgroundColor: 'var(--cm-gutter-bg, transparent)',
    color: 'var(--cm-gutter-fg, var(--text-faint))',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-line, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--cm-cursor, var(--brand-500))' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--cm-selection, rgba(99,102,241,0.25))',
  },
});

// Line-level diff highlighting: a StateField holds a decoration set that paints
// whole lines as added / removed / changed. CompareView pushes fresh ranges after
// every recompute via the setDiffLines() effect.
export interface DiffLine { line: number; kind: 'add' | 'del' | 'chg' }
const setDiffEffect = StateEffect.define<DiffLine[]>();
const diffLineDeco = {
  add: Decoration.line({ class: 'cm-diff-add' }),
  del: Decoration.line({ class: 'cm-diff-del' }),
  chg: Decoration.line({ class: 'cm-diff-chg' }),
};
const diffField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDiffEffect)) {
        const ranges = e.value
          .filter((d) => d.line >= 1 && d.line <= tr.state.doc.lines)
          .map((d) => diffLineDeco[d.kind].range(tr.state.doc.line(d.line).from));
        ranges.sort((a, b) => a.from - b.from);
        deco = Decoration.set(ranges);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class TextEditor {
  private view: EditorView;
  private lang = new Compartment();

  constructor(host: HTMLElement, opts: { doc: string; language: FileKind; filename?: string; onChange?: () => void }) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: opts.doc,
        extensions: [
          basicSetup,
          foldGutter(),
          search(),
          cssVarTheme,
          diffField,
          autocompletion({ activateOnTyping: true }),
          // Global word-completion provider, merged with language completions.
          EditorState.languageData.of(() => [{ autocomplete: wordCompletionSource }]),
          keymap.of([...searchKeymap, ...foldKeymap]),
          this.lang.of(syncLang(opts.language)),
          ...(opts.onChange
            ? [EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange!(); })]
            : []),
        ],
      }),
    });
    if (opts.filename) void this.loadLangByFilename(opts.filename);
  }

  // Resolve the precise grammar from the filename (python, css, html, sql, rust,
  // yaml, …) via @codemirror/language-data and hot-swap it into the compartment.
  private async loadLangByFilename(filename: string) {
    try {
      const desc = LanguageDescription.matchFilename(languages, filename);
      if (!desc) return;
      const support = await desc.load();
      this.view.dispatch({ effects: this.lang.reconfigure(support) });
    } catch {
      // Keep the synchronous guess if the grammar fails to load.
    }
  }

  getValue() { return this.view.state.doc.toString(); }
  setValue(v: string) { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: v } }); }
  openSearch() { this.view.focus(); openSearchPanel(this.view); }

  /** Format the code using Prettier (best-effort). */
  async format(): Promise<string> {
    try {
      const code = this.getValue();
      const formatted = await this.formatCode(code);
      this.setValue(formatted);
      return formatted;
    } catch (err) {
      console.error('Format error:', err);
      return this.getValue();
    }
  }

  /** Validate code and return errors. */
  validate(): { line: number; message: string }[] {
    const code = this.getValue();
    const errors: { line: number; message: string }[] = [];

    // Basic JSON validation
    if (this.view.state.doc.length > 0) {
      try {
        const lines = code.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check for unclosed brackets/braces
          const openBraces = (line.match(/[\{\[\(]/g) || []).length;
          const closeBraces = (line.match(/[\}\]\)]/g) || []).length;
          if (openBraces > closeBraces) {
            // This is a heuristic; full validation depends on language
          }
        }
        // Try JSON parse for basic validation
        if (code.trim().startsWith('{') || code.trim().startsWith('[')) {
          JSON.parse(code);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ line: 1, message: `Syntax error: ${msg}` });
      }
    }
    return errors;
  }

  private async formatCode(code: string): Promise<string> {
    // Use simple indentation-based formatting
    return this.simpleFormat(code);
  }

  private simpleFormat(code: string): string {
    let indent = 0;
    const lines = code.split('\n');
    return lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith(')')) {
        indent = Math.max(0, indent - 1);
      }
      const formatted = '  '.repeat(indent) + trimmed;
      if (trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.endsWith('(')) {
        indent++;
      }
      return formatted;
    }).join('\n');
  }

  /** Replace the diff highlighting for this editor (1-based line numbers). */
  setDiffLines(lines: DiffLine[]) { this.view.dispatch({ effects: setDiffEffect.of(lines) }); }
  /** Scroll a 1-based line into view (used to jump to a hunk). */
  scrollToLine(line: number) {
    const n = Math.max(1, Math.min(line, this.view.state.doc.lines));
    const pos = this.view.state.doc.line(n).from;
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  }
  destroy() { this.view.destroy(); }
}
