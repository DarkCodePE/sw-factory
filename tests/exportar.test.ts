import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportar, mainExportar } from "../scripts/ideas/exportar.ts";
import { parseFrontmatter } from "../scripts/ideas/reflejar.ts";

let tmp: string, root: string, vault: string, registry: any;
const sha = "d901657fce1af2320ba4b235b4c436020fb11a96";
const analysis = "docs/research/analisis/esf.md";
const registryPath = "docs/research/registry.json";
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const opts = () => ({ root, proyecto: vault, aprobadoPor: "X" });
function commit(approve = true) {
  git("add", ".");
  git("commit", "-qm", "fixture", "--allow-empty");
  if (approve) git("branch", "-f", "release/prueba", "HEAD");
}
function save() { writeFileSync(join(root, registryPath), JSON.stringify(registry)); }
const target = () => join(vault, "raw/sources/repos/esf/d901657f.md");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fab-exportar-"));
  root = join(tmp, "fab"); vault = join(tmp, "vault");
  mkdirSync(join(root, "docs/research/analisis"), { recursive: true });
  git("init", "-q", "-b", "trabajo");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  registry = { repos: [{ name: "esf", last_sha: sha, analysis: `sw-factory/${analysis}`,
    layers: { C6: { level: "fuerte", what: "verificación determinista", evidence: "src/test.go:4@d901657", verified: true } },
    license: { spdx: "MIT", file_hash: "sha256:test", scopes: [] }, use_rule: "adaptar citando origen",
    candidates: ["C6-verificacion-01"], incompatible_perfil: ["Temporal"] }, { name: "pendiente", last_sha: null, analysis: null }] };
  save(); writeFileSync(join(root, analysis), "# Ficha Loop B\nPrueba src/test.go:4@d901657\n"); commit();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("crea la ficha corta con identidad canónica y cuatro preguntas, sin rutas locales", () => {
  const result = exportar("esf", opts())[0]!;
  expect(result.action).toBe("created"); expect(result.path).toBe(target());
  const text = readFileSync(target(), "utf8"), fm = parseFrontmatter(text).frontmatter;
  expect(Buffer.byteLength(text)).toBeLessThan(4096);
  expect(fm.trust).toBe("agent"); expect(fm.upstream_commit).toBe(sha);
  expect(fm.canonical_commit).toBe(git("rev-parse", "HEAD"));
  expect(fm.canonical_revision).toBe(1); expect(fm.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(text).toContain("categories: [FACTORY, EVAL]");
  for (const section of ["Qué reutilizar", "Para qué problema", "Límites y licencia", "Dónde está la prueba"]) expect(text).toContain(section);
  expect(text).toContain(`esf@${fm.canonical_commit}:${analysis}`);
  expect(text).not.toContain(root); expect(text).not.toContain(vault); expect(text).not.toContain("/home/");
});

test("segunda ejecución y cambio de aprobador no escriben ni cambian mtime", () => {
  exportar("esf", opts()); const mtime = statSync(target()).mtimeMs;
  expect(exportar("esf", { ...opts(), aprobadoPor: "otro" })[0]!.action).toBe("unchanged");
  expect(statSync(target()).mtimeMs).toBe(mtime);
});

test("simulación por defecto y --dry-run no crean el proyecto", () => {
  expect(exportar("esf", { root, proyecto: vault })[0]!.action).toBe("dry-run");
  expect(exportar("esf", { ...opts(), dryRun: true })[0]!.action).toBe("dry-run");
  expect(existsSync(vault)).toBe(false);
});

test("campo del registro aprobado nuevo conserva revisión 1 y enlaza supersedes", () => {
  exportar("esf", opts()); const previous = readFileSync(target(), "utf8");
  registry.repos[0].use_rule = "reimplementar"; save(); commit();
  const result = exportar("esf", opts())[0]!;
  expect(result.revision).toBe(2); expect(result.action).toBe("superseded");
  expect(readFileSync(target().replace(".md", ".r1.md"), "utf8")).toBe(previous);
  expect(result.content).toContain("supersedes: \"d901657f.r1.md@");
  expect(exportar("esf", opts())[0]!.action).toBe("unchanged");
});

test("cambio de upstream crea otra ficha y marca todas las antiguas para reevaluación", () => {
  exportar("esf", opts());
  registry.repos[0].use_rule = "otra regla"; save(); commit(); exportar("esf", opts());
  registry.repos[0].last_sha = "a".repeat(40); save(); commit();
  const result = exportar("esf", opts())[0]!;
  expect(result.path).toBe(join(vault, "raw/sources/repos/esf/aaaaaaaa.md"));
  expect(result.revision).toBe(1);
  for (const file of [target(), target().replace(".md", ".r1.md")]) expect(parseFrontmatter(readFileSync(file, "utf8")).frontmatter.status).toBe("requiere-reevaluacion");
});

test("upstream en simulación no altera la ficha anterior", () => {
  exportar("esf", opts()); const before = readFileSync(target(), "utf8");
  registry.repos[0].last_sha = "b".repeat(40); save(); commit();
  exportar("esf", { ...opts(), dryRun: true });
  expect(readFileSync(target(), "utf8")).toBe(before);
  expect(existsSync(join(vault, "raw/sources/repos/esf/bbbbbbbb.md"))).toBe(false);
});

test("ficha o registro con cambios unstaged y staged abortan sin escribir", () => {
  for (const path of [analysis, registryPath]) {
    const original = readFileSync(join(root, path), "utf8");
    writeFileSync(join(root, path), original + "\n");
    expect(() => exportar("esf", opts())).toThrow("cambios locales");
    git("add", path); expect(() => exportar("esf", opts())).toThrow("cambios locales");
    git("reset", "-q", "HEAD", "--", path); writeFileSync(join(root, path), original);
  }
  expect(existsSync(vault)).toBe(false);
});

test("D1 rechaza commit sin rama aprobada aunque haya aprobador", () => {
  registry.repos[0].use_rule = "nuevo"; save(); commit(false);
  expect(() => exportar("esf", opts())).toThrow("no alcanzable"); expect(existsSync(vault)).toBe(false);
});

test("D1 acepta main remoto y commit anterior al tip aprobado", () => {
  git("branch", "-D", "release/prueba"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  commit(false); expect(exportar("esf", opts())[0]!.action).toBe("created");
});

test("--todos omite sin last_sha/analysis y no toca catálogo heredado", () => {
  mkdirSync(join(vault, "raw/sources/repos"), { recursive: true });
  const legacy = join(vault, "raw/sources/repos/dsh-herdr.md"); writeFileSync(legacy, "heredado");
  const results = exportar("--todos", opts());
  expect(results.map(r => r.action)).toEqual(["created", "skipped"]);
  expect(results[1]!.reason).toContain("last_sha o analysis"); expect(readFileSync(legacy, "utf8")).toBe("heredado");
});

test("prevalida todo el lote: segunda ficha sucia impide escribir la primera", () => {
  registry.repos.push({ ...registry.repos[0], name: "otro", analysis: "docs/research/analisis/otro.md" });
  writeFileSync(join(root, "docs/research/analisis/otro.md"), "otro"); save(); commit();
  writeFileSync(join(root, "docs/research/analisis/otro.md"), "sin commit");
  expect(() => exportar("--todos", opts())).toThrow("cambios locales"); expect(existsSync(vault)).toBe(false);
});

test("rechaza traversal, rutas absolutas, symlinks de origen y de destino", () => {
  expect(() => exportar("../esf", opts())).toThrow("repo inválido");
  for (const path of ["../escape.md", join(tmp, "escape.md")]) {
    registry.repos[0].analysis = path; save(); commit();
    expect(() => exportar("esf", opts())).toThrow("ruta no relativa");
  }
  registry.repos[0].analysis = analysis; save();
  rmSync(join(root, analysis)); writeFileSync(join(tmp, "outside.md"), "externo");
  symlinkSync(join(tmp, "outside.md"), join(root, analysis)); commit();
  expect(() => exportar("esf", opts())).toThrow("symlink");
  rmSync(join(root, analysis)); writeFileSync(join(root, analysis), "real"); commit();
  mkdirSync(vault); mkdirSync(join(tmp, "outside")); symlinkSync(join(tmp, "outside"), join(vault, "raw"));
  expect(() => exportar("esf", opts())).toThrow("symlink"); expect(existsSync(join(tmp, "outside/sources"))).toBe(false);
});

test("no filtra rutas absolutas del contenido ni permite escapar del envoltorio", () => {
  registry.repos[0].use_rule = "</untrusted-source><script>pwn</script>"; save(); commit();
  const text = exportar("esf", opts())[0]!.content!;
  expect(text.match(/<\/untrusted-source>/g)?.length).toBe(1); expect(text).toContain("‹script›");
  registry.repos[0].use_rule = "/home/alguien/local"; save(); commit();
  expect(() => exportar("esf", opts())).toThrow("ruta absoluta");
});

test("rechaza lock ocupado sin alterar fichas", () => {
  mkdirSync(join(vault, ".fab-exportar.lock"), { recursive: true });
  expect(() => exportar("esf", opts())).toThrow("ocupada"); expect(existsSync(target())).toBe(false);
});

test("CLI rechaza opciones desconocidas, valor ausente y selector ambiguo", () => {
  for (const argv of [[], ["esf", "--proyecto"], ["esf", "--aprobado-por", "--todos"], ["esf", "--todos"], ["esf", "--desconocido"]]) expect(mainExportar(argv)).toBe(2);
});

test("registro real esf genera d901657f.md en proyecto temporal con menos de 4 KB", () => {
  registry = JSON.parse(readFileSync(resolve(import.meta.dir, "../docs/research/registry.json"), "utf8"));
  save(); commit();
  const result = exportar("esf", opts())[0]!;
  expect(result.path).toContain("d901657f.md"); expect(existsSync(target())).toBe(true);
  expect(Buffer.byteLength(readFileSync(target()))).toBeLessThan(4096);
});

test("no sobrescribe histórico divergente ni colisiones de sha8", () => {
  exportar("esf", opts());
  const backup = target().replace(".md", ".r1.md"); writeFileSync(backup, "histórico ajeno");
  const before = readFileSync(target(), "utf8");
  registry.repos[0].use_rule = "cambio aprobado"; save(); commit();
  expect(() => exportar("esf", opts())).toThrow("histórica");
  expect(readFileSync(backup, "utf8")).toBe("histórico ajeno"); expect(readFileSync(target(), "utf8")).toBe(before);
  rmSync(backup); registry.repos[0].last_sha = sha.slice(0, 8) + "a".repeat(32); save(); commit();
  expect(() => exportar("esf", opts())).toThrow("colisión"); expect(readFileSync(target(), "utf8")).toBe(before);
});

test("no sigue symlink del histórico ni sobreescribe su destino", () => {
  exportar("esf", opts()); const outside = join(tmp, "outside.md"); writeFileSync(outside, "no tocar");
  symlinkSync(outside, target().replace(".md", ".r1.md"));
  registry.repos[0].use_rule = "cambio"; save(); commit();
  expect(() => exportar("esf", opts())).toThrow("symlink"); expect(readFileSync(outside, "utf8")).toBe("no tocar");
});

test("rechaza nombres duplicados y SHA incompleto", () => {
  registry.repos.push(registry.repos[0]); save(); commit(); expect(() => exportar("--todos", opts())).toThrow("duplicados");
  registry.repos.pop(); registry.repos[0].last_sha = "d901657"; save(); commit();
  expect(() => exportar("esf", opts())).toThrow("40 hex"); expect(existsSync(target())).toBe(false);
});
