import { terminalText } from './config.ts';

const paint = (s: string, code: string, color: boolean) => color ? `\x1b[${code}m${s}\x1b[0m` : s;
export const cellWidth = (s: string) => Bun.stringWidth(terminalText(s));
export function fit(s: string, width: number): string {
  let out = '', used = 0;
  for (const c of terminalText(s)) { const n = cellWidth(c); if (used + n > width) break; out += c; used += n; }
  return out;
}
const inline = (s: string, color: boolean) => s.replace(/(`[^`]+`|\*\*[^*]+\*\*)/g, token =>
  token.startsWith('`') ? paint(token.slice(1, -1), '48;5;236;38;5;223', color) : paint(token.slice(2, -2), '1', color));
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const plainInline = (s: string) => inline(s, false);

/** Incremental, line-oriented Markdown. Incomplete tokens/tables stay buffered until complete. */
export class MarkdownStream {
  private pending = '';
  private fence = false;
  private table: string[] = [];
  constructor(private color = false, private width = 80) {}
  push(text: string, final = false): string {
    this.pending += terminalText(text);
    let output = '', end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      output += this.line(this.pending.slice(0, end)); this.pending = this.pending.slice(end + 1);
    }
    if (final) {
      if (this.pending) output += this.line(this.pending);
      this.pending = ''; output += this.flushTable();
      if (this.fence) { output += this.border('└'); this.fence = false; }
    }
    return output;
  }
  private border(left: string, language = '') { return paint(fit(left + '─'.repeat(Math.max(2, Math.min(68, this.width - 2))) + (language ? ' ' + language : ''), this.width - 1), '2', this.color) + '\n'; }
  private flushTable() {
    if (!this.table.length) return '';
    const rows = this.table.map(cells).filter(row => !row.every(c => /^:?-{3,}:?$/.test(c)));
    this.table = [];
    const count = Math.min(20, Math.max(...rows.map(r => r.length)));
    const widths = Array.from({ length: count }, (_, i) => Math.min(Math.max(1, Math.floor((this.width - count * 3) / count)), Math.max(...rows.map(r => cellWidth(plainInline(r[i] ?? ''))))));
    return rows.map(row => row.slice(0, count).map((c, i) => {
      const text = fit(plainInline(c), widths[i]!); return text + ' '.repeat(Math.max(0, widths[i]! - cellWidth(text)));
    }).join(' │ ') + '\n').join('');
  }
  private line(line: string): string {
    if (!this.fence && line.includes('|') && /^\s*\|/.test(line)) {
      this.table.push(line); return this.table.length >= 100 ? this.flushTable() : '';
    }
    const table = this.flushTable();
    if (/^\s*```/.test(line)) {
      this.fence = !this.fence;
      return table + this.border(this.fence ? '┌' : '└', this.fence ? line.trim().slice(3) : '');
    }
    if (this.fence) return table + paint('│ ' + fit(line, Math.max(1, this.width - 3)), '48;5;236;37', this.color) + '\n';
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    return table + (heading ? paint(inline(heading[1]!, this.color), '1;36', this.color)
      : inline(line.replace(/^(\s*)[-*+]\s+/, '$1• '), this.color)) + '\n';
  }
}
export function renderMarkdown(text: string, color = false, width = 80) { return new MarkdownStream(color, width).push(text, true); }

export interface FileChange { path: string; before?: { data: Uint8Array; mode: number }; after: Uint8Array; mode: number }
/** Common prefix/suffix diff avoids quadratic LCS on 1 MiB tool files. */
export function renderDiff(change: FileChange, color = false, expanded = false, width = 80): string {
  const lines = (data: Uint8Array) => { const result = terminalText(Buffer.from(data).toString('utf8')).split('\n'); if (!result.at(-1)) result.pop(); return result; };
  const before = change.before ? lines(change.before.data) : [], after = lines(change.after);
  let first = 0, tail = 0;
  while (first < before.length && first < after.length && before[first] === after[first]) first++;
  while (tail < before.length - first && tail < after.length - first && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
  const removed = before.slice(first, before.length - tail), added = after.slice(first, after.length - tail);
  let output = paint(`${change.path}  +${added.length} -${removed.length}`, '1', color) + '\n';
  const limit = expanded ? 400 : 12;
  const all = [...removed.map((s, i) => ({ sign: '-', line: first + i + 1, s })), ...added.map((s, i) => ({ sign: '+', line: first + i + 1, s }))];
  for (const row of all.slice(0, limit)) output += paint(`${row.sign} ${String(row.line).padStart(4)} │ ${fit(row.s, Math.max(1, width - 10))}`, row.sign === '+' ? '32' : '31', color) + '\n';
  if (all.length > limit) output += `… ${all.length - limit} líneas omitidas${expanded ? ' (límite 400)' : ' · Ctrl+O: ampliar'}\n`;
  return output;
}
