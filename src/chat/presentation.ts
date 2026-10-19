import type { Writable } from 'node:stream';
import { fit, MarkdownStream, renderDiff, type FileChange } from './render.ts';
import { terminalText } from './config.ts';
import { modeLine, resourceLine, type Resources } from './chrome.ts';

export interface StatusState { model: string; mode: string; autonomy: string; inputTokens: number; outputTokens: number; contextTokens: number; maxContextTokens: number; reasoning?: 'low' | 'medium' | 'high'; resources?: Resources; modelLabel?: string }
export function statusLine(state: StatusState, width: number) {
  const percent = Math.round(100 * state.contextTokens / Math.max(1, state.maxContextTokens));
  return fit(`${state.model}${state.reasoning ? ` (${state.reasoning})` : ''} · ${state.mode}/${state.autonomy} · in ${state.inputTokens} / out ${state.outputTokens} · ctx ~${percent}%`, Math.max(0, width - 1));
}
/** Two reserved rows; cursor save/restore never writes into the readline or streaming row. */
export class TerminalPresentation {
  private reserved = false;
  private reservedRows = 2;
  private menuLines: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private started = 0;
  private frame = 0;
  private working = '';
  private paused = false;
  private markdown?: MarkdownStream;
  private lastDiff?: FileChange;
  private closed = false;
  state?: StatusState;
  constructor(readonly output: Writable, readonly size: () => { columns: number; rows: number }, readonly color: () => boolean) {}
  update(state?: StatusState) { if (this.closed) return; if (state) this.state = state; this.draw(); }
  menu(lines: string[]) { this.menuLines = lines; this.draw(); }
  resize() {
    if (this.closed) return;
    if (this.reserved) {
      // Make room after terminal reflow before reserving the new bottom rows.
      this.output.write(`\x1b[r\x1b[${this.size().rows};1H${'\n'.repeat(this.reservedRows + 1)}`); this.reserved = false;
    }
    this.draw();
  }
  private release() {
    if (this.reserved) { const { rows } = this.size(); this.output.write(`\x1b7\x1b[r\x1b[${Math.max(1, rows - this.reservedRows + 1)};1H\x1b[J\x1b8`); this.reserved = false; }
  }
  private draw() {
    if (this.closed || this.output.destroyed) return;
    const { columns, rows } = this.size();
    if (!this.color() || columns < 20 || rows < 5) { this.release(); return; }
    const menu = this.menuLines.slice(0, Math.max(0, Math.min(6, rows - 7))), count = 2 + (this.state?.resources ? 1 : 0) + menu.length;
    if (this.reserved && count !== this.reservedRows) {
      // Opening suggestions must move the existing welcome/log upward before
      // the new reserved rows occupy it; otherwise tips and shortcuts disappear.
      if (count > this.reservedRows) this.output.write(`\x1b[${rows - this.reservedRows};1H${'\n'.repeat(count - this.reservedRows)}`);
      this.release();
    }
    this.reservedRows = count;
    if (!this.reserved) { this.output.write(`\x1b[1;${rows - count}r\x1b[${rows - count};1H`); this.reserved = true; }
    const spinner = this.working && !this.paused ? `${['⠋', '⠙', '⠹', '⠸'][this.frame++ % 4]} ${this.working} · ${((Date.now() - this.started) / 1000).toFixed(1)} s · Ctrl+C: cancelar` : this.state?.resources ? modeLine({ ...this.state, model: this.state.modelLabel ?? this.state.model }, columns) : '';
    const extra = [...menu, ...(this.state?.resources ? [resourceLine(this.state.resources)] : [])];
    this.output.write(`\x1b7${extra.map((line, i) => `\x1b[${rows - count + i + 1};1H\x1b[2K${line.startsWith('›') ? '\x1b[7m' : ''}${fit(line, columns - 1)}\x1b[0m`).join('')}\x1b[${rows - 1};1H\x1b[2K${fit(spinner, columns - 1)}\x1b[${rows};1H\x1b[2K\x1b[7m${this.state ? statusLine(this.state, columns) : ''}\x1b[0m\x1b8`);
  }
  work(label?: string) {
    if (this.closed) return;
    if (label && !this.working) this.started = Date.now();
    this.working = label ? terminalText(label).replace(/\n/g, ' ') : '';
    if (this.working && !this.timer) this.timer = setInterval(() => this.draw(), 100);
    if (!this.working && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.draw();
  }
  pause(value: boolean) { this.paused = value; this.draw(); }
  assistant(text: string, final = false) {
    if (this.closed) return;
    this.work();
    this.markdown ??= new MarkdownStream(this.color(), this.size().columns);
    this.output.write(this.markdown.push(text, final));
    if (final) this.markdown = undefined;
  }
  finishText() { if (this.markdown) this.assistant('', true); }
  diff(change: FileChange, expanded: boolean) {
    if (this.closed) return;
    this.lastDiff = change;
    this.output.write(renderDiff(change, this.color(), expanded, this.size().columns));
  }
  expand(expanded: boolean) { if (this.lastDiff) this.diff(this.lastDiff, expanded); }
  close() { if (this.closed) return; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.finishText(); this.work(); this.release(); this.closed = true; }
}
