import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { FAB_VERSION, modeLine, resourceLine, welcome } from '../src/chat/chrome.ts';
import { cellWidth } from '../src/chat/render.ts';
import { paletteCatalog, renderPalette, suggestions } from '../src/chat/palette.ts';
import { projectCatalog } from '../src/chat/project.ts';
import { ChatController, type ChatIO } from '../src/chat/controller.ts';
import { loadChatConfig } from '../src/chat/config.ts';
import { TerminalInput } from '../src/chat/terminal.ts';
import type { ModelProvider } from '../src/agent/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(fileURLToPath(new URL('../docs/evidence/.p2-test-', import.meta.url))); roots.push(root);
  const cwd = join(root, 'workspace'), home = join(root, 'home'); await mkdir(cwd);
  let output = '', calls = 0; const requests: string[] = [], efforts: Array<string | undefined> = [];
  const io: ChatIO = { write(s) { output += s; }, async question() { return ''; }, async select() { return undefined; } };
  const providerFor = (_model: string, effort?: string): ModelProvider => { efforts.push(effort); return { id: 'fixture', async complete(r) {
    calls++; requests.push(JSON.stringify(r.messages)); return { text: 'Listo', toolCalls: [], finishReason: 'stop' };
  } }; };
  const app = new ChatController({ cwd, home, providerFor, config: { model: 'fixture', autonomy: 'off', mode: 'auto', theme: 'plain' } }, io);
  const resource = async (kind: 'skills' | 'commands', name: string, text: string) => {
    const dir = join(cwd, '.agents', kind, kind === 'skills' ? name : ''); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, kind === 'skills' ? 'SKILL.md' : name + '.md'), text);
  };
  return { root, cwd, home, app, providerFor, requests, efforts, resource, output: () => output, calls: () => calls };
}

test('welcome identifies FAB and its real version, rotates tips, fits narrow/wide terminals and shows honest resources', () => {
  const empty = { skills: 0, commands: 0, mcpConfigured: 0, agents: false, warnings: 0 };
  const a = welcome(100, empty, 0), b = welcome(100, empty, 1);
  expect(a).toContain(`fab v${FAB_VERSION}`); expect(a).toContain('████'); expect(a).not.toBe(b); expect(a).not.toContain('0.244.0');
  expect(a).toContain('Tab: razonamiento'); expect(resourceLine(empty)).toContain('MCPs (0) ✗'); expect(resourceLine(empty)).toContain('AGENTS.md ✗');
  expect(resourceLine({ ...empty, skills: 2, mcpConfigured: 1, agents: true })).toContain('configurados, sin verificar');
  for (const width of [25, 80, 150]) for (const row of welcome(width, empty).split('\n')) expect(cellWidth(row)).toBeLessThan(width);
  const line = modeLine({ model: 'GPT fixture', mode: 'auto', autonomy: 'off', reasoning: 'high' }, 120);
  expect(line.startsWith('Auto (off)')).toBe(true); expect(line.endsWith('GPT fixture (high)')).toBe(true);
});

test('palette ranks names/descriptions and renders descriptions and origins including unavailable commands', () => {
  const catalog = paletteCatalog([{ name: 'DeployCheck', kind: 'skills', description: 'Verificar despliegue local' }]);
  const rows = suggestions('/deploy', catalog); expect(rows[0]?.name).toBe('deploycheck'); expect(rows[0]?.origin).toBe('skill del proyecto');
  expect(suggestions('/despliegue', catalog)[0]?.name).toBe('deploycheck');
  expect(suggestions('/plugins', catalog)[0]?.disabled).toBe(true);
  expect(catalog.some(e => e.name === 'skill')).toBe(true); expect(catalog.some(e => e.name === 'detect-overlapping-workstreams')).toBe(true);
  expect(renderPalette(rows, 0, 120)[0]).toContain('Verificar despliegue local'); expect(renderPalette(rows, 0, 120)[0]).toContain('skill del proyecto');
  for (const row of renderPalette(catalog, 25, 60)) expect(cellWidth(row)).toBeLessThan(60);
  expect(suggestions('/deploy arg', catalog)).toEqual([]);
});

test('project skills and commands invoke their safe prompt bodies with arguments; builtins and aliases cannot be shadowed', async () => {
  const f = await fixture();
  await f.resource('skills', 'Inspect', '---\nname: arbitrary\ndescription: Inspección local\n---\nInspect $ARGUMENTS');
  await f.resource('commands', 'Build', '---\ndescription: Compilación local\n---\nBuild $ARGUMENTS');
  await f.resource('commands', 'resume', 'Do not shadow the builtin');
  await f.resource('skills', 'plugins', 'Do not shadow plugins');
  await f.app.refreshCommands();
  expect(f.app.palette.find(e => e.name === 'inspect')?.origin).toBe('skill del proyecto');
  expect(f.app.palette.filter(e => e.name === 'resume')).toHaveLength(1); expect(f.app.palette.find(e => e.name === 'plugins')?.disabled).toBe(true);
  expect(f.app.resources.warnings).toBe(2);
  await f.app.submit('/inspect src'); await f.app.submit('/build debug'); await f.app.submit('/skill Inspect tests');
  expect(f.requests[0]).toContain('Inspect src'); expect(f.requests[1]).toContain('Build debug'); expect(f.requests[2]).toContain('Inspect tests');
  expect(f.requests[0]).not.toContain('description: Inspección');
  const count = f.calls(); await f.app.submit('/plugins'); expect(f.calls()).toBe(count); expect(f.output()).toContain('marketplaces');
});

test('invalid resources and symlinks are omitted; resource bar reports files/configuration without starting MCP', async () => {
  const f = await fixture(); await mkdir(join(f.cwd, '.agents/skills/missing'), { recursive: true });
  await f.resource('skills', 'valid', '---\ndescription: Valid\n---\nInspect');
  await symlink(join(f.cwd, '.agents/skills/valid/SKILL.md'), join(f.cwd, '.agents/skills/missing/SKILL.md'));
  const catalog = await projectCatalog(f.cwd); expect(catalog.resources.map(r => r.name)).toEqual(['valid']); expect(catalog.warnings).toHaveLength(1);
  await writeFile(join(f.cwd, 'AGENTS.md'), 'Guidance'); await f.app.refreshCommands(); expect(f.app.resources.agents).toBe(true); expect(f.app.resources.skills).toBe(1);
  expect(f.calls()).toBe(0);
  const io: ChatIO = { write() {}, async question() { return ''; }, async select() { return undefined; } };
  const app = new ChatController({ cwd: f.cwd, home: f.home, settings: { mcpServers: { broken: { command: '/bin/false' } } }, providerFor: f.providerFor }, io);
  await app.refreshCommands(); expect(app.statusState.resources?.mcpConfigured).toBe(1);
  await app.submit('/mcp disable broken'); expect(app.statusState.resources?.mcpConfigured).toBe(0);
});

test('Tab reasoning persists and reaches the provider without mutating the draft', async () => {
  const f = await fixture(), input = new PassThrough(), output = new PassThrough(); output.resume();
  const io = new TerminalInput(input, output, true); const app = new ChatController({ cwd: f.cwd, home: f.home, providerFor: f.providerFor,
    config: { model: 'fixture', autonomy: 'off', mode: 'auto', theme: 'plain' } }, io); io.controller = app;
  try {
    const q = io.question('fab [auto/off] › '); input.write('draft'); input.write('\t'); input.write('\t');
    expect(app.config.reasoning).toBe('medium'); expect(io.rl.line).toBe('draft'); app.provider(); expect(f.efforts.at(-1)).toBe('medium');
    expect(loadChatConfig({}, f.home).reasoning).toBe('medium'); input.write('\r'); expect(await q).toBe('draft');
    await app.submit('/reasoning high'); app.provider(); expect(f.efforts.at(-1)).toBe('high');
    await app.submit('/reasoning default'); expect(app.config.reasoning).toBeUndefined();
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test('live palette filters, arrows select and Enter only completes; permissions and paste never execute a suggestion', async () => {
  const f = await fixture(), input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', chunk => text += chunk);
  Object.assign(output, { columns: 120, rows: 30 });
  const io = new TerminalInput(input, output, true), app = new ChatController({ cwd: f.cwd, home: f.home, providerFor: f.providerFor,
    config: { model: 'fixture', autonomy: 'off', mode: 'auto', theme: 'color' } }, io); io.controller = app;
  try {
    const q = io.question('fab [auto/off] › '); let submitted = false; void q.then(() => submitted = true);
    input.write('/pl'); await Bun.sleep(15); expect(text).toContain('marketplaces'); expect(text).toContain('no disponible');
    input.write('\x1b[B'); input.write('\r\n'); expect(submitted).toBe(false); expect(io.rl.line).toBe('/plugins ');
    input.write('\r'); expect(await q).toBe('/plugins '); expect(f.calls()).toBe(0);
    const permission = io.question('¿Permitir? ', undefined, { fresh: true }), before = text.length;
    input.write('/pl'); await Bun.sleep(15); expect(text.slice(before)).not.toContain('marketplaces'); input.write('\r'); expect(await permission).toBe('/pl');
    const pasted = io.question('fab [auto/off] › '); input.write('\x1b[200~/skill Inspect\nsecond line\x1b[201~'); await Bun.sleep(15);
    expect(f.calls()).toBe(0); input.write('\r'); expect(await pasted).toBe('/skill Inspect\nsecond line');
  } finally { io.close(); input.destroy(); output.destroy(); }
});
