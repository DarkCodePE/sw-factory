import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySources, DEFAULTS, parseArgs, parseEvaluation, readSource, selectCategories, stripFrontmatter, TAXONOMY, truncateText, updateCategories, writeCategories, writeTarget, type Category, type Options } from "../scripts/ideas/clasificar.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clasificar-test-")); dirs.push(dir);
  const raw = join(dir, "raw", "sources"); mkdirSync(raw, { recursive: true });
  return { dir, raw };
}
const categories = Object.keys(TAXONOMY) as Category[], hash = "a".repeat(64);
const scores = (overrides: Partial<Record<Category, number>> = {}) => Object.fromEntries(categories.map(c => [c, overrides[c] ?? 0.1])) as Record<Category, number>;
function evaluation(overrides: Partial<Record<Category, number>> = {}) {
  return { model: "fake-local", x_jevify: { recipe_hash: hash }, answers: Object.fromEntries(categories.map(c => [c, {
    type: "noul", noul: overrides[c] ?? 0.1, x_jevify: { recipe_hash: hash, degraded: false },
  }])) };
}

test("taxonomía cerrada y opciones validadas", () => {
  expect(categories).toHaveLength(14);
  const parsed = parseArgs(["--threshold", "0.7", "--max-categories", "2", "a.md", "--max-chars", "400"]);
  expect(parsed.options).toMatchObject({ threshold: 0.7, maxCategories: 2, maxChars: 400, write: false });
  expect(parsed.paths[0]).toEndWith("/a.md");
  for (const args of [[], ["--threshold", "NaN", "a.md"], ["--threshold", "1.1", "a.md"], ["--max-categories", "4", "a.md"], ["--max-categories", "0", "a.md"], ["--max-chars", "0", "a.md"], ["--recipe"], ["--oops", "a.md"]]) expect(() => parseArgs(args)).toThrow();
});

test("probabilidades: umbral inclusivo, orden principal, máximo y fallback marcado", () => {
  const probs = scores({ WIKI: 0.5, GRAPH: 0.8, MODEL: 0.9, EVAL: 0.7 });
  expect(selectCategories(probs, 0.5, 3)).toEqual({ categories: ["MODEL", "GRAPH", "EVAL"], low_confidence: false });
  expect(selectCategories(probs, 0.5, 2).categories).toEqual(["MODEL", "GRAPH"]);
  expect(selectCategories(scores({ WIKI: 0.5 }), 0.5, 3).categories).toEqual(["WIKI"]);
  expect(selectCategories(scores({ MEMORY: 0.49 }), 0.5, 3)).toEqual({ categories: ["MEMORY"], low_confidence: true });
  expect(selectCategories(scores(), 0.5, 3).categories).toEqual(["ONTOLOGIA"]); // empates estables
});

test("respuesta jevify tipada, completa y con receta consistente", () => {
  expect(parseEvaluation(evaluation()).recipe_hash).toBe(hash);
  for (const value of [null, {}, { ...evaluation(), model: "" }, { ...evaluation(), x_jevify: { recipe_hash: "bad" } }]) expect(() => parseEvaluation(value)).toThrow();
  for (const value of [NaN, Infinity, -0.1, 1.1, "0.8", null]) {
    const raw = evaluation(); raw.answers.WIKI!.noul = value as number;
    expect(() => parseEvaluation(raw)).toThrow("noul inválida");
  }
  const missing = evaluation(); delete missing.answers.GRAPH;
  expect(() => parseEvaluation(missing)).toThrow();
  const inconsistent = evaluation(); inconsistent.answers.WIKI!.x_jevify.recipe_hash = "b".repeat(64);
  expect(() => parseEvaluation(inconsistent)).toThrow("inconsistente");
  const degraded = evaluation(); degraded.answers.WIKI!.x_jevify.degraded = true;
  expect(() => parseEvaluation(degraded)).toThrow("degradado");
});

test("clip: quita únicamente frontmatter inicial, conserva separadores del cuerpo", () => {
  expect(stripFrontmatter("---\ntitle: Example\n---\nTexto\n---\nfin")).toBe("Texto\n---\nfin");
  expect(stripFrontmatter("\uFEFF---\r\ntitle: Example\r\n---\r\nCuerpo")).toBe("Cuerpo");
  expect(stripFrontmatter("Texto\n---\nfin")).toBe("Texto\n---\nfin");
  expect(() => stripFrontmatter("---\ntitle: incomplete\n")).toThrow("sin cierre");
});

test("frontmatter: solo categories; comentarios, texto, BOM y CRLF idénticos; segunda edición no cambia bytes", () => {
  const old = '\uFEFF---\r\ntitle: "No cambiar # nada"\r\ncategories: [OLD] # mantener comentario\r\nsource: example\r\n---\r\n# Texto\r\n\r\nSin newline';
  const updated = updateCategories(old, ["MODEL", "EVAL"]);
  expect(updated).toBe(old.replace("categories: [OLD]", "categories: [MODEL, EVAL]"));
  expect(updateCategories(updated, ["MODEL", "EVAL"])).toBe(updated);
});

test("frontmatter: categorías en bloque y flow multilínea, conserva otros campos y comentarios", () => {
  for (const oldValue of ["categories:\n  - WIKI\n  - GRAPH\n", "'categories': [\n  WIKI,\n  GRAPH\n]\n"]) {
    const old = `---\ntitle: Example\n${oldValue}# comentario\nother:\n  nested: true\n---\nBody\n`;
    const updated = updateCategories(old, ["MEMORY"]);
    expect(updated).toBe("---\ntitle: Example\ncategories: [MEMORY]\n# comentario\nother:\n  nested: true\n---\nBody\n");
  }
});

test("frontmatter: crea o añade categories sin cambiar cuerpo ni otros campos", () => {
  expect(updateCategories("# body\n", ["WIKI"])).toBe("---\ncategories: [WIKI]\n---\n# body\n");
  expect(updateCategories("---\ntitle: A\n---\nB", ["WIKI"])).toBe("---\ntitle: A\ncategories: [WIKI]\n---\nB");
  expect(updateCategories("---\n---\nB", ["WIKI"])).toBe("---\ncategories: [WIKI]\n---\nB");
  expect(() => updateCategories("---\ncategories: [WIKI]\ncategories: [GRAPH]\n---\nB", ["WIKI"])).toThrow();
  expect(() => updateCategories("---\n{title: A, categories: [WIKI]}\n---\nB", ["WIKI"])).toThrow("no soportado");
  expect(() => updateCategories("Body", [])).toThrow();
});

test("truncado explícito cuenta caracteres Unicode sin partir emoji", () => {
  expect(truncateText("a😀bc", 2)).toEqual({ state: "a😀", characters_total: 4, characters_used: 2, truncated: true });
  expect(truncateText("abc", 3).truncated).toBe(false);
});

test("repo: README más descripción de package, Cargo y pyproject; no ejecuta scripts", () => {
  const { dir } = fixture();
  writeFileSync(join(dir, "README.md"), "README topic");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "js", description: "JSON description", scripts: { install: "never execute" } }));
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="rust"\ndescription="Cargo description"\n');
  writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="python"\ndescription="Python description"\n');
  const { text } = readSource(dir);
  for (const expected of ["README topic", "JSON description", "Cargo description", "Python description"]) expect(text).toContain(expected);
  expect(text).not.toContain("never execute");
  expect(text.indexOf("description")).toBeLessThan(text.indexOf("README topic"));
});

test("repo no sigue README enlazado ni admite fuentes desconocidas/vacías", async () => {
  const { dir, raw } = fixture(), outside = join(raw, "secret.md"); writeFileSync(outside, "do not read");
  const repo = join(dir, "repo"); mkdirSync(repo); symlinkSync(outside, join(repo, "README.md"));
  expect(() => readSource(repo)).toThrow("sin README");
  const other = join(dir, "unrelated.txt"); writeFileSync(other, "x");
  expect(() => readSource(other)).toThrow("solo .md");
  const empty = join(raw, "empty.md"); writeFileSync(empty, "");
  await expect(classifySources([empty], DEFAULTS, () => evaluation())).rejects.toThrow("vacía");
});

test("jevify simulado: estado sin metadata, truncado, receta y salida; dry-run no escribe", async () => {
  const { raw } = fixture(), file = join(raw, "clip.md");
  const content = "---\ntitle: do not send\n---\nabcdefghij"; writeFileSync(file, content);
  const calls: string[] = [];
  const [result] = await classifySources([file], { ...DEFAULTS, maxChars: 5 }, (state, recipe) => {
    calls.push(state); expect(recipe).toBe(DEFAULTS.recipe); return evaluation({ GRAPH: 0.9 });
  });
  expect(calls).toEqual(["abcde"]);
  expect(result).toMatchObject({ ruta: file, categories: ["GRAPH"], modelo: "fake-local", recipe_hash: hash, characters_total: 10, characters_used: 5, truncated: true, low_confidence: false });
  expect(Object.keys(result!.probs)).toHaveLength(14);
  expect(readFileSync(file, "utf8")).toBe(content);
});

test("--write solo bajo raw/sources, rechaza symlinks/escapes antes de llamar al modelo", async () => {
  const { dir, raw } = fixture(), outside = join(dir, "outside.md"), valid = join(raw, "valid.md");
  writeFileSync(outside, "outside"); writeFileSync(valid, "valid"); symlinkSync(outside, join(raw, "escape.md"));
  symlinkSync(valid, join(raw, "alias.md"));
  const options: Options = { ...DEFAULTS, write: true, vault: dir };
  for (const file of [outside, join(raw, "escape.md"), join(raw, "alias.md"), dir]) {
    expect(() => writeTarget(file, dir)).toThrow();
    await expect(classifySources([file], options, () => { throw new Error("NO LLAMAR"); })).rejects.not.toThrow("NO LLAMAR");
  }
  expect(readFileSync(outside, "utf8")).toBe("outside");
});

test("raw/sources enlazado fuera del vault no permite escritura", () => {
  const { dir } = fixture(), other = fixture();
  rmSync(join(dir, "raw", "sources"), { recursive: true });
  symlinkSync(other.raw, join(dir, "raw", "sources"));
  const file = join(other.raw, "clip.md"); writeFileSync(file, "x");
  expect(() => writeTarget(join(dir, "raw", "sources", "clip.md"), dir)).toThrow("solo clips");
});

test("--write es idempotente, no mueve archivos ni cambia el resto del clip", async () => {
  const { dir, raw } = fixture(), file = join(raw, "clip.md");
  const before = "---\ntitle: A\ncategories: [GRAPH]\n---\nUnchanged body"; writeFileSync(file, before);
  chmodSync(file, 0o660);
  const options = { ...DEFAULTS, write: true, vault: dir }, fake = () => evaluation({ MEMORY: 0.9 });
  await classifySources([file], options, fake);
  expect(readFileSync(file, "utf8")).toBe(before.replace("[GRAPH]", "[MEMORY]"));
  expect(statSync(file).mode & 0o777).toBe(0o660);
  const mtime = statSync(file).mtimeMs;
  await classifySources([file], options, fake);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect(readdirSync(raw)).toEqual(["clip.md"]);
  expect(() => writeCategories(file, ["WIKI"], dir, before)).toThrow("cambió");
  await expect(classifySources([file, file], options, fake)).rejects.toThrow("duplicadas");
});

test("fallo de jevify o frontmatter no editable: ningún clip del lote se escribe", async () => {
  const { dir, raw } = fixture(), first = join(raw, "one.md"), second = join(raw, "two.md");
  writeFileSync(first, "body one"); writeFileSync(second, "body two");
  let calls = 0;
  await expect(classifySources([first, second], { ...DEFAULTS, write: true, vault: dir }, () => {
    if (++calls === 2) throw new Error("backend falló"); return evaluation();
  })).rejects.toThrow("backend falló");
  expect(readFileSync(first, "utf8")).toBe("body one");
  writeFileSync(second, "---\n{title: A, categories: [WIKI]}\n---\nbody two");
  await expect(classifySources([first, second], { ...DEFAULTS, write: true, vault: dir }, () => evaluation())).rejects.toThrow();
  expect(readFileSync(first, "utf8")).toBe("body one");
});

test("CLI completa con jevify y pdftotext simulados, y error claro si falta extractor", () => {
  const { dir } = fixture(), bin = join(dir, "bin"); mkdirSync(bin);
  const pdf = join(dir, "paper.pdf"); writeFileSync(pdf, "fake PDF fixture");
  writeFileSync(join(bin, "pdftotext"), `#!${process.execPath}\nconsole.log('PDF extracted fixture');`, { mode: 0o755 });
  writeFileSync(join(bin, "jevify"), `#!${process.execPath}\nimport {readFileSync} from 'node:fs';
const args=process.argv.slice(2); const state=args[args.indexOf('--state')+1];
if(args[0]!=='ask' || args.filter(x=>x==='--noul').length!==14 || readFileSync(state.slice(1),'utf8')!=='PDF extracted fixture\\n') process.exit(4);
console.log(${JSON.stringify(JSON.stringify(evaluation({ EVAL: 0.9 })))});`, { mode: 0o755 });
  const script = join(import.meta.dir, "..", "scripts", "ideas", "clasificar.ts");
  const run = () => Bun.spawnSync([process.execPath, script, pdf], { env: { ...process.env, PATH: bin } });
  const result = run(); expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())[0]).toMatchObject({ categories: ["EVAL"], modelo: "fake-local", truncated: false });
  rmSync(join(bin, "pdftotext"));
  const missing = run(); expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("pdftotext");
  expect(missing.stderr.toString()).toContain("PATH");
  expect(missing.stdout.toString()).toBe("");
});
