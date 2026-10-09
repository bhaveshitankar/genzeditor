// Keeps each range slider's --pct in sync so the CSS can paint the filled part
// of the track (WebKit has no ::-webkit-slider-progress). Delegated, so it also
// covers sliders created later; a MutationObserver handles initial render and
// programmatic value changes made at insert time.
import './controls.css';

function sync(el: HTMLInputElement): void {
  const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--pct', `${Math.min(100, Math.max(0, pct))}%`);
}
const isRange = (n: Node): n is HTMLInputElement => n instanceof HTMLInputElement && n.type === 'range';

export function initControls(): void {
  // Programmatic `input.value = x` fires no event; hook the setter so resets
  // and AI-applied values repaint the fill too.
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc?.set && desc.get) {
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true, enumerable: desc.enumerable,
      get: desc.get,
      set(this: HTMLInputElement, v: string) { desc.set!.call(this, v); if (this.type === 'range') sync(this); },
    });
  }
  document.addEventListener('input', (e) => { if (isRange(e.target as Node)) sync(e.target as HTMLInputElement); }, true);
  document.addEventListener('change', (e) => { if (isRange(e.target as Node)) sync(e.target as HTMLInputElement); }, true);
  const scan = (root: ParentNode) => root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(sync);
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => { if (isRange(n)) sync(n); else if (n instanceof Element) scan(n); });
      if (m.type === 'attributes' && isRange(m.target)) sync(m.target);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'min', 'max'] });
}
