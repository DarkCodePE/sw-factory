import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseReportStatus, validateReportStatus } from '../src/prompts.ts';
import { boundedAgentOutput } from '../src/agents.ts';
import { runPool } from '../src/pool.ts';
import { Store } from '../src/store.ts';
import { branchCommits } from '../src/worktrees.ts';

let dir: string;
let repo: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  store = new Store(join(dir, 'f.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pool runs investigation with the fake agent in a per-change worktree', async () => {
  const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const c = store.createChange(ws.id, 'fix it', 'desc');
  await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });
  const [inv] = store.listActivities({ changeId: c.id });
  expect(inv?.status).toBe('completed');
  expect(inv?.result).toContain('STATUS: done');
  expect(store.getChange(c.id).branch).toBe(`fab/${c.id.slice(0, 8)}`);
  expect(store.getChange(c.id).status).toBe('in_review');
});

test('a blocked report counts as a failure and is retried', async () => {
  process.env.FABRICA_FAKE_STATUS = 'blocked - cannot reproduce';
  try {
    const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo, agent: 'fake', requireChangeApproval: false });
    store.setWorkstreamState(ws.id, 'active');
    const c = store.createChange(ws.id, 'fix it', 'desc');
    await runPool(store, { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {} });
    const [inv] = store.listActivities({ changeId: c.id });
    expect(inv?.status).toBe('failed');
    expect(inv?.retryCount).toBe(3);
    expect(inv?.error).toContain('cannot reproduce');
  } finally {
    delete process.env.FABRICA_FAKE_STATUS;
  }
});

test('parseReportStatus', () => {
  expect(parseReportStatus('STATUS: done\nok').done).toBe(true);
  expect(parseReportStatus('**STATUS: done**').done).toBe(true);
  expect(parseReportStatus('## **STATUS: done**').done).toBe(true);
  expect(parseReportStatus('STATUS: blocked - no repro')).toEqual({ done: false, kind: 'blocked', reason: 'blocked - no repro' });
  expect(parseReportStatus('no status here')).toEqual({ done: false, kind: 'missing', reason: 'report has no STATUS line' });
  for (const text of ['STATUS: doneXYZ', 'STATUS: pending\nSTATUS: done']) {
    expect(validateReportStatus(text)).toBeDefined(); expect(parseReportStatus(text).done).toBe(false);
  }
  expect(validateReportStatus('**STATUS: done**')).toBeUndefined();
  expect(validateReportStatus('STATUS: blocked - no repro')).toBeUndefined();
});

test('bounded reports retain the first STATUS line for the factory decision', () => {
  for (const status of ['done', 'blocked - no evidence', 'pending']) {
    const text = `STATUS: ${status}\n${'body\n'.repeat(5000)}\nSTATUS: done`;
    const bounded = boundedAgentOutput(text);
    expect(bounded.length).toBeLessThanOrEqual(20_000);
    expect(bounded.startsWith(`STATUS: ${status}\n`)).toBe(true);
    expect(parseReportStatus(bounded)).toEqual(parseReportStatus(text));
  }
});

test('report truncation cannot create a successful STATUS or overflow through a long reason', () => {
  // This suffix aligns the embedded token with the former report-tail boundary.
  const embedded = 'prefix ' + 'x'.repeat(30_000) + 'STATUS: done\n' + 'x'.repeat(19_935);
  const missing = boundedAgentOutput(embedded);
  expect(parseReportStatus(embedded).done).toBe(false); expect(parseReportStatus(missing).done).toBe(false);
  expect(missing.length).toBeLessThanOrEqual(20_000);
  const blocked = boundedAgentOutput('STATUS: blocked - ' + 'x'.repeat(30_000) + '\n' + 'body'.repeat(1000));
  expect(blocked.length).toBeLessThanOrEqual(20_000); expect(parseReportStatus(blocked).done).toBe(false);
});

test('native factory completes investigation and implementation through its own agent loop', async () => {
  writeFileSync(join(repo, 'check.test.ts'), `import {test,expect} from 'bun:test';\ntest('fixed',async()=>expect(await Bun.file('a.txt').text()).toBe('fixed\\n'));\n`);
  for (const args of [['config','user.name','fixture'], ['config','user.email','fixture@local'], ['add','.'], ['commit','-qm','test fixture']]) {
    expect(Bun.spawnSync(['git','-C',repo,...args]).exitCode).toBe(0);
  }
  const calls = new Map<string, number>(), results: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as any;
    const prompt = body.messages.findLast((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('# Your activity:'))?.content ?? '';
    const kind = prompt.includes('# Your activity: implementation') ? 'implementation' : 'investigation';
    const n = (calls.get(kind) ?? 0) + 1; calls.set(kind, n);
    const workspace = /^Workspace: (.+)$/m.exec(body.messages[1].content)![1]!;
    const lastTool = body.messages.findLast((m: any) => m.role === 'tool');
    if (lastTool) results.push({kind, content:lastTool.content});
    let name = '', input: any;
    if (kind === 'investigation') {
      if (n === 1) { name='Read'; input={file_path:join(workspace,'a.txt')}; }
      if (n === 2) { name='Execute'; input={command:'bun test'}; }
      if (n === 3) { name='Edit'; input={file_path:'a.txt',old_str:'x',new_str:'forbidden'}; }
    } else {
      if (n === 1) { name='Edit'; input={file_path:'a.txt',old_str:'x',new_str:'fixed'}; }
      if (n === 2) { name='Execute'; input={command:'bun test'}; }
      if (n === 3) { name='Execute'; input={command:'git add a.txt'}; }
      if (n === 4) { name='Execute'; input={command:'git commit -m "fix fixture"'}; }
    }
    const message = name ? {role:'assistant',content:null,tool_calls:[{id:`${kind}-${n}`,type:'function',function:{name,arguments:JSON.stringify(input)}}]}
      : {role:'assistant',content:'STATUS: done\nLocal fixture verified.'};
    return Response.json({choices:[{message,finish_reason:name?'tool_calls':'stop'}]});
  } });
  const settings: Record<string,string> = {FABRICA_LLM_MODEL:'fixture',FABRICA_LLM_BASE_URL:server.url.href+'v1',FABRICA_LLM_API_KEY:'',FABRICA_HOME:join(dir,'native-state'),FABRICA_AGENT_AUTONOMY:'medium'};
  const previous = Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));
  Object.assign(process.env,settings);
  try {
    const ws = store.createWorkstream({slug:'native',goal:'fix fixture',repo,requireChangeApproval:false,requireApproval:false});
    expect(ws.agent).toBe('native');
    store.setWorkstreamState(ws.id,'active'); const change = store.createChange(ws.id,'fix','Replace x with fixed');
    await runPool(store,{workstream:ws.id,stateDir:dir,untilIdle:true,pollMs:5,log:()=>{}});
    const activities = store.listActivities({changeId:change.id});
    expect(activities.map(a=>({kind:a.kind,status:a.status}))).toEqual([{kind:'investigation',status:'completed'},{kind:'implementation',status:'completed'}]);
    expect(store.getChange(change.id).status).toBe('implemented');
    expect((await branchCommits(repo,store.getChange(change.id).branch!)).length).toBe(1);
    expect(await Bun.file(join(repo,'a.txt')).text()).toBe('x\n');
    expect(await Bun.file(join(dir,'worktrees',change.id.slice(0,8),'a.txt')).text()).toBe('fixed\n');
    expect(results.some(r=>r.kind==='investigation' && r.content.includes('Spec mode denies'))).toBe(true);
    expect(results.some(r=>r.kind==='implementation' && r.content.includes('"exitCode":0') && r.content.includes('1 pass'))).toBe(true);
  } finally {
    server.stop(true);
    for (const key of Object.keys(settings)) { if (previous[key]===undefined) delete process.env[key]; else process.env[key]=previous[key]; }
  }
}, 20_000);

test('the factory commits for agents whose sandbox keeps Git metadata read-only', async () => {
  const { commitWorktree } = await import('../src/worktrees.ts');
  const { buildWorkerPrompt } = await import('../src/prompts.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'fab-commit-'));
  const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).stdout.toString().trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init');
  expect(await commitWorktree(repo, 'nothing')).toBe(false);
  writeFileSync(join(repo, 'a.txt'), 'fixed\n'); writeFileSync(join(repo, 'b.txt'), 'new\n');
  expect(await commitWorktree(repo, 'Fix a\n\nImplemented by codex.')).toBe(true);
  expect(git('log', '-1', '--format=%an %s')).toBe('fab Fix a');
  expect(git('status', '--porcelain')).toBe('');
  const input = { workstream: { goal: 'g' }, change: { title: 't', description: 'd' }, activity: { kind: 'implementation' }, history: [], worktree: repo, branch: 'b' } as never;
  expect(buildWorkerPrompt(input, { factoryCommits: true })).toContain('Do NOT run git add or git commit');
  expect(buildWorkerPrompt(input)).toContain('Commit your work on the current branch');
});
