#!/usr/bin/env bun
// Catálogo regenerable Loop B. Sin LLM; D1 = commit en main/release/* + aprobador.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defang } from "./ciclo.ts";
import { computeContentHash, parseFrontmatter, prepareRevision, resolveProyecto, writeRevision } from "./reflejar.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REGISTRY = "docs/research/registry.json";
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
type Layer = { level: string; what: string; evidence: string; verified: boolean };
type Repo = {
  name: string; last_sha?: string | null; analysis?: string | null;
  layers: Record<string, Layer>; license: { spdx: string; file_hash?: string | null; scopes: unknown[] };
  use_rule: string; candidates?: string[]; incompatible_perfil?: string[]; tos_risk?: string;
};
export type ExportarOpts = { root?: string; proyecto?: string; aprobadoPor?: string; dryRun?: boolean };
export type ExportarResult = { repo: string; action: string; path?: string; content?: string; revision?: number; reason?: string };

function git(root: string, ...args: string[]): string {
  try { return execFileSync("git", ["--literal-pathspecs", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd(); }
  catch { throw new Error(`falló git ${args[0]}`); }
}

/** Solo rutas relativas dentro del checkout, sin symlinks (incluidos los padres). */
function confined(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some(p => p === ".." || p === "" || p === ".")) throw new Error("ruta no relativa o insegura");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("ruta con symlink no permitida"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}

function cleanTracked(root: string, path: string): void {
  const full = confined(root, path);
  if (!lstatSync(full).isFile()) throw new Error(`${path}: no es archivo regular`);
  if (git(root, "status", "--porcelain", "--untracked-files=all", "--", path)) throw new Error(`${path}: cambios locales sin commit`);
  const head = execFileSync("git", ["--literal-pathspecs", "-C", root, "show", `HEAD:${path}`]);
  if (!readFileSync(full).equals(head)) throw new Error(`${path}: contenido distinto de HEAD`);
}

function analysisPath(path: string): string {
  // El registro guarda rutas relativas a factory, históricamente con prefijo sw-factory/.
  return path.startsWith("sw-factory/") ? path.slice("sw-factory/".length) : path;
}

function canonicalCommit(root: string, analysis: string): string {
  cleanTracked(root, REGISTRY);
  cleanTracked(root, analysis);
  const commit = git(root, "log", "-1", "--format=%H", "HEAD", "--", REGISTRY, analysis);
  const refs = git(root, "for-each-ref", `--contains=${commit}`, "--format=%(refname)", "refs/heads", "refs/remotes").split("\n");
  if (!refs.some(r => /^refs\/(?:heads|remotes\/[^/]+)\/(?:main|release\/.+)$/.test(r))) {
    throw new Error("D1: canonical_commit no alcanzable desde main o release/*");
  }
  return commit;
}

function compact(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // Los datos del registro son contenido no confiable; las rutas locales no son portables.
  if (/(?:^|[\s"'`(])(?:\/(?!\/)[\w.]|[A-Za-z]:[\\/])/.test(text)) throw new Error("el catálogo contiene una ruta absoluta local");
  return defang(text.replace(/\s+/g, " ")).slice(0, limit);
}

function render(repo: Repo, commit: string, analysis: string, state: ReturnType<typeof prepareRevision>, hash: string, aprobadoPor?: string): string {
  const categories = ["FACTORY", ...(repo.layers.C5 ? ["HARNESS"] : []), ...(repo.layers.C6 ? ["EVAL"] : [])];
  const identity = `${repo.name}@${commit}:${analysis}`;
  const fm = ["---", `knowledge_id: "repo-${repo.name}"`, `canonical_revision: ${state.revision}`,
    `content_hash: "${hash}"`, `upstream_commit: "${repo.last_sha}"`, `canonical_commit: "${commit}"`,
    "kind: observation", "scope: project", "project_id: fab", `status: ${aprobadoPor ? "reviewed" : "candidate"}`,
    "trust: agent", `categories: [${categories.join(", ")}]`, `aprobado_por: ${JSON.stringify(aprobadoPor ?? null)}`,
    `supersedes: ${JSON.stringify(state.supersedes)}`, `evidence: [${JSON.stringify(identity)}]`, "---"];
  const layers = Object.entries(repo.layers).map(([layer, data]) => `- ${compact(layer, 8)} (${compact(data.level, 20)}): ${compact(data.what, 90)}${data.verified ? "" : " [sin verificar]"}`);
  return [...fm, "", `# Catálogo: ${repo.name}`, "", "<untrusted-source>", "## Qué reutilizar", ...layers,
    "", "## Para qué problema", `Candidatos Loop B: ${compact(repo.candidates ?? [], 600)}.`,
    "Son propuestas para experimentar en fab; no implican adopción ni recomendación universal.", "", "## Límites y licencia",
    `Licencia: ${compact(repo.license, Infinity)}`, `Regla: ${compact(repo.use_rule, Infinity)}`,
    `Perfil incompatible: ${compact(repo.incompatible_perfil ?? [], Infinity)}. Riesgo ToS: ${compact(repo.tos_risk ?? "no registrado", 80)}.`,
    "", "## Dónde está la prueba", `Ficha Loop B: [${analysis}](${analysis}) @ ${commit}`,
    `Identidad: ${identity}`, `Evidencias por capa y líneas en la ficha, fijadas a upstream ${repo.last_sha}.`,
    "</untrusted-source>", "", "La memoria da pistas, no permisos. Verificar contra el checkout antes de aplicar.", ""].join("\n");
}

/** Planifica todo el lote antes de escribir; un repo sin ficha/SHA se omite con motivo. */
export function exportar(selector: string, opts: ExportarOpts = {}): ExportarResult[] {
  if (selector !== "--todos" && !NAME.test(selector)) throw new Error("repo inválido");
  const root = resolve(opts.root ?? ROOT);
  cleanTracked(root, REGISTRY);
  const registryContent = readFileSync(join(root, REGISTRY), "utf8");
  const registry = JSON.parse(registryContent);
  if (!Array.isArray(registry.repos)) throw new Error("registro inválido: falta repos");
  const repos: Repo[] = selector === "--todos" ? registry.repos : registry.repos.filter((r: Repo) => r.name === selector);
  if (new Set(registry.repos.map((r: Repo) => r.name)).size !== registry.repos.length) throw new Error("registro inválido: repos duplicados");
  if (!repos.length) throw new Error(`repo desconocido: ${selector}`);
  const proyecto = resolveProyecto(opts);
  const aprobadoPor = opts.aprobadoPor?.trim() || undefined;
  const dryRun = opts.dryRun === true || !aprobadoPor;
  for (const repo of repos) if (repo.last_sha && repo.analysis) canonicalCommit(root, analysisPath(repo.analysis));
  // El lock cubre lectura, planificación y escritura para todos los upstream del proyecto.
  const lock = join(proyecto, ".fab-exportar.lock");
  if (!dryRun) {
    confined(proyecto, "raw/sources/repos");
    mkdirSync(proyecto, { recursive: true });
    try { mkdirSync(lock); } catch { throw new Error("exportación ocupada: existe .fab-exportar.lock"); }
  }
  try {
    if (readFileSync(join(root, REGISTRY), "utf8") !== registryContent) throw new Error("el registro cambió durante la exportación; reintentar");
    const plans = repos.map(repo => {
      if (!NAME.test(repo.name)) throw new Error("nombre de repo inseguro");
      if (!repo.last_sha || !repo.analysis) return { result: { repo: repo.name, action: "skipped", reason: "falta last_sha o analysis" } as ExportarResult };
      if (!/^[a-f0-9]{40}$/.test(repo.last_sha)) throw new Error(`${repo.name}: last_sha debe tener 40 hex`);
      const analysis = analysisPath(repo.analysis);
      const commit = canonicalCommit(root, analysis);
      const payload = { knowledgeId: `repo-${repo.name}`, upstream_commit: repo.last_sha, canonical_commit: commit, analysis,
        layers: repo.layers, license: repo.license, use_rule: repo.use_rule, candidates: repo.candidates ?? [],
        incompatible_perfil: repo.incompatible_perfil ?? [], tos_risk: repo.tos_risk ?? null };
      const hash = computeContentHash(payload);
      const path = confined(proyecto, `raw/sources/repos/${repo.name}/${repo.last_sha.slice(0, 8)}.md`);
      const state = prepareRevision(path, hash);
      if (state.existingContent !== null) {
        const fm = parseFrontmatter(state.existingContent).frontmatter;
        if (fm.upstream_commit !== repo.last_sha || fm.knowledge_id !== `repo-${repo.name}`) throw new Error("colisión de prefijo upstream_sha8 o identidad");
      }
      confined(proyecto, relative(proyecto, state.previousPath));
      if (state.action === "superseded" && existsSync(state.previousPath) && readFileSync(state.previousPath, "utf8") !== state.existingContent) throw new Error("revisión histórica ya existe con otro contenido");
      const content = state.action === "unchanged" ? state.existingContent! : render(repo, commit, analysis, state, hash, aprobadoPor);
      if (Buffer.byteLength(content) >= 4096) throw new Error(`${repo.name}: ficha demasiado larga (>= 4 KB)`);
      const prior: { path: string; content: string }[] = [];
      if (existsSync(dirname(path))) for (const file of readdirSync(dirname(path))) {
        if (!/^[a-f0-9]{8}(?:\.r\d+)?\.md$/.test(file) || file.startsWith(repo.last_sha.slice(0, 8))) continue;
        const previous = confined(proyecto, `raw/sources/repos/${repo.name}/${file}`);
        const text = readFileSync(previous, "utf8");
        const fm = parseFrontmatter(text).frontmatter;
        if (fm.knowledge_id !== `repo-${repo.name}`) continue;
        if (fm.status !== "requiere-reevaluacion") prior.push({ path: previous, content: text.replace(/^status: .+$/m, "status: requiere-reevaluacion") });
      }
      return { result: { repo: repo.name, path, content, revision: state.revision,
        action: state.action === "unchanged" ? "unchanged" : dryRun ? "dry-run" : state.action } as ExportarResult, state, prior, commit, analysis };
    });
    if (!dryRun) {
      cleanTracked(root, REGISTRY);
      if (readFileSync(join(root, REGISTRY), "utf8") !== registryContent) throw new Error("el registro cambió durante la exportación; reintentar");
      for (const plan of plans) if (plan.analysis && canonicalCommit(root, plan.analysis) !== plan.commit) throw new Error("la fuente canónica cambió; reintentar");
      for (const plan of plans) if (plan.state && plan.result.path) {
        const current = existsSync(plan.result.path) ? readFileSync(plan.result.path, "utf8") : null;
        if (current !== plan.state.existingContent) throw new Error("la ficha cambió durante la exportación; reintentar");
      }
      for (const plan of plans) if (plan.state && plan.result.path && plan.result.content) {
        if (plan.state.action !== "unchanged") writeRevision(plan.result.path, plan.state, plan.result.content);
        for (const previous of plan.prior!) writeFileSync(previous.path, previous.content, "utf8");
      }
    }
    return plans.map(p => p.result);
  } finally { if (!dryRun) rmSync(lock, { recursive: true }); }
}

export function mainExportar(argv: string[]): number {
  try {
    let selector: string | undefined;
    const opts: ExportarOpts = {};
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--dry-run") opts.dryRun = true;
      else if (arg === "--aprobado-por" || arg === "--proyecto") {
        const value = argv[++i];
        if (!value?.trim() || value.startsWith("--")) throw new Error(`falta valor de ${arg}`);
        if (arg === "--proyecto") opts.proyecto = value; else opts.aprobadoPor = value;
      } else if (arg === "--todos" || !arg.startsWith("--")) {
        if (selector) throw new Error("usar un repo o --todos");
        selector = arg;
      } else throw new Error(`opción desconocida: ${arg}`);
    }
    if (!selector) throw new Error("uso: exportar.ts <repo>|--todos [--aprobado-por N] [--proyecto P] [--dry-run]");
    for (const result of exportar(selector, opts)) {
      if (result.action === "skipped") console.log(`${result.repo}: omitido (${result.reason})`);
      else if (result.action === "unchanged") console.log(`${result.repo}: sin cambios en ${result.path}`);
      else if (result.action === "dry-run") console.log(`[dry-run] ${result.path}\n${result.content}`);
      else console.log(`exportado: ${result.path} (${result.action}, rev ${result.revision})`);
    }
    return 0;
  } catch (error) { console.error(`exportar: ${(error as Error).message}`); return 2; }
}
if (import.meta.main) process.exit(mainExportar(process.argv.slice(2)));
