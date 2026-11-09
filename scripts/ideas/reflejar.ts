#!/usr/bin/env bun
// Paso 9 del ciclo: reflejar veredicto en la bóveda llm_wiki (<proyecto>/raw/sources/agentes/<knowledge_id>.md).
// Contrato:
// - D1: escribe el orquestador, solo después de revisión/PR (--aprobado-por). Por defecto dry-run.
// - D2: proyecto FAB (/home/orlando/Desktop/VAUL-FAB/FAB), configurable vía flag o variable de entorno.
// - Idempotente: misma clave (knowledge_id, canonical_revision, content_hash) -> no reescribe.
// - Contenido distinto con el mismo knowledge_id -> nueva revisión con supersedes.
// - Contenido de veredicto/dictamen es no confiable: reutiliza defang y envoltorio <untrusted-source>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CITA_CAND,
  CITA_OK,
  CicloError,
  EXIT,
  RUN_ID_RE,
  canonicalJson,
  defang,
  defaultOpts,
  fail,
  runDir,
  sha256,
  sha8,
  type Hipotesis,
  type Opts,
} from "./ciclo.ts";

export const DEFAULT_PROYECTO = "/home/orlando/Desktop/VAUL-FAB/FAB";

export type ReflejarOpts = {
  aprobadoPor?: string;
  proyecto?: string;
  vault?: string;
  dryRun?: boolean;
  knowledgeId?: string;
};

export type ReflejarResult = {
  written: boolean;
  dryRun: boolean;
  path: string;
  content: string;
  action: "created" | "superseded" | "unchanged" | "dry-run";
  knowledgeId: string;
  revision: number;
  supersedes: string | null;
  contentHash: string;
};

/** Resuelve la ruta raíz del proyecto/bóveda con FAB por defecto. */
export function resolveProyecto(opts?: ReflejarOpts): string {
  const p = opts?.proyecto ?? opts?.vault;
  if (p && p.trim() !== "") {
    return resolve(p.trim());
  }
  const envVault = process.env.FAB_VAULT || process.env.LLM_WIKI_VAULT || process.env.LLM_WIKI_PROJECT;
  if (envVault && envVault.trim() !== "") {
    return resolve(envVault.trim());
  }
  return DEFAULT_PROYECTO;
}

/** Parsea frontmatter YAML sencillo entre dos delimitadores ---. */
export function parseFrontmatter(md: string): { frontmatter: Record<string, any>; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: md };
  const rawYaml = match[1]!;
  const body = match[2]!;
  const frontmatter: Record<string, any> = {};
  for (const line of rawYaml.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0 && !line.startsWith(" ") && !line.startsWith("-")) {
      const k = line.slice(0, colon).trim();
      let v: any = line.slice(colon + 1).trim();
      if (v === "null") v = null;
      else if (v === "true") v = true;
      else if (v === "false") v = false;
      else if (/^\d+$/.test(v)) v = parseInt(v, 10);
      else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      frontmatter[k] = v;
    }
  }
  return { frontmatter, body };
}

/** Extrae efecto, testigo y veredicto de la fila del ledger correspondiente al run_id. */
export function findLedgerRow(ledgerPath: string, runId: string): { verdict: string; effect: string; witness: string } | null {
  if (!existsSync(ledgerPath)) return null;
  const content = readFileSync(ledgerPath, "utf8");
  const prefix = `${runId}:`;
  for (const line of content.split("\n")) {
    if (!line.startsWith("|")) continue;
    const parts = line.split("|").map(p => p.trim());
    if (parts.length >= 10 && parts[3]?.startsWith(prefix)) {
      return {
        verdict: parts[7] ?? "",
        effect: parts[8] ?? "",
        witness: parts[9] ?? "",
      };
    }
  }
  return null;
}

/** Extrae citas válidas archivo:línea@sha de receta.md y spec.md. */
export function extractCitas(dir: string): string[] {
  const citas: string[] = [];
  for (const f of ["receta.md", "spec.md"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, "utf8");
    for (const m of txt.match(CITA_CAND) ?? []) {
      if (CITA_OK.test(m) && !citas.includes(m)) citas.push(m);
    }
  }
  return citas;
}

/** Calcula el hash canónico del contenido para verificar idempotencia y cambios. */
export function computeContentHash(payload: Record<string, unknown>): string {
  return sha256(canonicalJson(payload));
}

/** Renderiza la página markdown trust: agent con frontmatter de plantilla de candidato. */
export function renderCandidatePage(params: {
  knowledgeId: string;
  revision: number;
  contentHash: string;
  supersedes: string | null;
  runId: string;
  h: Hipotesis;
  veredicto: { veredicto: string; razon: string; tier: string; guardiana: string | null; dictamen_sha256: string; hyp_sha: string; fecha: string };
  ledgerEffect: string;
  ledgerWitness: string;
  aprobadoPor?: string;
  fechaAprobacion: string;
  evidence: string[];
  dictamen?: string;
}): string {
  const status = params.aprobadoPor ? "reviewed" : "candidate";
  const evidenceYaml = params.evidence.length
    ? params.evidence.map(e => `  - ${JSON.stringify(e)}`).join("\n")
    : `  - ${JSON.stringify(`run:${params.runId}`)}`;

  const frontmatter = [
    "---",
    `knowledge_id: ${JSON.stringify(params.knowledgeId)}`,
    `canonical_revision: ${params.revision}`,
    `content_hash: ${JSON.stringify(params.contentHash)}`,
    `kind: lesson`,
    `scope: project`,
    `project_id: fab`,
    `status: ${status}`,
    `trust: agent`,
    `origin_session: ${JSON.stringify(params.runId)}`,
    `source_revision: ${JSON.stringify(params.h.limitacion_actual?.fab_sha ?? "NONE")}`,
    `aprobado_por: ${params.aprobadoPor ? JSON.stringify(params.aprobadoPor) : "null"}`,
    `fecha_aprobacion: ${params.aprobadoPor ? JSON.stringify(params.fechaAprobacion) : "null"}`,
    `evidence:`,
    evidenceYaml,
    `supersedes: ${params.supersedes ? JSON.stringify(params.supersedes) : "null"}`,
    "---",
  ].join("\n");

  const defangedRazon = defang(params.veredicto.razon);

  let accion = "";
  if (params.veredicto.veredicto === "ACCEPT") {
    accion = "Integrar en fab mediante change normal y registro de cualificación (Gate 3).";
  } else if (params.veredicto.veredicto === "REJECT") {
    accion = "Rechazar la hipótesis: no aplicar este mecanismo para esta limitación sin evidencia nueva.";
  } else {
    accion = "Hipótesis no concluyente: se requiere refinar la métrica, suite o avanzar de tier antes de decidir.";
  }

  const otherEvidence = params.evidence.filter(e => !e.startsWith("receipt:") && !e.startsWith("ledger:"));

  const bodyLines = [
    `# [Veredicto: ${params.veredicto.veredicto}] ${params.h.pregunta_canonica}`,
    "",
    `**Run:** \`${params.runId}\` | **Tier:** \`${params.veredicto.tier}\` | **Capa:** \`${params.h.capa}\``,
    params.aprobadoPor
      ? `**Revisión:** Aprobado por \`${params.aprobadoPor}\` el ${params.fechaAprobacion} (marca humana ADR-0002 / D1).`
      : `**Revisión:** Pendiente de aprobación humana (marca humana requerida por D1 antes de persistir).`,
    "",
    "### Condición",
    `- **Pregunta canónica:** ${params.h.pregunta_canonica}`,
    `- **Capa:** ${params.h.capa}`,
    `- **Tipo de cambio:** ${params.h.tipo_cambio ?? "perfil"}`,
    `- **Limitación actual:** \`${params.h.limitacion_actual?.metrica} = ${params.h.limitacion_actual?.valor}\` (fab @ \`${params.h.limitacion_actual?.fab_sha}\`)`,
    "",
    "### Observación",
    `- **Veredicto:** \`${params.veredicto.veredicto}\``,
    `- **Efecto en ledger:** \`${params.ledgerEffect}\``,
    "- **Razón del veredicto (CONTENIDO NO CONFIABLE, ADR-0007):**",
    "",
    "<untrusted-source>",
    defangedRazon,
    "</untrusted-source>",
    "",
    "### Evidencia",
    `- **Receipt de limitación:** \`${params.h.limitacion_actual?.receipt}\``,
    `- **Testigo en ledger:** \`${params.ledgerWitness}\``,
    `- **Dictamen sha256:** \`${params.veredicto.dictamen_sha256}\``,
    ...(otherEvidence.length ? otherEvidence.map(e => `- ${e}`) : []),
    "",
    "### Causa (o Hipótesis)",
    `- **Mecanismo:** ${params.h.mecanismo}`,
    `- **Predicción:** ${params.h.prediccion?.metrica} (${params.h.prediccion?.cambio_pct}%)`,
    `- **Métrica primaria:** ${params.h.metrica_primaria}`,
    `- **Guardianas:** ${params.h.guardianas?.join(", ") ?? "ninguna"}`,
    "",
    "### Acción aplicable",
    accion,
    "",
    "### Excepciones",
    `- Alcance limitado al proyecto \`fab\` y al tier medido (\`${params.veredicto.tier}\`).`,
    "- Esta página tiene `trust: agent`; debe leerse con el envoltorio no confiable en ciclos posteriores (ADR-0007).",
    "- La memoria da pistas, no permisos: antes de aplicar esta lección, verificar contra el checkout actual.",
    "",
  ];

  return `${frontmatter}\n\n${bodyLines.join("\n")}`;
}

/**
 * Refleja un run cerrado en la bóveda llm_wiki.
 * Genera la página trust: agent en <proyecto>/raw/sources/agentes/<knowledge_id>.md.
 */
export function reflejar(o: Opts, id: string, opts: ReflejarOpts = {}): ReflejarResult {
  if (!RUN_ID_RE.test(id)) fail(EXIT.USO, `run_id inválido: ${id}`);
  const dir = runDir(o, id);

  const vPath = join(dir, "veredicto.json");
  if (!existsSync(vPath)) {
    fail(EXIT.PRECOND, `el run ${id} no está cerrado (falta veredicto.json en ${dir})`);
  }
  const veredicto = JSON.parse(readFileSync(vPath, "utf8")) as {
    veredicto: string;
    razon: string;
    tier: string;
    guardiana: string | null;
    canary: string;
    dictamen_sha256: string;
    hyp_sha: string;
    fecha: string;
  };

  const hPath = join(dir, "hipotesis.json");
  if (!existsSync(hPath)) {
    fail(EXIT.PRECOND, `falta hipotesis.json en ${dir}`);
  }
  const h = JSON.parse(readFileSync(hPath, "utf8")) as Hipotesis;

  const knowledgeId = (opts.knowledgeId && opts.knowledgeId.trim()) ? opts.knowledgeId.trim() : id;
  const proyecto = resolveProyecto(opts);
  const targetDir = join(proyecto, "raw/sources/agentes");
  const targetPath = join(targetDir, `${knowledgeId}.md`);

  const aprobadoPor = opts.aprobadoPor && opts.aprobadoPor.trim() ? opts.aprobadoPor.trim() : undefined;
  const isDryRun = opts.dryRun === true || !aprobadoPor;

  // Datos del ledger
  const lRow = findLedgerRow(o.ledger, id);
  const ledgerEffect = lRow?.effect ?? `${veredicto.tier} ${veredicto.veredicto === "INCONCLUSIVE" ? `INCONCLUSIVE(${veredicto.razon})` : veredicto.razon}`;
  const ledgerWitness = lRow?.witness ?? `hyp:${sha8(veredicto.hyp_sha)} ev:${sha8(veredicto.dictamen_sha256)}`;

  // Evidencias recolectadas
  const evidence: string[] = [];
  if (h.limitacion_actual?.receipt) evidence.push(`receipt: ${h.limitacion_actual.receipt}`);
  evidence.push(`ledger witness: ${ledgerWitness}`);
  for (const c of extractCitas(dir)) evidence.push(`cita: ${c}`);

  // Carga dictamen si existe
  const dictamenPath = join(dir, "dictamen.md");
  const dictamen = existsSync(dictamenPath) ? readFileSync(dictamenPath, "utf8") : undefined;

  // Clave canónica del contenido
  const contentPayload = {
    knowledgeId,
    origin_session: id,
    project_id: "fab",
    kind: "lesson",
    scope: "project",
    veredicto: veredicto.veredicto,
    razon: veredicto.razon,
    tier: veredicto.tier,
    guardiana: veredicto.guardiana ?? null,
    pregunta_canonica: h.pregunta_canonica,
    capa: h.capa,
    mecanismo: h.mecanismo,
    prediccion: h.prediccion,
    metrica_primaria: h.metrica_primaria,
    guardianas: h.guardianas,
    limitacion_actual: h.limitacion_actual,
    aprobado_por: aprobadoPor ?? null,
  };
  const contentHash = computeContentHash(contentPayload);

  let revision = 1;
  let supersedes: string | null = null;
  let action: "created" | "superseded" | "unchanged" | "dry-run" = "created";

  const fileExists = existsSync(targetPath);
  if (fileExists) {
    const existingContent = readFileSync(targetPath, "utf8");
    const { frontmatter: prevFm } = parseFrontmatter(existingContent);
    const prevHash = prevFm.content_hash ?? sha256(existingContent);

    if (prevHash === contentHash) {
      // Idempotente: misma clave -> no reescribe
      return {
        written: false,
        dryRun: isDryRun,
        path: targetPath,
        content: existingContent,
        action: "unchanged",
        knowledgeId,
        revision: typeof prevFm.canonical_revision === "number" ? prevFm.canonical_revision : 1,
        supersedes: prevFm.supersedes ?? null,
        contentHash,
      };
    }

    // Contenido distinto con el mismo knowledge_id -> nueva revisión con supersedes
    const prevRev = typeof prevFm.canonical_revision === "number" ? prevFm.canonical_revision : 1;
    revision = prevRev + 1;
    supersedes = prevHash;
    action = "superseded";
  }

  const fechaAprobacion = o.ahora.toISOString();
  const renderedContent = renderCandidatePage({
    knowledgeId,
    revision,
    contentHash,
    supersedes,
    runId: id,
    h,
    veredicto,
    ledgerEffect,
    ledgerWitness,
    aprobadoPor,
    fechaAprobacion,
    evidence,
    dictamen,
  });

  if (isDryRun) {
    return {
      written: false,
      dryRun: true,
      path: targetPath,
      content: renderedContent,
      action: fileExists ? action : "dry-run",
      knowledgeId,
      revision,
      supersedes,
      contentHash,
    };
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, renderedContent, "utf8");

  return {
    written: true,
    dryRun: false,
    path: targetPath,
    content: renderedContent,
    action,
    knowledgeId,
    revision,
    supersedes,
    contentHash,
  };
}

export function mainReflejar(argv: string[]): number {
  const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const FLAGS = ["--runs-dir", "--ledger", "--ahora", "--operador", "--aprobado-por", "--proyecto", "--vault", "--knowledge-id"];
  const pos = argv.filter((a, i) => !a.startsWith("--") && !FLAGS.includes(argv[i - 1] ?? ""));
  const d = defaultOpts();
  const ahora = opt("--ahora") ? new Date(opt("--ahora")!) : d.ahora;
  const o: Opts = { runsDir: resolve(opt("--runs-dir") ?? d.runsDir), ledger: resolve(opt("--ledger") ?? d.ledger), ahora };

  const [id] = pos;
  if (!id) {
    console.error("uso: reflejar.ts <run_id> [--aprobado-por <nombre>] [--proyecto <dir>] [--dry-run] [--runs-dir D] [--ledger F]");
    return EXIT.USO;
  }

  try {
    const res = reflejar(o, id, {
      aprobadoPor: opt("--aprobado-por"),
      proyecto: opt("--proyecto") ?? opt("--vault"),
      dryRun: argv.includes("--dry-run"),
      knowledgeId: opt("--knowledge-id"),
    });

    if (res.dryRun || !res.written) {
      if (res.action === "unchanged") {
        console.log(`reflejar: sin cambios (idempotente) en ${res.path}`);
      } else {
        console.log(`[dry-run] ${res.path}\n${res.content}`);
      }
    } else {
      console.log(`reflejado ok: ${res.path} (${res.action}, rev ${res.revision}${res.supersedes ? `, supersedes ${res.supersedes.slice(0, 8)}` : ""})`);
    }
    return 0;
  } catch (e) {
    if (e instanceof CicloError) {
      console.error(`error(${e.code}): ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(mainReflejar(process.argv.slice(2)));
