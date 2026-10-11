// A stand-in for `@xterm/xterm` and `@xterm/addon-web-links` in a mounted
// fixture (board #335 ③a): it paints nothing and records what it was asked to
// write, so a test can see WHICH terminal a frame reached. The mount tier
// cannot paint (docs/conventions/testing.md §3); claims about rendering stay
// with the browser fixture.
type Disposable = { dispose(): void };
const disposable = (): Disposable => ({ dispose() {} });

/** Every terminal built in this realm, in order. */
export const terminals: StandInTerminal[] = [];
(globalThis as { __xterms?: StandInTerminal[] }).__xterms = terminals;

export class StandInTerminal {
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  element: HTMLElement | null = null;
  /** Everything `write` was given, concatenated. */
  written = '';
  disposed = false;
  buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorX: 0, cursorY: 0, getLine: () => undefined } };

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
    this.cols = Number(options.cols) || 80;
    this.rows = Number(options.rows) || 24;
    terminals.push(this);
  }
  open(el: HTMLElement) { this.element = el; }
  loadAddon() {}
  write(data: string, done?: () => void) { this.written += data; done?.(); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  onData() { return disposable(); }
  onRender() { return disposable(); }
  onScroll() { return disposable(); }
  onSelectionChange() { return disposable(); }
  attachCustomKeyEventHandler() {}
  select() {}
  scrollToLine() {}
  scrollToBottom() {}
  scrollLines() {}
  refresh() {}
  focus() {}
  clearSelection() {}
  hasSelection() { return false; }
  getSelection() { return ''; }
  getSelectionPosition() { return undefined; }
  dispose() { this.disposed = true; }
}

export { StandInTerminal as Terminal };

export class WebLinksAddon {
  activate() {}
  dispose() {}
}
