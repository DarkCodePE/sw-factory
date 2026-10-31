import { createInterface, type Interface } from 'node:readline';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { completions } from './commands.ts';
import { terminalText } from './config.ts';
import type { ChatController, ChatIO } from './controller.ts';
import { TerminalPresentation, type StatusState } from './presentation.ts';
import type { FileChange } from './render.ts';
import { PasteDecoder } from './paste.ts';
import { renderPalette, suggestions, type PaletteEntry } from './palette.ts';
import { welcome as renderWelcome } from './chrome.ts';

/** Single input owner: abort removes the waiter, so the next prompt cannot satisfy an old permission. */
export class TerminalInput implements ChatIO {
  readonly rl: Interface;
  private relay = new PassThrough();
  private queue: string[] = [];
  private waiter?: { resolve(s: string): void; reject(e: Error): void; cleanup(): void };
  private ended = false;
  private prompt = '';
  private selection?: { choices: string[]; index: number };
  private escape = Buffer.alloc(0);
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private paste = new PasteDecoder();
  private substitutions = new Map<string, string>();
  private ownHistory: string[] = [];
  private historyIndex = 0;
  private historyDraft = '';
  private presenter: TerminalPresentation;
  private safeOutput: Writable;
  private pasteEnabled = false;
  private windowTimer?: ReturnType<typeof setInterval>;
  private paletteEntries: PaletteEntry[] = [];
  private paletteIndex = -1;
  private paletteLine = '';
  private paletteSuppressed?: string;
  private paletteTimer?: ReturnType<typeof setTimeout>;
  controller?: ChatController;
  onInterrupt?: () => void;
  onClose?: () => void;
  constructor(readonly input: Readable, readonly output: Writable, readonly terminal: boolean) {
    this.safeOutput = new Writable({ write: (chunk, _encoding, done) => {
      if (!output.destroyed) output.write(this.ansi ? chunk.toString().replace(/\x1b\[(?:0)?J/g, '\x1b[0K') : terminalText(chunk.toString()));
      done();
    } });
    Object.defineProperty(this.safeOutput, 'columns', { get: () => this.size().columns });
    this.presenter = new TerminalPresentation(output, () => this.size(), () => this.ansi);
    // Bun may drain an already-buffered stdin during createInterface. Attach our line
    // listeners before forwarding bytes, including piped /help\n/exit input.
    const source = input as Readable & { setRawMode?(mode: boolean): void };
    Object.assign(this.relay, { isTTY: terminal, setRawMode: (mode: boolean) => source.setRawMode?.(mode) });
    this.rl = createInterface({ input: this.relay, output: this.safeOutput, terminal, historySize: 100,
      completer: (line: string) => completions(line, this.controller?.modelIds, this.controller?.customCommands) });
    this.rl.on('line', this.line); this.rl.on('close', this.closed); this.rl.on('SIGINT', this.interrupt);
    input.on('end', this.end); input.on('error', this.error); input.on('data', this.forward);
    output.on('resize', this.resize);
    // Bun caches dimensions until SIGWINCH. PTY launchers may not forward that signal
    // to an inherited terminal, so also refresh the built-in ioctl cache while attached.
    if (terminal) { this.windowTimer = setInterval(this.refreshSize, 150); process.on('SIGWINCH', this.refreshSize); }
    input.resume();
  }
  private get ansi() { return this.terminal && this.controller?.config.theme !== 'plain'; }
  private size() { const out = this.output as Writable & { columns?: number; rows?: number }; return { columns: out.columns ?? 80, rows: out.rows ?? 24 }; }
  write(text: string) { this.safeOutput.write(text); }
  work(label?: string) { this.presenter.work(label); }
  assistant(text: string, final = false) { this.presenter.assistant(text, final); }
  diff(change: FileChange, expanded: boolean) { this.presenter.diff(change, expanded); }
  expand(expanded: boolean) {
    if (this.waiter && this.ansi) this.write('\r\x1b[2K');
    this.presenter.expand(expanded); this.redraw();
  }
  update(state: StatusState) {
    if (this.ansi !== this.pasteEnabled) { this.output.write(this.ansi ? '\x1b[?2004h' : '\x1b[?2004l'); this.pasteEnabled = this.ansi; }
    this.presenter.update(state); this.redraw();
  }
  welcome(tipIndex = Date.now() % 4) { if (this.controller) this.write(renderWelcome(this.size().columns, this.controller.resources, tipIndex)); }
  private rootQuestion() { return !!this.waiter && this.prompt.startsWith('fab [') && !this.selection && !this.controller?.busy; }
  private syncPalette() {
    const line = this.rl.line;
    if (line !== this.paletteLine) { this.paletteIndex = -1; this.paletteLine = line; }
    const entries = this.rootQuestion() && line !== this.paletteSuppressed ? suggestions(line, this.controller?.palette ?? []) : [];
    if (!entries.length && !this.paletteEntries.length) return;
    this.paletteEntries = entries;
    if (this.ansi) { this.write('\r\x1b[2K'); this.presenter.menu(renderPalette(entries, this.paletteIndex, this.size().columns)); this.redraw(); }
  }
  private closePalette() { this.paletteEntries = []; this.paletteIndex = -1; this.presenter.menu([]); }
  private completePalette() {
    const entry = this.paletteEntries[Math.max(0, this.paletteIndex)]; if (!entry) return;
    this.clearLine(); if (this.ansi) this.write('\r\x1b[2K'); this.closePalette(); this.rl.write(`/${entry.name} `); this.redraw();
  }
  private resize = () => { this.presenter.resize(); this.redraw(); };
  private refreshSize = () => (this.output as Writable & { _refreshSize?(): void })._refreshSize?.();
  private displayHistory(text: string) {
    if (!text.includes('\n')) return text;
    for (const [token, value] of this.substitutions) if (value === text) return token;
    const token = `⟦${crypto.randomUUID().slice(0, 8)}: ${text.replace(/\n/g, ' ↵ ').slice(0, 48)}⟧`;
    this.substitutions.set(token, text); return token;
  }
  setHistory(entries: string[]) {
    if (!this.waiter && !this.rl.line) this.substitutions.clear();
    this.ownHistory = entries.slice(-100).map(s => this.displayHistory(s));
    this.installHistory();
  }
  private installHistory() {
    (this.rl as Interface & { history: string[] }).history = this.ownHistory.slice().reverse();
  }
  private clearLine() {
    // Public readline state also works with Bun's TERM=dumb implementation,
    // where rl.write(null, {ctrl:true,name:'u'}) deliberately does nothing.
    Object.assign(this.rl, { line: '', cursor: 0 });
    if (this.waiter && this.ansi) this.redraw();
  }
  private line = (line: string) => {
    this.closePalette();
    for (const [token, text] of this.substitutions) if (line.includes(token)) line = line.replaceAll(token, text);
    this.installHistory(); this.presenter.pause(false);
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter.cleanup(); waiter.resolve(line); }
    else if (this.controller?.busy && line.trim().startsWith('/mission pause')) {
      void this.controller.submit(line).catch(e => this.controller?.print(e.message));
    }
    else if (this.queue.length < 100) this.queue.push(line);
    else this.close();
  };
  private closed = () => {
    this.ended = true;
    const waiter = this.waiter; this.waiter = undefined;
    if (waiter) { waiter.cleanup(); waiter.reject(new Error('Entrada cerrada')); }
    this.onClose?.();
    if (this.terminal) this.presenter.close();
  };
  private interrupt = () => this.onInterrupt?.();
  private end = () => {
    const last = this.paste.end(); if (last.length) this.forwardKeys(last);
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    if (this.escape.length) this.relay.write(this.escape);
    this.escape = Buffer.alloc(0); this.relay.end();
  };
  private error = (e: Error) => {
    const waiter = this.waiter; this.waiter = undefined;
    if (waiter) { waiter.cleanup(); waiter.reject(e); }
    this.controller?.interrupt(); this.close();
  };
  private forward = (data: Buffer | string) => {
    if (!this.terminal) { this.relay.write(data); return; }
    for (const event of this.paste.feed(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
      if (event.type === 'data') this.forwardKeys(event.data);
      else if (event.type === 'overflow') this.write('\nPegado descartado: máximo 256 KiB\n');
      else {
        const text = terminalText(event.text);
        if (this.substitutions.size >= 200) { this.write('\nDemasiados pegados en esta sesión\n'); continue; }
        this.rl.write(this.displayHistory(text));
      }
    }
    if (this.paletteTimer) clearTimeout(this.paletteTimer);
    this.paletteTimer = setTimeout(() => this.syncPalette(), 0);
  };
  private forwardKeys = (data: Buffer) => {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    const bytes = Buffer.concat([this.escape, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
    this.escape = Buffer.alloc(0);
    let start = 0, i = 0;
    while (i < bytes.length) {
      let key: { name: string; ctrl?: boolean; shift?: boolean } | undefined, width = 1;
      const b = bytes[i];
      if (b === 27 && (i + 1 === bytes.length || bytes[i + 1] === 91 && i + 2 === bytes.length)) {
        this.relay.write(bytes.subarray(start, i)); this.escape = Buffer.from(bytes.subarray(i));
        this.escapeTimer = setTimeout(() => {
          if (this.paletteEntries.length && this.escape.length === 1) { this.paletteSuppressed = this.rl.line; this.closePalette(); this.redraw(); }
          else this.relay.write(this.escape);
          this.escape = Buffer.alloc(0);
        }, 40); return;
      }
      if (b === 27 && bytes[i + 1] === 91) {
        if (bytes[i + 2] === 90) { key = { name: 'tab', shift: true }; width = 3; }
        else if ((this.selection || this.waiter && this.prompt.startsWith('fab ')) && [65, 66].includes(bytes[i + 2]!)) { key = { name: bytes[i + 2] === 65 ? 'up' : 'down' }; width = 3; }
      } else if ([12, 14, 15, 20].includes(b!)) key = { name: b === 12 ? 'l' : b === 14 ? 'n' : b === 15 ? 'o' : 't', ctrl: true };
      else if (b === 9 && this.rootQuestion()) key = { name: 'tab' };
      else if ([10, 13].includes(b!) && this.paletteEntries.length && this.paletteIndex >= 0 && this.rootQuestion()) { key = { name: 'accept' }; if (b === 13 && bytes[i + 1] === 10) width = 2; }
      if (key && (this.selection || this.controller && (!this.controller.busy || key.name === 'o' || key.name === 't'))) {
        this.relay.write(bytes.subarray(start, i)); this.syncPalette(); this.shortcut(key); i += width; start = i;
      } else i++;
    }
    this.relay.write(bytes.subarray(start));
  };
  private shortcut = (key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    if (this.selection && (key.name === 'up' || key.name === 'down')) {
      const menu = this.selection;
      menu.index = (menu.index + (key.name === 'down' ? 1 : -1) + menu.choices.length) % menu.choices.length;
      this.clearLine(); this.rl.write(String(menu.index + 1)); return;
    }
    if (this.paletteEntries.length && this.rootQuestion()) {
      if (key.name === 'up' || key.name === 'down') { this.paletteIndex = (this.paletteIndex + (key.name === 'down' ? 1 : -1) + this.paletteEntries.length) % this.paletteEntries.length; this.syncPalette(); return; }
      if (key.name === 'accept' || key.name === 'tab' && !key.shift) { this.completePalette(); return; }
    }
    if (key.name === 'up' || key.name === 'down') {
      if (this.historyIndex === this.ownHistory.length) this.historyDraft = this.rl.line;
      this.historyIndex = Math.max(0, Math.min(this.ownHistory.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.clearLine(); this.rl.write(this.ownHistory[this.historyIndex] ?? this.historyDraft); return;
    }
    const app = this.controller; if (!app) return;
    if (key.ctrl && key.name === 'o') { app.toggleDetail(); return; }
    if (key.ctrl && key.name === 't') { app.toggleMissionPanel(); return; }
    if (app.busy) return;
    if (key.name === 'tab' && !key.shift) {
      if (this.rl.line.startsWith('/')) {
        const [values] = completions(this.rl.line, app.modelIds, app.customCommands);
        if (values[0]) { this.clearLine(); this.rl.write(values[0]); this.redraw(); }
      } else app.cycleReasoning();
      return;
    }
    this.write('\r\n');
    let action: Promise<unknown> | void;
    if (key.name === 'tab' && key.shift) app.cycleMode();
    else if (key.ctrl && key.name === 'n') {
      const ids = app.modelIds, next = ids[(ids.indexOf(app.config.model) + 1) % ids.length]!;
      action = app.changeModel(next);
    } else if (key.ctrl && key.name === 'l') {
      const values = ['off', 'low', 'medium', 'high'], next = values[(values.indexOf(app.config.autonomy) + 1) % values.length]!;
      action = app.submit('/auto ' + next);
    }
    void Promise.resolve(action!).catch(e => app.print(e.message)).finally(() => this.redraw());
  };
  private redraw() {
    if (!this.waiter || !this.terminal) return;
    if (this.prompt.startsWith('fab [') && this.controller) this.prompt = `fab [${this.controller.config.mode}/${this.controller.config.autonomy}] › `;
    this.rl.setPrompt(this.displayPrompt()); this.rl.prompt(true);
  }
  private displayPrompt() { return this.terminal && this.controller?.config.theme !== 'plain' ? `\x1b[36m${this.prompt}\x1b[0m` : this.prompt; }
  clearInput() { if (this.terminal) this.clearLine(); this.redraw(); }
  question(prompt: string, signal?: AbortSignal, options?: { fresh?: boolean }): Promise<string> {
    signal?.throwIfAborted();
    if (this.waiter) return Promise.reject(new Error('Ya hay una pregunta activa'));
    if (options?.fresh) {
      this.queue = []; this.paste = new PasteDecoder(); this.escape = Buffer.alloc(0);
      if (this.escapeTimer) clearTimeout(this.escapeTimer);
      // A pipe has no interactive reply boundary: it cannot grant a future permission.
      if (!this.terminal) return Promise.resolve('');
      this.clearLine();
    }
    this.prompt = prompt; const display = this.displayPrompt();
    this.paletteSuppressed = undefined;
    this.historyIndex = this.ownHistory.length; this.historyDraft = '';
    this.presenter.pause(true);
    this.installHistory();
    if (this.terminal) { this.rl.setPrompt(display); this.rl.prompt(true); } else this.write(display);
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.reject(new Error('Entrada cerrada'));
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        this.waiter = undefined; cleanup();
        this.presenter.pause(false);
        if (this.terminal) this.clearLine();
        reject(new Error('Pregunta cancelada'));
      };
      this.waiter = { resolve, reject, cleanup };
      this.syncPalette();
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
  }
  async select(prompt: string, choices: string[], signal?: AbortSignal) {
    if (!choices.length) return;
    this.write(terminalText(prompt) + '\n' + choices.map((c, i) => `  ${i + 1}. ${terminalText(c)}`).join('\n') + '\n');
    this.selection = { choices, index: -1 };
    try {
      const answer = (await this.question('Número (↑↓ y Enter, vacío cancela): ', signal)).trim();
      if (!answer) return;
      if (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > choices.length) throw new Error('Selección fuera del catálogo');
      return Number(answer) - 1;
    } finally { this.selection = undefined; }
  }
  close() {
    if (this.paletteTimer) clearTimeout(this.paletteTimer);
    if (this.windowTimer) { clearInterval(this.windowTimer); this.windowTimer = undefined; }
    process.removeListener('SIGWINCH', this.refreshSize);
    this.presenter.close();
    if (this.pasteEnabled) { this.output.write('\x1b[?2004l'); this.pasteEnabled = false; }
    this.rl.close(); if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.rl.removeListener('line', this.line); this.rl.removeListener('close', this.closed); this.rl.removeListener('SIGINT', this.interrupt);
    this.input.removeListener('data', this.forward); this.input.removeListener('end', this.end); this.input.removeListener('error', this.error);
    this.output.removeListener('resize', this.resize);
    this.relay.destroy(); this.input.pause();
  }
}
