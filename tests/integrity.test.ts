import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.ts';
import { runPool } from '../src/pool.ts';
import { getAgent } from '../src/agents.ts';
import { commitWorktree, ensureWorktree } from '../src/worktrees.ts';
import { DEFAULT_PROTECTED_PATHS, protectedIntegrity } from '../src/validators/integrity.ts';
import { mergeBlocker } from '../src/validators/publish.ts';

let dir:string, repo:string, store:Store;
function git(cwd:string,...args:string[]) {
  const p = Bun.spawnSync(['git','-c','user.name=t','-c','user.email=t@t',...args],{cwd});
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),'fab-integrity-')); repo=join(dir,'repo');
  git(dir,'init','-q','-b','main',repo);
  mkdirSync(join(repo,'tests')); writeFileSync(join(repo,'tests/math.test.ts'),'assert(answer === 42);\n');
  writeFileSync(join(repo,'bunfig.toml'),'[test]\n'); writeFileSync(join(repo,'code.ts'),'answer = 42;\n');
  git(repo,'add','.'); git(repo,'commit','-qm','base'); store=new Store(join(dir,'fabrica.db'));
});
afterEach(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
function setup(slug='gate') {
  const ws=store.createWorkstream({slug,repo,goal:'g',agent:'fake',workerConcurrency:1,requireApproval:false,requireChangeApproval:false});
  store.setWorkstreamState(ws.id,'active'); const c=store.createChange(ws.id,'fix','d');
  return {ws,c};
}
const attacks:Record<string,(wt:string)=>void> = {
  'edit test': wt=>writeFileSync(join(wt,'tests/math.test.ts'),'assert(false);\n'),
  'delete assertion': wt=>writeFileSync(join(wt,'tests/math.test.ts'),''),
  'new ignored conftest': wt=>{writeFileSync(join(wt,'.gitignore'),'conftest.py\n');writeFileSync(join(wt,'conftest.py'),'skip_all = True\n');},
  'change bunfig': wt=>writeFileSync(join(wt,'bunfig.toml'),'[test]\ncoverage = false\n'),
  'commit only with disk restored': wt=>{
    const old=readFileSync(join(wt,'tests/math.test.ts'));writeFileSync(join(wt,'tests/math.test.ts'),'assert(true);\n');
    git(wt,'add','.');git(wt,'commit','-qm','weaken test');writeFileSync(join(wt,'tests/math.test.ts'),old);
  },
  'symlink': wt=>{rmSync(join(wt,'tests/math.test.ts'));symlinkSync('/outside/missing',join(wt,'tests/math.test.ts'));},
};
for (const [name,attack] of Object.entries(attacks)) test(`integrity detects ${name}`,async()=>{
  const {c}=setup(); const wt=await ensureWorktree(repo,dir,c.id); attack(wt.path);
  const result=await protectedIntegrity(wt.path,wt.baseSha,DEFAULT_PROTECTED_PATHS);
  expect(result.tampered.length).toBeGreaterThan(0);
});
for(let i=0;i<10;i++) test(`clean change ${i+1} has no false positive`,async()=>{
  const {c}=setup(); const wt=await ensureWorktree(repo,dir,c.id);
  writeFileSync(join(wt.path,'code.ts'),`answer = ${i};\n`);
  if(i%2) await commitWorktree(wt.path,'code only');
  expect((await protectedIntegrity(wt.path,wt.baseSha,DEFAULT_PROTECTED_PATHS)).tampered).toEqual([]);
});
test('ignored prose under a wildcard test glob is not a test (F4), but code still is',async()=>{
  const {c}=setup(); const wt=await ensureWorktree(repo,dir,c.id);
  writeFileSync(join(wt.path,'.gitignore'),'graft/\n'); mkdirSync(join(wt.path,'graft/tests'),{recursive:true});
  writeFileSync(join(wt.path,'graft/tests/health.test.md'),'# index\n');
  expect((await protectedIntegrity(wt.path,wt.baseSha,DEFAULT_PROTECTED_PATHS)).tampered).toEqual([]);
  writeFileSync(join(wt.path,'graft/tests/health.test.ts'),'skip();\n');
  expect((await protectedIntegrity(wt.path,wt.baseSha,DEFAULT_PROTECTED_PATHS)).tampered).toEqual(['graft/tests/health.test.ts']);
});
test('default protections can be extended; only protect-none disables them, migration persists',()=>{
  expect(setup().ws.protectedPaths).toEqual(DEFAULT_PROTECTED_PATHS);
  expect(store.createWorkstream({slug:'extra',repo,goal:'g',protectedPaths:['docs/**']}).protectedPaths).toContain('tests/**');
  expect(()=>store.createWorkstream({slug:'empty',repo,goal:'g',protectedPaths:[]})).toThrow('protect-none');
  expect(store.createWorkstream({slug:'none',repo,goal:'g',protectNone:true}).protectedPaths).toEqual([]);
  store.close();store=new Store(join(dir,'fabrica.db'));
  expect(store.getWorkstream('gate').protectedPaths).toEqual(DEFAULT_PROTECTED_PATHS);
});
test('pool blocks tampering before declared blocked, retry reblocks, CLI allow audits, invalidates and passes',async()=>{
  const {ws,c}=setup();
  const inv=store.claimActivity(ws.id,'w')!;store.completeActivity(inv.id,'w','STATUS: done');
  const wt=await ensureWorktree(repo,dir,c.id);store.setChangeBase(c.id,wt.baseSha);
  writeFileSync(join(wt.path,'tests/math.test.ts'),'assert(true);\n');
  process.env.FABRICA_FAKE_STATUS='blocked - trying to hide';
  const options={workstream:ws.id,stateDir:dir,untilIdle:true,log:()=>{}};
  try {await runPool(store,options);}finally{delete process.env.FABRICA_FAKE_STATUS;}
  expect(store.getChange(c.id).status).toBe('blocked');
  expect(store.inbox(ws.id)[0]!.error).toBe('GATE_TAMPERED: tests/math.test.ts');
  store.retryChange(c.id);await runPool(store,options);
  expect(store.getChange(c.id).status).toBe('blocked');
  expect(store.inbox(ws.id)).toHaveLength(1);
  // A prior pass must not survive a baseline approval.
  store.db.query(`INSERT INTO activities (id,workstream_id,change_id,kind,status,validator,review_status,created_at,retry_count)
    VALUES ('old-pass',?,?,'change_review','completed','qa','approved','2000-01-01',0)`).run(ws.id,c.id);
  const cli=(...args:string[])=>Bun.spawnSync(['bun',resolve('src/cli.ts'),...args],{env:{...process.env,FABRICA_HOME:dir,FAB_ACTOR:'gate-operator'}});
  expect(cli('gate','allow',c.id,'tests/math.test.ts').exitCode).toBe(1);
  expect(cli('gate','allow',c.id,'../escape','--comment','no').exitCode).toBe(1);
  const allow=cli('gate','allow',c.id,'tests/math.test.ts','--comment','test change reviewed');
  expect(allow.stderr.toString()).toBe('');expect(allow.exitCode).toBe(0);
  expect(store.listEvents(ws.id).find(e=>String(e.message).startsWith('gate allow:'))).toMatchObject({actor:'gate-operator'});
  expect(store.getActivity('old-pass').reviewStatus).toBeNull();
  expect(mergeBlocker(store.validationSummary(c.id))).toContain('qa');
  await runPool(store,options);
  expect(store.getChange(c.id).status).toBe('implemented');
  expect(store.getChange(c.id).baseSha).toBe(wt.baseSha);
  // Moving the repository base cannot silently authorize more protected edits.
  writeFileSync(join(repo,'bunfig.toml'),'changed on main\n');git(repo,'add','.');git(repo,'commit','-qm','main moved');
  store.setChangeBase(c.id,git(repo,'rev-parse','HEAD'));
  expect(store.getChange(c.id).baseSha).toBe(wt.baseSha);
  writeFileSync(join(wt.path,'bunfig.toml'),'changed again\n');
  const current=store.getChange(c.id);
  expect((await protectedIntegrity(wt.path,current.baseSha!,ws.protectedPaths,current.protectedBaseline)).tampered).toEqual(['bunfig.toml']);
});
test('each validator is checked even on blocked or unsuccessful agent reports',async()=>{
  const {ws,c}=setup();
  await runPool(store,{workstream:ws.id,stateDir:dir,untilIdle:true,log:()=>{}});
  const fake=getAgent('fake');const original=fake.command;
  try {
    for(const validator of ['code_review','security_audit','qa'] as const) {
      // Independently reset protected state for each validator.
      store.db.query(`UPDATE changes SET status='implemented' WHERE id=?`).run(c.id);
      const wt=await ensureWorktree(repo,dir,c.id);
      git(wt.path,'checkout','HEAD','--','bunfig.toml');
      store.requestValidation(c.id,[validator]);
      fake.command=()=>['sh','-c',`printf 'tampered' > bunfig.toml; printf 'STATUS: blocked - no access\\n'; exit 1`];
      await runPool(store,{workstream:ws.id,stateDir:dir,untilIdle:true,log:()=>{}});
      expect(store.getChange(c.id).status).toBe('blocked');
      expect(store.inbox(ws.id).at(-1)!.error).toBe('GATE_TAMPERED: bunfig.toml');
    }
  } finally {fake.command=original;}
});

test('new symlink roots tests and .github are protected without following their targets',async()=>{
  const {c}=setup();const wt=await ensureWorktree(repo,dir,c.id);
  rmSync(join(wt.path,'tests'),{recursive:true});
  git(wt.path,'add','-A');git(wt.path,'commit','-qm','fixture without tests');
  const base=git(wt.path,'rev-parse','HEAD');
  symlinkSync('/outside/missing',join(wt.path,'tests'));
  symlinkSync(repo,join(wt.path,'.github'));
  expect((await protectedIntegrity(wt.path,base,DEFAULT_PROTECTED_PATHS)).tampered).toEqual(['.github','tests']);
});
test('gate allow on validator commits only approved paths, keeps porcelain and reruns validator',async()=>{
  const {ws,c}=setup();const options={workstream:ws.id,stateDir:dir,untilIdle:true,log:()=>{}};
  await runPool(store,options);
  store.requestValidation(c.id,['qa']);
  const wt=await ensureWorktree(repo,dir,c.id);
  writeFileSync(join(wt.path,'bunfig.toml'),'[test]\ncoverage = true\n');
  await runPool(store,options);
  expect(store.getChange(c.id).status).toBe('blocked');
  const p=Bun.spawnSync(['bun',resolve('src/cli.ts'),'gate','allow',c.id,'bunfig.toml','--comment','reviewed config'],
    {env:{...process.env,FABRICA_HOME:dir,FAB_ACTOR:'reviewer'}});
  expect(p.stderr.toString()).toBe('');expect(p.exitCode).toBe(0);
  expect(git(wt.path,'status','--porcelain')).toBe('');
  expect(git(wt.path,'log','-1','--format=%s')).toBe('gate allow: reviewed config');
  process.env.FABRICA_FAKE_STATUS='done\nVERDICT: pass\nverified';
  try {await runPool(store,options);} finally {delete process.env.FABRICA_FAKE_STATUS;}
  expect(store.getChange(c.id).status).toBe('implemented');
  expect(store.validationSummary(c.id).passed).toBe(true);
});
test('gate approval commits selected paths without committing unrelated staged work',async()=>{
  const { commitProtectedPaths } = await import('../src/worktrees.ts');
  const {c}=setup();const wt=await ensureWorktree(repo,dir,c.id);
  writeFileSync(join(wt.path,'bunfig.toml'),'approved\n');
  writeFileSync(join(wt.path,'code.ts'),'unrelated\n');git(wt.path,'add','code.ts');
  await commitProtectedPaths(wt.path,['bunfig.toml'],'reviewed');
  expect(git(wt.path,'show','HEAD:code.ts')).toBe('answer = 42;');
  expect(git(wt.path,'diff','--cached','--name-only')).toBe('code.ts');
  expect((await protectedIntegrity(wt.path,wt.baseSha,DEFAULT_PROTECTED_PATHS)).tampered).toEqual(['bunfig.toml']);
});
test('a missing STATUS remains retryable for three sessions',async()=>{
  const {ws,c}=setup(); process.env.FABRICA_FAKE_STATUS='working';
  try {await runPool(store,{workstream:ws.id,stateDir:dir,untilIdle:true,log:()=>{}});}finally{delete process.env.FABRICA_FAKE_STATUS;}
  const a=store.listActivities({changeId:c.id})[0]!;
  expect(a.status).toBe('failed');expect(a.retryCount).toBe(3);
});
test('CLI merge --force audits actor before bypassing validation',async()=>{
  const {ws,c}=setup();await runPool(store,{workstream:ws.id,stateDir:dir,untilIdle:true,log:()=>{}});
  const wt=await ensureWorktree(repo,dir,c.id);
  writeFileSync(join(wt.path,'code.ts'),'answer = 43;\n');await commitWorktree(wt.path,'feature');
  store.requestValidation(c.id,['qa']);
  const cli=(...args:string[])=>Bun.spawnSync(['bun',resolve('src/cli.ts'),...args],{env:{...process.env,FABRICA_HOME:dir,FAB_ACTOR:'force-operator'}});
  expect(cli('merge',c.id).exitCode).toBe(1);
  const force=cli('merge',c.id,'--force');
  expect(force.stderr.toString()).toBe('');expect(force.exitCode).toBe(0);
  expect(store.getChange(c.id).status).toBe('completed');
  expect(store.listEvents(ws.id).find(e=>String(e.message).startsWith('merge --force'))).toMatchObject({actor:'force-operator'});
});
test('partial gate approval cannot authorize another protected path',async()=>{
  const {ws,c}=setup();const options={workstream:ws.id,stateDir:dir,untilIdle:true,log:()=>{}};
  store.completeActivity(store.claimActivity(ws.id,'w')!.id,'w','STATUS: done');
  const wt=await ensureWorktree(repo,dir,c.id);
  writeFileSync(join(wt.path,'bunfig.toml'),'approved config\n');
  writeFileSync(join(wt.path,'tests/math.test.ts'),'unapproved test\n');
  await runPool(store,options);
  const p=Bun.spawnSync(['bun',resolve('src/cli.ts'),'gate','allow',c.id,'bunfig.toml','--comment','config only'],{env:{...process.env,FABRICA_HOME:dir}});
  expect(p.exitCode).toBe(0);
  await runPool(store,options);
  expect(store.inbox(ws.id)[0]!.error).toBe('GATE_TAMPERED: tests/math.test.ts');
});
