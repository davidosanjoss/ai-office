// Um xterm por agente, criado na primeira vez que ele é aberto e mantido em memória.

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

interface Term {
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  /** Até o replay chegar, a saída ao vivo já está contida nele e é descartada. */
  ready: boolean;
}

const THEME = {
  background: '#16161e',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: '#33467c',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

export interface TerminalIO {
  attach(id: string): void;
  input(id: string, data: string): void;
  /** Tecla ou colagem feita por você (não conta respostas automáticas do terminal). */
  userActivity(id: string): void;
  resize(id: string, cols: number, rows: number): void;
}

export class Terminals {
  private terms = new Map<string, Term>();
  private active?: string;

  constructor(private host: HTMLElement, private io: TerminalIO) {
    new ResizeObserver(() => this.fitActive()).observe(host);
  }

  show(id: string) {
    let t = this.terms.get(id);
    if (!t) t = this.create(id);
    for (const [key, other] of this.terms) other.el.hidden = key !== id;
    this.active = id;
    requestAnimationFrame(() => {
      this.fitActive();
      t.term.focus();
    });
  }

  hideAll() {
    for (const t of this.terms.values()) t.el.hidden = true;
    this.active = undefined;
  }

  private create(id: string): Term {
    const el = document.createElement('div');
    el.className = 'term';
    this.host.appendChild(el);
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      theme: THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    term.onData((data) => this.io.input(id, data));
    term.onKey(() => this.io.userActivity(id));
    term.textarea?.addEventListener('paste', () => this.io.userActivity(id));
    term.onResize(({ cols, rows }) => this.io.resize(id, cols, rows));
    // Ctrl+Shift+C / Ctrl+Shift+V como em terminais Linux; Ctrl+C continua indo para o Claude.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC') {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (e.code === 'KeyV') {
        navigator.clipboard.readText().then((text) => term.paste(text));
        return false;
      }
      return true;
    });

    const t: Term = { term, fit, el, ready: false };
    this.terms.set(id, t);
    this.io.attach(id);
    return t;
  }

  replay(id: string, data: string) {
    const t = this.terms.get(id);
    if (!t) return;
    t.term.reset();
    t.term.write(data);
    t.ready = true;
    if (id === this.active) this.fitActive(true);
  }

  output(id: string, data: string) {
    const t = this.terms.get(id);
    if (t?.ready) t.term.write(data);
  }

  /** Depois de reconectar ao servidor: pede o histórico de novo para todos. */
  reattachAll() {
    for (const [id, t] of this.terms) {
      t.ready = false;
      this.io.attach(id);
    }
  }

  remove(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    t.term.dispose();
    t.el.remove();
    this.terms.delete(id);
    if (this.active === id) this.active = undefined;
  }

  private fitActive(forceResize = false) {
    if (!this.active) return;
    const t = this.terms.get(this.active);
    if (!t || t.el.hidden || !t.el.clientWidth) return;
    const before = `${t.term.cols}x${t.term.rows}`;
    t.fit.fit();
    // O PTY tem um só tamanho; quem estiver olhando define.
    if (forceResize || before === `${t.term.cols}x${t.term.rows}`) {
      this.io.resize(this.active, t.term.cols, t.term.rows);
    }
  }
}
