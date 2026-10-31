import { expect, test } from 'bun:test';
import { userInfo, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.ts';
import { handleKey, newTuiState, render, stripAnsi } from '../src/tui.ts';

test('review decision requires a reason, is atomic and records actor with OS fallback', () => {
  const previous = process.env.FAB_ACTOR;
  const s = new Store(':memory:');
  try {
    delete process.env.FAB_ACTOR;
    const ws = s.createWorkstream({slug:'audit',repo:'/tmp/no',goal:'g'});
    expect(s.listEvents(ws.id)[0]!.actor).toBe(userInfo().username);
    const c = s.createChange(ws.id,'t','d'); const a = s.inbox(ws.id)[0]!;
    const n = s.listEvents(ws.id).length;
    expect(()=>s.resolveReview(a.id,'decline','  ')).toThrow('motivo');
    expect(s.getChange(c.id).status).toBe('in_review');
    expect(s.listEvents(ws.id)).toHaveLength(n);
    process.env.FAB_ACTOR = 'operador';
    s.resolveReview(a.id,'decline','fuera de alcance');
    expect(s.listEvents(ws.id).at(-1)).toMatchObject({actor:'operador',message:'change_review declined: fuera de alcance'});
  } finally { s.close(); if(previous===undefined) delete process.env.FAB_ACTOR; else process.env.FAB_ACTOR=previous; }
});
test('TUI decline collects motivo and rejects empty input', () => {
  const s = new Store(':memory:');
  try {
    const ws = s.createWorkstream({slug:'tui',repo:'/tmp/no',goal:'g'});
    const c = s.createChange(ws.id,'t','d'); const state = newTuiState();
    handleKey(s,ws.id,state,'d');
    expect(state.mode).toBe('comment');
    expect(render(s,ws.id,state,100,20).map(stripAnsi).join('\n')).toContain('motivo:');
    handleKey(s,ws.id,state,'\r');
    expect(state.mode).toBe('comment');
    expect(s.getChange(c.id).status).toBe('in_review');
    handleKey(s,ws.id,state,'no procede'); handleKey(s,ws.id,state,'\r');
    expect(s.getChange(c.id).status).toBe('declined');
    expect(s.listActivities({changeId:c.id})[0]!.reviewComment).toBe('no procede');
  } finally {s.close();}
});
test('CLI decline without comment fails; reject is audited', () => {
  const home = mkdtempSync(join(tmpdir(),'fab-audit-'));
  const s = new Store(join(home,'fabrica.db'));
  try {
    const ws = s.createWorkstream({slug:'cli',repo:home,goal:'g'});
    const c = s.createChange(ws.id,'t','d'); const a = s.inbox(ws.id)[0]!;
    const cli = (...args:string[]) => Bun.spawnSync(['bun',resolve('src/cli.ts'),...args],{env:{...process.env,FABRICA_HOME:home,FAB_ACTOR:'cli-operator'}});
    const decline = cli('review',a.id,'decline');
    expect(decline.exitCode).toBe(1); expect(decline.stderr.toString()).toContain('motivo');
    expect(s.getChange(c.id).status).toBe('in_review');
    // No worktree exists, so no Git deletion is needed.
    const reject = cli('reject',c.id);
    expect(s.listEvents(ws.id).some(e=>e.actor==='cli-operator' && e.message==='reject solicitado')).toBe(true);
  } finally { s.close(); rmSync(home,{recursive:true,force:true}); }
});
