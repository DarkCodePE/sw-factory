import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export function mockModel(workerCommand = 'sh -c "printf x >> count; touch started; sleep 30; touch late"') {
  const requests: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as any; requests.push(body);
    const messages = body.messages as any[];
    const texts = messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'));
    const task = texts.filter(t => /^(slow|next|one|two|three|recover|hook-demo|mission-crash|mission-resume)/.test(t)).at(-1) ?? texts.at(-1) ?? '';
    const assigned = texts.find(t => t.startsWith('Assigned mission feature '));
    const toolMessages = messages.filter(m => m.role === 'tool');
    let calls: Array<[string, unknown]> = [], text = 'fixture: ' + task;
    const handoff = { featureId: 'one', successState: 'success', returnToOrchestrator: false, handoff: {
      salientSummary: 'Completed the deterministic mission fixture.', whatWasImplemented: 'Reviewed the assigned fixture and preserved the protected contract file with observed verification.', whatWasLeftUndone: '',
      verification: { commandsRun: [] }, tests: { added: [], coverage: 'Independent verification.' }, discoveredIssues: [] } };
    if (assigned) {
      if (!toolMessages.length) calls = [['Execute', { command: assigned.includes('role worker.') ? workerCommand : 'cat contract.txt' }]];
      else if (!messages.some(m => m.role === 'assistant' && m.tool_calls?.some((t: any) => t.function.name === 'EndFeatureRun'))) calls = [['EndFeatureRun', handoff]];
    } else if (task.startsWith('mission-')) {
      const resume = /^mission-resume ([\w-]+)/.exec(task);
      if (resume) {
        const boundary = messages.map(m => m.role === 'user' && m.content === task).lastIndexOf(true);
        if (!messages.slice(boundary).some(m => m.role === 'assistant' && m.tool_calls?.some((t: any) => t.function.name === 'StartMissionRun'))) calls = [['StartMissionRun', { resumeWorkerSessionId: resume[1], messageToWorker: 'Inspect interrupted effects before continuing.' }]];
      } else if (!messages.some(m => m.tool_calls?.some((t: any) => t.function.name === 'ProposeMission'))) calls = [['ProposeMission', { title: 'Crash fixture', proposal: 'Verify one protected fixture feature with independent validators.' }]];
      else if (!messages.some(m => m.tool_calls?.some((t: any) => t.function.name === 'Create'))) {
        const dir = JSON.parse(toolMessages.at(-1).content).missionDir;
        calls = [['Create', { file_path: join(dir, 'features.json'), content: JSON.stringify({ features: [{ id: 'one', description: 'Review the fixed contract.', skillName: 'fixture', milestone: 'first', status: 'pending', preconditions: [], expectedBehavior: ['Contract intact'], fulfills: [], verificationCommands: ['cat contract.txt'], protectedPaths: ['contract.txt'] }] }) }],
          ['Create', { file_path: join(dir, 'skills/fixture/SKILL.md'), content: '---\nname: fixture\ndescription: Inspect fixture.\n---\nInspect actual evidence.' }]];
      } else if (!messages.some(m => m.tool_calls?.some((t: any) => t.function.name === 'StartMissionRun'))) calls = [['StartMissionRun', {}]];
    } else if (task === 'slow' && messages.at(-1).role === 'user') calls = [['Execute', { command: 'sh -c "printf x >> count; touch started; sleep 30; touch late"' }]];
    else if (task === 'hook-demo' && !toolMessages.length) calls = [['LS', {}]];
    if (calls.length) text = '';
    return Response.json({ choices: [{ message: { role: 'assistant', content: text,
      ...(calls.length ? { tool_calls: calls.map(([name, input]) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  return { server, requests };
}

export async function demo(dir: string) {
  await mkdir(join(dir, 'work/.fab'), { recursive: true }); await mkdir(join(dir, 'bin'), { recursive: true });
  const { server } = mockModel();
  const source = resolve(import.meta.dir, '../src/cli.ts');
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await writeFile(join(dir, 'bin/fab'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' --no-env-file ' + quote(source) + ' "$@"\n', { mode: 0o700 });
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ modelId: 'custom:fixture', customModels: [{ id: 'custom:fixture', model: 'fixture', provider: 'generic-chat-completion-api', baseUrl: server.url.href + 'v1' }] }));
  await writeFile(join(dir, 'work/contract.txt'), 'intact\n');
  await writeFile(join(dir, 'work/.fab/hooks.json'), JSON.stringify({ SessionStart: [{ hooks: [{ type: 'command', command: 'printf "session-start:$FAB_PROJECT_DIR"' }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf "hook-context"' }] }], PreToolUse: [{ matcher: 'LS', hooks: [{ type: 'command', command: 'printf \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\'' }] }], SessionEnd: [{ hooks: [{ type: 'command', command: 'printf ended > hook-ended' }] }] }));
  await writeFile(join(dir, 'ready'), String(server.port));
  return server;
}
if (import.meta.main && process.argv[2] === '--serve') { await demo(resolve(process.argv[3]!)); }
