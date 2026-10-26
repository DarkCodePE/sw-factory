import { isAutoProvider, type AutoProvider } from '../agent/providers/auto.ts';
import { validateSettingsChanges, type SettingsPolicy, type SettingsProposal } from '../agent/staged-settings.ts';
import { resolveExecutionPolicy, scopedExecutionOptions, YOLO_NOTICE, type ExecutionPolicy } from '../agent/execution-policy.ts';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { listConfiguredToolCatalog, runCodingAgent } from '../agent/engine.ts';
import { estimatedTokens } from '../agent/provider.ts';
import { configuredProviders, type ExecSettings } from '../agent/settings.ts';
import type { AgentEvent, AgentOptions, AgentResult, ModelProvider, PermissionRequest, ToolContext, UserAnswers } from '../agent/types.ts';
import { detectSandbox } from '../sandbox/index.ts';
import { NETWORK_POLICIES, networkPolicy } from '../agent/network-policy.ts';
import { AUTONOMIES, REASONING, loadChatConfig, saveChatConfig, terminalText, type ChatConfig } from './config.ts';
import { CHAT_COMMANDS, commandFor, commandHelp, parseInput } from './commands.ts';
import { compressSession, editSession, forkSession, listSessions } from './sessions.ts';
import { projectItems, projectPrompt, projectCatalog, promptBody, type ProjectResource } from './project.ts';
import { paletteCatalog } from './palette.ts';
import type { Resources } from './chrome.ts';
import { readWorkspaceFile } from '../agent/files.ts';
import { Checkpoints } from './checkpoints.ts';
import { PromptHistory } from './history.ts';
import type { FileChange } from './render.ts';
import type { StatusState } from './presentation.ts';
import { handleMissionCommand } from './mission-commands.ts';
import { MissionTracker, formatMissionEvent } from './mission-view.ts';
import { handleHooksCommand, handleMcpCommand } from './status-commands.ts';

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
  agent?: Pick<AgentOptions, 'allowExitSpecMode' | 'requireReadBeforeEdit' | 'settingsPolicy' | 'permissionMode' | 'timeoutMs' | 'maxTurns' | 'maxContextTokens' | 'sandbox' | 'appendSystemPrompt' | 'onlyTools' | 'removeTools' | 'hooks'>;
  providerFor?: (model: string, reasoning?: string) => ModelProvider;
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
  private readonly startupPolicy: ExecutionPolicy;
  private defaults: ChatConfig;
  private agentExitedSpec = false;
  private savedOverrides: Partial<Pick<ChatConfig, 'model' | 'autonomy' | 'networkPolicy'>> = {};
  private settings: ExecSettings;
  private lastResult?: AgentResult;
  private customNames: string[] = [];
  private projectResources: ProjectResource[] = [];
  resources: Resources = { skills: 0, commands: 0, mcpConfigured: 0, agents: false, warnings: 0 };
  private tokens = { inputTokens: 0, outputTokens: 0 };
  private turnUsage = { inputTokens: 0, outputTokens: 0 };
  private contextTokens = 0;
  missionTracker = new MissionTracker();
  private missionPauseController?: AbortController;
  private missionMailbox: string[] = [];
  constructor(readonly options: ChatOptions, readonly io: ChatIO) {
    this.cwd = options.cwd; this.settings = options.settings ?? {};
    this.config = options.config ?? loadChatConfig(this.settings, options.home);
    this.startupPolicy = resolveExecutionPolicy({ ...options.agent, networkPolicy: this.config.networkPolicy,
      autonomy: options.agent?.permissionMode === 'yolo' ? undefined : this.config.autonomy, interactionMode: this.config.mode });
    this.defaults = { ...this.config }; this.only = options.agent?.onlyTools; this.removed = options.agent?.removeTools;
  }
  get yoloAuthorized() { return this.startupPolicy.permissionMode === 'yolo'; }
  executionOptions(side = false) {
    const scope = scopedExecutionOptions({ executionPolicy: this.agentExitedSpec ? resolveExecutionPolicy({ autonomy: this.config.autonomy }) : this.startupPolicy, autonomy: side ? 'off' : this.yoloAuthorized && !this.agentExitedSpec ? 'high' : this.config.autonomy,
      sandbox: this.options.agent?.sandbox ?? 'required', networkPolicy: this.agentExitedSpec ? 'deny' : networkPolicy(this.config.networkPolicy) }, side || this.config.mode === 'spec');
    return { ...scope, interactionMode: side ? 'spec' as const : this.config.mode };
  }
  get executionPolicy() { return resolveExecutionPolicy(this.executionOptions()); }
  get permissionLabel() { return this.executionPolicy.permissionMode === 'yolo' ? 'YOLO' : this.yoloAuthorized ? 'YOLO suspendido' : this.config.autonomy; }
  get sessionDir() { return join(this.options.home, 'agent-sessions'); }
  get busy() { return !!this.active; }
  get modelIds() {
    const aliases = Object.keys(this.settings.modelAliases ?? {});
    return [...new Set([this.config.model, ...(this.settings.omniRouter ? ['omni'] : []), ...aliases, ...this.settings.customModels?.filter(m => !this.settings.omniRouter?.profiles.some(p => p.modelId === m.id)).map(m => m.id) ?? []])];
  }
  get modelLabel() {
    if (this.settings.modelAliases && Object.hasOwn(this.settings.modelAliases, this.config.model)) {
      return `${this.config.model} (${this.settings.modelAliases[this.config.model]})`;
    }
    const model = this.settings.customModels?.find(m => m.id === this.config.model);
    return model?.displayName ?? model?.model ?? this.config.model;
  }
  get customCommands() { return this.customNames; }
  get palette() { return paletteCatalog(this.projectResources); }
  get mcpServers() { return Object.fromEntries(Object.entries(this.settings.mcpServers ?? {}).filter(([name]) => !this.disabledMcp.has(name))); }
  print(value: unknown) { this.io.write(terminalText(value) + '\n'); }
  status() { return `${this.yoloAuthorized ? (this.config.mode === 'spec' || this.agentExitedSpec) ? 'YOLO suspendido · sandbox requerido · sin red · ' : YOLO_NOTICE + ' · ' : ''}${this.modelShown} (${this.config.reasoning ?? 'predeterminado'}) · ${this.config.mode} · auto ${this.executionPolicy.effectiveAutonomy} · red ${this.executionOptions().networkPolicy ?? 'auto'} · ${this.cwd} · sesión ${this.sessionId ?? '(nueva)'}`; }
  get statusState(): StatusState { return { model: this.modelShown, mode: this.config.mode, autonomy: this.executionPolicy.effectiveAutonomy, permissionMode: this.executionPolicy.permissionMode, yoloSuspended: this.yoloAuthorized && (this.config.mode === 'spec' || this.agentExitedSpec),
    inputTokens: this.tokens.inputTokens + this.turnUsage.inputTokens, outputTokens: this.tokens.outputTokens + this.turnUsage.outputTokens,
    contextTokens: this.contextTokens, maxContextTokens: this.options.agent?.maxContextTokens ?? 32000, reasoning: this.config.reasoning, modelLabel: this.modelLabel,
    missionSummary: this.missionTracker.summary,
    resources: { ...this.resources, mcpConfigured: Object.keys(this.mcpServers).length } }; }
  toggleMissionPanel() {
    if (!this.missionTracker.hasMission) return;
    this.missionTracker.panelVisible = !this.missionTracker.panelVisible;
    this.print(this.missionTracker.renderPanel(80, this.config.theme === 'plain'));
  }
  cycleReasoning() { this.config.reasoning = REASONING[(REASONING.indexOf(this.config.reasoning as any) + 1) % REASONING.length]; this.persist(); this.io.update?.(this.statusState); }
  toggleDetail() { this.detailed = !this.detailed; this.io.expand?.(this.detailed); }
  async syncHistory() { this.io.setHistory?.(await new PromptHistory(this.options.home, this.cwd).load()); }
  interrupt() { this.active?.abort(new Error('Interrumpido por el usuario')); }
  get activeSignal() { return this.active?.signal; }
  clearActive() { this.active = undefined; }
  pauseMission(subArg?: string): boolean {
    if (!this.missionTracker.activeRun || !this.missionPauseController) {
      this.print('No hay una misión en ejecución activa para pausar.');
      return false;
    }
    if (subArg) this.missionMailbox.push(subArg);
    this.missionPauseController.abort(new Error('Misión pausada por el usuario'));
    this.missionTracker.state = 'paused';
    if (this.missionTracker.snapshot) this.missionTracker.snapshot.state = 'paused';
    this.print('Pausa solicitada al orquestador' + (subArg ? `: ${subArg}` : ''));
    this.io.update?.(this.statusState);
    return true;
  }
  provider(config = this.config) {
    if (this.options.providerFor) return this.options.providerFor(config.model, config.reasoning);
    const configured = configuredProviders({ ...this.settings, modelId: config.model }, {
      model: config.model, baseUrl: process.env.FABRICA_LLM_BASE_URL, apiKey: process.env.FABRICA_LLM_API_KEY, reasoningEffort: config.reasoning,
    }, undefined, undefined, this.providerRuntime);
    const provider = configured.providers[configured.defaultModelId]!;
    if (!isAutoProvider(provider)) { this.autoProvider = undefined; return provider; }
    // One auto provider per chat so the routed model stays fixed across turns.
    provider.setSurface('chat');
    return this.autoProvider ??= provider;
  }
  private autoProvider?: AutoProvider;
  private providerRuntime: import('../agent/omni/runtime.ts').ProviderRuntime = {};
  /** `auto → model` once the router has chosen; plain model id otherwise. */
  private get modelShown() { const now = this.autoProvider?.currentModelId; return this.config.model === 'auto' && now ? `auto → ${now}` : this.config.model; }
  async refreshCommands() {
    const catalog = await projectCatalog(this.cwd);
    this.projectResources = catalog.resources; this.customNames = catalog.resources.filter(r => !commandFor(r.name.toLowerCase())).map(r => r.name.toLowerCase());
    let agents = false; try { await readWorkspaceFile(this.cwd, 'AGENTS.md'); agents = true; } catch { /* Missing/unreadable guidance is shown as absent. */ }
    this.resources = { skills: catalog.resources.filter(r => r.kind === 'skills').length, commands: catalog.resources.filter(r => r.kind === 'commands').length,
      mcpConfigured: Object.keys(this.mcpServers).length, agents, warnings: catalog.warnings.length + catalog.resources.filter(r => !!commandFor(r.name.toLowerCase())).length };
    this.io.update?.(this.statusState);
  }
  private async invokeResource(name: string, args: string, kind?: 'skills') {
    await this.refreshCommands();
    const resource = this.projectResources.find(r => r.name.toLowerCase() === name.toLowerCase() && (!kind || r.kind === kind));
    if (!resource || commandFor(name) && !kind) throw new Error(`Recurso no disponible: ${name}`);
    await this.runPrompt(promptBody(await projectPrompt(this.cwd, resource.kind, resource.name)).replaceAll('$ARGUMENTS', args));
  }
  private resetStagedSettings() {
    this.config = { ...this.config, ...this.savedOverrides };
    this.savedOverrides = {}; this.agentExitedSpec = false;
  }
  private persist() { saveChatConfig({ ...this.config, ...this.savedOverrides }, this.options.home); }
  setMode(value: string) {
    if (!['auto', 'spec', 'mission'].includes(value)) throw new Error('Modo: auto, spec o mission');
    if (value === 'mission' && this.executionPolicy.effectiveAutonomy !== 'high') throw new Error('Mission exige /auto high explícito');
    this.agentExitedSpec = false; this.config.mode = value as ChatConfig['mode']; this.print(this.status());
  }
  cycleMode() {
    const modes = this.executionPolicy.effectiveAutonomy === 'high' ? ['auto', 'spec', 'mission'] : ['auto', 'spec'];
    this.setMode(modes[(modes.indexOf(this.config.mode) + 1) % modes.length]!);
  }
  async changeModel(id?: string) {
    if (!id) {
      const n = await this.io.select('Modelo (cancela con Enter; /model <id> admite otro ID)', this.modelIds, this.active?.signal);
      if (n === undefined) return; id = this.modelIds[n]!;
    }
    const previous = this.config.model; this.config.model = id;
    try { this.provider(); } catch (e) { this.config.model = previous; throw e; }
    this.autoProvider = undefined;
    delete this.savedOverrides.model; this.persist(); this.print(this.status());
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
    await editSession(this.sessionDir, id, this.cwd, s => {
      s.archived = false;
      if (s.mission) {
        this.missionTracker.state = s.mission.state;
        this.missionTracker.directory = s.mission.directory;
        this.missionTracker.missionId = s.mission.missionId;
      }
    });
    this.resetStagedSettings(); this.sessionId = id; this.print(this.status());
  }
  private permission = async (request: PermissionRequest, context: ToolContext): Promise<'proceed_once' | 'cancel'> => {
    this.print('Permiso para esta llamada (sin autorización permanente):');
    for (const use of request.toolUses) {
      this.print(`${use.toolUse.name}\n${JSON.stringify(use.toolUse.input, null, 2)}`);
      if (use.toolUse.name === 'FetchUrl') this.print('Acceso HTTP(S) para esta URL y hasta cinco redirecciones validadas, solo durante esta llamada. Sin credenciales; se bloquean destinos privados por defecto.');
      else if (use.details.network) this.print(`Acceso de red del equipo para este comando y sus descendientes, solo durante esta llamada.\nCarpeta: ${context.cwd}\nEl aislamiento de archivos se conserva. No se limita la conexión a un dominio concreto.`);
    }
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
    const settingsPolicy: SettingsPolicy = this.options.agent?.settingsPolicy ?? {
      modelIds: this.modelIds, maxAutonomy: this.executionPolicy.effectiveAutonomy, networkPolicy: this.executionOptions(side).networkPolicy ?? 'auto',
    };
    const proposals: SettingsProposal[] = [];
    const previousId = this.sessionId;
    const checkpoints = new Checkpoints(this.cwd, this.options.home);
    const changed = new Set<string>();
    this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    if (!side) {
      const history = new PromptHistory(this.options.home, this.cwd); await history.load();
      try { await history.add(prompt); this.io.setHistory?.(history.entries); } catch { this.print('No se pudo guardar el historial local de prompts'); }
      await checkpoints.begin(prompt);
      this.missionPauseController = new AbortController();
      this.missionTracker.markRunStarted();
    }
    const assistant = (text: string, final = false) => this.io.assistant ? this.io.assistant(text, final) : this.io.write(text + (final ? '\n' : ''));
    this.io.work?.('Modelo');
    const onEvent = (event: AgentEvent) => {
      if ((event.type === 'model_routed' || event.type === 'model_transition') && typeof event.agentId === 'string') {
        const route = event.type === 'model_routed'
          ? `auto → ${(event.decision as { modelId: string }).modelId}`
          : `${event.from} → ${event.to}`;
        this.print(`↳ subagente: ${route}`);
      } else if (event.type === 'settings_staged' && !side) {
        if (proposals.length < 64) proposals.push(event.proposal as SettingsProposal);
        else this.print('Límite de propuestas de ajustes: se descarta esta propuesta');
      } else if (event.type === 'mode_changed' && !side) {
        const autonomy = event.autonomy as ChatConfig['autonomy'];
        if (!AUTONOMIES.includes(autonomy)) throw new Error('Autonomía inválida en cambio de modo');
        if (this.config.autonomy !== autonomy && !Object.hasOwn(this.savedOverrides, 'autonomy')) this.savedOverrides.autonomy = this.config.autonomy;
        this.config.autonomy = autonomy;
        this.agentExitedSpec = true; this.config.mode = 'auto'; this.print('Modo auto para el próximo turno; autonomía conservada.');
        this.io.update?.(this.statusState);
      } else if (event.type === 'model_routed' && !side) {
        const d = event.decision as { modelId: string; reason: string; fallbacks: string[] };
        this.print(`Modelo elegido: ${d.modelId} (${d.reason})${d.fallbacks.length ? ` · respaldos: ${d.fallbacks.join(', ')}` : ''}`);
        this.io.update?.(this.statusState);
      } else if (event.type === 'model_transition' && !side) {
        this.print(`Cambio de modelo: ${event.from} → ${event.to} (${event.source})`);
        this.io.update?.(this.statusState);
      } else if (event.type === 'provider_retry') {
        if (streamed) assistant('', true); streamed = '';
        this.print(`Reintento del proveedor ${event.attempt}/${event.maxAttempts}: ${event.message}`);
        this.io.work?.('Modelo');
      } else if (event.type === 'assistant_delta') { const t = terminalText(event.text); this.io.work?.(); assistant(t); streamed += t; }
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
      else if ((event.type as string) === 'model_fallback') this.print(`Fallback de modelo: de ${event.from} a ${event.to} (${event.reason})`);
      else if (event.type === 'network_permission' && event.decision === 'allowed_automatically' && !this.yoloAuthorized) this.print('Red autorizada automáticamente para esta llamada (auto high).');
      else if (event.type.startsWith('mission_')) {
        this.missionTracker.handleEvent(event as Record<string, any>);
        this.print(formatMissionEvent(event as Record<string, any>));
        this.io.update?.(this.statusState);
      }
    };
    try {
    const result = await (this.options.run ?? runCodingAgent)({ ...this.options.agent,
      prompt, cwd: this.cwd, provider: this.provider(), ...this.executionOptions(side), mcpServers: this.mcpServers,
      allowExitSpecMode: !side && this.options.agent?.allowExitSpecMode !== false, settingsPolicy,
      sessionDir: side ? undefined : this.sessionDir, sessionId: side ? undefined : this.sessionId,
      onlyTools: this.only, removeTools: this.removed, signal: this.active?.signal, onEvent,
      permissionHandler: side ? undefined : this.permission, askUserHandler: this.askUser,
      receiveMessages: () => this.missionMailbox.splice(0),
      mission: {
        ...(this.options.agent as any)?.mission,
        pauseSignal: this.missionPauseController?.signal,
      },
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
      if (result.mission) {
        this.missionTracker.missionId = result.mission.missionId;
        this.missionTracker.state = result.mission.state;
        this.missionTracker.directory = result.mission.directory;
        if (result.mission.snapshot) this.missionTracker.snapshot = result.mission.snapshot;
      }
    } else this.sessionId = previousId;
    if (!result.ok) this.print(`${result.error?.type}: ${result.error?.message}`);
    if (!side && result.ok) for (const proposal of proposals) {
      this.active?.signal.throwIfAborted();
      const changes = validateSettingsChanges(proposal.changes, settingsPolicy, this.executionPolicy);
      this.print(`Propuesta de ajustes de sesión: ${JSON.stringify(changes)}`);
      const answer = (await this.io.question('¿Aplicar / descartar? [a/d] ', this.active?.signal, { fresh: true })).trim().toLowerCase();
      this.active?.signal.throwIfAborted();
      if (!['a', 'aplicar'].includes(answer)) { this.print('Propuesta descartada'); continue; }
      const candidate = { ...this.config, ...(changes.modelId !== undefined ? { model: changes.modelId } : {}),
        ...(changes.autonomy !== undefined ? { autonomy: changes.autonomy } : {}),
        ...(changes.networkPolicy !== undefined ? { networkPolicy: changes.networkPolicy } : {}) };
      this.provider(candidate); // Validate all settings before changing session state.
      for (const key of ['model', 'autonomy', 'networkPolicy'] as const) if (candidate[key] !== this.config[key] && !Object.hasOwn(this.savedOverrides, key))
        Object.assign(this.savedOverrides, { [key]: this.config[key] });
      this.config = candidate;
      this.print('Ajustes aplicados solo a esta sesión'); this.io.update?.(this.statusState);
    }
    this.print(`${result.turns} turnos · ${result.toolCalls} tools · ${(result.durationMs / 1000).toFixed(1)} s`);
    return result;
    } finally {
      if (!side) {
        this.missionPauseController = undefined;
        this.missionTracker.markRunEnded();
      }
      this.io.work?.(); assistant('', true); await checkpoints.finish(); this.io.update?.(this.statusState);
    }
  }
  async submit(line: string): Promise<boolean> {
    const input = parseInput(line); if (input.kind === 'empty') return true;
    if (this.active) {
      if (input.kind === 'command' && input.name === 'mission' && input.arg.trim().startsWith('pause')) {
        const [, ...rest] = input.arg.trim().split(/\s+/);
        const subArg = rest.join(' ').trim();
        return this.pauseMission(subArg);
      }
      throw new Error('Hay una operación en curso');
    }
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
          this.print('Rewind de Edit/Create/ApplyPatch. Nunca revierte Execute, otros efectos ni el historial de conversación; conserva directorios vacíos.');
          const journal = new Checkpoints(this.cwd, this.options.home);
          if (arg === 'list') { for (const t of await journal.list()) this.print(`${t.id} · ${t.label} · ${t.files} archivos${t.blocked ? ' [bloqueado]' : ''}`); }
          else { const restored = await journal.rewind(arg || undefined, this.active.signal); this.print(`Checkpoint ${restored.id}: ${restored.files} archivos restaurados. El contexto conserva el turno; comunica el rewind al agente.`); }
          break;
        }
        case 'yolo': if (arg) throw new Error('/yolo solo muestra el estado; usa --yolo al arrancar'); this.print(this.yoloAuthorized ? this.status() : 'YOLO desactivado; se activa únicamente con --yolo al arrancar'); break;
        case 'status': this.print(this.status()); break;
        case 'model': await this.changeModel(arg || undefined); break;
        case 'reasoning': {
          if (!arg) { this.cycleReasoning(); break; }
          if (arg !== 'default' && !REASONING.includes(arg as any)) throw new Error('Razonamiento: default, low, medium o high');
          this.config.reasoning = arg === 'default' ? undefined : arg as ChatConfig['reasoning']; this.persist(); break;
        }
        case 'skill': { const [name, ...args] = arg.split(/\s+/); if (!name) this.print((await projectItems(this.cwd, 'skills')).join('\n')); else await this.invokeResource(name, args.join(' '), 'skills'); break; }
        case 'auto': {
          const n = arg ? AUTONOMIES.indexOf(arg as any) : await this.io.select('Autonomía', AUTONOMIES, this.active.signal);
          if (n === undefined) break;
          if (n < 0) throw new Error('Autonomía: off, low, medium o high');
          if (this.yoloAuthorized) { if (AUTONOMIES[n] !== 'high') throw new Error('YOLO exige high; reinicia sin --yolo para cambiar autonomía'); this.print(this.status()); break; }
          this.config.autonomy = AUTONOMIES[n]!; delete this.savedOverrides.autonomy;
          if (this.config.mode === 'mission' && this.config.autonomy !== 'high') this.config.mode = 'auto';
          this.persist(); this.print(this.status()); break;
        }
        case 'network': {
          const selected = arg || NETWORK_POLICIES[(await this.io.select('Red de Execute (auto: automática solo en high)', [...NETWORK_POLICIES], this.active.signal)) ?? -1];
          if (selected === undefined) { this.print(`Red de Execute: ${this.config.networkPolicy ?? 'auto'}`); break; }
          if (this.yoloAuthorized) {
            if (selected !== 'auto') throw new Error('YOLO exige red auto; reinicia sin --yolo para limitar la red');
            this.print(this.status()); break;
          }
          this.config.networkPolicy = networkPolicy(selected); delete this.savedOverrides.networkPolicy; this.persist(); this.print(this.status()); break;
        }
        case 'mode': {
          const modes = ['auto', 'spec', 'mission'];
          const n = arg ? modes.indexOf(arg) : await this.io.select('Modo', modes, this.active.signal);
          if (n !== undefined) this.setMode(modes[n] ?? ''); break;
        }
        case 'settings':
          if (arg) { const [key, ...value] = arg.split(/\s+/); if (!['model', 'auto', 'mode', 'theme', 'reasoning', 'network'].includes(key!)) throw new Error('Ajuste: model, auto, mode, theme, reasoning o network');
            const nested = key === 'theme' ? 'themes' : key; this.active = undefined; return await this.submit(`/${nested} ${value.join(' ')}`); }
          this.print(JSON.stringify({ ...this.config, executionPolicy: this.executionPolicy, settingsModel: this.settings.modelId, mcp: Object.keys(this.mcpServers),
            maxTurns: this.options.agent?.maxTurns ?? 128, timeoutMs: this.options.agent?.timeoutMs ?? 1200000, only: this.only, removed: this.removed }, null, 2)); break;
        case 'themes': {
          const choices = ['color', 'plain']; const n = arg ? choices.indexOf(arg) : await this.io.select('Tema', choices, this.active.signal);
          if (n === undefined) break; if (n < 0) throw new Error('Tema: color o plain');
          this.config.theme = choices[n] as ChatConfig['theme']; this.persist(); break;
        }
        case 'new': this.agentExitedSpec = false; this.config = { ...this.defaults }; this.savedOverrides = {}; this.sessionId = undefined; this.missionTracker = new MissionTracker(); this.print('Conversación nueva con ajustes de arranque'); break;
        case 'clear': this.sessionId = undefined; this.missionTracker = new MissionTracker(); this.print('Contexto nuevo; ajustes conservados'); break;
        case 'sessions': await this.resume(arg === '--last' ? '' : arg, arg === '--last'); break;
        case 'search': {
          const { sessions, truncated } = await listSessions(this.sessionDir, this.cwd, arg, true);
          sessions.forEach(s => this.print(`${s.id} · ${s.title}${s.archived ? ' [archivada]' : ''}\n  ${s.preview.replace(/\n/g, ' ')}`));
          this.print(`${sessions.length} sesiones${truncated ? ' (búsqueda parcial por límite)' : ''}`); break;
        }
        case 'fork': this.sessionId = await forkSession(this.sessionDir, arg || this.requireSession(), this.cwd); this.resetStagedSettings(); this.print(this.status()); break;
        case 'rename': if (!arg || arg.length > 200) throw new Error('Título requerido, máximo 200 caracteres');
          await editSession(this.sessionDir, this.requireSession(), this.cwd, s => { s.title = arg; }); this.print('Título guardado'); break;
        case 'favorite': await editSession(this.sessionDir, this.requireSession(), this.cwd, s => { s.pinned = !s.pinned; this.print(s.pinned ? 'Sesión fijada' : 'Sesión desfijada'); }); break;
        case 'archive': await editSession(this.sessionDir, this.requireSession(), this.cwd, s => { s.archived = true; }); this.resetStagedSettings(); this.sessionId = undefined; this.print('Sesión archivada; /search la incluye'); break;
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
        case 'handoff': this.sessionId = await forkSession(this.sessionDir, this.requireSession(), this.cwd, async s => { await compressSession(s, this.provider(), this.active!.signal, arg); }); this.resetStagedSettings(); this.print(this.status()); break;
        case 'btw': if (!arg) throw new Error('/btw <pregunta>'); await this.runPrompt(arg, true); break;
        case 'mission': return await handleMissionCommand(this, arg);
        case 'cwd':
          if (!arg) { this.print(this.cwd); break; }
          { const cwd = await realpath(resolve(this.cwd, arg));
            if (!(await stat(cwd)).isDirectory()) throw new Error('La carpeta no existe');
            this.resetStagedSettings(); this.cwd = cwd; this.sessionId = undefined; await this.refreshCommands(); this.print(this.status()); } break;
        case 'mcp': handleMcpCommand(this.settings.mcpServers, this.disabledMcp, arg, msg => this.print(msg)); break;
        case 'hooks': await handleHooksCommand(this.cwd, msg => this.print(msg)); break;
        case 'tools': {
          const [action, ...rest] = arg.split(/\s+/); const names = rest.join('').split(',').filter(Boolean);
          if (action === 'reset') { this.only = undefined; this.removed = undefined; }
          else if (action === 'only' || action === 'remove') {
            if (!names.length) throw new Error('/tools only|remove <nombres separados por coma>');
            const catalog = await listConfiguredToolCatalog({ ...this.options.agent, prompt: '', cwd: this.cwd, provider: this.provider(), mcpServers: this.mcpServers, ...this.executionOptions() }, this.active.signal);
            for (const n of names) if (!catalog.some(t => t.schema.function.name === n)) throw new Error(`Tool desconocida: ${n}`);
            if (action === 'only') this.only = names; else this.removed = names;
          } else if (action && action !== 'list') throw new Error('/tools [list|only <nombres>|remove <nombres>|reset]');
          const catalog = await listConfiguredToolCatalog({ ...this.options.agent, prompt: '', cwd: this.cwd, provider: this.provider(), mcpServers: this.mcpServers,
            ...this.executionOptions(), onlyTools: this.only, removeTools: this.removed }, this.active.signal);
          this.print(catalog.map(t => `${t.schema.function.name} [${t.effect}]`).join('\n')); break;
        }
        case 'skills': if (arg) this.print(await projectPrompt(this.cwd, 'skills', arg)); else this.print((await projectItems(this.cwd, 'skills')).join('\n') || 'Sin skills en .agents/skills'); break;
        case 'commands': await this.refreshCommands(); this.print(this.customNames.map(n => '/' + n).join('\n') || 'Sin prompts en .agents/commands/*.md'); break;
        case 'droids': this.print('Subagentes propios: Task/SpawnAgent, ListAgents, MessageAgent, InterruptAgent, TaskOutput/TaskStop. Profundidad 2, máximo 8 agentes y 256 llamadas compartidas. No existe un gestor de custom Droids.'); break;
        case 'limits': this.print(JSON.stringify({ timeoutMs: this.options.agent?.timeoutMs ?? 1200000, maxTurns: this.options.agent?.maxTurns ?? 128,
          maxContextTokens: this.options.agent?.maxContextTokens ?? 32000, lastUsage: this.lastResult?.usage, billing: 'Sin límites de crédito de Factory' }, null, 2)); break;
        case 'diagnostics': { const sandbox = await detectSandbox(); this.print(JSON.stringify({ sandbox, executionPolicy: this.executionPolicy, networkPolicy: this.config.networkPolicy ?? 'auto', cwd: this.cwd, configuredModels: this.modelIds, mcpConfigured: Object.keys(this.mcpServers) }, null, 2)); break; }
        case 'terminal-setup': this.print('/: paleta con descripción y origen · ↑↓: sugerencias o historial · Tab: completar /comando; fuera de / cambia razonamiento · Enter sobre sugerencia elegida: rellenar · Esc: cerrar paleta · Shift+Tab: auto/spec (mission solo con high) · Ctrl+N: siguiente modelo · Ctrl+L: autonomía · Ctrl+O: ampliar diff · Ctrl+T: panel misión · Ctrl+C: cancelar · Ctrl+D: salir'); break;
        case 'init': await this.runPrompt('Inspect this repository and prepare contributor guidance in AGENTS.md. Preserve existing guidance; ask before replacing unrelated content. ' + arg); break;
        default:
          if (this.customNames.includes(name) && !commandFor(name)) await this.invokeResource(name, arg);
          else throw new Error(`Comando desconocido: /${name}. Usa /help o Tab.`);
      }
      return true;
    } finally { clearTimeout(timer); this.active = undefined; this.io.update?.(this.statusState); }
  }
}
