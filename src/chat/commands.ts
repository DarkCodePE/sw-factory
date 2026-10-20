export interface ChatCommand { name: string; aliases?: string[]; group: string; help: string; unavailable?: string }
const unavailable = 'Necesita un servicio de Factory; fab no lo implementa.';
export const CHAT_COMMANDS: ChatCommand[] = [
  { name: 'help', aliases: ['?'], group: 'Ayuda', help: 'Catálogo y atajos' },
  { name: 'model', group: 'Configuración', help: 'Seleccionar modelo configurado o introducir su ID' },
  { name: 'reasoning', group: 'Configuración', help: 'Esfuerzo low, medium, high o default; Tab lo alterna' },
  { name: 'auto', group: 'Configuración', help: 'Autonomía off, low, medium o high' },
  { name: 'network', group: 'Configuración', help: 'Red de Execute: auto (automática solo en high), ask o deny' },
  { name: 'mode', group: 'Configuración', help: 'Modo auto, spec o mission (requiere high)' },
  { name: 'settings', group: 'Configuración', help: 'Ver ajustes o cambiar model/auto/mode/theme/reasoning/network' },
  { name: 'themes', group: 'Configuración', help: 'Elegir color o plain' },
  { name: 'cwd', aliases: ['cd'], group: 'Configuración', help: 'Ver o cambiar carpeta; abre conversación nueva' },
  { name: 'mcp', group: 'Capacidades', help: 'Servidores configurados y exclusión local por sesión' },
  { name: 'tools', group: 'Capacidades', help: 'Catálogo de herramientas y filtros only/remove/reset' },
  { name: 'skills', group: 'Capacidades', help: 'Listar skills del proyecto o leer una por nombre' },
  { name: 'skill', group: 'Capacidades', help: 'Invocar una skill local: /skill nombre argumentos' },
  { name: 'commands', group: 'Capacidades', help: 'Listar prompts propios de .agents/commands/*.md' },
  { name: 'droids', group: 'Capacidades', help: 'Ver capacidades y límites de subagentes propios' },
  { name: 'context', group: 'Sesión', help: 'Estimar tokens del historial, sin llamar al modelo' },
  { name: 'limits', group: 'Sesión', help: 'Ver límites locales de ejecución' },
  { name: 'status', group: 'Sesión', help: 'Modelo, modo, autonomía, carpeta y sesión' },
  { name: 'diagnostics', group: 'Sesión', help: 'Diagnóstico local de sandbox y configuración' },
  { name: 'clear', group: 'Sesión', help: 'Nueva conversación conservando ajustes actuales' },
  { name: 'new', group: 'Sesión', help: 'Nueva conversación con los ajustes de arranque' },
  { name: 'sessions', aliases: ['resume'], group: 'Sesión', help: 'Seleccionar sesión local o reanudar por ID' },
  { name: 'search', aliases: ['find'], group: 'Sesión', help: 'Buscar texto en las sesiones de esta carpeta' },
  { name: 'fork', group: 'Sesión', help: 'Crear una rama de la conversación actual o indicada' },
  { name: 'tree', group: 'Sesión', help: 'Ver parentesco de los forks locales' },
  { name: 'rename', group: 'Sesión', help: 'Cambiar título de la sesión actual' },
  { name: 'favorite', aliases: ['pin'], group: 'Sesión', help: 'Fijar o desfijar sesión' },
  { name: 'archive', group: 'Sesión', help: 'Archivar sesión y abrir una conversación nueva' },
  { name: 'compress', aliases: ['compact'], group: 'Sesión', help: 'Resumir el historial sin ejecutar herramientas' },
  { name: 'handoff', group: 'Sesión', help: 'Crear un fork con historial resumido; conserva el original' },
  { name: 'btw', group: 'Sesión', help: 'Consulta lateral readonly, sin cambiar el historial principal' },
  { name: 'rewind', group: 'Sesión', help: 'Restaurar archivos del último checkpoint, por ID, o listarlos con list; excluye Execute' },
  { name: 'init', group: 'Proyecto', help: 'Pedir al agente que prepare AGENTS.md, con los permisos actuales' },
  { name: 'terminal-setup', group: 'Ayuda', help: 'Mostrar atajos sin modificar el terminal' },
  { name: 'exit', aliases: ['quit'], group: 'Ayuda', help: 'Salir' },
  ...['account', 'login', 'logout', 'share', 'install-code-review'].map(name => ({ name, group: 'Sin backend', help: 'Servicio de Factory', unavailable })),
  { name: 'install-triage', group: 'Sin backend', help: 'Configurar triage de canales y tareas; requiere integración de servicio', unavailable },
  { name: 'detect-overlapping-workstreams', group: 'Sin backend', help: 'Detectar objetivos duplicados en workstreams de Factory', unavailable: 'La detección entre workstreams de Factory requiere su catálogo remoto; no está disponible.' },
  ...[
    ['plugins', 'No existe un gestor propio de plugins/marketplaces.'],
    ['hooks', 'No se ejecutan hooks de shell configurados por el proyecto.'],
    ['fast', 'El transporte no dispone de un contrato de fast mode.'],
    ['language', 'La interfaz propia está disponible en español.'],
    ['statusline', 'La línea de estado es interna; no ejecuta comandos externos.'],
    ['rewind-conversation', 'El historial de conversación no se rebobina; /rewind restaura únicamente archivos Edit/Create.'],
    ['migrate', 'No hay un flujo equivalente verificado; utiliza el agente o el pipeline de fábrica.'],
    ['simplify', 'No hay un flujo equivalente verificado; pide una revisión con un prompt.'],
  ].map(([name, reason]) => ({ name: name!, group: 'Sin backend', help: reason!, unavailable: reason! })),
];
export const commandFor = (name: string) => CHAT_COMMANDS.find(c => c.name === name || c.aliases?.includes(name));
export function commandHelp() {
  return [...new Set(CHAT_COMMANDS.map(c => c.group))].map(group => `${group}\n` + CHAT_COMMANDS.filter(c => c.group === group)
    .map(c => `  /${c.name}${c.aliases?.length ? ` (${c.aliases.map(a => '/' + a).join(', ')})` : ''} — ${c.help}${c.unavailable ? ' [no disponible]' : ''}`).join('\n')).join('\n\n');
}
export type SlashResult = { kind: 'prompt'; text: string } | { kind: 'command'; name: string; arg: string } | { kind: 'empty' };
export function parseInput(line: string): SlashResult {
  const text = line.trim();
  if (!text) return { kind: 'empty' };
  if (!text.startsWith('/')) return { kind: 'prompt', text };
  const match = /^\/([^\s]*)\s*([\s\S]*)$/.exec(text)!;
  return { kind: 'command', name: match[1]!.toLowerCase() || 'help', arg: match[2]! };
}
export function completions(line: string, models: string[] = [], custom: string[] = []): [string[], string] {
  const options = line.startsWith('/model ') ? models.map(m => '/model ' + m)
    : line.startsWith('/network ') ? ['auto', 'ask', 'deny'].map(n => '/network ' + n)
    : line.startsWith('/reasoning ') ? ['default', 'low', 'medium', 'high'].map(r => '/reasoning ' + r)
    : line.startsWith('/auto ') ? ['off', 'low', 'medium', 'high'].map(a => '/auto ' + a)
    : line.startsWith('/mode ') ? ['auto', 'spec', 'mission'].map(m => '/mode ' + m)
    : [...CHAT_COMMANDS.flatMap(c => [c.name, ...c.aliases ?? []]), ...custom].map(n => '/' + n);
  return [options.filter(c => c.startsWith(line)), line];
}
