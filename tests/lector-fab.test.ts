import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
