export interface Command {
  id: string;
  label: string;
  run: () => void;
}

export class CommandPalette {
  private overlay!: HTMLElement;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private filteredCommands: Command[] = [];
  private selectedIndex = 0;

  constructor(private root: HTMLElement, private commands: Command[]) {
    this.render();
    this.wireEvents();
  }

  private render() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'command-palette-overlay';
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = `
      <div class="command-palette">
        <input type="text" placeholder="Type a command..." aria-label="Command search">
        <ul role="listbox"></ul>
      </div>
    `;
    this.root.appendChild(this.overlay);
    this.input = this.overlay.querySelector('input')!;
    this.list = this.overlay.querySelector('ul')!;
  }

  private wireEvents() {
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.input.addEventListener('input', () => this.filter());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredCommands.length - 1);
        this.renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.runSelected();
      }
    });
  }

  private filter() {
    const query = this.input.value.toLowerCase();
    this.filteredCommands = query
      ? this.commands.filter(cmd => cmd.label.toLowerCase().includes(query))
      : this.commands;
    this.selectedIndex = 0;
    this.renderList();
  }

  private renderList() {
    this.list.innerHTML = '';
    this.filteredCommands.forEach((cmd, i) => {
      const li = document.createElement('li');
      li.textContent = cmd.label;
      li.className = i === this.selectedIndex ? 'selected' : '';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.selectedIndex));
      li.addEventListener('click', () => {
        this.selectedIndex = i;
        this.runSelected();
      });
      this.list.appendChild(li);
    });
  }

  private runSelected() {
    const cmd = this.filteredCommands[this.selectedIndex];
    if (cmd) {
      this.close();
      cmd.run();
    }
  }

  /** Run a command by id (lets other UI reuse palette actions). */
  run(id: string): void {
    this.commands.find((c) => c.id === id)?.run();
  }

  open() {
    this.overlay.style.display = 'flex';
    this.input.value = '';
    this.filter();
    this.input.focus();
  }

  close() {
    this.overlay.style.display = 'none';
  }
}
