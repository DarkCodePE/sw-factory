import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAXONOMY, type Category } from "../scripts/ideas/clasificar.ts";
import { ingestaNocturna, migrarSueltos } from "../scripts/ideas/ingesta-nocturna.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const hash = "a".repeat(64), cats = Object.keys(TAXONOMY) as Category[];
const fake = (top: Category | null) => () => ({ model: "fake", x_jevify: { recipe_hash: hash }, answers: Object.fromEntries(cats.map(c => [c, { type: "noul", noul: c === top ? 0.9 : 0.1, x_jevify: { recipe_hash: hash, degraded: false } }])) });
const caido = () => { throw new Error("jevify caído"); };
const env = { LLM_WIKI_PROJECT_ID: "p1" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ingesta-")); dirs.push(dir);
  const inbox = join(dir, "inbox"), proyecto = join(dir, "FAB");
  mkdirSync(inbox); mkdirSync(join(proyecto, "raw", "sources"), { recursive: true }); mkdirSync(join(proyecto, "wiki"));
  return { dir, inbox, proyecto };
}

test("clip clasificado va a clips/<CAT>/ con categories; segunda pasada no hace nada", async () => {
  const { inbox, proyecto } = setup();
  writeFileSync(join(inbox, "a.md"), "---\ntitle: A\n---\nmemoria episódica");
  let llamadas = 0;
  const rescan = async () => { llamadas++; };
  const r = await ingestaNocturna({ inbox, proyecto, env, ask: fake("MEMORY"), rescan });
  const dest = join(proyecto, "raw/sources/clips/MEMORY/a.md");
  expect(r.movidos).toEqual([dest]);
  expect(readFileSync(dest, "utf8")).toContain("categories: [MEMORY]");
  expect(existsSync(join(inbox, "a.md"))).toBe(false);
  const r2 = await ingestaNocturna({ inbox, proyecto, env, ask: fake("MEMORY"), rescan });
  expect(r2).toMatchObject({ movidos: [], retenidos: [], rescan: "omitido" });
  expect(llamadas).toBe(1);
});

test("clasificador caído o baja confianza: el clip se queda", async () => {
  const { inbox, proyecto } = setup();
  writeFileSync(join(inbox, "a.md"), "texto"); writeFileSync(join(inbox, "b.md"), "otro");
  for (const ask of [caido, fake(null)]) {
    const r = await ingestaNocturna({ inbox, proyecto, env, ask, rescan: async () => {} });
    expect(r.movidos).toEqual([]); expect(r.retenidos).toHaveLength(2);
    expect(readdirSync(inbox).filter(n => n.endsWith(".md")).sort()).toEqual(["a.md", "b.md"]);
  }
});

test("app cerrada: se mueve igual y el fallo del rescan queda en el journal", async () => {
  const { inbox, proyecto } = setup();
  writeFileSync(join(inbox, "a.md"), "texto");
  const r = await ingestaNocturna({ inbox, proyecto, env, ask: fake("WIKI"), rescan: async () => { throw new Error("ECONNREFUSED"); } });
  expect(r.movidos).toHaveLength(1);
  expect(r.rescan).toEqual({ error: "ECONNREFUSED" });
  expect(readFileSync(join(inbox, ".ingesta-journal.jsonl"), "utf8")).toContain("ECONNREFUSED");
});

test("destino existente no se pisa", async () => {
  const { inbox, proyecto } = setup();
  mkdirSync(join(proyecto, "raw/sources/clips/WIKI"), { recursive: true });
  writeFileSync(join(proyecto, "raw/sources/clips/WIKI/a.md"), "previo");
  writeFileSync(join(inbox, "a.md"), "nuevo");
  await ingestaNocturna({ inbox, proyecto, env, ask: fake("WIKI"), rescan: async () => {} });
  expect(readFileSync(join(proyecto, "raw/sources/clips/WIKI/a.md"), "utf8")).toBe("previo");
  expect(existsSync(join(proyecto, "raw/sources/clips/WIKI/a-2.md"))).toBe(true);
});

test("migrar sueltos: simulación no toca nada; aplicar hace copia previa y mueve", async () => {
  const { dir, proyecto } = setup();
  writeFileSync(join(proyecto, "raw/sources/s.md"), "suelto"); writeFileSync(join(proyecto, "wiki/w.md"), "w");
  const sim = await migrarSueltos({ proyecto, env, ask: fake("LOOP") });
  expect(sim.simulado).toBe(true); expect(sim.plan).toEqual([{ clip: join(proyecto, "raw/sources/s.md"), categories: ["LOOP"] }]);
  expect(existsSync(join(proyecto, "raw/sources/s.md"))).toBe(true);
  const backupDir = join(dir, "backup");
  const r = await migrarSueltos({ proyecto, aplicar: true, backupDir, env, ask: fake("LOOP"), rescan: async () => {} });
  expect(r.movidos).toEqual([join(proyecto, "raw/sources/clips/LOOP/s.md")]);
  expect(readFileSync(join(backupDir, "raw/sources/s.md"), "utf8")).toBe("suelto");
  expect(readFileSync(join(backupDir, "wiki/w.md"), "utf8")).toBe("w");
  expect(existsSync(join(proyecto, "raw/sources/s.md"))).toBe(false);
});
