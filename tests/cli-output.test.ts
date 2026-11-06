import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fab-cli-output-'));
  roots.push(root);
  const preload = join(root, 'open-handle.ts');
  // The CLI must still exit once output drains even if a dependency leaves a handle.
  writeFileSync(preload, 'setInterval(() => {}, 1000);\n');
  return { root, preload };
}
async function cli(root: string, preload: string, args: string[]) {
  // Bun's direct capture can absorb writes fast enough to mask this bug. Use
  // native pipes on both channels, as shell consumers (wc/python) receive them.
  const child = Bun.spawn(['bash', '-o', 'pipefail', '-c',
    '"$1" --preload "$2" src/cli.ts "${@:3}" 2> >(cat >&2) | cat',
    'cli-output', process.execPath, preload, ...args], {
    cwd: join(import.meta.dir, '..'), env: { ...process.env, FABRICA_HOME: root },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
  });
  const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(killGroup, 10_000);
  try {
    // Hold off reading so kernel pipe capacity cannot hide buffered output loss.
    await Bun.sleep(100);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); killGroup(); }
}

test('CLI drains stdout over 64 KiB to a pipe before exiting with an open handle', async () => {
  const { root, preload } = fixture();
  const store = new Store(join(root, 'fabrica.db'));
  const title = 'salida íntegra '.repeat(10_000);
  let id: string;
  try {
    store.createWorkstream({ slug: 'output', goal: 'test', repo: root, agent: 'fake' });
    id = store.addSignal('output', title, 'test').id;
  } finally { store.close(); }
  const result = await cli(root, preload, ['signal', 'list', 'output']);
  expect(Buffer.byteLength(title)).toBeGreaterThan(64 * 1024);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(`${id.slice(0, 8)} ${'new'.padEnd(9)} ${title}\n`);
}, 15_000);

test('CLI drains stderr over 64 KiB and preserves a failing exit code', async () => {
  const { root, preload } = fixture();
  const id = 'x'.repeat(96 * 1024);
  const result = await cli(root, preload, ['improve', 'report', id, '--json']);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`error (not_found): experimento ${id} no existe\n`);
}, 15_000);


test('capture entrypoint drains both pipes and preserves the child exit code', async () => {
  const { root, preload } = fixture();
  const result = await cli(root, preload, ['__capture', join(root, 'capture.log'), process.execPath, '-e',
    'process.stdout.write("o".repeat(128 * 1024)); process.stderr.write("e".repeat(128 * 1024)); process.exitCode = 7;']);
  expect(result.code).toBe(7);
  expect(result.stdout).toBe('o'.repeat(128 * 1024));
  expect(result.stderr).toBe('e'.repeat(128 * 1024));
}, 15_000);
