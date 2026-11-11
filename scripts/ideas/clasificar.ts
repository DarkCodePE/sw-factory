#!/usr/bin/env bun
// jevify ask agrupa 14 preguntas por fuente sin gestionar servidor/puerto ni dejar procesos residentes.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Taxonomía cerrada de FAB/schema.md; descripciones en inglés para el readout noul validado.
export const TAXONOMY = {
  ONTOLOGIA: "formal domain models, taxonomies and semantic hierarchies",
  WIKI: "Markdown knowledge vaults and linked Karpathy-style knowledge bases",
  HARNESS: "execution environments, sandboxes and adapters for AI agents",
  MEMORY: "episodic, semantic, operational or vector memory systems",
  LOOP: "reasoning loops, feedback cycles and iterative workflows",
  "SELF-IMPROVING": "learning from errors and changing strategies to improve future behavior",
  CONTEXT: "management, compaction, compression and budgets of context windows",
  FACTORY: "industrial orchestration, multi-agent workflows and software assembly",
  MODEL: "architectures, weights, intrinsic capabilities and benchmarks of large language models",
  RL: "reinforcement learning, reward optimization and behavioral alignment",
  "FINE-TUNING": "supervised fine-tuning, SFT, LoRA, QLoRA and model specialization",
  EVAL: "evaluation rubrics, test suites, benchmarks and agent metrics",
  SKILL: "packaged capabilities, standard procedures and tools",
  GRAPH: "dependency graphs, knowledge graphs and call indexes",
} as const;
export type Category = keyof typeof TAXONOMY;
const CATEGORIES = Object.keys(TAXONOMY) as Category[];
export const DEFAULT_RECIPE = fileURLToPath(new URL("../../config/ideas/qwen35.ollama.yaml", import.meta.url));
export type Options = { threshold: number; maxCategories: number; maxChars: number; recipe: string; write: boolean; vault: string };
export const DEFAULTS: Options = { threshold: 0.5, maxCategories: 3, maxChars: 16_000, recipe: DEFAULT_RECIPE, write: false, vault: "/home/orlando/Desktop/VAUL-FAB/FAB" };
export type Ask = (state: string, recipe: string) => unknown | Promise<unknown>;
export type Classification = { ruta: string; categories: Category[]; probs: Record<Category, number>; recipe_hash: string; modelo: string; low_confidence: boolean; characters_total: number; characters_used: number; truncated: boolean };

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: se esperaba un objeto`);
  return value as Record<string, unknown>;
}

export function validateOptions(options: Options): void {
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) throw new Error("--threshold: número entre 0 y 1");
  if (!Number.isInteger(options.maxCategories) || options.maxCategories < 1 || options.maxCategories > 3) throw new Error("--max-categories: entero entre 1 y 3");
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1) throw new Error("--max-chars: entero positivo");
}

type Markdown = { bom: string; opening: string; header: string | null; closing: string; body: string; eol: string };
function markdownParts(text: string): Markdown {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const raw = text.slice(bom.length), eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const start = /^---[ \t]*\r?\n/.exec(raw);
  if (!start) return { bom, opening: "", header: null, closing: "", body: raw, eol };
  const rest = raw.slice(start[0].length);
  const end = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!end) throw new Error("frontmatter sin cierre");
  const header = rest.slice(0, end.index);
  const parsed: unknown = Bun.YAML.parse(header);
  if (parsed !== null) object(parsed, "frontmatter YAML");
  return { bom, opening: start[0], header, closing: end[0], body: rest.slice(end.index + end[0].length), eol };
}

export const stripFrontmatter = (text: string): string => markdownParts(text).body;

/** Reemplaza solo el campo categories; conserva cuerpo, otros campos, comentarios y CRLF/BOM. */
export function updateCategories(text: string, categories: Category[]): string {
  if (categories.length < 1 || categories.length > 3 || new Set(categories).size !== categories.length || categories.some(c => !CATEGORIES.includes(c))) throw new Error("categories: se requieren 1–3 categorías oficiales distintas");
  const p = markdownParts(text), value = `categories: [${categories.join(", ")}]`;
  if (p.header === null) return `${p.bom}---${p.eol}${value}${p.eol}---${p.eol}${p.body}`;
  const before = object(Bun.YAML.parse(p.header) ?? {}, "frontmatter");
  const lines = p.header.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const indices = lines.flatMap((line, i) => /^(?:categories|"categories"|'categories')[ \t]*:/.test(line) ? [i] : []);
  if (indices.length > 1 || (Object.hasOwn(before, "categories") && indices.length !== 1)) throw new Error("frontmatter: campo categories duplicado o formato no soportado");
  let header: string;
  if (indices.length === 0) header = `${p.header}${p.header && !p.header.endsWith("\n") ? p.eol : ""}${value}${p.eol}`;
  else {
    const start = indices[0]!;
    // Un # fuera de comillas y precedido por espacio inicia comentario YAML.
    const original = lines[start]!.replace(/\r?\n$/, "");
    let quote = "", comment = "";
    for (let i = original.indexOf(":") + 1; i < original.length; i++) {
      const c = original[i]!;
      if (quote === '"' && c === "\\") { i++; continue; }
      if (quote === "'" && c === "'" && original[i + 1] === "'") { i++; continue; }
      if (c === quote) quote = "";
      else if (!quote && (c === '"' || c === "'")) quote = c;
      else if (!quote && c === "#" && /\s/.test(original[i - 1] ?? "")) { comment = ` ${original.slice(i)}`; break; }
    }
    let end = start + 1;
    const keep: string[] = [];
    while (end < lines.length) {
      const line = lines[end]!;
      if (/^\s*(?:#.*)?(?:\r?\n)?$/.test(line)) keep.push(line);
      else if (!/^[ \t]|^-|^\]/.test(line)) break;
      end++;
    }
    header = [...lines.slice(0, start), `${value}${comment}${p.eol}`, ...keep, ...lines.slice(end)].join("");
  }
  const after = object(Bun.YAML.parse(header), "frontmatter actualizado");
  const withoutCategories = ({ categories: _, ...rest }: Record<string, unknown>) => rest;
  if (JSON.stringify(withoutCategories(before)) !== JSON.stringify(withoutCategories(after))) throw new Error("frontmatter: la edición cambiaría otros campos; no se escribe");
  return `${p.bom}${p.opening}${header}${p.closing}${p.body}`;
}

/** Cuenta puntos de código Unicode (no bytes ni mitades de un surrogate). */
export function truncateText(text: string, maxChars: number) {
  const chars = Array.from(text);
  return { state: chars.slice(0, maxChars).join(""), characters_total: chars.length, characters_used: Math.min(chars.length, maxChars), truncated: chars.length > maxChars };
}

function command(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  if (result.error) throw new Error(`${command}: ${result.error.message}${"code" in result.error && result.error.code === "ENOENT" ? " (no está instalado o no figura en PATH)" : ""}`);
  if (result.status !== 0) throw new Error(`${command}: salida ${result.status ?? result.signal}: ${result.stderr.trim().slice(0, 2000)}`);
  return result.stdout;
}

/** Solo lee nombres/descripciones de manifests y README, nunca scripts ni archivos de entorno. */
export function readSource(path: string): { ruta: string; text: string; markdown?: string } {
  const ruta = realpathSync(path), info = lstatSync(ruta);
  if (info.isDirectory()) {
    const read = (name: string): string | null => {
      const file = join(ruta, name);
      try {
        if (!lstatSync(file).isFile()) return null; // no seguir README/manifests enlazados
      } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
      return readFileSync(file, "utf8");
    };
    const texts: string[] = [];
    for (const name of ["README.md", "readme.md", "README.rst", "README"]) {
      const content = read(name);
      if (content !== null) { texts.push(stripFrontmatter(content)); break; }
    }
    for (const name of ["package.json", "Cargo.toml", "pyproject.toml"]) {
      const raw = read(name);
      if (raw === null) continue;
      const manifest = object(name.endsWith(".json") ? JSON.parse(raw) : Bun.TOML.parse(raw), name);
      const sections = name === "package.json" ? [manifest] : name === "Cargo.toml"
        ? [manifest.package, (manifest.workspace as Record<string, unknown> | undefined)?.package]
        : [manifest.project, ((manifest.tool as Record<string, unknown> | undefined)?.poetry)];
      for (const section of sections) {
        if (!section || typeof section !== "object") continue;
        const fields = section as Record<string, unknown>;
        const description = [fields.name, fields.description].filter(x => typeof x === "string").join(" — ");
        if (description) texts.push(`${name}: ${description}`);
      }
    }
    if (!texts.length) throw new Error(`${path}: repo sin README ni descripción de package/Cargo/pyproject`);
    // Metadatos primero: el truncado de un README largo no los deja fuera.
    return { ruta, text: texts.slice(1).concat(texts[0]!).join("\n\n") };
  }
  if (!info.isFile()) throw new Error(`${path}: no es archivo ni directorio`);
  const extension = extname(ruta).toLowerCase();
  if (extension === ".md") {
    const markdown = readFileSync(ruta, "utf8");
    return { ruta, text: stripFrontmatter(markdown), markdown };
  }
  if (extension === ".pdf") return { ruta, text: command("pdftotext", ["-layout", ruta, "-"]) };
  throw new Error(`${path}: solo .md, .pdf o directorios de repo`);
}

export function askJevify(state: string, recipe: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "fab-clasificar-"));
  try {
    const file = join(dir, "state.txt");
    writeFileSync(file, state, { mode: 0o600 });
    const questions = CATEGORIES.flatMap(cat => ["--noul", `${cat}:The main topic of this text includes ${TAXONOMY[cat]}.`]);
    return JSON.parse(command("jevify", ["ask", recipe, "--state", `@${file}`, ...questions]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function parseEvaluation(raw: unknown): { probs: Record<Category, number>; recipe_hash: string; modelo: string } {
  const result = object(raw, "jevify"), answers = object(result.answers, "jevify.answers");
  const hash = object(result.x_jevify, "jevify.x_jevify").recipe_hash;
  if (typeof result.model !== "string" || !result.model.trim() || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("jevify: modelo o recipe_hash inválidos");
  const probs = {} as Record<Category, number>;
  for (const cat of CATEGORIES) {
    const answer = object(answers[cat], `jevify.answers.${cat}`), p = answer.noul;
    if (answer.type !== "noul" || typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`jevify: probabilidad noul inválida para ${cat}`);
    if (answer.x_jevify !== undefined) {
      const metadata = object(answer.x_jevify, `${cat}.x_jevify`);
      if (metadata.recipe_hash !== hash || metadata.degraded === true) throw new Error(`jevify: receta inconsistente o readout degradado para ${cat}`);
    }
    probs[cat] = p;
  }
  return { probs, recipe_hash: hash, modelo: result.model };
}

export function selectCategories(probs: Record<Category, number>, threshold: number, maxCategories: number) {
  validateOptions({ ...DEFAULTS, threshold, maxCategories });
  const ranked = [...CATEGORIES].sort((a, b) => probs[b] - probs[a]);
  const selected = ranked.filter(c => probs[c] >= threshold).slice(0, maxCategories);
  return { categories: selected.length ? selected : [ranked[0]!], low_confidence: selected.length === 0 };
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export function writeTarget(path: string, vault: string): string {
  const root = realpathSync(vault), raw = realpathSync(join(root, "raw", "sources")), target = realpathSync(path);
  if (!inside(root, raw) || !inside(raw, target) || extname(target).toLowerCase() !== ".md" || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`--write: solo clips .md regulares dentro de ${root}/raw/sources/`);
  return target;
}

export function writeCategories(path: string, categories: Category[], vault: string, expected: string): boolean {
  const target = writeTarget(path, vault), fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let mode: number;
  try {
    if (readFileSync(fd, "utf8") !== expected) throw new Error(`${path}: cambió durante la clasificación; no se escribe`);
    mode = fstatSync(fd).mode & 0o777;
  } finally { closeSync(fd); }
  const updated = updateCategories(expected, categories);
  if (updated === expected) return false;
  const temp = join(dirname(target), `.clasificar-${randomUUID()}.tmp`);
  try {
    const out = openSync(temp, "wx", mode);
    try { writeFileSync(out, updated); fchmodSync(out, mode); fsyncSync(out); } finally { closeSync(out); }
    if (writeTarget(path, vault) !== target || readFileSync(target, "utf8") !== expected) throw new Error(`${path}: cambió antes de guardar; no se escribe`);
    renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
  return true;
}

export async function classifySources(paths: string[], options: Options = DEFAULTS, ask: Ask = askJevify): Promise<Classification[]> {
  validateOptions(options);
  if (!paths.length) throw new Error("se requiere al menos una fuente");
  if (options.write) for (const path of paths) writeTarget(path, options.vault);
  const sources = paths.map(readSource), results: Classification[] = [];
  if (options.write && new Set(sources.map(s => s.ruta)).size !== sources.length) throw new Error("--write: fuentes duplicadas; cada clip debe aparecer una sola vez");
  for (const source of sources) {
    const { state, ...counts } = truncateText(source.text, options.maxChars);
    if (!state.trim()) throw new Error(`${source.ruta}: fuente vacía o sin texto extraíble`);
    const evaluation = parseEvaluation(await ask(state, options.recipe));
    results.push({ ruta: source.ruta, ...evaluation, ...selectCategories(evaluation.probs, options.threshold, options.maxCategories), ...counts });
  }
  if (options.write) {
    // Preparar todas las ediciones antes de tocar el primer clip.
    for (const [i, source] of sources.entries()) updateCategories(source.markdown!, results[i]!.categories);
    for (const [i, source] of sources.entries()) writeCategories(source.ruta, results[i]!.categories, options.vault, source.markdown!);
  }
  return results;
}

export function parseArgs(args: string[]): { paths: string[]; options: Options } {
  const options = { ...DEFAULTS }, paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { paths.push(...args.slice(i + 1)); break; }
    if (arg === "--write") { options.write = true; continue; }
    if (!arg.startsWith("--")) { paths.push(arg); continue; }
    if (!["--threshold", "--max-categories", "--max-chars", "--recipe", "--vault"].includes(arg)) throw new Error(`opción desconocida: ${arg}`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`falta valor para ${arg}`);
    switch (arg) {
      case "--threshold": options.threshold = Number(value); break;
      case "--max-categories": options.maxCategories = Number(value); break;
      case "--max-chars": options.maxChars = Number(value); break;
      case "--recipe": options.recipe = resolve(value); break;
      case "--vault": options.vault = resolve(value); break;
    }
  }
  validateOptions(options);
  if (!paths.length) throw new Error("se requiere al menos una fuente");
  return { paths: paths.map(p => resolve(p)), options };
}

if (import.meta.main) {
  if (process.argv.includes("--help")) console.log("uso: bun scripts/ideas/clasificar.ts <fuentes...> [--threshold 0.5] [--max-categories 3] [--max-chars 16000] [--recipe ruta] [--write --vault ruta]\nSin --write solo JSON; --write solo actualiza categories de clips bajo raw/sources/, sin moverlos.");
  else try {
    const { paths, options } = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(await classifySources(paths, options), null, 2));
  } catch (e) { console.error(`clasificar: ${(e as Error).message}`); process.exitCode = 1; }
}
