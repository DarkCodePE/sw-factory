#!/usr/bin/env bun
// Adaptador de fab para graft-lector (ADR-0008, A6): imprime la entrada MCP de graft con los readPaths que el sandbox de fab necesita.
// Lo acoplado a fab vive aquí; el núcleo (graft-lector.ts) no depende de fab.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** `readPaths` = node y raíz del paquete graft (lo que el sandbox no monta solo). */
export function buildMcpConfig(graftBin: string, nodeBin: string) {
  let pkg = dirname(realpathSync(graftBin));
  while (!existsSync(join(pkg, "package.json"))) {
    const up = dirname(pkg);
    if (up === pkg) throw new Error(`no hay package.json sobre ${graftBin}`);
    pkg = up;
  }
  return { graft: { command: graftBin, args: ["mcp"], readPaths: [realpathSync(nodeBin), pkg] } };
}

if (import.meta.main) {
  const graft = Bun.which("graft"), node = Bun.which("node");
  if (!graft || !node) { console.error("mcp-config: faltan graft o node en PATH"); process.exit(1); }
  console.log(JSON.stringify(buildMcpConfig(graft, node), null, 2));
}
