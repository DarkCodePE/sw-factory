import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// T96-H1: con una umask abierta, el estado que crea fab debe quedar privado para que los adjuntos funcionen.
test('fab crea un estado nuevo en 0700 aunque la umask sea 002', () => {
  const root = mkdtempSync(join(tmpdir(), 'fab-estado-'));
  const state = join(root, 'nuevo');
  try {
    Bun.spawnSync(['sh', '-c', `umask 002; exec bun ${join(import.meta.dir, '../src/cli.ts')} status`], { env: { ...process.env, FABRICA_HOME: state } });
    expect(statSync(state).mode & 0o777).toBe(0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// T96-H8: el primer comando puede ser cualquiera; todos crean el estado por la misma función (src/state-dir.ts).
for (const argv of ['pr show no-existe', 'profile list']) {
  test(`fab ${argv} como primer comando también crea el estado en 0700 con umask 002`, () => {
    const root = mkdtempSync(join(tmpdir(), 'fab-estado-'));
    const state = join(root, 'nuevo');
    try {
      Bun.spawnSync(['sh', '-c', `umask 002; exec bun ${join(import.meta.dir, '../src/cli.ts')} ${argv}`], { env: { ...process.env, FABRICA_HOME: state } });
      expect(statSync(state).mode & 0o777).toBe(0o700);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('el almacén de tokens MCP crea el estado en 0700 con umask abierta', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fab-estado-'));
  const state = join(root, 'nuevo');
  try {
    const script = `import { writeTokenStore } from ${JSON.stringify(join(import.meta.dir, '../src/agent/mcp-oauth.ts'))}; await writeTokenStore({});`;
    Bun.spawnSync(['sh', '-c', `umask 002; exec bun -e '${script}'`], { env: { ...process.env, FABRICA_HOME: state } });
    expect(statSync(state).mode & 0o777).toBe(0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// INT-H4 (T96-H8): `fab exec` crea su raíz de worktrees por defecto bajo el estado; con umask abierta debe quedar en 0700.
test('exec crea la raíz de worktrees por defecto en 0700 con umask 002', () => {
  const root = mkdtempSync(join(tmpdir(), 'fab-estado-'));
  const state = join(root, 'nuevo'), repo = join(root, 'repo');
  try {
    Bun.spawnSync(['sh', '-c', `mkdir ${repo} && cd ${repo} && git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m i`]);
    const script = `import { prepareExecWorktree } from ${JSON.stringify(join(import.meta.dir, '../src/agent/exec-worktree.ts'))}; await prepareExecWorktree({ repo: ${JSON.stringify(repo)} });`;
    Bun.spawnSync(['sh', '-c', `umask 002; exec bun -e '${script}'`], { env: { ...process.env, FABRICA_HOME: state } });
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(statSync(join(state, 'worktrees')).mode & 0o777).toBe(0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
