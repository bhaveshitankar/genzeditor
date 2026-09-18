export function mount(root: HTMLElement): void {
  const header = document.createElement('header');
  header.textContent = 'AnyEdits';
  root.appendChild(header);
}

const el = typeof document !== 'undefined' && document.getElementById('app');
if (el) mount(el);
