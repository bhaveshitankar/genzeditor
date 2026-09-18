// src/editors/TextEditor.ts
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { keymap } from '@codemirror/view';
import { foldGutter, foldKeymap } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import type { FileKind } from '../store/types';

function langFor(kind: FileKind): Extension[] {
  if (kind === 'json') return [json()];
  if (kind === 'code') return [javascript()];
  if (kind === 'markdown') return [markdown()];
  return [];
}

export class TextEditor {
  private view: EditorView;
  constructor(host: HTMLElement, opts: { doc: string; language: FileKind }) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: opts.doc,
        extensions: [basicSetup, foldGutter(), search(), keymap.of([...searchKeymap, ...foldKeymap]), ...langFor(opts.language)],
      }),
    });
  }
  getValue() { return this.view.state.doc.toString(); }
  setValue(v: string) { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: v } }); }
  openSearch() { this.view.focus(); openSearchPanel(this.view); }
  destroy() { this.view.destroy(); }
}
