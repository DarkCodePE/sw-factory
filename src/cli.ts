#!/usr/bin/env bun
// fab — local software factory CLI.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { AGENT_NAMES } from './agents.ts';
import type { ReviewDecision, WorkstreamState } from './enums.ts';
import { runPool } from './pool.ts';
import { Store, StoreError } from './store.ts';
import { runTui } from './tui.ts';
import { mergeAndCleanup, removeWorktree } from './worktrees.ts';

const STATE_DIR = resolve(process.env.FABRICA_HOME ?? resolve(process.env.HOME ?? '.', '.fabrica'));

const HELP = `fab — fábrica de software local

  fab ws create <slug> --repo <path> --goal <text> [--agent claude|codex|droid|fake]
                [--concurrency N] [--task-limit N] [--no-change-approval] [--no-spec-approval]
  fab ws list
  fab ws state <slug> <active|paused|archived>
  fab signal add <slug> <title> [--body <text>]
  fab signal list <slug>
  fab triage <signalId> | fab triage --all <slug>
  fab inbox [slug]
  fab review <activityId> <approve|comment|decline> [--comment <text>]
  fab run <slug> [--once] [--agent <name>]
  fab tui <slug>                panel interactivo: changes, bandeja y eventos
  fab status <slug>
  fab show <changeId>
  fab merge <changeId>          fusiona la rama fab/<id> en el repo y cierra el change
  fab retry <changeId>          re-encola la última actividad de un change fallido
  fab reject <changeId>         cancela el change y borra su worktree
  fab events <slug>

Estado en ${STATE_DIR} (cambiar con FABRICA_HOME). Agentes: ${AGENT_NAMES.join(', ')}`;

function openStore(): Store {
  mkdirSync(STATE_DIR, { recursive: true });
  return new Store(resolve(STATE_DIR, 'fabrica.db'));
}

const short = (id: string): string => id.slice(0, 8);

function findByPrefix<T extends { id: string }>(items: T[], prefix: string, what: string): T {
  const matches = items.filter((i) => i.id.startsWith(prefix));
  if (matches.length !== 1) throw new StoreError('not_found', `${what} "${prefix}": ${matches.length} matches`);
  return matches[0] as T;
}

function allActivities(store: Store) {
  return store.listActivities();
}

function allChanges(store: Store) {
  return store.listWorkstreams().flatMap((w) => store.listChanges(w.id));
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      goal: { type: 'string' },
      agent: { type: 'string' },
      concurrency: { type: 'string' },
      'task-limit': { type: 'string' },
      'no-change-approval': { type: 'boolean' },
      'no-spec-approval': { type: 'boolean' },
      body: { type: 'string' },
      comment: { type: 'string' },
      all: { type: 'boolean' },
      once: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  if (!cmd || values.help) {
    console.log(HELP);
    return 0;
  }
  const store = openStore();
  try {
    switch (cmd) {
      case 'ws': {
        if (sub === 'create') {
          const slug = rest[0];
          if (!slug || !values.repo || !values.goal) throw new StoreError('invalid_input', 'usage: fab ws create <slug> --repo <path> --goal <text>');
          if (values.agent && !AGENT_NAMES.includes(values.agent)) throw new StoreError('invalid_input', `unknown agent ${values.agent}`);
          const ws = store.createWorkstream({
            slug,
            goal: values.goal,
            repo: resolve(values.repo),
            agent: values.agent,
            workerConcurrency: values.concurrency ? Number(values.concurrency) : undefined,
            taskLimit: values['task-limit'] ? Number(values['task-limit']) : undefined,
            requireChangeApproval: !values['no-change-approval'],
            requireApproval: !values['no-spec-approval'],
          });
          console.log(`workstream ${ws.slug} (${short(ws.id)}) creado en draft; actívalo con: fab ws state ${ws.slug} active`);
        } else if (sub === 'list') {
          for (const w of store.listWorkstreams()) {
            console.log(`${w.slug.padEnd(20)} ${w.state.padEnd(9)} agent=${w.agent} workers=${w.workerConcurrency} repo=${w.repo}`);
          }
        } else if (sub === 'state') {
          const ws = store.setWorkstreamState(rest[0] ?? '', rest[1] as WorkstreamState);
          console.log(`${ws.slug} -> ${ws.state}`);
        } else throw new StoreError('invalid_input', 'fab ws create|list|state');
        return 0;
      }
      case 'signal': {
        if (sub === 'add') {
          const [slug, title] = rest;
          if (!slug || !title) throw new StoreError('invalid_input', 'usage: fab signal add <slug> <title> [--body text]');
          const s = store.addSignal(slug, title, values.body ?? title);
          console.log(`signal ${short(s.id)} añadida`);
        } else if (sub === 'list') {
          for (const s of store.listSignals(rest[0] ?? '')) console.log(`${short(s.id)} ${s.status.padEnd(9)} ${s.title}`);
        } else throw new StoreError('invalid_input', 'fab signal add|list');
        return 0;
      }
      case 'triage': {
        const signals = values.all
          ? store.listSignals(sub ?? '', 'new')
          : [findByPrefix(store.listWorkstreams().flatMap((w) => store.listSignals(w.id)), sub ?? '', 'signal')];
        for (const s of signals) {
          const c = store.triageSignal(s.id);
          console.log(`signal ${short(s.id)} -> change ${short(c.id)} (${c.status})`);
        }
        return 0;
      }
      case 'inbox': {
        const items = store.inbox(sub);
        if (items.length === 0) console.log('bandeja vacía');
        for (const a of items) {
          const c = store.getChange(a.changeId);
          console.log(`\n== ${short(a.id)}  ${a.kind}  change ${short(c.id)}: ${c.title}`);
          console.log(a.kind === 'change_review' ? c.description : (a.result ?? '').slice(0, 4000));
          console.log(`-> fab review ${short(a.id)} approve|comment|decline`);
        }
        return 0;
      }
      case 'review': {
        const a = findByPrefix(allActivities(store), sub ?? '', 'activity');
        const decision = rest[0] as ReviewDecision;
        if (!['approve', 'comment', 'decline'].includes(decision)) throw new StoreError('invalid_input', 'decision: approve|comment|decline');
        store.resolveReview(a.id, decision, values.comment ?? '');
        console.log(`${a.kind} ${short(a.id)}: ${decision}`);
        return 0;
      }
      case 'run': {
        await runPool(store, { workstream: sub ?? '', stateDir: STATE_DIR, agentOverride: values.agent, untilIdle: !!values.once });
        return 0;
      }
      case 'tui': {
        await runTui(store, store.getWorkstream(sub ?? '').id);
        return 0;
      }
      case 'status': {
        const ws = store.getWorkstream(sub ?? '');
        console.log(`${ws.slug} [${ws.state}] agent=${ws.agent} — ${ws.goal}`);
        for (const c of store.listChanges(ws.id)) {
          const acts = store.listActivities({ changeId: c.id });
          const last = acts[acts.length - 1];
          console.log(
            `  ${short(c.id)} ${c.status.padEnd(12)} ${c.title}` +
              (last ? `  [${last.kind}:${last.status}${last.reviewStatus ? `/${last.reviewStatus}` : ''}]` : '')
          );
        }
        return 0;
      }
      case 'show': {
        const c = findByPrefix(allChanges(store), sub ?? '', 'change');
        console.log(`change ${c.id}\n${c.title} [${c.status}] branch=${c.branch ?? '-'}\n\n${c.description}`);
        for (const a of store.listActivities({ changeId: c.id })) {
          console.log(`\n--- ${a.kind} ${short(a.id)} ${a.status}${a.reviewStatus ? ` review=${a.reviewStatus}` : ''} retries=${a.retryCount}`);
          if (a.reviewComment) console.log(`comentario: ${a.reviewComment}`);
          if (a.result) console.log(a.result.slice(0, 3000));
          if (a.error) console.log(`error: ${a.error.slice(0, 1500)}`);
        }
        return 0;
      }
      case 'merge': {
        const c = findByPrefix(allChanges(store), sub ?? '', 'change');
        const ws = store.getWorkstream(c.workstreamId);
        if (c.status !== 'implemented') throw new StoreError('invalid_transition', `change is ${c.status}, not implemented`);
        console.log(await mergeAndCleanup(ws.repo, STATE_DIR, c.id));
        store.closeChange(c.id, 'completed');
        console.log(`change ${short(c.id)} completado`);
        return 0;
      }
      case 'retry': {
        const c = findByPrefix(allChanges(store), sub ?? '', 'change');
        const a = store.retryChange(c.id);
        console.log(`change ${short(c.id)}: ${a.kind} re-encolada`);
        return 0;
      }
      case 'reject': {
        const c = findByPrefix(allChanges(store), sub ?? '', 'change');
        await removeWorktree(store.getWorkstream(c.workstreamId).repo, STATE_DIR, c.id);
        store.closeChange(c.id, 'canceled');
        console.log(`change ${short(c.id)} cancelado`);
        return 0;
      }
      case 'events': {
        for (const e of store.listEvents(sub ?? '')) console.log(`${e.created_at} ${String(e.severity).padEnd(7)} ${e.message}`);
        return 0;
      }
      default:
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    console.error(err instanceof StoreError ? `error (${err.code}): ${err.message}` : err);
    return 1;
  } finally {
    store.close();
  }
}

process.exit(await main(process.argv.slice(2)));
