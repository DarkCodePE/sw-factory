import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExecSettings } from '../src/agent/settings.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temp() { const path = await mkdtemp(join(tmpdir(),'fab-cli-')); roots.push(path); return path; }
const entry = fileURLToPath(new URL('../src/cli.ts',import.meta.url));

test('native CLI uses configured BYOK model, explicit environment key and model token ceiling', async () => {
  const cwd = await temp(); let called = 0;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    called++; expect(req.headers.get('authorization')).toBe('Bearer synthetic-key');
    const body = await req.json() as any; expect(body.model).toBe('actual-fixture'); expect(body.max_tokens).toBe(512);
    return Response.json({choices:[{message:{role:'assistant',content:'STATUS: done'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}});
  }});
  const settings = join(cwd,'settings.json');
  await writeFile(settings,JSON.stringify({modelId:'custom:fixture',customModels:[{id:'custom:fixture',model:'actual-fixture',provider:'generic-chat-completion-api',baseUrl:server.url.href+'v1',apiKey:'${NATIVE_TEST_TOKEN}',maxOutputTokens:512}]}));
  try {
    const child = Bun.spawn([process.execPath,'--no-env-file',entry,'exec','--settings',settings,'--cwd',cwd,'-o','json','hello'],{
      env:{PATH:process.env.PATH??'',HOME:cwd,NATIVE_TEST_TOKEN:'synthetic-key'},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const [code,out,err] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(err).toBe(''); expect(called).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ok:true,text:'STATUS: done',usage:{inputTokens:7,outputTokens:3}});
    expect(out).not.toContain('synthetic-key');
  } finally {server.stop(true);}
});

test('unsupported settings policy is rejected rather than ignored', async () => {
  const cwd = await temp(), path = join(cwd,'settings.json');
  await writeFile(path,JSON.stringify({permissions:{deny:['Edit']}}));
  await expect(loadExecSettings(path)).rejects.toThrow('Unsupported settings field: permissions');
});

test('CLI tool catalog enumerates the installed native capabilities', async () => {
  const cwd = await temp();
  const child = Bun.spawn([process.execPath,'--no-env-file',entry,'exec','--list-tools','-o','json'],{
    cwd,env:{PATH:process.env.PATH??'',HOME:cwd},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const [code,out] = await Promise.all([child.exited,new Response(child.stdout).text()]);
  expect(code).toBe(0);
  const tools = JSON.parse(out);
  expect(tools.map((t:any)=>t.llmId)).toContain('Script'); expect(tools.map((t:any)=>t.llmId)).toContain('Task');
  expect(tools.find((t:any)=>t.llmId==='Execute')).toMatchObject({currentlyAllowed:true,conditional:true});
});

test('empty model turns serialize valid assistant content before recovery', async () => {
  const {createOpenAICompatibleProvider,runCodingAgent}=await import('../src/agent/index.ts');
  const cwd=await temp();let requests=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const body=await req.json() as any; requests++;
    if(body.messages.some((m:any)=>m.role==='assistant' && m.content===null && !m.tool_calls?.length)) return Response.json({error:{message:'invalid message content type: <nil>'}},{status:400});
    return Response.json({choices:[{message:{role:'assistant',content:requests===1?'':'done'},finish_reason:'stop'}]});
  }});
  try{
    const provider=createOpenAICompatibleProvider({model:'fixture',baseUrl:server.url.href+'v1'});
    expect(await runCodingAgent({prompt:'recover',cwd,provider})).toMatchObject({ok:true,text:'done',turns:2});
    expect(requests).toBe(2);
  }finally{server.stop(true);}
});
