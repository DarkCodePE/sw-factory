import { isAbsolute } from 'node:path';
export interface FilePatch { operation: 'update' | 'add'; path: string; hunks: Array<{ before: string[]; after: string[] }> }
const MAX_PATCH = 1024 * 1024;
/** Original, single-file patch grammar. Deliberately rejects unsupported directives. */
export function parsePatch(value: unknown): FilePatch {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_PATCH || value.includes('\0')) throw new Error('Patch must be a nonempty string of at most 1 MiB without NUL');
  const lines = value.replace(/\r\n/g, '\n').split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines[0] === '*** Begin Patch') { lines.shift(); if (lines.pop() !== '*** End Patch') throw new Error('Missing patch end'); }
  const header = /^\*\*\* (Update|Add) File: (.+)$/.exec(lines.shift() ?? '');
  if (!header || !isAbsolute(header[2]!) || header[2]!.length > 4096) throw new Error('Patch requires one absolute Update File or Add File path');
  const patch: FilePatch = { operation: header[1] === 'Add' ? 'add' : 'update', path: header[2]!, hunks: [] };
  if (lines.some(line => line.startsWith('*** '))) throw new Error('Patch supports exactly one file');
  if (patch.operation === 'add') {
    if (!lines.length || lines.some(line => !line.startsWith('+'))) throw new Error('Add File requires only + lines');
    patch.hunks.push({ before: [], after: lines.map(line => line.slice(1)) }); return patch;
  }
  let hunk: FilePatch['hunks'][number] | undefined;
  for (const line of lines) {
    if (line === '@@') { if (patch.hunks.length >= 128) throw new Error('Patch exceeds 128 hunks'); hunk = { before: [], after: [] }; patch.hunks.push(hunk); }
    else {
      if (!hunk || ![' ', '-', '+'].includes(line[0] ?? '')) throw new Error('Update hunks require @@ and lines prefixed with space, - or +');
      if (line[0] !== '+') hunk.before.push(line.slice(1));
      if (line[0] !== '-') hunk.after.push(line.slice(1));
    }
  }
  if (!patch.hunks.length || patch.hunks.some(h => !h.before.length || h.before.join('\n') === h.after.join('\n'))) throw new Error('Each update hunk requires existing context and a change');
  return patch;
}
function uniqueMatch(source: string[], pattern: string[], cursor: number): number {
  // KMP keeps repeated-line patches linear instead of blocking on quadratic search.
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, n = 0; i < pattern.length; i++) {
    while (n && pattern[i] !== pattern[n]) n = prefix[n - 1]!;
    if (pattern[i] === pattern[n]) n++;
    prefix[i] = n;
  }
  let found = -1;
  for (let i = cursor, n = 0; i < source.length; i++) {
    while (n && source[i] !== pattern[n]) n = prefix[n - 1]!;
    if (source[i] === pattern[n]) n++;
    if (n === pattern.length) {
      if (found !== -1) throw new Error('Patch hunk is ambiguous');
      found = i - n + 1; n = prefix[n - 1]!;
    }
  }
  if (found === -1) throw new Error('Patch hunk does not apply');
  return found;
}
export function applyHunks(before: string, patch: FilePatch): string {
  if (patch.operation === 'add') return patch.hunks[0]!.after.join('\n') + '\n';
  if (before.includes('\r')) throw new Error('Update File currently requires LF text');
  const newline = before.endsWith('\n'), source = before.split('\n'); if (newline) source.pop();
  const output: string[] = []; let cursor = 0;
  for (const h of patch.hunks) {
    const start = uniqueMatch(source, h.before, cursor);
    for (let i = cursor; i < start; i++) output.push(source[i]!);
    for (const line of h.after) output.push(line);
    cursor = start + h.before.length;
  }
  for (let i = cursor; i < source.length; i++) output.push(source[i]!);
  const after = output.join('\n') + (newline && output.length ? '\n' : '');
  if (Buffer.byteLength(after) > MAX_PATCH) throw new Error('Patched file exceeds 1 MiB');
  return after;
}
