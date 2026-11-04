// Lint de procedencia (docs/research/arquitectura-ideacion/adr/ADR-0005): pin por upstream, registro de cualificación y ledger.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
// Upstream no compila con noUncheckedIndexedAccess y no se parchea (sha256 en el pin): ruta en variable para que tsc no lo siga.
const LEDGER_LIB = '../third_party/dream-machine/ledger/index.ts';
const { verifyLedger } = (await import(LEDGER_LIB)) as { verifyLedger: (md: string) => { errors: string[] } };
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sha256 = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');

function tsFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

interface Pin { commit: string; license_spdx: string; use_rule: string; vendored?: { path: string; sha256?: string; patched?: boolean }[] }
const pin = (name: string): Pin => JSON.parse(read(`third_party/${name}/UPSTREAM.json`));

test('toda "Idea: ext/<repo>/...@<sha>" en src/ tiene pin con ese commit', () => {
  const refs = tsFiles('src').flatMap((f) =>
    [...read(f).matchAll(/Idea: ext\/([\w.-]+)\/\S*?@([0-9a-f]{7,40})/g)].map((m) => ({ f, repo: m[1]!, sha: m[2]! })));
  expect(refs.length).toBeGreaterThan(0);
  for (const { f, repo, sha } of refs) {
    expect(existsSync(join(ROOT, 'third_party', repo, 'UPSTREAM.json')), `${f}: falta third_party/${repo}/UPSTREAM.json`).toBe(true);
    expect(pin(repo).commit.startsWith(sha), `${f}: @${sha} no coincide con el pin`).toBe(true);
  }
});

test('código copiado: LICENSE presente y archivos sin parchear idénticos al upstream', () => {
  for (const name of readdirSync(join(ROOT, 'third_party'))) {
    const p = pin(name);
    expect(p.commit, name).toMatch(/^[0-9a-f]{40}$/);
    expect(p.license_spdx, name).toBeTruthy();
    if (p.use_rule !== 'vendored') continue;
    expect(existsSync(join(ROOT, 'third_party', name, 'LICENSE')), `${name}: falta LICENSE`).toBe(true);
    for (const v of p.vendored ?? []) {
      const file = `third_party/${name}/${v.path}`;
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      if (!v.patched) expect(sha256(file), `${file} difiere del upstream; regístralo en local_patches`).toBe(v.sha256!);
    }
  }
});

test('registros de cualificación: gates pendientes, y "cualificado" exige evidencia', () => {
  const dir = 'docs/qualification';
  for (const f of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    const md = read(`${dir}/${f}`);
    const estado = md.match(/^Estado: (candidato|cualificado)\b/m)?.[1];
    expect(estado, `${f}: falta "Estado: candidato|cualificado"`).toBeDefined();
    expect(md, `${f}: falta sección de gates pendientes`).toContain('## Gates pendientes');
    const ev = join(ROOT, dir, 'evidence', f.replace(/\.md$/, ''));
    if (estado === 'cualificado') expect(existsSync(ev) && readdirSync(ev).length > 0, `${f}: cualificado sin evidencia`).toBe(true);
  }
});

test('docs/research/ledger.md pasa verifyLedger de dream-machine', () => {
  const r = verifyLedger(read('docs/research/ledger.md'));
  expect(r.errors).toEqual([]);
});
