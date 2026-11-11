import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpConfig } from "../scripts/ideas/lector-fab.ts";
import { wrapMcpCommand } from "../src/agent/mcp-sandbox.ts";
import type { ToolContext } from "../src/agent/types.ts";

const graftBin = Bun.which("graft"), nodeBin = Bun.which("node"), bwrapBin = Bun.which("bwrap");
test.skipIf(!graftBin || !nodeBin || !bwrapBin)("A6: graft --version arranca dentro del sandbox MCP con readPaths de mcp-config", async () => {
  const cfg = buildMcpConfig(graftBin!, nodeBin!).graft;
  expect(cfg.args).toEqual(["mcp"]);
  const cwd = mkdtempSync(join(tmpdir(), "lt-"));
  const ctx = { cwd } as unknown as ToolContext;
  const w = await wrapMcpCommand(cfg.command, ["--version"], { PATH: process.env.PATH ?? "" }, ctx, false, false, cfg.readPaths);
  expect(w.argv).toContain("--unshare-net");
  const r = spawnSync(w.argv[0]!, w.argv.slice(1), { encoding: "utf8", env: w.env, timeout: 30_000 });
  expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
});

test.skipIf(!graftBin || !nodeBin)("mcp-config monta wiki por defecto y raw/sources solo si se solicita", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-config-"));
  try {
    mkdirSync(join(root, "wiki")); mkdirSync(join(root, "raw/sources"), { recursive: true });
    const base = buildMcpConfig(graftBin!, nodeBin!, { vault: root }).graft;
    expect(base.readPaths).toContain(join(root, "wiki"));
    expect(base.readPaths).not.toContain(join(root, "raw/sources"));
    const withRaw = buildMcpConfig(graftBin!, nodeBin!, { vault: root, includeRawSources: true }).graft;
    expect(withRaw.readPaths).toContain(join(root, "raw/sources"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!graftBin || !nodeBin)("mcp-config rechaza wiki enlazada fuera de la bóveda", () => {
  const root = mkdtempSync(join(tmpdir(), "vault-config-"));
  try {
    const outside = mkdtempSync(join(tmpdir(), "vault-outside-"));
    symlinkSync(outside, join(root, "wiki"));
    expect(() => buildMcpConfig(graftBin!, nodeBin!, { vault: root })).toThrow(/escapa de la bóveda/);
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
