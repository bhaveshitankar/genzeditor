import './styles/app.css';
import { FileStore, OpfsAdapter } from './store/opfs';
import { AppShell } from './shell/AppShell';

export async function mount(root: HTMLElement): Promise<void> {
  const store = new FileStore(new OpfsAdapter());
  const shell = new AppShell(root, store);
  await shell.refreshLibrary();
}

const el = typeof document !== 'undefined' && document.getElementById('app');
if (el) mount(el);
