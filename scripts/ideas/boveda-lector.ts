import { realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { wrapMcpCommand } from "../../src/agent/mcp-sandbox.ts";
import type { ToolContext } from "../../src/agent/types.ts";
import { defang } from "./ciclo.ts";

export const DEFAULT_VAULT = "/home/orlando/Desktop/VAUL-FAB/FAB";
export const MAX_VAULT_BYTES = 8_192;
export const MAX_VAULT_RESULTS = 40;

function clipUtf8(text: string, maxBytes: number): string {
  let out = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char; bytes += size;
  }
  return out;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve only the supported corpus areas and fail closed for escaping symlinks. */
export async function resolveVaultArea(vaultPath: string, area: "wiki" | "raw/sources" = "wiki"): Promise<{ vault: string; directory: string }> {
  const requested = resolve(vaultPath);
  let vault: string;
  try { vault = await realpath(requested); }
  catch { throw new Error(`no existe la bóveda: ${requested}`); }
  if (!(await stat(vault)).isDirectory()) throw new Error(`la bóveda no es un directorio: ${vault}`);
  const lexical = resolve(vault, area);
  if (!inside(vault, lexical)) throw new Error("ruta fuera de la bóveda");
  let directory: string;
  try { directory = await realpath(lexical); }
  catch { throw new Error(`no existe el directorio de la bóveda: ${area}`); }
  if (!inside(vault, directory)) throw new Error(`el directorio ${area} escapa de la bóveda por symlink`);
  if (!(await stat(directory)).isDirectory()) throw new Error(`el directorio de la bóveda no es válido: ${area}`);
  return { vault, directory };
}

export async function searchVault(query: string, options: {
  vault?: string; area?: "wiki" | "raw/sources"; maxBytes?: number; maxResults?: number;
} = {}): Promise<string> {
  if (!query.trim()) throw new Error("la búsqueda de bóveda requiere un texto");
  if (Buffer.byteLength(query) > 512) throw new Error("la consulta de bóveda no puede superar 512 bytes");
  const { vault, directory } = await resolveVaultArea(options.vault ?? DEFAULT_VAULT, options.area ?? "wiki");
  const maxBytes = options.maxBytes ?? MAX_VAULT_BYTES;
  const maxResults = options.maxResults ?? MAX_VAULT_RESULTS;
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 1_048_576) throw new Error("maxBytes debe estar entre 256 y 1048576");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) throw new Error("maxResults debe estar entre 1 y 500");
  const rg = Bun.which("rg");
  if (!rg) throw new Error("rg no está disponible para buscar en la bóveda");
  const args = ["-n", "--no-heading", "--color", "never", "--max-count", String(maxResults), "-g", "*.md", "-g", "*.txt", "-e", query, "--", directory];
  const wrapped = await wrapMcpCommand(rg, args, { PATH: process.env.PATH ?? "" }, { cwd: directory } as ToolContext, false, false, [directory]);
  const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
    encoding: "utf8", env: wrapped.env, maxBuffer: Math.max(maxBytes * 4, 65_536), timeout: 10_000,
  });
  if (result.error) throw new Error(`falló rg en la bóveda: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) throw new Error(`falló rg en la bóveda: ${(result.stderr || "código desconocido").trim()}`);
  const rows = result.stdout.split("\n").filter(Boolean).slice(0, maxResults);
  const prefix = defang(`Bóveda: ${vault}\nBúsqueda: ${query}\nResultados: ${rows.length}${result.status === 1 ? " (sin coincidencias)" : ""}\n`);
  const opening = `<untrusted-source url="${defang(vault)}">\n`, closing = "\n</untrusted-source>";
  const payloadLimit = maxBytes - Buffer.byteLength(opening + closing);
  if (payloadLimit < 1) throw new Error("maxBytes insuficiente para el envoltorio");
  const content = [prefix, ...rows.map(defang)].join("\n");
  const marker = "\n[truncado: límite de bytes o resultados]";
  const truncated = rows.length >= maxResults || Buffer.byteLength(content) > payloadLimit;
  const payload = truncated
    ? `${clipUtf8(content, Math.max(0, payloadLimit - Buffer.byteLength(marker)))}${marker}`
    : content;
  return `${opening}${payload}${closing}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const query = argv.find((arg, i) => !arg.startsWith("--") && i > 0 && !["--vault", "--area"].includes(argv[i - 1]!));
  try {
    const result = await searchVault(query ?? "", {
      vault: value("--vault"),
      area: value("--area") === "raw/sources" ? "raw/sources" : "wiki",
    });
    console.log(result);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
