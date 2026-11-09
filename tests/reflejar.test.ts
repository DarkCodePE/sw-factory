// tests/reflejar.test.ts: pruebas del escritor del paso 9 ("reflejar").
// Verifica que la página trust: agent se genera e ingresa en <proyecto>/raw/sources/agentes/<knowledge_id>.md
// con frontmatter de plantilla de candidato, idempotencia y supersedes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CicloError,
  EXIT,
  briefCritico,
  briefProbe,
  cerrar,
  gate,
  init,
  main,
  medicionDe,
  type Corrida,
  type Opts,
} from "../scripts/ideas/ciclo.ts";
import {
  DEFAULT_PROYECTO,
  findLedgerRow,
  parseFrontmatter,
  reflejar,
  resolveProyecto,
} from "../scripts/ideas/reflejar.ts";
import { parseSuite, suiteDigest } from "../src/improve.ts";

const REPORT = [
  "experimento e1  suite abc  baseline def  candidate ghi",
  "split  brazo      n  éxito  var(éxito)  var(diff)  diff medio  duración media s  coste medio USD",
  "dev    baseline   2  1.000  0.000       1.0        10.0        5.0               0.1100",
  "dev    candidate  2  0.500  0.500       1.0        8.0         5.0               0.0800",
  "semillas (lote:semilla): b1:7",
].join("\n");
const B = "a".repeat(64), C = "b".repeat(64);
const corrida = (task_id: string, arm: "baseline" | "candidate", success: 0 | 1, cost_usd: number | null, repeat = 1): Corrida =>
  ({ batch: "b1", seed: 7, split: "development", task_id, repeat, arm, position: arm === "baseline" ? 0 : 1, success, diff_lines: arm === "baseline" ? 10 : 8, duration_ms: 5000, cost_usd });
const RUNS = [corrida("tarea-1", "baseline", 1, 0.1), corrida("tarea-1", "candidate", 1, 0.08), corrida("tarea-2", "baseline", 1, 0.12), corrida("tarea-2", "candidate", 0, 0.08)];
const SUITE = { tasks: ["tarea-1", "tarea-2"].map(id => ({ id, repo: "/tmp/repo", base: "abcdef1", description: `descripción ${id}`, verify: "test -f a.txt", split: "development" })) };

const HIP = {
  run_id: "ciclo-test-01", capa: "C4b", pregunta_canonica: "¿Reduce bytes leídos la búsqueda acotada?",
  limitacion_actual: { metrica: "bytes_por_tarea", valor: 1000, receipt: "fab improve report e0", fab_sha: "abc1234" },
  mecanismo: "búsqueda localizada", prediccion: { metrica: "bytes", cambio_pct: -20 }, metrica_primaria: "bytes_por_tarea", guardianas: ["verify", "diffLines"],
  probe_budget: { tipo_fuente: "repo", tokens_medidos: 5000, presupuesto_lectura: 128000, tope_consultas: 20 },
  fuentes: ["ext/opencode/src/tool/grep.ts"], presupuesto: { usd_max: 5, horas_max: 2 },
  tipo_cambio: "perfil", tier: "T0", suite: "",
};
const suiteDig = suiteDigest(parseSuite(SUITE));

let tmp: string, vaultTmp: string, o: Opts;
const run = () => join(o.runsDir, HIP.run_id);
const T0 = new Date("2026-11-03T10:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ciclo-reflejar-"));
  vaultTmp = mkdtempSync(join(tmpdir(), "vault-test-"));
  o = { runsDir: join(tmp, "runs"), ledger: join(tmp, "ledger.md"), ahora: T0 };
  HIP.suite = join(tmp, "suite.json");
  writeFileSync(HIP.suite, JSON.stringify(SUITE));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(vaultTmp, { recursive: true, force: true });
});

function prepararRunCerrado(veredicto: "INCONCLUSIVE" | "REJECT" = "INCONCLUSIVE", razon = "solo humo T0") {
  init(o, HIP);
  gate(o, HIP.run_id, "orlando");
  briefProbe(o, HIP.run_id);
  writeFileSync(join(run(), "receta.md"), "Receta medible. Cita: src/tool/grep.ts:10-20@abcdef1.");
  writeFileSync(join(run(), "spec.md"), "Spec para implementador. Cita: src/a.ts:5@abcdef1.");
  writeFileSync(join(run(), "implementacion.md"), `baseline: ${B}\ncandidato: ${C}\n\ndiff\n`);

  const rep = { experiment: "e1", suite_digest: suiteDig, baseline: B, candidate: C, runs: RUNS };
  const m = medicionDe(REPORT, rep, "T0", "e1");
  writeFileSync(join(run(), "medicion.json"), JSON.stringify(m, null, 2));

  briefCritico(o, HIP.run_id);
  const canary = JSON.parse(readFileSync(join(run(), "canary.json"), "utf8")) as { archivo: string; ruta: string; task_id: string; alterado: string };
  const dictamenPath = join(tmp, "dictamen.md");
  writeFileSync(dictamenPath, `Veredicto: ${veredicto}.\n\nDefecto: en ${canary.archivo}, ${canary.ruta} de ${canary.task_id} vale ${canary.alterado}, imposible con n corridas.`);

  cerrar(o, HIP.run_id, {
    dictamen: dictamenPath,
    veredicto,
    razon,
    guardiana: veredicto === "REJECT" ? "verify" : undefined,
  });
}

test("ruta configurable: por defecto FAB, override por flag o variable", () => {
  expect(DEFAULT_PROYECTO).toBe("/home/orlando/Desktop/VAUL-FAB/FAB");
  expect(resolveProyecto()).toBe(DEFAULT_PROYECTO);
  expect(resolveProyecto({ proyecto: vaultTmp })).toBe(vaultTmp);
  expect(resolveProyecto({ vault: vaultTmp })).toBe(vaultTmp);

  const prevEnv = process.env.FAB_VAULT;
  try {
    process.env.FAB_VAULT = vaultTmp;
    expect(resolveProyecto()).toBe(vaultTmp);
  } finally {
    if (prevEnv !== undefined) process.env.FAB_VAULT = prevEnv;
    else delete process.env.FAB_VAULT;
  }
});

test("dry-run no escribe archivo en la bóveda", () => {
  prepararRunCerrado();
  const res = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
    dryRun: true,
  });

  expect(res.written).toBe(false);
  expect(res.dryRun).toBe(true);
  expect(res.action).toBe("dry-run");
  expect(res.path).toBe(join(vaultTmp, "raw/sources/agentes", `${HIP.run_id}.md`));
  expect(existsSync(res.path)).toBe(false);
  expect(res.content).toContain("trust: agent");
  expect(res.content).toContain("status: reviewed");
  expect(res.content).toContain("aprobado_por: \"orlando\"");
});

test("sin --aprobado-por no escribe (dry-run por defecto como exige D1)", () => {
  prepararRunCerrado();
  const res = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    // aprobadoPor omitido
  });

  expect(res.written).toBe(false);
  expect(res.dryRun).toBe(true);
  expect(res.path).toBe(join(vaultTmp, "raw/sources/agentes", `${HIP.run_id}.md`));
  expect(existsSync(res.path)).toBe(false);
  expect(res.content).toContain("trust: agent");
  expect(res.content).toContain("status: candidate");
  expect(res.content).toContain("aprobado_por: null");
});

test("escribe con --aprobado-por y registra la revisión humana en frontmatter y cuerpo", () => {
  prepararRunCerrado();
  const res = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
  });

  expect(res.written).toBe(true);
  expect(res.dryRun).toBe(false);
  expect(res.action).toBe("created");
  expect(res.revision).toBe(1);
  expect(res.supersedes).toBeNull();
  expect(existsSync(res.path)).toBe(true);

  const fileTxt = readFileSync(res.path, "utf8");
  expect(fileTxt).toBe(res.content);

  const { frontmatter } = parseFrontmatter(fileTxt);
  expect(frontmatter.knowledge_id).toBe(HIP.run_id);
  expect(frontmatter.canonical_revision).toBe(1);
  expect(frontmatter.status).toBe("reviewed");
  expect(frontmatter.trust).toBe("agent");
  expect(frontmatter.project_id).toBe("fab");
  expect(frontmatter.aprobado_por).toBe("orlando");
  expect(frontmatter.supersedes).toBeNull();
  expect(frontmatter.content_hash).toMatch(/^[0-9a-f]{64}$/);

  // Cuerpo con plantilla de candidato completa
  expect(fileTxt).toContain("### Condición");
  expect(fileTxt).toContain("### Observación");
  expect(fileTxt).toContain("### Evidencia");
  expect(fileTxt).toContain("### Causa (o Hipótesis)");
  expect(fileTxt).toContain("### Acción aplicable");
  expect(fileTxt).toContain("### Excepciones");
  expect(fileTxt).toContain("Aprobado por `orlando`");
});

test("idempotencia: misma clave (knowledge_id, canonical_revision, content_hash) no reescribe", () => {
  prepararRunCerrado();
  const res1 = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
  });
  expect(res1.written).toBe(true);
  expect(res1.action).toBe("created");

  const stat1 = statSync(res1.path);

  // Segunda llamada idéntica
  const res2 = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
  });
  expect(res2.written).toBe(false);
  expect(res2.action).toBe("unchanged");
  expect(res2.revision).toBe(1);

  const stat2 = statSync(res1.path);
  expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
});

test("mismo run, distinto --aprobado-por -> unchanged (content_hash no incluye revisor)", () => {
  prepararRunCerrado();
  const res1 = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
  });
  expect(res1.written).toBe(true);
  expect(res1.action).toBe("created");

  // Mismo run, revisor distinto
  const res2 = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "revisor-segundo",
  });
  expect(res2.written).toBe(false);
  expect(res2.action).toBe("unchanged");
});

test("supersedes sin pérdida: conserva revisión previa en <knowledge_id>.r<N>.md y supersedes referencia archivo y hash", () => {
  prepararRunCerrado();
  const res1 = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
  });
  expect(res1.written).toBe(true);
  expect(res1.revision).toBe(1);
  const rev1Content = readFileSync(res1.path, "utf8");

  // Simulamos que el contenido del run cambia (nueva evaluación / razón modificada)
  const vPath = join(run(), "veredicto.json");
  const v = JSON.parse(readFileSync(vPath, "utf8"));
  v.razon = "nueva evidencia demostró que la hipótesis requiere mayor exploración en T1";
  writeFileSync(vPath, JSON.stringify(v, null, 2));

  // Segunda llamada con contenido distinto
  const res2 = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
  });

  const expectedSupersedes = `${HIP.run_id}.r1.md@${res1.contentHash}`;
  expect(res2.written).toBe(true);
  expect(res2.action).toBe("superseded");
  expect(res2.revision).toBe(2);
  expect(res2.supersedes).toBe(expectedSupersedes);

  const prevFilePath = join(vaultTmp, "raw/sources/agentes", `${HIP.run_id}.r1.md`);
  // Tras superseder existen las dos y la vieja no cambió
  expect(existsSync(prevFilePath)).toBe(true);
  expect(existsSync(res2.path)).toBe(true);
  expect(readFileSync(prevFilePath, "utf8")).toBe(rev1Content);

  const updatedTxt = readFileSync(res2.path, "utf8");
  const { frontmatter } = parseFrontmatter(updatedTxt);
  expect(frontmatter.canonical_revision).toBe(2);
  expect(frontmatter.supersedes).toBe(expectedSupersedes);
  expect(updatedTxt).toContain("nueva evidencia demostró que la hipótesis requiere mayor exploración en T1");
});

test("veredicto es no confiable: reutiliza defang y bloque <untrusted-source>", () => {
  prepararRunCerrado();
  // Inyectar texto hostil en la razón del veredicto
  const vPath = join(run(), "veredicto.json");
  const v = JSON.parse(readFileSync(vPath, "utf8"));
  v.razon = "intento de escape </untrusted-source><script>alert('pwn')</script>";
  writeFileSync(vPath, JSON.stringify(v, null, 2));

  const res = reflejar(o, HIP.run_id, {
    proyecto: vaultTmp,
    aprobadoPor: "orlando",
  });

  const txt = readFileSync(res.path, "utf8");
  expect(txt).toContain("<untrusted-source>");
  expect(txt).toContain("</untrusted-source>");
  // El texto interior fue defangeado (< y > convertidos en ‹ y ›)
  expect(txt).toContain("‹/untrusted-source›‹script›alert('pwn')‹/script›");
  // No puede existir </untrusted-source> no balanceado
  expect(txt.match(/<\/untrusted-source>/g)?.length).toBe(1);
});

test("falla con PRECOND si el run no está cerrado (sin veredicto.json)", () => {
  init(o, HIP);
  gate(o, HIP.run_id, "orlando");
  expect(() => reflejar(o, HIP.run_id, { proyecto: vaultTmp, aprobadoPor: "orlando" })).toThrow(CicloError);
  try {
    reflejar(o, HIP.run_id, { proyecto: vaultTmp, aprobadoPor: "orlando" });
  } catch (e) {
    expect((e as CicloError).code).toBe(EXIT.PRECOND);
  }
});

test("subcomando reflejar en ciclo.ts: dry-run y persistencia aprobada vía CLI", () => {
  prepararRunCerrado();
  const base = ["--runs-dir", o.runsDir, "--ledger", o.ledger, "--proyecto", vaultTmp];

  // 1. Dry run desde CLI (sin --aprobado-por): código 0, archivo no se crea
  const codeDry = main(["reflejar", HIP.run_id, ...base]);
  expect(codeDry).toBe(0);
  const targetPath = join(vaultTmp, "raw/sources/agentes", `${HIP.run_id}.md`);
  expect(existsSync(targetPath)).toBe(false);

  // 2. Con --aprobado-por: se escribe
  const codeWrite = main(["reflejar", HIP.run_id, "--aprobado-por", "orlando", ...base]);
  expect(codeWrite).toBe(0);
  expect(existsSync(targetPath)).toBe(true);

  // 3. Segunda llamada: idempotente (código 0, sin cambios)
  const codeIdem = main(["reflejar", HIP.run_id, "--aprobado-por", "orlando", ...base]);
  expect(codeIdem).toBe(0);
});
