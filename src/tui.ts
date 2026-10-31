// fab tui — live terminal dashboard: changes, inbox and events, with keyboard review actions.
// Plain ANSI escapes, no dependencies. The pool runs separately (`fab run <ws>`); this view only
// reads the store and records human decisions.
import type { Activity, Change, Store } from './store.ts';
import { chatMain } from './chat.ts';

const ESC = '\x1b[';
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inv: `${ESC}7m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  cyan: `${ESC}36m`,
};

const STATUS_COLOR: Record<string, string> = {
  pending: c.yellow,
  in_progress: c.blue,
  in_review: c.cyan,
  implemented: c.green,
  completed: c.green,
  failed: c.red,
  blocked: c.yellow,
  declined: c.dim,
  canceled: c.dim,
};

type Mode = 'list' | 'detail' | 'comment';

export interface TuiState {
  selected: number;
  mode: Mode;
  scroll: number;
  input: string;
  flash: string;
}

export interface Row {
  change: Change;
  last: Activity | undefined;
  awaiting: Activity | undefined;
}

export function newTuiState(): TuiState {
  return { selected: 0, mode: 'list', scroll: 0, input: '', flash: '' };
}

export function buildRows(store: Store, workstream: string): Row[] {
  return store.listChanges(workstream).map((change) => {
    const acts = store.listActivities({ changeId: change.id });
    return { change, last: acts[acts.length - 1], awaiting: acts.find((a) => a.reviewStatus === 'awaiting') };
  });
}

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

function fit(s: string, width: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= width) return s + ' '.repeat(width - plain.length);
  return plain.slice(0, Math.max(0, width - 1)) + '…';
}

function header(store: Store, workstream: string, rows: Row[], width: number): string[] {
  const ws = store.getWorkstream(workstream);
  const awaiting = rows.filter((r) => r.awaiting).length;
  const stateColor = ws.state === 'active' ? c.green : c.yellow;
  return [
    fit(
      `${c.bold}fab${c.reset} · ${c.bold}${ws.slug}${c.reset} [${stateColor}${ws.state}${c.reset}] ` +
        `agent=${ws.agent} workers=${ws.workerConcurrency} · bandeja: ${awaiting ? c.cyan + awaiting + c.reset : '0'}`,
      width
    ),
    fit(`${c.dim}${ws.goal}${c.reset}`, width),
    '─'.repeat(width),
  ];
}

function listBody(store: Store, workstream: string, rows: Row[], state: TuiState, width: number, height: number): string[] {
  const out: string[] = [];
  if (rows.length === 0) {
    out.push(fit(`${c.dim}sin changes — añade señales con: fab signal add <ws> "<título>"${c.reset}`, width));
  }
  rows.forEach((r, i) => {
    const color = STATUS_COLOR[r.change.status] ?? '';
    const mark = r.awaiting ? `${c.cyan}●${c.reset}` : ' ';
    const stage = r.last ? `${r.last.kind}:${r.last.status}` : '';
    const line = `${mark} ${r.change.id.slice(0, 8)} ${color}${r.change.status.padEnd(12)}${c.reset} ${stage.padEnd(26)} ${r.change.title}`;
    out.push(i === state.selected ? `${c.inv}${fit(stripAnsi(line), width)}${c.reset}` : fit(line, width));
  });
  const room = height - out.length - 1;
  if (room >= 2) {
    const events = store.listEvents(workstream, room - 1);
    while (out.length < height - events.length - 1) out.push('');
    out.push(fit(`${c.dim}── eventos ──${c.reset}`, width));
    for (const e of events) {
      const sev = e.severity === 'error' ? c.red : e.severity === 'warning' ? c.yellow : c.dim;
      out.push(fit(`${sev}${String(e.created_at).slice(11, 19)} ${e.message}${c.reset}`, width));
    }
  }
  return out;
}

function detailLines(store: Store, row: Row): string[] {
  const out = [
    `${c.bold}${row.change.title}${c.reset}  [${row.change.status}] rama=${row.change.branch ?? '-'}`,
    '',
    ...row.change.description.split('\n'),
    '',
  ];
  for (const a of store.listActivities({ changeId: row.change.id })) {
    out.push(`${c.bold}── ${a.kind} ${a.id.slice(0, 8)} · ${a.status}${a.reviewStatus ? ` · revisión: ${a.reviewStatus}` : ''}${c.reset}`);
    if (a.reviewComment) out.push(`${c.yellow}comentario: ${a.reviewComment}${c.reset}`);
    if (a.result) out.push(...a.result.trim().split('\n'));
    if (a.error) out.push(...`error: ${a.error}`.split('\n').slice(0, 12).map((l) => c.red + l + c.reset));
    out.push('');
  }
  return out;
}

const HELP: Record<Mode, string> = {
  list: '↑↓ mover · enter detalle · a aprobar · c comentar · d rechazar · r reintentar · g agente · q salir',
  detail: '↑↓ desplazar · a aprobar · c comentar · d rechazar · g agente · esc volver · q salir',
  comment: 'escribe y enter para enviar · esc cancelar',
};

/** Render the whole screen as `height` lines. Pure, so it can be tested without a terminal. */
export function render(store: Store, workstream: string, state: TuiState, width: number, height: number): string[] {
  const rows = buildRows(store, workstream);
  state.selected = Math.min(state.selected, Math.max(0, rows.length - 1));
  const lines = header(store, workstream, rows, width);
  const bodyHeight = Math.max(3, height - lines.length - 1);
  let body: string[];
  if (state.mode === 'list') {
    body = listBody(store, workstream, rows, state, width, bodyHeight);
  } else {
    const row = rows[state.selected];
    const inputRows = state.mode === 'comment' ? 2 : 0;
    const detail = row ? detailLines(store, row) : ['(sin selección)'];
    state.scroll = Math.min(state.scroll, Math.max(0, detail.length - 1));
    body = detail.slice(state.scroll, state.scroll + bodyHeight - inputRows).map((l) => fit(l, width));
    while (body.length < bodyHeight - inputRows) body.push('');
    if (state.mode === 'comment') body.push('─'.repeat(width), fit(`${c.bold}comentario:${c.reset} ${state.input}█`, width));
  }
  while (body.length < bodyHeight) body.push('');
  body.length = bodyHeight;
  const flash = state.flash ? `  ${c.yellow}${state.flash}${c.reset}` : '';
  // Every line is padded to full width so stale characters from the previous frame are overwritten.
  return [...lines, ...body, `${c.dim}${HELP[state.mode]}${c.reset}${flash}`].map((l) => fit(l, width));
}

/** Apply one keypress. Returns false when the user quits. Review decisions are written to the store. */
export function handleKey(store: Store, workstream: string, state: TuiState, key: string): boolean {
  const rows = buildRows(store, workstream);
  const row = rows[state.selected];
  state.flash = '';
  if (state.mode === 'comment') {
    if (key === '\x1b') state.mode = 'detail';
    else if (key === '\r' || key === '\n') {
      if (row?.awaiting && state.input.trim()) {
        store.resolveReview(row.awaiting.id, 'comment', state.input.trim());
        state.flash = 'comentario enviado; se re-encola la actividad';
      }
      state.input = '';
      state.mode = 'detail';
    } else if (key === '\x7f') state.input = state.input.slice(0, -1);
    else if (!key.startsWith('\x1b') && key >= ' ') state.input += key;
    return true;
  }
  if (key === 'q' || key === '\x03') return false;
  const up = key === '\x1b[A' || key === 'k';
  const down = key === '\x1b[B' || key === 'j';
  if (state.mode === 'detail') {
    if (key === '\x1b') {
      state.mode = 'list';
      state.scroll = 0;
    } else if (up) state.scroll = Math.max(0, state.scroll - 1);
    else if (down) state.scroll += 1;
  } else if (up) state.selected = Math.max(0, state.selected - 1);
  else if (down) state.selected = Math.min(Math.max(0, rows.length - 1), state.selected + 1);
  else if ((key === '\r' || key === '\n') && row) {
    state.mode = 'detail';
    state.scroll = 0;
  }
  if (!row) return true;
  try {
    if (key === 'a' || key === 'd') {
      if (!row.awaiting) state.flash = 'este change no espera revisión';
      else {
        store.resolveReview(row.awaiting.id, key === 'a' ? 'approve' : 'decline');
        state.flash = key === 'a' ? `${row.awaiting.kind} aprobado` : 'change rechazado';
      }
    } else if (key === 'c') {
      if (!row.awaiting) state.flash = 'este change no espera revisión';
      else {
        state.mode = 'comment';
        state.input = '';
      }
    } else if (key === 'r') {
      if (!['failed', 'blocked', 'implemented'].includes(row.change.status)) state.flash = 'solo se reintentan changes fallidos, bloqueados o con validador agotado';
      else {
        store.retryChange(row.change.id);
        state.flash = 'change re-encolado';
      }
    }
  } catch (err) {
    state.flash = err instanceof Error ? err.message : String(err);
  }
  return true;
}

export async function runTui(store: Store, workstream: string): Promise<void> {
  const state = newTuiState();
  const out = process.stdout;
  const draw = () => out.write(`${ESC}H${render(store, workstream, state, out.columns || 100, out.rows || 30).join('\n')}${ESC}J`);
  for (;;) {
    out.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode?.(true);
    let timer: ReturnType<typeof setInterval> | undefined;
    let input: ((buf: Buffer) => void) | undefined;
    let closed: (() => void) | undefined;
    let action: 'quit' | 'agent';
    try {
      draw(); timer = setInterval(draw, 2000); out.on('resize', draw);
      action = await new Promise<'quit' | 'agent'>(resolve => {
        input = buf => {
          const key = buf.toString('utf8');
          if (key === 'g' && state.mode !== 'comment') { resolve('agent'); return; }
          if (handleKey(store, workstream, state, key)) draw(); else resolve('quit');
        };
        closed = () => resolve('quit');
        process.stdin.on('data', input); process.stdin.on('end', closed); process.once('SIGTERM', closed);
        process.stdin.resume();
      });
    } finally {
      if (timer) clearInterval(timer);
      out.removeListener('resize', draw);
      if (input) process.stdin.removeListener('data', input);
      if (closed) { process.stdin.removeListener('end', closed); process.removeListener('SIGTERM', closed); }
      out.write(`${ESC}?25h${ESC}?1049l`); process.stdin.setRawMode?.(false); process.stdin.pause();
    }
    if (action === 'quit') return;
    await chatMain(['--cwd', store.getWorkstream(workstream).repo]);
  }
}
