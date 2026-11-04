import { expect, test } from "bun:test";
import { bound, candidatesOrNull, chargeSession, exportRank, exportedNames, lsFilesEol, measureDecision, rgReport, staleness, tokensOf, validateProbeBudget, type Session } from "../scripts/ideas/graft-lector.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("M2: varias definiciones → lista de candidatos con archivo:línea, sin elegir", () => {
  const m = (path: string) => ({ symbol: { name: "execute", kind: "function", path, span: "L3-L9" }, hits: [] });
  expect(candidatesOrNull([m("a.ts")], "execute")).toBeNull();
  const out = candidatesOrNull([m("a.ts"), m("b.ts")], "execute")!;
  expect(out).toContain("AMBIGUO: 2");
  expect(out).toContain("b.ts:L3-L9");
});

test("M3: sobre el tope escribe el completo a un archivo y avisa la ruta", () => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  const long = Array.from({ length: 50 }, (_, i) => `línea ${i}`).join("\n");
  const out = bound(long, 100, dir);
  expect(Buffer.byteLength(out)).toBeLessThan(260);
  expect(readFileSync(out.match(/en (\S+)\]$/)![1]!, "utf8")).toBe(long);
  expect(bound("corto", 100, dir)).toBe("corto");
});

test("M4: commit distinto o sin sidecar se detecta", () => {
  expect(staleness({ commit: "a".repeat(40), indexedAt: "" }, "a".repeat(40))).toBeNull();
  expect(staleness({ commit: "a".repeat(40), indexedAt: "" }, "b".repeat(40))).toContain("obsoleto");
  expect(staleness(null, "b")).toContain("sin sidecar");
});

test("A1: M1 retirada, ya no se exporta", async () => {
  const mod = await import("../scripts/ideas/graft-lector.ts");
  for (const k of ["buildSeedIndex", "extractSeeds", "prioritize"]) expect(k in mod).toBe(false);
});

test("A2: rg informa líneas y archivos en la cabecera", () => {
  const out = rgReport("foo", "a.ts:1:foo\na.ts:9:foo\nb.ts:2:foo\n");
  expect(out.split("\n")[0]).toContain("3 líneas en 2 archivos");
});

test("A3: la vista previa conserva la cabecera y los exports antes de cortar", () => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  const names = exportedNames("export function pub() {}\nfunction priv() {}\nexport const layer = 1;\n");
  expect([...names].sort()).toEqual(["layer", "pub"]);
  const text = ["graft skeleton — a.ts", "", ...Array.from({ length: 30 }, (_, i) => `- L${i}-L${i} function priv${i}  priv${i} = ()`), "- L99-L99  function pub  pub = ()"].join("\n");
  const out = bound(text, 200, dir, { head: 2, rank: exportRank(names) });
  expect(out).toContain("graft skeleton — a.ts");
  expect(out).toContain("function pub");
});

test("A4: tokens = bytes/4 y decisión por presupuesto", () => {
  expect(tokensOf(401)).toBe(101);
  expect(measureDecision(128_000, 128_000)).toBe("leer_entero");
  expect(measureDecision(128_001, 128_000)).toBe("bajar_nivel");
});

test("A4: measure descarta binarios según git (i/-text)", () => {
  const raw = "i/lf    w/lf    attr/                 \tsrc/a.ts\0i/-text w/-text attr/                 \tlogo.png\0";
  expect(lsFilesEol(raw)).toEqual([{ path: "src/a.ts", binary: false }, { path: "logo.png", binary: true }]);
});

test("A5: validador y sesión que corta al superar el tope", () => {
  const ok = { tipo_fuente: "repo" as const, tokens_medidos: 10, presupuesto_lectura: 100, tope_consultas: 2 };
  expect(validateProbeBudget(ok)).toEqual(ok);
  expect(() => validateProbeBudget({ ...ok, tipo_fuente: "web" })).toThrow();
  expect(() => validateProbeBudget({ ...ok, tope_consultas: 0 })).toThrow();
  let s: Session = { budget: validateProbeBudget(ok), consultas: 0, bytes_servidos: 0 };
  const a = chargeSession(s, 100); s = a.session;
  expect(a.cut).toBeNull();
  const b = chargeSession(s, 100); s = b.session;
  expect(b.cut).toBeNull();
  expect(s.bytes_servidos).toBe(200);
  expect(chargeSession(s, 1).cut).toContain("tope de consultas");
  const big = chargeSession({ budget: s.budget, consultas: 0, bytes_servidos: 0 }, 401);
  expect(big.cut).toContain("presupuesto de lectura");
  expect(chargeSession(big.session, 1).cut).toBe(big.cut); // la sesión cortada sigue cortada
});


test("Independencia: el núcleo no importa nada de src/ de fab", () => {
  const src = readFileSync(join(import.meta.dir, "..", "scripts", "ideas", "graft-lector.ts"), "utf8");
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  expect(specs.length).toBeGreaterThan(0);
  expect(specs.filter((x) => /(^|\/)src\//.test(x) || /lector-fab/.test(x))).toEqual([]);
});
