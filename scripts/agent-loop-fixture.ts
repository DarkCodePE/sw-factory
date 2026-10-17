// Offline, deterministic model fixture for REA black-box probes. It stores shapes,
// never system prompts, credentials, or proprietary tool descriptions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(process.env.FIXTURE_OUT ?? './probe-output');
mkdirSync(out, { recursive: true });
const turns = new Map<string, number>();
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(process.env.PORT ?? 11436),
  async fetch(req) {
    const scenario = new URL(req.url).pathname.split('/')[1] ?? 'read-edit';
    const body = await req.json() as any;
    const metadata = !Array.isArray(body.tools) || !body.tools.length;
    const key = scenario + (metadata ? '-metadata' : '');
    const n = (turns.get(key) ?? 0) + 1;
    turns.set(key, n);
    mkdirSync(resolve(out, scenario), { recursive: true });
    writeFileSync(resolve(out, scenario, `${metadata ? 'metadata-' : ''}${n}.json`), JSON.stringify({
      scenario, turn: n, metadata, stream: body.stream, model: body.model, toolNames: body.tools?.map((t:any)=>t.function?.name),
      messages: body.messages?.map((m: any) => ({
        role: m.role, tool_call_id: m.tool_call_id,
        tool_calls: m.tool_calls?.map((t: any) => ({ id: t.id, name: t.function?.name })),
        // Only synthetic fixture data and reminders; exclude system/tool schemas.
        content: m.role === 'tool' ? String(m.content).slice(0, 1000) : undefined,
      })),
    }, null, 2));
    const worker = body.tools?.some((t:any)=>t.function?.name === 'EndFeatureRun');
    if (process.env.CAPTURE_CONTRACTS === '1' && (n === 1 || worker) && !metadata) {
      // Protocol field names and types only. Exclude proprietary prose/prompts.
      const strip = (v: any, fields = false): any => Array.isArray(v) ? v.map(x => strip(x)) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([k]) => fields || !['description', 'title', 'examples', 'default'].includes(k)).map(([k, value]) => [k, strip(value, ['properties', '$defs', 'definitions'].includes(k))])) : v;
      writeFileSync(resolve(out, scenario, worker ? 'worker-tool-contracts.json' : 'tool-contracts.json'), JSON.stringify(body.tools.map((t:any) => ({name:t.function?.name,parameters:strip(t.function?.parameters)})), null, 2));
    }
    let message: any = { role: 'assistant', content: 'STATUS: done\nPrueba local completada.' };
    let finish = 'stop';
    const call = (name: string, input: unknown) => {
      finish = 'tool_calls';
      message = { role: 'assistant', content: null, tool_calls: [{
        id: `fixture-${n}`, type: 'function', function: { name, arguments: JSON.stringify(input) },
      }] };
    };
    if (metadata) { message.content = 'Local fixture session';
    } else if (worker && scenario.includes('handoff-valid') && n === 5) {
      call('EndFeatureRun', {successState:'partial',returnToOrchestrator:true,featureId:'add',handoff:{
        salientSummary:'Synthetic protocol handoff without implementation.',
        whatWasImplemented:'No implementation was attempted. This worker only exercised the local synthetic handoff protocol.',
        whatWasLeftUndone:'The arithmetic implementation and all tests remain undone.',verification:{commandsRun:[]},
        tests:{added:[],coverage:'No tests were run.'},discoveredIssues:[]}});
    } else if (worker && scenario.includes('handoff') && n === 5) {
      call('EndFeatureRun', {});
    } else if (scenario.includes('mission-features') && n === 1) {
      call('ProposeMission', {title:'Synthetic arithmetic mission', proposal:'Inspect calc.ts, implement addition, run the local test, and report the result.'});
    } else if (scenario.includes('mission-features') && n === 2) {
      const result = body.messages?.filter((m:any)=>m.role === 'tool').at(-1)?.content;
      const missionDir = JSON.parse(result).missionDir;
      if (!missionDir?.startsWith(resolve(out,scenario,'home/.factory/missions')+'/')) throw new Error('Invalid owned fixture mission directory');
      call('Create', {file_path:resolve(missionDir,'features.json'),content:JSON.stringify({features:[{id:'add',description:'Fix addition in calc.ts',skillName:'fixture',status:'pending',preconditions:[],expectedBehavior:['add(2,3) equals 5'],verificationSteps:['bun test'],fulfills:[],milestone:'smoke'}]})});
    } else if (scenario.includes('mission-features-v2') && n === 3) {
      const result = body.messages?.filter((m:any)=>m.role === 'tool').map((m:any)=>{try{return JSON.parse(m.content);}catch{return {};}}).find((r:any)=>r.missionDir);
      if (!result?.missionDir?.startsWith(resolve(out,scenario,'home/.factory/missions')+'/')) throw new Error('Invalid owned fixture mission directory');
      call('Create', {file_path:resolve(result.missionDir,'skills/fixture/SKILL.md'),content:'---\nname: fixture\ndescription: Verify synthetic arithmetic locally.\n---\nInspect calc.ts and report the observed arithmetic. Use only the local fixture workspace.'});
    } else if (scenario.includes('mission-features-v2') && n === 4 || scenario.includes('mission-features') && n === 3) {
      call('StartMissionRun', {});
    } else if (scenario.includes('mission-run') && n === 1) {
      call('ProposeMission', {title:'Synthetic arithmetic mission', proposal:'Inspect calc.ts, implement addition, run the local test, and report the result.'});
    } else if (scenario.includes('mission-run') && n === 2) {
      call('StartMissionRun', {});
    } else if (scenario.includes('mission-proposal') && n === 1) {
      call('ProposeMission', {title:'Synthetic arithmetic mission', proposal:'Inspect calc.ts, implement addition, run the local test, and report the result.'});
    } else if (scenario.includes('spec-valid') && n === 1) {
      call('ExitSpecMode', {plan:'Inspect calc.ts, replace subtraction with addition, and run bun test. Synthetic local plan.'});
    } else if (scenario.includes('mission-contract') && n === 1) {
      call('ProposeMission', {});
    } else if (scenario.includes('spec-contract') && n === 1) {
      call('ExitSpecMode', {});
    } else if (scenario.includes('permission') && n === 1) {
      call('Create', {file_path:resolve(out,scenario,'work/created.txt'),content:'permission-probe'});
    } else if (scenario.includes('ask-user') && n === 1) {
      call('AskUser', {questionnaire:'1. [question] Choose a color\n[topic] Color\n[option] red\n[option] blue'});
    } else if (scenario.includes('read-edit')) {
      if (n === 1) call('Read', { file_path: 'calc.py' });
      if (n === 2) call('Edit', { file_path: 'calc.py', old_str: 'a - b', new_str: 'a + b' });
    } else if (scenario.includes('tool-error') && n === 1) {
      call('Read', { file_path: 'does-not-exist.txt' });
    } else if (scenario.includes('truncated') && n === 1) {
      message.content = ''; finish = 'length';
    }
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      'data: ' + JSON.stringify({ id: `fixture-${n}`, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((t: any, index: number) => ({ ...t, index })) }
      : { role: 'assistant', content: message.content };
    return new Response(chunk(delta) + chunk({}, finish) + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});
console.log(`fixture ${server.url}`);
