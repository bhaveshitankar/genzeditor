import { unzipSync, strFromU8 } from 'fflate';
import type { DocEditor } from './registry';

export class PresentationView implements DocEditor {
  private host: HTMLElement;

  private constructor(host: HTMLElement) {
    this.host = host;
  }

  static async open(host: HTMLElement, blob: Blob): Promise<PresentationView> {
    const view = new PresentationView(host);
    await view.render(blob);
    return view;
  }

  destroy(): void {
    // No-op: host clears DOM itself
  }

  async export(): Promise<null> {
    return null;
  }

  private async render(blob: Blob): Promise<void> {
    this.host.innerHTML = '';

    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const files = unzipSync(bytes);

      // Find slide files
      interface SlideEntry {
        num: number;
        content: Uint8Array;
      }
      const slides: SlideEntry[] = [];

      for (const [path, content] of Object.entries(files)) {
        const match = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        if (match && match[1]) {
          slides.push({ num: parseInt(match[1], 10), content });
        }
      }

      if (slides.length === 0) {
        this.renderEmpty();
        return;
      }

      // Sort by slide number
      slides.sort((a, b) => a.num - b.num);

      // Header note
      const note = document.createElement('div');
      note.className = 'pptx-note';
      note.textContent =
        'PowerPoint files are shown as a read-only text outline. Editing .pptx is not supported.';
      this.host.appendChild(note);

      // Render each slide
      for (const slide of slides) {
        this.renderSlide(slide.num, slide.content);
      }
    } catch (err) {
      console.error('Failed to parse presentation:', err);
      this.renderEmpty();
    }
  }

  private renderSlide(slideNum: number, content: Uint8Array): void {
    const xml = strFromU8(content);
    const textLines = this.extractText(xml);

    const card = document.createElement('div');
    card.className = 'pptx-slide';

    const badge = document.createElement('div');
    badge.className = 'pptx-slide-num';
    badge.textContent = `Slide ${slideNum}`;
    card.appendChild(badge);

    if (textLines.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pptx-line';
      empty.textContent = '(no text)';
      empty.style.fontStyle = 'italic';
      empty.style.color = '#999';
      card.appendChild(empty);
    } else {
      for (const line of textLines) {
        const p = document.createElement('p');
        p.className = 'pptx-line';
        p.textContent = line;
        card.appendChild(p);
      }
    }

    this.host.appendChild(card);
  }

  private extractText(xml: string): string[] {
    const lines: string[] = [];
    const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(xml)) !== null) {
      if (match[1]) {
        const decoded = this.decodeXmlEntities(match[1]);
        const trimmed = decoded.trim();
        if (trimmed) {
          lines.push(trimmed);
        }
      }
    }

    return lines;
  }

  private decodeXmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  private renderEmpty(): void {
    const empty = document.createElement('div');
    empty.className = 'pptx-empty';
    empty.textContent =
      'Unable to read this presentation file. Legacy .ppt (binary format) is not supported; only .pptx files can be viewed.';
    this.host.appendChild(empty);
  }
}
