import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { listConfiguredToolCatalog, runCodingAgent } from '../agent/engine.ts';
import { estimatedTokens } from '../agent/provider.ts';
import { configuredProviders, type ExecSettings } from '../agent/settings.ts';
import type { AgentEvent, AgentOptions, AgentResult, ModelProvider, PermissionRequest, ToolContext, UserAnswers } from '../agent/types.ts';
import { detectSandbox } from '../sandbox/index.ts';
import { AUTONOMIES, loadChatConfig, saveChatConfig, terminalText, type ChatConfig } from './config.ts';
import { CHAT_COMMANDS, commandFor, commandHelp, parseInput } from './commands.ts';
import { compressSession, editSession, forkSession, listSessions } from './sessions.ts';
import { projectItems, projectPrompt } from './project.ts';
import { Checkpoints } from './checkpoints.ts';
import { PromptHistory } from './history.ts';
import type { FileChange } from './render.ts';
import type { StatusState } from './presentation.ts';

export interface ChatIO {
  write(text: string): void;
  question(prompt: string, signal?: AbortSignal, options?: { fresh?: boolean }): Promise<string>;
  select(prompt: string, choices: string[], signal?: AbortSignal): Promise<number | undefined>;
  work?(label?: string): void;
  assistant?(text: string, final?: boolean): void;
  diff?(change: FileChange, expanded: boolean): void;
  expand?(expanded: boolean): void;
  update?(state: StatusState): void;
  setHistory?(entries: string[]): void;
}
export interface ChatOptions {
  cwd: string; home: string; settings?: ExecSettings; config?: ChatConfig;
  agent?: Pick<AgentOptions, 'timeoutMs' | 'maxTurns' | 'maxContextTokens' | 'sandbox' | 'appendSystemPrompt' | 'onlyTools' | 'removeTools'>;
  providerFor?: (model: string) => ModelProvider;
  run?: typeof runCodingAgent;
}
/** Shared command/application state used by the terminal and deterministic integration tests. */
export class ChatController {
  cwd: string;
  config: ChatConfig;
  sessionId?: string;
  detailed = false;
  private active?: AbortController;
  private disabledMcp = new Set<string>();
  private only?: string[];
  private removed?: string[];
  private defaults: ChatConfig;
  private settings: ExecSettings;
  private lastResult?: AgentResult;
  private customNames: string[] = [];
  private tokens = { inputTokens: 0, outputTokens: 0 };
  private turnUsage = { inputTokens: 0, outputTokens: 0 };
  private contextTokens = 0;
  constructor(readonly options: ChatOptions, readonly io: ChatIO) {
    this.cwd = options.cwd; this.settings = options.settings ?? {};
    this.config = options.config ?? loadChatConfig(this.settings, options.home);
    this.defaults = { ...this.config }; this.only = options.agent?.onlyTools; this.removed = options.agent?.removeTools;
  }
  get sessionDir() { return join(this.options.home, 'agent-sessions'); }
  get busy() { return !!this.active; }
  get modelIds() { return [...new Set([this.config.model, ...this.settings.customModels?.map(m => m.id) ?? []])]; }
  get customCommands() { return this.customNames; }
  get mcpServers() { return Object.fromEntries(Object.entries(this.settings.mcpServers ?? {}).filter(([name]) => !this.disabledMcp.has(name))); }
  print(value: unknown) { this.io.write(terminalText(value) + '\n'); }
  status() { return `${this.config.model} · ${this.config.mode} · auto ${this.config.autonomy} · ${this.cwd} · sesión ${this.sessionId ?? '(nueva)'}`; }
  get statusState(): StatusState { return { model: this.config.model, mode: this.config.mode, autonomy: this.config.autonomy,
    inputTokens: this.tokens.inputTokens + this.turnUsage.inputTokens, outputTokens: this.tokens.outputTokens + this.turnUsage.outputTokens,
    contextTokens: this.contextTokens, maxContextTokens: this.options.agent?.maxContextTokens ?? 32000 }; }
  toggleDetail() { this.detailed = !this.detailed; this.io.expand?.(this.detailed); }
  async syncHistory() { this.io.setHistory?.(await new PromptHistory(this.options.home, this.cwd).load()); }
  interrupt() { this.active?.abort(new Error('Interrumpido por el usuario')); }
  provider() {
    if (this.options.providerFor) return this.options.providerFor(this.config.model);
    const configured = configuredProviders({ ...this.settings, modelId: this.config.model }, {
      model: this.config.model, baseUrl: process.env.FABRICA_LLM_BASE_URL, apiKey: process.env.FABRICA_LLM_API_KEY,
    });
    return configured.providers[configured.defaultModelId]!;
  }
  async refreshCommands() { this.customNames = await projectItems(this.cwd, 'commands'); }
  private persist() { saveChatConfig(this.config, this.options.home); }
  setMode(value: string) {
    if (!['auto', 'spec', 'mission'].includes(value)) throw new Error('Modo: auto, spec o mission');
    if (value === 'mission' && this.config.autonomy !== 'high') throw new Error('Mission exige /auto high explícito');
    this.config.mode = value as ChatConfig['mode']; this.print(this.status());
  }
  cycleMode() {
    const modes = this.config.autonomy === 'high' ? ['auto', 'spec', 'mission'] : ['auto', 'spec'];
    this.setMode(modes[(modes.indexOf(this.config.mode) + 1) % modes.length]!);
  }
  async changeModel(id?: string) {
    if (!id) {
      const n = await this.io.select('Modelo (cancela con Enter; /model <id> admite otro ID)', this.modelIds, this.active?.signal);
      if (n === undefined) return; id = this.modelIds[n]!;
    }
    const previous = this.config.model; this.config.model = id;
    try { this.provider(); } catch (e) { this.config.model = previous; throw e; }
    this.persist(); this.print(this.status());
  }
  private requireSession() { if (!this.sessionId) throw new Error('No hay una sesión guardada; envía primero una tarea'); return this.sessionId; }
  async resume(id = '', last = false) {
    if (!id) {
      const { sessions, truncated } = await listSessions(this.sessionDir, this.cwd);
      if (truncated) this.print('Listado parcial: usa /search para acotar');
      if (!sessions.length) { this.print('Sin sesiones en esta carpeta'); return; }
      const n = last ? sessions.reduce((best, s, i) => s.updatedAt > sessions[best]!.updatedAt ? i : best, 0)
        : await this.io.select('Reanudar sesión', sessions.map(s => `${s.pinned ? '★ ' : ''}${s.id} · ${s.title} · ${s.blocked ? 'requiere reconciliación' : s.status}`), this.active?.signal);
      if (n === undefined) return; id = sessions[n]!.id;
    }
    await editSession(this.sessionDir, id, this.cwd, s => { s.archived = false; });
    this.sessionId = id; this.print(this.status());
  }
  private permission = async (request: PermissionRequest, context: ToolContext): Promise<'proceed_once' | 'cancel'> => {
    this.print('Permiso para esta llamada (sin autorización permanente):');
    for (const use of request.toolUses) this.print(`${use.toolUse.name}\n${JSON.stringify(use.toolUse.input, null, 2)}`);
    const answer = (await this.io.question('¿Permitir una vez? [s/N] ', context.signal, { fresh: true })).trim().toLowerCase();
    return ['s', 'si', 'sí', 'y'].includes(answer) ? 'proceed_once' : 'cancel';
  };
  private askUser = async (request: Parameters<NonNullable<AgentOptions['askUserHandler']>>[0], context: ToolContext): Promise<UserAnswers> => {
    const answers: UserAnswers['answers'] = [];
    for (const q of request.questions) {
      this.print(`${q.topic}: ${q.question}`);
      q.options.forEach((option, i) => this.print(`  ${i + 1}. ${option}`));
      const value = (await this.io.question('Respuesta (Enter cancela): ', context.signal, { fresh: true })).trim();
      if (!value) return { cancelled: true, answers };
      const chosen = /^\d+$/.test(value) ? q.options[Number(value) - 1] : undefined;
      answers.push({ index: q.index, question: q.question, answer: chosen ?? value });
    }
    return { answers };
  };
  async runPrompt(prompt: string, side = false) {
    let streamed = '', finalText = '';
    const previousId = this.sessionId;
    const checkpoints = new Checkpoints(this.cwd, this.options.home);
    const changed = new Set<string>();
    this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    if (!side) {
      const history = new PromptHistory(this.options.home, this.cwd); await history.load();
      try { await history.add(prompt); this.io.setHistory?.(history.entries); } catch { this.print('No se pudo guardar el historial local de prompts'); }
      await checkpoints.begin(prompt);
    }
    const assistant = (text: string, final = false) => this.io.assistant ? this.io.assistant(text, final) : this.io.write(text + (final ? '\n' : ''));
    this.io.work?.('Modelo');
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'assistant_delta') { const t = terminalText(event.text); this.io.work?.(); assistant(t); streamed += t; }
      else if (event.type === 'assistant') {
        const full = terminalText(event.text);
        assistant(full.startsWith(streamed) ? full.slice(streamed.length) : full, true);
        streamed = ''; finalText = String(event.text);
      } else if (event.type === 'tool_call') { this.io.work?.(String(event.toolName)); this.print(`● ${event.toolName}${this.detailed ? ' ' + event.arguments : ''}`); }
      else if (event.type === 'tool_result') {
        if (!changed.delete(String(event.id))) this.print(this.detailed ? JSON.stringify(event.value) : `  ${event.isError ? 'error' : 'ok'}`);
        this.io.work?.('Modelo');
      } else if (event.type === 'usage') {
        const usage = event.usage as typeof this.turnUsage;
        if (usage && ['inputTokens', 'outputTokens'].every(k => Number.isSafeInteger(usage[k as keyof typeof usage]) && usage[k as keyof typeof usage] >= 0)) this.turnUsage = { ...usage };
        if (typeof event.contextTokens === 'number' && Number.isFinite(event.contextTokens)) this.contextTokens = Math.max(0, event.contextTokens);
        this.io.update?.(this.statusState);
      }
      else if (event.type === 'compaction') this.print('(contexto compactado)');
      else if (event.type.startsWith('mission_')) this.print(JSON.stringify(event));
    };
    try {
    const result = await (this.options.run ?? runCodingAgent)({ ...this.options.agent,
      prompt, cwd: this.cwd, provider: this.provider(), autonomy: side ? 'off' : this.config.autonomy,
      interactionMode: side ? 'spec' : this.config.mode, mcpServers: this.mcpServers,
      sessionDir: side ? undefined : this.sessionDir, sessionId: side ? undefined : this.sessionId,
      onlyTools: this.only, removeTools: this.removed, signal: this.active?.signal, onEvent,
      permissionHandler: side ? undefined : this.permission, askUserHandler: this.askUser,
      fileJournal: side ? undefined : {
        barrier: (name, context) => checkpoints.barrier(name, context),
        prepare: async (change, context) => {
          const applied = await checkpoints.prepare(change, context);
          return async snapshot => {
            await applied(snapshot); changed.add(context.toolUseId ?? '');
            if (this.io.diff) this.io.diff({ ...change, after: snapshot.data, mode: snapshot.mode }, this.detailed);
            else { const { renderDiff } = await import('./render.ts'); this.io.write(renderDiff(change)); }
          };
        },
      },
    });
    this.tokens.inputTokens += result.usage.inputTokens; this.tokens.outputTokens += result.usage.outputTokens;
    this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    if (result.text && result.text !== finalText) assistant(result.text, true);
    else if (streamed) { assistant('', true); streamed = ''; }
    if (!side) {
      // Keep IDs only when the snapshot is resumable. Never clear/replay ambiguous pending calls.
      try {
        await editSession(this.sessionDir, result.sessionId, this.cwd, () => {}, false);
        this.sessionId = result.sessionId;
      } catch {
        this.sessionId = undefined;
        this.print(`Sesión ${result.sessionId} conservada para inspección; no se reanuda automáticamente. Usa /sessions o /new.`);
      }
      this.lastResult = result;
    } else this.sessionId = previousId;
    if (!result.ok) this.print(`${result.error?.type}: ${result.error?.message}`);
    this.print(`${result.turns} turnos · ${result.toolCalls} tools · ${(result.durationMs / 1000).toFixed(1)} s`);
    return result;
    } finally { this.io.work?.(); assistant('', true); await checkpoints.finish(); this.io.update?.(this.statusState); }
  }
  async submit(line: string): Promise<boolean> {
    if (this.active) throw new Error('Hay una operación en curso');
    const input = parseInput(line); if (input.kind === 'empty') return true;
    this.active = new AbortController();
    const operation = this.active;
    const timer = setTimeout(() => operation.abort(new Error('Tiempo total de la operación agotado')), this.options.agent?.timeoutMs ?? 1200000);
    try {
      if (input.kind === 'prompt') { await this.runPrompt(input.text); return true; }
      const command = commandFor(input.name);
      if (command?.unavailable) { this.print(command.unavailable); return true; }
      const name = command?.name ?? input.name, arg = input.arg;
      switch (name) {
        case 'exit': return false;
        case 'help': this.print(commandHelp()); break;
        case 'rewind': {
          this.print('Rewind solo de Edit/Create. Nunca revierte Execute, otros efectos ni el historial de conversación; conserva directorios vacíos.');
          const journal = new Checkpoints(this.cwd, this.options.home);
          if (arg === 'list') { for (const t of await journal.list()) this.print(`${t.id} · ${t.label} · ${t.files} archivos${t.blocked ? ' [bloqueado]' : ''}`); }
          else { const restored = await journal.rewind(arg || undefined, this.active.signal); this.print(`Checkpoint ${restored.id}: ${restored.files} archivos restaurados. El contexto conserva el turno; comunica el rewind al agente.`); }
          break;
        }
        case 'status': this.print(this.status()); break;
        case 'model': await this.changeModel(arg || undefined); break;
        case 'auto': {
          const n = arg ? AUTONOMIES.indexOf(arg as any) : await this.io.select('Autonomía', AUTONOMIES, this.active.signal);
          if (n === undefined) break;
          if (n < 0) throw new Error('Autonomía: off, low, medium o high');
          this.config.autonomy = AUTONOMIES[n]!;
          if (this.config.mode === 'mission' && this.config.autonomy !== 'high') this.config.mode = 'auto';
          this.persist(); this.print(this.status()); break;
        }
        case 'mode': {
          const modes = ['auto', 'spec', 'mission'];
          const n = arg ? modes.indexOf(arg) : await this.io.select('Modo', modes, this.active.signal);
          if (n !== undefined) this.setMode(modes[n] ?? ''); break;
        }
        case 'settings':
          if (arg) { const [key, ...value] = arg.split(/\s+/); if (!['model', 'auto', 'mode', 'theme'].includes(key!)) throw new Error('Ajuste: model, auto, mode o theme');
            const nested = key === 'theme' ? 'themes' : key; this.active = undefined; return await this.submit(`/${nested} ${value.join(' ')}`); }
          this.print(JSON.stringify({ ...this.config, settingsModel: this.settings.modelId, mcp: Object.keys(this.mcpServers),
            maxTurns: this.options.agent?.maxTurns ?? 128, timeoutMs: this.options.agent?.timeoutMs ?? 1200000, only: this.only, removed: this.removed }, null, 2)); break;
        case 'themes': {
          const choices = ['color', 'plain']; const n = arg ? choices.indexOf(arg) : await this.io.select('Tema', choices, this.active.signal);
          if (n === undefined) break; if (n < 0) throw new Error('Tema: color o plain');
          this.config.theme = choices[n] as ChatConfig['theme']; this.persist(); break;
        }
        case 'new': this.config = { ...this.defaults }; this.sessionId = undefined; this.print('Conversación nueva con ajustes de arranque'); break;
        case 'clear': this.sessionId = undefined; this.print('Contexto nuevo; ajustes conservados'); break;
        case 'sessions': await this.resume(arg === '--last' ? '' : arg, arg === '--last'); break;
        case 'search': {
          const { sessions, truncated } = await listSessions(this.sessionDir, this.cwd, arg, true);
          sessions.forEach(s => this.print(`${s.id} · ${s.title}${s.archived ? ' [archivada]' : ''}\n  ${s.preview.replace(/\n/g, ' ')}`));
          this.print(`${sessions.length} sesiones${truncated ? ' (búsqueda parcial por límite)' : ''}`); break;
        }
        case 'fork': this.sessionId = await forkSession(this.sessionDir, arg || this.requireSession(), this.cwd); this.print(this.status()); break;
        case 'rename': if (!arg || arg.length > 200) throw new Error('Título requerido, máximo 200 caracteres');
          await editSession(this.sessionDir, this.requireSession(), this.cwd, s => { s.title = arg; }); this.print('Título guardado'); break;
        case 'favorite': await editSession(this.sessionDir, this.requireSession(), this.cwd, s => { s.pinned = !s.pinned; this.print(s.pinned ? 'Sesión fijada' : 'Sesión desfijada'); }); break;
        case 'archive': await editSession(this.sessionDir, this.requireSession(), this.cwd, s => { s.archived = true; }); this.sessionId = undefined; this.print('Sesión archivada; /search la incluye'); break;
        case 'tree': {
          const { sessions } = await listSessions(this.sessionDir, this.cwd, '', true);
          sessions.forEach(s => this.print(`${s.id} ← ${s.parentSessionId ?? '(raíz)'} · ${s.title}`)); break;
        }
        case 'context': {
          const tokens = this.sessionId ? await editSession(this.sessionDir, this.sessionId, this.cwd, s => estimatedTokens(s.messages, []), false) : 0;
          this.print(`Historial: ~${tokens} tokens (estimación; no incluye schemas). Presupuesto: ${this.options.agent?.maxContextTokens ?? 32000}.`); break;
        }
        case 'compress': {
          const result = await editSession(this.sessionDir, this.requireSession(), this.cwd, s => compressSession(s, this.provider(), this.active!.signal, arg));
          this.print(`Contexto comprimido: ~${result.before} → ~${result.after} tokens`); break;
        }
        case 'handoff': this.sessionId = await forkSession(this.sessionDir, this.requireSession(), this.cwd, async s => { await compressSession(s, this.provider(), this.active!.signal, arg); }); this.print(this.status()); break;
        case 'btw': if (!arg) throw new Error('/btw <pregunta>'); await this.runPrompt(arg, true); break;
        case 'cwd':
          if (!arg) { this.print(this.cwd); break; }
          { const cwd = await realpath(resolve(this.cwd, arg));
            if (!(await stat(cwd)).isDirectory()) throw new Error('La carpeta no existe');
            this.cwd = cwd; this.sessionId = undefined; await this.refreshCommands(); this.print(this.status()); } break;
        case 'mcp': {
          const [action, server] = arg.split(/\s+/);
          if (action && action !== 'list') {
            if (!['enable', 'disable'].includes(action) || !server || !Object.hasOwn(this.settings.mcpServers ?? {}, server)) throw new Error('/mcp [list|enable <nombre>|disable <nombre>]');
            if (action === 'disable') this.disabledMcp.add(server); else this.disabledMcp.delete(server);
          }
          Object.keys(this.settings.mcpServers ?? {}).forEach(n => this.print(`${n}: ${this.disabledMcp.has(n) ? 'excluido' : 'configurado'} (conectividad no comprobada)`));
          if (!Object.keys(this.settings.mcpServers ?? {}).length) this.print('Sin MCP configurados. Usa --settings con mcpServers.'); break;
        }
        case 'tools': {
          const [action, ...rest] = arg.split(/\s+/); const names = rest.join('').split(',').filter(Boolean);
          if (action === 'reset') { this.only = undefined; this.removed = undefined; }
          else if (action === 'only' || action === 'remove') {
            if (!names.length) throw new Error('/tools only|remove <nombres separados por coma>');
            const catalog = await listConfiguredToolCatalog({ prompt: '', cwd: this.cwd, provider: this.provider(), mcpServers: this.mcpServers, interactionMode: this.config.mode }, this.active.signal);
            for (const n of names) if (!catalog.some(t => t.schema.function.name === n)) throw new Error(`Tool desconocida: ${n}`);
            if (action === 'only') this.only = names; else this.removed = names;
          } else if (action && action !== 'list') throw new Error('/tools [list|only <nombres>|remove <nombres>|reset]');
          const catalog = await listConfiguredToolCatalog({ prompt: '', cwd: this.cwd, provider: this.provider(), mcpServers: this.mcpServers,
            autonomy: this.config.autonomy, interactionMode: this.config.mode, onlyTools: this.only, removeTools: this.removed }, this.active.signal);
          this.print(catalog.map(t => `${t.schema.function.name} [${t.effect}]`).join('\n')); break;
        }
        case 'skills': if (arg) this.print(await projectPrompt(this.cwd, 'skills', arg)); else this.print((await projectItems(this.cwd, 'skills')).join('\n') || 'Sin skills en .agents/skills'); break;
        case 'commands': await this.refreshCommands(); this.print(this.customNames.map(n => '/' + n).join('\n') || 'Sin prompts en .agents/commands/*.md'); break;
        case 'droids': this.print('Subagentes propios: Task/SpawnAgent, ListAgents, MessageAgent, InterruptAgent, TaskOutput/TaskStop. Profundidad 2, máximo 8 agentes y 256 llamadas compartidas. No existe un gestor de custom Droids.'); break;
        case 'limits': this.print(JSON.stringify({ timeoutMs: this.options.agent?.timeoutMs ?? 1200000, maxTurns: this.options.agent?.maxTurns ?? 128,
          maxContextTokens: this.options.agent?.maxContextTokens ?? 32000, lastUsage: this.lastResult?.usage, billing: 'Sin límites de crédito de Factory' }, null, 2)); break;
        case 'diagnostics': { const sandbox = await detectSandbox(); this.print(JSON.stringify({ sandbox, cwd: this.cwd, configuredModels: this.modelIds, mcpConfigured: Object.keys(this.mcpServers) }, null, 2)); break; }
        case 'terminal-setup': this.print('Tab: completar comandos · ↑↓: historial por carpeta · pegado multilínea entre marcadores · Shift+Tab: auto/spec (mission solo con high) · Ctrl+N: siguiente modelo · Ctrl+L: autonomía · Ctrl+O: ampliar diff/detalle · Ctrl+C: cancelar · Ctrl+D: salir · \\ al final: multilínea'); break;
        case 'init': await this.runPrompt('Inspect this repository and prepare contributor guidance in AGENTS.md. Preserve existing guidance; ask before replacing unrelated content. ' + arg); break;
        default:
          if (this.customNames.includes(name) && !CHAT_COMMANDS.some(c => c.name === name)) await this.runPrompt((await projectPrompt(this.cwd, 'commands', name)).replaceAll('$ARGUMENTS', arg));
          else throw new Error(`Comando desconocido: /${name}. Usa /help o Tab.`);
      }
      return true;
    } finally { clearTimeout(timer); this.active = undefined; this.io.update?.(this.statusState); }
  }
}
