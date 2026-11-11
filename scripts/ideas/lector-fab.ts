#!/usr/bin/env bun
// Adaptador de fab para graft-lector (ADR-0008, A6): imprime la entrada MCP de graft con los readPaths que el sandbox de fab necesita.
// Lo acoplado a fab vive aquí; el núcleo (graft-lector.ts) no depende de fab.
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_VAULT } from "./boveda-lector.ts";

/** `readPaths` = node y raíz del paquete graft (lo que el sandbox no monta solo). */
export function buildMcpConfig(graftBin: string, nodeBin: string, options: { vault?: string; includeRawSources?: boolean } = {}) {
  let pkg = dirname(realpathSync(graftBin));
  while (!existsSync(join(pkg, "package.json"))) {
    const up = dirname(pkg);
    if (up === pkg) throw new Error(`no hay package.json sobre ${graftBin}`);
    pkg = up;
  }
  const vaultPath = options.vault ?? DEFAULT_VAULT;
  let vault: string;
  try { vault = realpathSync(vaultPath); }
  catch { throw new Error(`no existe la bóveda: ${vaultPath}`); }
  if (!statSync(vault).isDirectory()) throw new Error(`la bóveda no es un directorio: ${vault}`);
  const within = (candidate: string) => {
    const rel = relative(vault, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  const wiki = realpathSync(join(vault, "wiki"));
  if (!within(wiki) || !statSync(wiki).isDirectory()) throw new Error("wiki escapa de la bóveda o no es un directorio");
  const readPaths = [realpathSync(nodeBin), pkg, wiki];
  if (options.includeRawSources) {
    const raw = realpathSync(join(vault, "raw/sources"));
    if (!within(raw) || !statSync(raw).isDirectory()) throw new Error("raw/sources escapa de la bóveda o no es un directorio");
    readPaths.push(raw);
  }
  return { graft: { command: graftBin, args: ["mcp"], readPaths } };
}

if (import.meta.main) {
  const graft = Bun.which("graft"), node = Bun.which("node");
  if (!graft || !node) { console.error("mcp-config: faltan graft o node en PATH"); process.exit(1); }
  const argv = process.argv.slice(2);
  const vaultArg = argv.includes("--vault") ? argv[argv.indexOf("--vault") + 1] : undefined;
  console.log(JSON.stringify(buildMcpConfig(graft, node, { vault: vaultArg, includeRawSources: argv.includes("--raw-sources") }), null, 2));
}
