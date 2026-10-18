// `fab` with no arguments: an interactive terminal chat with the fab coding agent.
// Each prompt is one agent run on the same persisted session, so the conversation continues.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as readline from 'node:readline/promises';

import { runCodingAgent } from './agent/engine.ts';
import { defaultAuthFile } from './agent/chatgpt.ts';
import { configuredProviders, loadExecSettings } from './agent/settings.ts';
import type { AgentEvent, Autonomy, PermissionRequest } from './agent/types.ts';

const AUTONOMIES: Autonomy[] = ['off', 'low', 'medium', 'high'];
const c = (code: string) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2'), bold = c('1'), cyan = c('36'), red = c('31'), green = c('32'), yellow = c('33');

export interface ChatConfig { model: string; autonomy: Autonomy }

const home = () => resolve(process.env.FABRICA_HOME ?? join(homedir(), '.fabrica'));
const configPath = () => join(home(), 'chat.json');

/** Model precedence: FABRICA_LLM_MODEL, saved choice, ChatGPT if Codex is logged in, local Ollama. */
export function loadChatConfig(): ChatConfig {
  let saved: Partial<ChatConfig> = {};
  try { saved = JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* first run */ }
  const model = process.env.FABRICA_LLM_MODEL ?? saved.model ?? (existsSync(defaultAuthFile()) ? 'chatgpt:gpt-6-luna' : 'qwen3.5-32k:latest');
  const autonomy = AUTONOMIES.includes(saved.autonomy as Autonomy) ? saved.autonomy as Autonomy : 'medium';
  return { model, autonomy };
}

function saveChatConfig(config: ChatConfig) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}

/** One-line description of a tool call, e.g. `Execute bun test` or `Read src/calc.ts`. */
export function describeCall(name: string, args: string): string {
  let input: Record<string, unknown> = {};
  try { input = JSON.parse(args); } catch { /* show the name only */ }
  const target = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description;
  const text = typeof target === 'string' ? target.replace(/\s+/g, ' ') : '';
  return text ? `${name} ${text.length > 100 ? text.slice(0, 97) + '…' : text}` : name;
}

/** Short summary of a tool result for the transcript. */
export function describeResult(value: unknown, isError: boolean): string {
  if (isError) return red(`error: ${String((value as { message?: unknown })?.message ?? value).split('\n')[0]!.slice(0, 160)}`);
  const v = value as Record<string, unknown> | null;
  if (v && typeof v.exitCode === 'number') return v.exitCode === 0 ? green('exit 0') : yellow(`exit ${v.exitCode}`);
  if (typeof value === 'string') return dim(`${value.split('\n').length} líneas`);
  return green('ok');
}

export type SlashResult = { kind: 'prompt'; text: string } | { kind: 'command'; name: string; arg: string } | { kind: 'empty' };

export function parseInput(line: string): SlashResult {
  const text = line.trim();
  if (!text) return { kind: 'empty' };
  if (!text.startsWith('/')) return { kind: 'prompt', text };
  const [name, ...rest] = text.slice(1).split(/\s+/);
  return { kind: 'command', name: name!.toLowerCase(), arg: rest.join(' ') };
}

const HELP = `${bold('Comandos')}
  /model <id>    cambia de modelo (chatgpt:gpt-6-luna, qwen3.5-32k:latest, custom:…)
  /auto <nivel>  autonomía: off · low · medium · high
  /new           empieza una conversación nueva
  /status        modelo, autonomía, carpeta y sesión
  /exit          salir (también Ctrl+D)
${dim('Ctrl+C interrumpe el turno en curso. Una línea terminada en \\ continúa en la siguiente.')}`;

export async function chatMain(argv: string[]): Promise<number> {
  const cwd = resolve(argv.find(a => !a.startsWith('-')) ?? process.cwd());
  const config = loadChatConfig();
  const settings = await loadExecSettings(process.env.FABRICA_AGENT_SETTINGS);
  const providerFor = (model: string) => {
    const configured = configuredProviders({ ...settings, modelId: model }, {
      model, baseUrl: process.env.FABRICA_LLM_BASE_URL ?? (model.startsWith('chatgpt:') ? undefined : 'http://127.0.0.1:11434/v1'),
      apiKey: process.env.FABRICA_LLM_API_KEY,
    });
    return configured.providers[configured.defaultModelId]!;
  };
  let provider = providerFor(config.model);
  let sessionId: string | undefined;
  let running: AbortController | undefined;
  const sessionDir = join(home(), 'agent-sessions');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  rl.on('SIGINT', () => {
    if (running) { running.abort(new Error('Interrumpido por el usuario')); process.stdout.write(yellow('\n⏹ interrumpido\n')); }
    else { process.stdout.write(dim('\n(Ctrl+D o /exit para salir)\n')); rl.prompt(); }
  });

  const permission = async (request: PermissionRequest): Promise<'proceed_once' | 'cancel'> => {
    const use = request.toolUses[0]?.toolUse;
    const what = use ? describeCall(use.name, JSON.stringify(use.input)) : 'esta acción';
    const answer = (await rl.question(yellow(`\n¿Permitir ${what}? [s/N] `))).trim().toLowerCase();
    return answer === 's' || answer === 'si' || answer === 'sí' || answer === 'y' ? 'proceed_once' : 'cancel';
  };

  const onEvent = (event: AgentEvent) => {
    if (event.type === 'assistant_delta') process.stdout.write(String(event.text));
    else if (event.type === 'tool_call') process.stdout.write(`\n${cyan('●')} ${describeCall(String(event.toolName), String(event.arguments))}\n`);
    else if (event.type === 'tool_result') process.stdout.write(`  ${dim('⎿')} ${describeResult(event.value, event.isError === true)}\n`);
    else if (event.type === 'compaction') process.stdout.write(dim('\n(contexto compactado)\n'));
  };

  console.log(`${bold('fab')} ${dim('· agente de código')}  ${cyan(config.model)} ${dim(`· auto ${config.autonomy} · ${cwd}`)}`);
  console.log(dim('Escribe una tarea, o /help.\n'));

  let buffer = '';
  for (;;) {
    let line: string;
    try { line = await rl.question(buffer ? dim('… ') : bold('› ')); }
    catch { break; } // stdin closed (Ctrl+D)
    if (line.endsWith('\\')) { buffer += line.slice(0, -1) + '\n'; continue; }
    const input = parseInput(buffer + line); buffer = '';
    if (input.kind === 'empty') continue;
    if (input.kind === 'command') {
      if (input.name === 'exit' || input.name === 'quit') break;
      if (input.name === 'help') console.log(HELP);
      else if (input.name === 'new') { sessionId = undefined; console.log(dim('Conversación nueva.')); }
      else if (input.name === 'status') console.log(`modelo ${config.model} · auto ${config.autonomy} · ${cwd} · sesión ${sessionId ?? '(nueva)'}`);
      else if (input.name === 'auto' && AUTONOMIES.includes(input.arg as Autonomy)) {
        config.autonomy = input.arg as Autonomy; saveChatConfig(config); console.log(dim(`autonomía: ${config.autonomy}`));
      } else if (input.name === 'model' && input.arg) {
        try { provider = providerFor(input.arg); config.model = input.arg; saveChatConfig(config); console.log(dim(`modelo: ${config.model}`)); }
        catch (error) { console.log(red(error instanceof Error ? error.message : String(error))); }
      } else console.log(red(`Comando desconocido o incompleto: /${input.name}. Prueba /help.`));
      continue;
    }
    running = new AbortController();
    try {
      const result = await runCodingAgent({
        prompt: input.text, cwd, provider, autonomy: config.autonomy, interactionMode: 'auto',
        sessionDir, sessionId, signal: running.signal, onEvent, permissionHandler: permission,
      });
      sessionId = result.sessionId;
      if (!result.ok && !running.signal.aborted) console.log(red(`\n${result.error?.type}: ${result.error?.message}`));
      console.log(dim(`\n${result.turns} turnos · ${result.toolCalls} herramientas · ${(result.durationMs / 1000).toFixed(1)} s\n`));
    } catch (error) {
      console.log(red(`\n${error instanceof Error ? error.message : String(error)}\n`));
    } finally { running = undefined; }
  }
  rl.close();
  return 0;
}
