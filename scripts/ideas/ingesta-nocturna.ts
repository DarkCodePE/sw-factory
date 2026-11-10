#!/usr/bin/env bun
// Ingesta nocturna (T4b): clasifica los clips de la carpeta de entrada, los mueve a raw/sources/clips/<CATEGORÍA>/
// y avisa a llm_wiki con el rescan que ya existe. Un clip que no se clasifica con confianza se queda donde está.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { classifySources, DEFAULTS, updateCategories, type Ask, type Options } from "./clasificar.ts";
import { resolveProyecto } from "./reflejar.ts";

export type Env = Record<string, string | undefined>;
export type Rescan = (projectId: string) => Promise<void>;
export type Resultado = { movidos: string[]; retenidos: { clip: string; motivo: string }[]; rescan: "ok" | "omitido" | { error: string } };

export const DEFAULT_INBOX = "/home/orlando/Desktop/VAUL-FAB/FAB-inbox";
const API = "http://127.0.0.1:19828/api/v1"; // puerto fijo de api_server.rs en llm_wiki

export const resolveInbox = (env: Env = process.env) => resolve(env.FAB_VAULT_INBOX?.trim() || DEFAULT_INBOX);

/** El token llega solo por LLM_WIKI_API_TOKEN; nunca se imprime ni se registra. */
export function rescanApi(env: Env = process.env): Rescan {
  return async projectId => {
    const token = env.LLM_WIKI_API_TOKEN;
    const base = env.LLM_WIKI_API_URL?.trim() || API;
    const res = await fetch(`${base}/projects/${encodeURIComponent(projectId)}/sources/rescan`, {
      method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`rescan: HTTP ${res.status}`);
  };
}

function journal(file: string, entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.error(line);
  try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, line + "\n"); } catch (e) { console.error(`journal: ${(e as Error).message}`); }
}

/** Escribe sin pisar nada: si el destino existe, añade -2, -3... al nombre. */
function destino(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = name.endsWith(".md") ? ".md" : "", stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    if (!existsSync(path)) return path;
  }
}

type Fuente = { clip: string; text: string };

/** Clasifica cada clip por separado (un fallo no arrastra al resto) y mueve solo los clasificados con confianza. */
async function clasificarYMover(fuentes: Fuente[], proyecto: string, opts: Options, ask: Ask | undefined, log: (e: Record<string, unknown>) => void): Promise<Pick<Resultado, "movidos" | "retenidos">> {
  const movidos: string[] = [], retenidos: Resultado["retenidos"] = [];
  const clips = join(proyecto, "raw", "sources", "clips");
  for (const { clip, text } of fuentes) {
    try {
      const [c] = await classifySources([clip], { ...opts, write: false }, ask);
      if (!c || c.low_confidence) { retenidos.push({ clip, motivo: "baja confianza" }); log({ evento: "retenido", clip, motivo: "baja confianza" }); continue; }
      const nuevo = destino(join(clips, c.categories[0]!), basename(clip));
      writeFileSync(nuevo, updateCategories(text, c.categories), { flag: "wx" });
      rmSync(clip);
      movidos.push(nuevo);
      log({ evento: "movido", clip, destino: nuevo, categories: c.categories });
    } catch (e) {
      retenidos.push({ clip, motivo: (e as Error).message });
      log({ evento: "retenido", clip, motivo: (e as Error).message });
    }
  }
  return { movidos, retenidos };
}

async function avisar(movidos: string[], rescan: Rescan, env: Env, log: (e: Record<string, unknown>) => void): Promise<Resultado["rescan"]> {
  if (!movidos.length) return "omitido";
  const id = env.LLM_WIKI_PROJECT_ID?.trim();
  try {
    if (!id) throw new Error("falta LLM_WIKI_PROJECT_ID");
    await rescan(id);
    log({ evento: "rescan", ok: true });
    return "ok";
  } catch (e) {
    // El movimiento no se deshace: la app recoge los archivos al abrirse (startup rescan).
    log({ evento: "rescan", ok: false, error: (e as Error).message });
    return { error: (e as Error).message };
  }
}

const clipsDe = (dir: string) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith(".")).map(d => join(dir, d.name)).sort() : [];

export async function ingestaNocturna(o: { inbox: string; proyecto: string; env?: Env; ask?: Ask; rescan?: Rescan; opts?: Partial<Options> }): Promise<Resultado> {
  const env = o.env ?? process.env, opts = { ...DEFAULTS, ...o.opts, vault: o.proyecto };
  const log = (e: Record<string, unknown>) => journal(join(o.inbox, ".ingesta-journal.jsonl"), e);
  const fuentes = clipsDe(o.inbox).map(clip => ({ clip, text: readFileSync(clip, "utf8") }));
  const r = await clasificarYMover(fuentes, o.proyecto, opts, o.ask, log);
  return { ...r, rescan: await avisar(r.movidos, o.rescan ?? rescanApi(env), env, log) };
}

/** Una sola vez: clips sueltos de raw/sources/*.md → clips/<CATEGORÍA>/. Simulación salvo aplicar=true; copia previa de raw/sources y wiki. */
export async function migrarSueltos(o: { proyecto: string; aplicar?: boolean; backupDir?: string; env?: Env; ask?: Ask; rescan?: Rescan; opts?: Partial<Options> }): Promise<Resultado & { backup?: string; simulado: boolean; plan?: { clip: string; categories: string[] }[] }> {
  const env = o.env ?? process.env, opts = { ...DEFAULTS, ...o.opts, vault: o.proyecto };
  const sueltos = clipsDe(join(o.proyecto, "raw", "sources"));
  if (!o.aplicar) {
    const plan = [];
    for (const clip of sueltos) { const [c] = await classifySources([clip], { ...opts, write: false }, o.ask); plan.push({ clip, categories: c!.low_confidence ? [`${c!.categories[0]} (baja confianza: se quedaría)`] : c!.categories }); }
    return { movidos: [], retenidos: [], rescan: "omitido", simulado: true, plan };
  }
  const backup = resolve(o.backupDir ?? `${o.proyecto}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (existsSync(backup)) throw new Error(`${backup}: la copia de seguridad ya existe`);
  for (const d of ["raw/sources", "wiki"]) if (existsSync(join(o.proyecto, d))) cpSync(join(o.proyecto, d), join(backup, d), { recursive: true });
  const log = (e: Record<string, unknown>) => journal(join(backup, "migracion.jsonl"), e);
  const r = await clasificarYMover(sueltos.map(clip => ({ clip, text: readFileSync(clip, "utf8") })), o.proyecto, opts, o.ask, log);
  return { ...r, rescan: await avisar(r.movidos, o.rescan ?? rescanApi(env), env, log), backup, simulado: false };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) console.log("uso: bun scripts/ideas/ingesta-nocturna.ts [--migrar-sueltos [--aplicar]]\nEntorno: FAB_VAULT_INBOX, FAB_VAULT, LLM_WIKI_PROJECT_ID, LLM_WIKI_API_TOKEN, LLM_WIKI_API_URL.\nSale con 1 si algún clip se queda sin mover o el rescan falla.");
  else try {
    const proyecto = resolveProyecto();
    const r = args.includes("--migrar-sueltos") ? await migrarSueltos({ proyecto, aplicar: args.includes("--aplicar") }) : await ingestaNocturna({ inbox: resolveInbox(), proyecto });
    console.log(JSON.stringify(r, null, 2));
    if (r.retenidos.length || typeof r.rescan === "object") process.exitCode = 1;
  } catch (e) { console.error(`ingesta-nocturna: ${(e as Error).message}`); process.exitCode = 1; }
}
