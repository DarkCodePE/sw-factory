import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directionKey,
  intakeBacklog,
  readBacklog,
  scoreEntry,
  siguienteCandidato,
  validateBacklog,
  writeBacklog,
  type BacklogData,
  type BacklogEntry,
} from "../scripts/ideas/backlog.ts";

let tmp: string;
let backlogPath: string;
let ledgerPath: string;
let vaultPath: string;

const LEDGER_HEADER = [
  "| Date | Deep | Finding | Issue | PR | Evaluated? | Verdict | Effect | Witness | Prior-night fates |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
].join("\n");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "backlog-test-"));
  backlogPath = join(tmp, "backlog.json");
  ledgerPath = join(tmp, "ledger.md");
  vaultPath = join(tmp, "vault");

  mkdirSync(join(vaultPath, "wiki"), { recursive: true });
  mkdirSync(join(vaultPath, "raw/sources"), { recursive: true });

  const initialBacklog: BacklogData = {
    schema_version: 1,
    items: [],
  };
  writeFileSync(backlogPath, JSON.stringify(initialBacklog, null, 2));

  // Ledger de prueba con última fila en capa C4b
  const ledgerContent = [
    LEDGER_HEADER,
    "| 2026-11-03 | C1 | triage de issues automático en worker | NONE | NONE | yes | INCONCLUSIVE | T0 INCONCLUSIVE | hyp:11111111 ev:22222222 | NONE |",
    "| 2026-11-04 | C2 | workflow temporal retry policy | NONE | NONE | yes | INCONCLUSIVE | T0 INCONCLUSIVE | hyp:33333333 ev:44444444 | NONE |",
    "| 2026-11-05 | C4b | 2026-11-04-C4b-tests-protegidos-T1-03: ¿Deja el worker de tocar rutas protegidas? | NONE | NONE | yes | ACCEPT | T1 candidato: ok | hyp:4d7c7a16 ev:1740141f | NONE |",
  ].join("\n");
  writeFileSync(ledgerPath, ledgerContent);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("Aceptación 4: backlog.json valida contra esquema; un JSON corrupto aborta sin sobrescribir", () => {
  // 1. JSON con sintaxis corrupta
  const corruptJson = '{ "schema_version": 1, "items": [ { "id": "bck-1" '; // sintaxis rota
  writeFileSync(backlogPath, corruptJson);

  expect(() => readBacklog(backlogPath)).toThrow(/JSON corrupto/);
  // Verificar que el archivo no fue sobrescrito y sigue intacto en disco
  expect(readFileSync(backlogPath, "utf8")).toBe(corruptJson);

  // 2. JSON válido pero con esquema corrupto (falta url obligatoria)
  const invalidSchema = JSON.stringify({
    schema_version: 1,
    items: [
      {
        id: "bck-1",
        // url ausente
        fecha: "2026-11-10",
        hash: "12345678",
        titulo: "Test",
        capa: "C1",
        impacto: 5,
        confianza: 5,
        esfuerzo: 2,
        estado: "pendiente",
      },
    ],
  });
  writeFileSync(backlogPath, invalidSchema);

  expect(() => readBacklog(backlogPath)).toThrow(/url es obligatoria/);
  expect(readFileSync(backlogPath, "utf8")).toBe(invalidSchema);

  // 3. Validación de campos: fecha inválida y capa inválida
  const invalidDate = {
    schema_version: 1,
    items: [
      {
        id: "bck-2",
        url: "https://example.com",
        fecha: "10-11-2026", // formato no YYYY-MM-DD
        hash: "12345678",
        titulo: "Test",
        capa: "INVALIDA",
        impacto: null,
        confianza: null,
        esfuerzo: null,
        score: null,
        estado: "pendiente",
      },
    ],
  };
  expect(() => validateBacklog(invalidDate)).toThrow(/fecha debe tener formato YYYY-MM-DD/);

  // 4. Estructura válida pasa sin error
  const validData: BacklogData = {
    schema_version: 1,
    items: [
      {
        id: "bck-ok",
        url: "https://arxiv.org/abs/2611.12345",
        fecha: "2026-11-10",
        hash: "a1b2c3d4",
        titulo: "Válido",
        capa: "C4b",
        impacto: 8,
        confianza: 7,
        esfuerzo: 2,
        score: 28,
        estado: "pendiente",
      },
    ],
  };
  expect(() => validateBacklog(validData)).not.toThrow();
  writeBacklog(backlogPath, validData);
  expect(readBacklog(backlogPath).items.length).toBe(1);
});

test("Aceptación 2: intake marca duplicada una entrada cuya url ya está en la bóveda", async () => {
  // Crear una página en la bóveda que contiene la URL objetivo
  writeFileSync(
    join(vaultPath, "wiki", "paper-existente.md"),
    "# Paper en wiki\nFuente referenciada: https://arxiv.org/abs/2611.00001\n"
  );

  const backlog: BacklogData = {
    schema_version: 1,
    items: [
      {
        id: "bck-vault-dup",
        url: "https://arxiv.org/abs/2611.00001",
        fecha: "2026-11-10",
        hash: "hash0001",
        titulo: "Paper ya en bóveda",
        capa: "C1",
        impacto: 5,
        confianza: 5,
        esfuerzo: 2,
        score: 12.5,
        estado: "pendiente",
      },
      {
        id: "bck-nuevo",
        url: "https://arxiv.org/abs/2611.99999",
        fecha: "2026-11-10",
        hash: "hash9999",
        titulo: "Paper nuevo no visto",
        capa: "C2",
        impacto: 6,
        confianza: 6,
        esfuerzo: 2,
        score: 18,
        estado: "pendiente",
      },
    ],
  };
  writeBacklog(backlogPath, backlog);

  const res = await intakeBacklog({
    backlogPath,
    ledgerPath,
    vaultPath,
  });

  expect(res.duplicadosDetectados).toBe(1);
  expect(res.detalles[0]?.id).toBe("bck-vault-dup");
  expect(res.detalles[0]?.motivo).toContain("bóveda");

  const updated = readBacklog(backlogPath);
  const dupItem = updated.items.find((i) => i.id === "bck-vault-dup")!;
  expect(dupItem.estado).toBe("duplicado");
  expect(dupItem.motivo_descarte).toContain("bóveda");

  const okItem = updated.items.find((i) => i.id === "bck-nuevo")!;
  expect(okItem.estado).toBe("pendiente");
});

test("Aceptación 2: intake marca duplicada una entrada cuyo hallazgo ya figura en el ledger", async () => {
  const backlog: BacklogData = {
    schema_version: 1,
    items: [
      {
        id: "bck-ledger-dup",
        url: "https://arxiv.org/abs/2611.00002",
        fecha: "2026-11-10",
        hash: "hash0002",
        titulo: "¿Deja el worker de tocar rutas protegidas?", // coincide con la fila 2026-11-05
        capa: "C4b",
        impacto: 9,
        confianza: 8,
        esfuerzo: 2,
        score: 36,
        estado: "pendiente",
      },
      {
        id: "bck-distinto",
        url: "https://arxiv.org/abs/2611.00003",
        fecha: "2026-11-10",
        hash: "hash0003",
        titulo: "Nueva técnica de síntesis de código no probada",
        capa: "C6",
        impacto: 7,
        confianza: 7,
        esfuerzo: 2,
        score: 24.5,
        estado: "pendiente",
      },
    ],
  };
  writeBacklog(backlogPath, backlog);

  const res = await intakeBacklog({
    backlogPath,
    ledgerPath,
    vaultPath,
  });

  expect(res.duplicadosDetectados).toBe(1);
  expect(res.detalles[0]?.id).toBe("bck-ledger-dup");
  expect(res.detalles[0]?.motivo).toContain("ledger");

  const updated = readBacklog(backlogPath);
  const dupItem = updated.items.find((i) => i.id === "bck-ledger-dup")!;
  expect(dupItem.estado).toBe("duplicado");
  expect(dupItem.motivo_descarte).toContain("ledger");

  const okItem = updated.items.find((i) => i.id === "bck-distinto")!;
  expect(okItem.estado).toBe("pendiente");
});

test("intake detecta duplicados dentro del propio backlog (misma URL o mismo hash)", async () => {
  const backlog: BacklogData = {
    schema_version: 1,
    items: [
      {
        id: "bck-orig",
        url: "https://arxiv.org/abs/2611.55555",
        fecha: "2026-11-09",
        hash: "hash5555",
        titulo: "Original",
        capa: "C1",
        impacto: 5,
        confianza: 5,
        esfuerzo: 2,
        score: 12.5,
        estado: "pendiente",
      },
      {
        id: "bck-dup-url",
        url: "https://arxiv.org/abs/2611.55555", // misma url
        fecha: "2026-11-10",
        hash: "hash6666",
        titulo: "Duplicado por url",
        capa: "C1",
        impacto: 5,
        confianza: 5,
        esfuerzo: 2,
        score: 12.5,
        estado: "pendiente",
      },
      {
        id: "bck-dup-hash",
        url: "https://example.com/other",
        fecha: "2026-11-10",
        hash: "hash5555", // mismo hash
        titulo: "Duplicado por hash",
        capa: "C2",
        impacto: 4,
        confianza: 4,
        esfuerzo: 2,
        score: 8,
        estado: "pendiente",
      },
    ],
  };
  writeBacklog(backlogPath, backlog);

  const res = await intakeBacklog({
    backlogPath,
    ledgerPath,
    vaultPath,
  });

  expect(res.duplicadosDetectados).toBe(2);
  const updated = readBacklog(backlogPath);
  expect(updated.items.find((i) => i.id === "bck-orig")?.estado).toBe("pendiente");
  expect(updated.items.find((i) => i.id === "bck-dup-url")?.estado).toBe("duplicado");
  expect(updated.items.find((i) => i.id === "bck-dup-hash")?.estado).toBe("duplicado");
});

test("Aceptación 3: siguiente no devuelve la misma capa que la última fila del ledger si hay otra candidata", async () => {
  // En el ledger de prueba, la última fila es de capa C4b
  // Agregamos dos candidatos pendientes:
  // - Candidato A: capa C4b, con score alto (80)
  // - Candidato B: capa C1, con score menor (30)
  const backlog: BacklogData = {
    schema_version: 1,
    items: [
      {
        id: "bck-c4b",
        url: "https://arxiv.org/abs/2611.00010",
        fecha: "2026-11-10",
        hash: "hash0010",
        titulo: "Benchmark en C4b con score alto",
        capa: "C4b",
        impacto: 10,
        confianza: 8,
        esfuerzo: 1, // score = 80
        score: 80,
        estado: "pendiente",
      },
      {
        id: "bck-c1",
        url: "https://arxiv.org/abs/2611.00020",
        fecha: "2026-11-09",
        hash: "hash0020",
        titulo: "Triage en C1 con score moderado",
        capa: "C1",
        impacto: 6,
        confianza: 5,
        esfuerzo: 1, // score = 30
        score: 30,
        estado: "pendiente",
      },
    ],
  };
  writeBacklog(backlogPath, backlog);

  const seleccionado = await siguienteCandidato({
    backlogPath,
    ledgerPath,
  });

  expect(seleccionado).not.toBeNull();
  // DEBE rotar: aunque C4b tiene score 80 y C1 tiene 30, devuelve C1 porque la última fila del ledger fue C4b
  expect(seleccionado?.id).toBe("bck-c1");
  expect(seleccionado?.capa).toBe("C1");
});

test("siguiente devuelve el mejor candidato de la misma capa solo si no hay otra capa disponible", async () => {
  // Solo hay candidatos en C4b
  const backlog: BacklogData = {
    schema_version: 1,
    items: [
      {
        id: "bck-c4b-menor",
        url: "https://arxiv.org/abs/2611.00030",
        fecha: "2026-11-08",
        hash: "hash0030",
        titulo: "Evaluación C4b menor",
        capa: "C4b",
        impacto: 4,
        confianza: 4,
        esfuerzo: 2, // score = 8
        score: 8,
        estado: "pendiente",
      },
      {
        id: "bck-c4b-mayor",
        url: "https://arxiv.org/abs/2611.00031",
        fecha: "2026-11-09",
        hash: "hash0031",
        titulo: "Evaluación C4b mayor",
        capa: "C4b",
        impacto: 8,
        confianza: 8,
        esfuerzo: 2, // score = 32
        score: 32,
        estado: "pendiente",
      },
    ],
  };
  writeBacklog(backlogPath, backlog);

  const seleccionado = await siguienteCandidato({
    backlogPath,
    ledgerPath,
  });

  expect(seleccionado).not.toBeNull();
  expect(seleccionado?.id).toBe("bck-c4b-mayor");
});

test("scoreEntry calcula (impacto * confianza) / esfuerzo y directionKey normaliza a 6 palabras", () => {
  expect(scoreEntry({ impacto: 8, confianza: 7, esfuerzo: 2 })).toBe(28);
  expect(scoreEntry({ impacto: 10, confianza: 5, esfuerzo: 0 })).toBeNull();
  expect(scoreEntry({ impacto: null, confianza: 5, esfuerzo: 2 })).toBeNull();

  expect(directionKey("[implement 2026-09-01] Router Selection for Multi-Agent Task Execution in Python")).toBe(
    "router selection for multiagent task execution"
  );
});
