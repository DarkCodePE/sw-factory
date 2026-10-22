import { isSearchConfigured } from './web-search.ts';
import type { AgentTool, Autonomy, InteractionMode } from './types.ts';

/** Public wire identifiers observed in the client, separate from model-facing names. */
const IDS: Record<string, string> = { Read: 'read-cli', LS: 'ls-cli', Grep: 'grep_tool_cli', Glob: 'glob-search-cli',
  Loop: 'loop-cli', FetchUrl: 'fetch_url', ExitSpecMode: 'exit-spec-mode', StageSettingsChanges: 'stage_settings_changes', ApplyPatch: 'apply-patch-cli', Edit: 'edit-cli', Create: 'create-cli', Execute: 'execute-cli', TodoWrite: 'todo_write', ToolSearch: 'tool-search-cli',
  AskUser: 'ask-user', Skill: 'skill', Script: 'script', Task: 'task-cli', TaskOutput: 'task-output-cli', TaskStop: 'task-stop-cli',
  ProposeMission: 'propose-mission', StartMissionRun: 'start-mission-run', EndFeatureRun: 'end-feature-run', DismissHandoffItems: 'dismiss-handoff-items',
  WebSearch: 'web_search' };
export const toolId = (name: string) => IDS[name] ?? name;
export const toolName = (selector: string) => {
  if (selector.startsWith('MCP:')) {
    const rest = selector.slice(4);
    if (rest.includes('/')) {
      const [server, ...toolParts] = rest.split('/');
      return `${decodeURIComponent(server!)}___${decodeURIComponent(toolParts.join('/'))}`;
    }
    return `${decodeURIComponent(rest)}___`;
  }
  return Object.entries(IDS).find(([, id]) => id === selector)?.[0] ?? selector;
};
export const selectToolNames = (selectors?: string[]) => selectors?.map(toolName);
export function describeTool(t: Pick<AgentTool, 'schema' | 'effect'>, autonomy: Autonomy = 'off', mode: InteractionMode = 'auto', only?: string[], removed?: string[], policy?: import('./execution-policy.ts').ExecutionPolicy, added?: string[]) {
  const name = t.schema.function.name;
  const conditional = name === 'ExitSpecMode' || policy?.permissionMode !== 'yolo' && ['Script', 'Execute', 'FetchUrl'].includes(name);
  const boundedChild = ['Task', 'SpawnAgent'].includes(name);
  const searchAvailable = name !== 'WebSearch' || isSearchConfigured();
  const id = toolId(name);
  const isAdded = !!(added && (added.includes(name) || added.includes(id) || (name.includes('___') && added.some(a => a.endsWith('___') && name.startsWith(a)))));
  const isRemoved = !!(removed && (removed.includes(name) || removed.includes(id) || (name.includes('___') && removed.some(r => r.endsWith('___') && name.startsWith(r)))));
  const isOnly = !only || only.includes(name) || only.includes(id) || (name.includes('___') && only.some(o => o.endsWith('___') && name.startsWith(o)));
  const permitted = (policy?.permissionMode === 'yolo' || t.effect === 'read' || conditional || (mode !== 'spec' || boundedChild) &&
    (t.effect === 'write' ? autonomy !== 'off' : ['medium', 'high'].includes(autonomy))) && searchAvailable;
  const currentlyAllowed = (isAdded || (permitted && isOnly)) && (!isRemoved || isAdded);
  return { executionPolicy: policy, id, llmId: name, displayName: name === 'WebSearch' ? 'Web Search' : name, description: t.schema.function.description,
    category: t.effect === 'write' ? 'edit' : t.effect, defaultAllowed: t.effect === 'read' && name !== 'ExitSpecMode' && searchAvailable,
    currentlyAllowed, conditional, schema: t.schema };
}
