// Opt-in acceptance/counterexample probe. Writes only a NEW disposable fixture.
// No model service, Droid binary, secrets, commits or existing repositories.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodingAgent } from '../src/agent/engine.ts';
import type { ModelProvider, ModelTurn } from '../src/agent/types.ts';

const scenario = process.argv[2] ?? 'forged';
if (!['truthful', 'forged'].includes(scenario)) throw new Error('Scenario must be truthful or forged');
const requested = process.argv[3];
if (requested && (!isAbsolute(requested) || existsSync(requested))) throw new Error('Fixture must be a NEW absolute directory');
const root = requested ? resolve(requested) : mkdtempSync(join(tmpdir(), 'fab-mission-probe-'));
mkdirSync(root, { recursive: true }); const cwd = join(root, 'repo'); mkdirSync(cwd);
writeFileSync(join(cwd, 'calc.ts'), 'export const add = (a:number,b:number) => a-b;\n');
writeFileSync(join(cwd, 'calc.test.ts'), "import {test,expect} from 'bun:test';import {add} from './calc';test('add',()=>expect(add(2,3)).toBe(5));\n");
const done = (): ModelTurn => ({ text: 'STATUS: done', toolCalls: [], finishReason: 'stop' });
const call = (name: string, input: unknown): ModelTurn => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } }] });
const handoff = (observed: boolean) => ({ successState: 'success', returnToOrchestrator: false, featureId: 'add', validatorsPassed: true,
  handoff: { salientSummary: 'Synthetic acceptance-test handoff for arithmetic.',
    whatWasImplemented: observed ? 'The fixture performed its assigned tool operation; independent test execution is recorded separately.' : 'This is a deliberately forged assertion. No implementation or verification was performed by this fixture role.',
    whatWasLeftUndone: '', verification: { commandsRun: [] }, tests: { added: [], coverage: observed ? 'See actual tool trace and independent test result.' : 'Deliberately false verification claim.' }, discoveredIssues: [] } });
let parent = 0, directory = '';
const turns = new Map<string, number>(), trace: unknown[] = [];
const provider: ModelProvider = { id: 'deterministic-mission-probe', async complete(request) {
  const prompt = request.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Assigned mission feature '))?.content as string | undefined;
  if (prompt) {
    const role = /role ([\w-]+)\./.exec(prompt)![1]!, n = turns.get(role) ?? 0; turns.set(role, n + 1);
    if (scenario === 'truthful' && !n) return role === 'worker' ? call('Edit', { file_path: 'calc.ts', old_str: 'a-b', new_str: 'a+b' }) : call('Execute', { command: 'bun test' });
    if (n === (scenario === 'truthful' ? 1 : 0)) return call('EndFeatureRun', handoff(scenario === 'truthful'));
    return done();
  }
  if (!parent++) return call('ProposeMission', { title: 'Arithmetic acceptance', proposal: 'Correct addition and verify using an independent test.' });
  if (parent === 2) {
    directory = JSON.parse(request.messages.at(-1)!.content as string).missionDir;
    return call('Create', { file_path: join(directory, 'features.json'), content: JSON.stringify({ features: [{ id: 'add', description: 'Fix addition', skillName: 'fixture', milestone: 'smoke', expectedBehavior: ['add(2,3) equals 5'], verificationCommands: ['bun test'], protectedPaths: ['calc.test.ts'], status: 'pending' }] }) });
  }
  if (parent === 3) return call('Create', { file_path: join(directory, 'skills/fixture/SKILL.md'), content: '---\nname: fixture\ndescription: Test synthetic arithmetic.\n---\nUse actual observations.' });
  if (parent === 4) return call('StartMissionRun', {});
  return done();
} };
const runtime = await runCodingAgent({ prompt: 'Run the synthetic acceptance mission.', cwd, provider, autonomy: 'high', interactionMode: 'mission',
  sessionDir: join(root, 'sessions'), timeoutMs: 15_000, onEvent: event => trace.push(event) });
const verification = Bun.spawnSync([process.execPath, 'test'], { cwd });
const contractSatisfied = runtime.ok && (scenario === 'truthful'
  ? runtime.mission?.state === 'completed' && verification.exitCode === 0
  : runtime.mission?.state !== 'completed' && verification.exitCode === 1);
const report = { scenario, contractSatisfied, fixture: root, runtime, independentTest: { exitCode: verification.exitCode, stdout: verification.stdout.toString(), stderr: verification.stderr.toString() } };
writeFileSync(join(root, 'trace.ndjson'), trace.map(event => JSON.stringify(event)).join('\n') + '\n');
writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report)); process.exitCode = contractSatisfied ? 0 : 1;
