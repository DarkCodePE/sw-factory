#!/usr/bin/env bun
// Envoltura del harness sobre la CLI de graft (ADR-0008, M2–M4 y fase A). No modifica graft ni el repo consultado.
// Núcleo independiente: solo Bun/node, git, rg y graft; no importa nada de src/ de fab (lo acoplado va en lector-fab.ts).
// Uso: graft-lector.ts <init|ask|callers|skeleton|grep|rg|measure|session-init> ... --repo <ruta> [--meta f] [--session f]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_BYTES = 8192;
export type Hit = { title: string; pointer: string; snippet: string; scope?: string; kind?: string };

export function formatHits(hits: Hit[]): string {
  return hits
    .map((h, i) => {
      const snip = h.snippet.replace(/\s+/g, " ").trim().slice(0, 160);
      return `${i + 1}. [${h.scope ?? ""}/] ${h.title}\n   ${h.pointer}${snip ? `\n   ${snip}` : ""}`;
    })
    .join("\n\n");
}

export type CallerMatch = { symbol: { name: string; kind: string; path: string; span: string }; hits: unknown[] };

/** M2: con más de una definición no se elige; se devuelven los candidatos con archivo:línea. */
export function candidatesOrNull(matches: CallerMatch[], name: string): string | null {
  if (matches.length <= 1) return null;
  const sorted = [...matches].sort((a, b) => Number(b.symbol.name === name) - Number(a.symbol.name === name));
  const lines = sorted.slice(0, 60).map((m) => `  ${m.symbol.path}:${m.symbol.span} (${m.symbol.kind} ${m.symbol.name}, ${m.hits.length} referencias)`);
  const more = sorted.length > 60 ? `\n  … y ${sorted.length - 60} más` : "";
  return `AMBIGUO: ${matches.length} definiciones de "${name}"; elige una y repite con --in <ruta>:\n${lines.join("\n")}${more}`;
}

/** M3 + A3: tope por llamada; si se supera, salida completa a un archivo y vista previa con la ruta.
 * `head` líneas iniciales (cabecera de conteo) se conservan siempre; con `rank`, las líneas de rango 0 (p. ej. exports) entran antes. */
export function bound(text: string, max = MAX_BYTES, dir = process.env.LECTOR_SPILL_DIR ?? tmpdir(), opts: { head?: number; rank?: (line: string) => number } = {}): string {
  const total = Buffer.byteLength(text);
  if (total <= max) return text;
  const file = join(mkdtempSync(join(dir, "lector-")), "salida.txt");
  writeFileSync(file, text);
  const lines = text.split("\n");
  const head = Math.min(opts.head ?? 0, lines.length);
  const keep = new Set<number>(Array.from({ length: head }, (_, i) => i));
  let used = lines.slice(0, head).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  const order = lines.map((_, i) => i).slice(head);
  if (opts.rank) order.sort((a, b) => opts.rank!(lines[a]!) - opts.rank!(lines[b]!) || a - b);
  for (const i of order) {
    used += Buffer.byteLength(lines[i]!) + 1;
    if (used > max) break;
    keep.add(i);
  }
  const cut = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n");
  return `${cut}\n[truncado: ${total} bytes en total, ${keep.size} de ${lines.length} líneas; salida completa en ${file}]`;
}

export type Meta = { commit: string; indexedAt: string };

/** M4: null si el índice está al día; si no, el motivo. */
export function staleness(meta: Meta | null, head: string): string | null {
  if (!meta) return "sin sidecar de frescura: ejecuta `init` tras verificar el índice";
  return meta.commit === head ? null : `índice obsoleto: indexado en ${meta.commit.slice(0, 8)}, HEAD en ${head.slice(0, 8)}`;
}

/** A3: nombres declarados con `export` en un fuente TS/JS (los que el skeleton debe mostrar primero). */
export function exportedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!);
  return names;
}

/** A3: rango 0 para las líneas de `graft skeleton` cuyo símbolo está exportado. */
export const exportRank = (names: Set<string>) => (line: string) => {
  const name = /^- L\d+-L\d+\s+\S+\s+([\w$]+)/.exec(line)?.[1];
  return name && names.has(name) ? 0 : 1;
};

/** A2: salida de `rg -n` con cabecera de conteo (la cabecera sobrevive a la vista previa de `bound`). */
export function rgReport(pattern: string, raw: string): string {
  const lines = raw.split("\n").filter(Boolean);
  const files = new Set(lines.map((l) => l.split(":")[0]));
  return `"${pattern}" — ${lines.length} líneas en ${files.size} archivos (rg; respeta .gitignore/.ignore)\n${lines.join("\n")}`;
}

/** A4: `git ls-files --eol -z` → rutas, marcando binarios (git los detecta: `i/-text`). */
export function lsFilesEol(raw: string): { path: string; binary: boolean }[] {
  return raw.split("\0").filter(Boolean).map((rec) => {
    const tab = rec.indexOf("\t");
    return { path: rec.slice(tab + 1), binary: rec.slice(0, tab).includes("i/-text") };
  });
}

/** A4: bytes/4, determinista. */
export const tokensOf = (bytes: number) => Math.ceil(bytes / 4);
export const DEFAULT_READ_BUDGET = 128_000;

export function measureDecision(tokens: number, budget: number): "leer_entero" | "bajar_nivel" {
  return tokens <= budget ? "leer_entero" : "bajar_nivel";
}

/** A5: presupuesto prerregistrable del Probe (ADR-0008, decisiones 1 y 4). */
export type ProbeBudget = { tipo_fuente: "paper" | "articulo" | "repo"; tokens_medidos: number; presupuesto_lectura: number; tope_consultas: number };

export function validateProbeBudget(x: unknown): ProbeBudget {
  const b = x as Partial<Record<keyof ProbeBudget, unknown>> | null;
  if (typeof b !== "object" || b === null) throw new Error("ProbeBudget: se esperaba un objeto");
  if (b.tipo_fuente !== "paper" && b.tipo_fuente !== "articulo" && b.tipo_fuente !== "repo") throw new Error("ProbeBudget.tipo_fuente: paper | articulo | repo");
  for (const k of ["tokens_medidos", "presupuesto_lectura", "tope_consultas"] as const) {
    const v = b[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < (k === "tokens_medidos" ? 0 : 1)) throw new Error(`ProbeBudget.${k}: entero ${k === "tokens_medidos" ? ">= 0" : ">= 1"}`);
  }
  return b as ProbeBudget;
}

export type Session = { budget: ProbeBudget; consultas: number; bytes_servidos: number; cortada?: string };

/** A5: cuenta una consulta y los bytes servidos. `cut` es el motivo si se supera un tope (y entonces no se sirve nada). Pura. */
export function chargeSession(s: Session, bytes: number): { session: Session; cut: string | null } {
  const next: Session = { ...s, consultas: s.consultas + 1 };
  const maxBytes = s.budget.presupuesto_lectura * 4;
  const cut = s.cortada
    ? s.cortada
    : next.consultas > s.budget.tope_consultas
      ? `tope de consultas superado (${s.budget.tope_consultas})`
      : s.bytes_servidos + bytes > maxBytes
        ? `presupuesto de lectura superado (${s.bytes_servidos + bytes} > ${maxBytes} bytes)`
        : null;
  if (cut) return { session: { ...next, cortada: cut }, cut };
  return { session: { ...next, bytes_servidos: s.bytes_servidos + bytes }, cut: null };
}

function run(cmd: string, args: string[], cwd?: string): { out: string; code: number } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, cwd });
  return { out: r.stdout + (r.status === 0 ? "" : r.stderr), code: r.status ?? 1 };
}

const USAGE = "uso: graft-lector <init|ask|callers|skeleton|grep|rg|measure> [arg] --repo <ruta> [--meta f] [--in ruta] [--fixed] [--bodies] [--allow-stale] [--session f] [--budget N]\n" +
  "     graft-lector session-init <archivo> --tipo-fuente <paper|articulo|repo> --tokens N --tope N [--budget N]";

function main(argv: string[]): number {
  const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const flags = new Set(["--repo", "--meta", "--in", "--max-bytes", "--session", "--budget", "--tipo-fuente", "--tokens", "--tope"]);
  const pos = argv.filter((a, i) => !a.startsWith("--") && !flags.has(argv[i - 1] ?? ""));
  const [cmd, arg] = pos;
  const repo = opt("--repo");

  if (cmd === "session-init") {
    if (!arg) { console.error(USAGE); return 2; }
    try {
      const budget = validateProbeBudget({
        tipo_fuente: opt("--tipo-fuente"), tokens_medidos: Number(opt("--tokens")),
        presupuesto_lectura: Number(opt("--budget") ?? DEFAULT_READ_BUDGET), tope_consultas: Number(opt("--tope")),
      });
      writeFileSync(arg, JSON.stringify({ budget, consultas: 0, bytes_servidos: 0 } satisfies Session));
    } catch (e) { console.error((e as Error).message); return 2; }
    console.log(`sesión escrita en ${arg}`);
    return 0;
  }
  if (!cmd || !arg && cmd !== "init" || !repo) { console.error(USAGE); return 2; }
  const metaPath = opt("--meta") ?? process.env.LECTOR_META ?? join(repo, "graft", ".lector-meta.json");
  const head = run("git", ["-C", repo, "rev-parse", "HEAD"]).out.trim();
  const max = Number(opt("--max-bytes") ?? MAX_BYTES);

  if (cmd === "init") {
    // Solo registra el commit si graft confirma que el índice coincide con el código.
    const chk = run("graft", ["check", repo]);
    if (chk.code !== 0 && !argv.includes("--force")) { console.error(`graft check falló:\n${chk.out}`); return 4; }
    writeFileSync(metaPath, JSON.stringify({ commit: head, indexedAt: new Date().toISOString() }));
    console.log(`sidecar escrito en ${metaPath}: ${head}`);
    return 0;
  }

  if (cmd === "measure") {
    // A4: bytes de los archivos versionados bajo la ruta; sin sidecar ni graft.
    const ls = run("git", ["-C", repo, "ls-files", "--eol", "-z", "--", arg!]);
    if (ls.code !== 0) { console.error(ls.out); return 1; }
    let bytes = 0, files = 0, binarios = 0;
    for (const { path: f, binary } of lsFilesEol(ls.out)) {
      if (binary) { binarios++; continue; } // no se leen como texto: no cuentan para el presupuesto
      try { bytes += statSync(join(repo, f)).size; files++; } catch { /* submódulo o archivo borrado */ }
    }
    const budget = Number(opt("--budget") ?? DEFAULT_READ_BUDGET);
    const tokens_medidos = tokensOf(bytes);
    console.log(JSON.stringify({ ruta: arg, archivos: files, binarios_excluidos: binarios, bytes, tokens_medidos, presupuesto_lectura: budget, decision: measureDecision(tokens_medidos, budget) }));
    return 0;
  }

  const sessionPath = opt("--session");
  const session: Session | null = sessionPath ? { ...JSON.parse(readFileSync(sessionPath, "utf8")) } : null;
  if (session) validateProbeBudget(session.budget);

  const meta: Meta | null = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  const stale = staleness(meta, head);
  if (cmd !== "rg" && stale && !argv.includes("--allow-stale")) { console.error(stale); return 3; }
  const warn = cmd !== "rg" && stale ? `AVISO: ${stale}\n` : "";
  const base = ["--no-refresh"]; // sin reescribir el índice (repo de solo lectura)
  const scope = opt("--in") ? ["--in", opt("--in")!] : [];
  let text = "";
  let shape: { head?: number; rank?: (line: string) => number } = {};

  if (cmd === "ask") {
    const r = argv.includes("--bodies") ? run("graft", ["ask", arg!, repo, "--source", ...scope, ...base]) : run("graft", ["ask", arg!, repo, "--json", ...scope, ...base]);
    if (r.code !== 0) { console.error(r.out); return 1; }
    text = argv.includes("--bodies") ? r.out : formatHits((JSON.parse(r.out) as { hits: Hit[] }).hits);
  } else if (cmd === "callers") {
    const r = run("graft", ["callers", arg!, repo, "--json", ...scope, ...base]);
    if (r.code !== 0) { console.error(r.out); return 1; }
    const matches = (JSON.parse(r.out) as { matches: CallerMatch[] }).matches;
    text = candidatesOrNull(matches, arg!) ?? run("graft", ["callers", arg!, repo, ...scope, ...base]).out;
  } else if (cmd === "skeleton" || cmd === "grep") {
    text = run("graft", [cmd, arg!, repo, ...(cmd === "grep" ? ["--fixed"] : []), ...scope, ...base]).out;
    if (cmd === "grep") shape = { head: 2 };
    else {
      const src = join(repo, arg!);
      shape = { head: Math.max(0, text.split("\n").findIndex((l) => l.startsWith("- "))), rank: existsSync(src) ? exportRank(exportedNames(readFileSync(src, "utf8"))) : undefined };
    }
  } else if (cmd === "rg") {
    // A2: localizador principal. Sin refresh ni índice: no depende de graft.
    const r = spawnSync("rg", ["-n", "--no-heading", "--sort", "path", "--max-columns", "200", "--max-columns-preview", ...(existsSync(join(repo, "graft", ".graph")) ? ["-g", "!/graft/"] : []), ...(argv.includes("--fixed") ? ["-F"] : []), "-e", arg!, "--", opt("--in") ?? "."], { encoding: "utf8", maxBuffer: 1 << 28, cwd: repo });
    if (r.status !== 0 && r.status !== 1) { console.error(r.stderr); return 1; }
    text = rgReport(arg!, r.stdout);
    shape = { head: 1 };
  } else { console.error(USAGE); return 2; }

  const out = bound(warn + text, max, undefined, shape);
  if (session && sessionPath) {
    const { session: next, cut } = chargeSession(session, Buffer.byteLength(out));
    writeFileSync(sessionPath, JSON.stringify(next));
    if (cut) { console.error(`SESIÓN CORTADA: ${cut}`); return 5; }
  }
  console.log(out);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
