import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { searchVault, DEFAULT_VAULT } from "./boveda-lector.ts";

export type BacklogEstado = "pendiente" | "duplicado" | "procesado" | "descartado";

export interface BacklogEntry {
  id: string;
  url: string;
  fecha: string; // YYYY-MM-DD
  hash: string;
  titulo: string;
  resumen?: string;
  capa: string; // C0-C9
  impacto: number | null;
  confianza: number | null;
  esfuerzo: number | null;
  score: number | null;
  estado: BacklogEstado;
  motivo_descarte?: string | null;
  origen?: string;
  metadata?: Record<string, unknown>;
}

export interface BacklogData {
  schema_version: number;
  items: BacklogEntry[];
}

export class BacklogSchemaError extends Error {
  constructor(message: string) {
    super(`Error de validación de backlog: ${message}`);
    this.name = "BacklogSchemaError";
  }
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const CAPA_REGEX = /^C[0-9][a-z]?$/i;
const VALID_ESTADOS = new Set<BacklogEstado>(["pendiente", "duplicado", "procesado", "descartado"]);

/** Normaliza un hallazgo/título a las primeras 6 palabras alfanuméricas (igual que @dream-machine/ledger) */
export function directionKey(text: string): string {
  return text
    .replace(/^(\s*\[[^\]]*\])+/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .trim();
}

/** Calcula el score según ADR-0003: (impacto × confianza) / esfuerzo */
export function scoreEntry(entry: {
  impacto: number | null;
  confianza: number | null;
  esfuerzo: number | null;
}): number | null {
  if (
    typeof entry.impacto === "number" &&
    Number.isFinite(entry.impacto) &&
    typeof entry.confianza === "number" &&
    Number.isFinite(entry.confianza) &&
    typeof entry.esfuerzo === "number" &&
    Number.isFinite(entry.esfuerzo) &&
    entry.esfuerzo > 0
  ) {
    return (entry.impacto * entry.confianza) / entry.esfuerzo;
  }
  return null;
}

/** Valida estrictamente la estructura y tipos de backlog.json */
export function validateBacklog(raw: unknown): BacklogData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BacklogSchemaError("El contenido debe ser un objeto JSON");
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.schema_version !== "number" || !Number.isInteger(obj.schema_version) || obj.schema_version < 1) {
    throw new BacklogSchemaError("schema_version debe ser un entero positivo");
  }

  if (!Array.isArray(obj.items)) {
    throw new BacklogSchemaError("items debe ser un arreglo");
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < obj.items.length; i++) {
    const item = obj.items[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BacklogSchemaError(`Elemento [${i}] no es un objeto válido`);
    }

    const e = item as Record<string, unknown>;

    if (typeof e.id !== "string" || !e.id.trim()) {
      throw new BacklogSchemaError(`Elemento [${i}]: id es obligatorio y no puede estar vacío`);
    }
    if (seenIds.has(e.id)) {
      throw new BacklogSchemaError(`Elemento [${i}]: id duplicado '${e.id}'`);
    }
    seenIds.add(e.id);

    if (typeof e.url !== "string" || !e.url.trim()) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): url es obligatoria`);
    }

    if (typeof e.fecha !== "string" || !DATE_REGEX.test(e.fecha)) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): fecha debe tener formato YYYY-MM-DD`);
    }

    if (typeof e.hash !== "string" || !e.hash.trim()) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): hash es obligatorio`);
    }

    if (typeof e.titulo !== "string" || !e.titulo.trim()) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): titulo es obligatorio`);
    }

    if (typeof e.capa !== "string" || !CAPA_REGEX.test(e.capa)) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): capa debe tener formato C0-C9 (ej. C1, C4b)`);
    }

    if (e.impacto !== null && (typeof e.impacto !== "number" || !Number.isFinite(e.impacto) || e.impacto < 0)) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): impacto debe ser un número >= 0 o null`);
    }

    if (e.confianza !== null && (typeof e.confianza !== "number" || !Number.isFinite(e.confianza) || e.confianza < 0)) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): confianza debe ser un número >= 0 o null`);
    }

    if (e.esfuerzo !== null && (typeof e.esfuerzo !== "number" || !Number.isFinite(e.esfuerzo) || e.esfuerzo <= 0)) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): esfuerzo debe ser un número > 0 o null`);
    }

    if (typeof e.estado !== "string" || !VALID_ESTADOS.has(e.estado as BacklogEstado)) {
      throw new BacklogSchemaError(`Elemento [${i}] (${e.id}): estado inválido '${String(e.estado)}'`);
    }
  }

  return raw as BacklogData;
}

/** Lee y valida backlog.json. Si está corrupto o no cumple el esquema, lanza error sin sobrescribir */
export function readBacklog(filePath: string): BacklogData {
  if (!existsSync(filePath)) {
    throw new Error(`Archivo de backlog no existe: ${filePath}`);
  }

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`No se pudo leer ${filePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON corrupto en backlog (${filePath}): ${(err as Error).message}`);
  }

  return validateBacklog(parsed);
}

/** Escribe atómicamente backlog.json validando previamente el esquema */
export function writeBacklog(filePath: string, data: BacklogData): void {
  validateBacklog(data);
  const dir = dirname(resolve(filePath));
  const tempPath = join(dir, `.backlog-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const content = JSON.stringify(data, null, 2) + "\n";
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Ignorar fallo al borrar archivo temporal
    }
    throw new Error(`Error al escribir backlog en ${filePath}: ${(err as Error).message}`);
  }
}

export interface IntakeOptions {
  backlogPath?: string;
  ledgerPath?: string;
  vaultPath?: string;
  dryRun?: boolean;
}

export interface IntakeResult {
  total: number;
  duplicadosDetectados: number;
  detalles: Array<{ id: string; url: string; motivo: string }>;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deduplica entradas pendientes contra el propio backlog, ledger y la bóveda */
export async function intakeBacklog(options: IntakeOptions = {}): Promise<IntakeResult> {
  const rootDir = resolve(import.meta.dir, "../..");
  const backlogPath = options.backlogPath ? resolve(options.backlogPath) : join(rootDir, "docs/research/backlog.json");
  const ledgerPath = options.ledgerPath ? resolve(options.ledgerPath) : join(rootDir, "docs/research/ledger.md");
  const vaultPath = options.vaultPath ? resolve(options.vaultPath) : (existsSync(DEFAULT_VAULT) ? DEFAULT_VAULT : undefined);

  const backlog = readBacklog(backlogPath);

  // 1. Cargar el ledger y las señales de aprendizaje
  let ledgerRows: Array<{ date: string; deep: string; finding: string }> = [];
  let duplicateDirections: string[] = [];

  if (existsSync(ledgerPath)) {
    try {
      const ledgerContent = readFileSync(ledgerPath, "utf8");
      const LEDGER_LIB = join(rootDir, "third_party/dream-machine/ledger/index.ts");
      const { parseLedger, learningSignals } = (await import(LEDGER_LIB)) as {
        parseLedger: (md: string) => { rows: Array<{ date: string; deep: string; finding: string }> };
        learningSignals: (rows: Array<{ date: string; deep: string; finding: string }>) => { duplicateDirections: string[] };
      };
      const parsed = parseLedger(ledgerContent);
      ledgerRows = parsed.rows || [];
      const signals = learningSignals(ledgerRows);
      duplicateDirections = signals.duplicateDirections || [];
    } catch (err) {
      console.warn(`[intake] Aviso: no se pudieron cargar señales del ledger: ${(err as Error).message}`);
    }
  }

  const detalles: Array<{ id: string; url: string; motivo: string }> = [];
  const seenUrls = new Map<string, string>();
  const seenHashes = new Map<string, string>();

  // Registrar entradas no duplicadas previas en el backlog
  for (const item of backlog.items) {
    if (item.estado !== "duplicado" && item.estado !== "descartado") {
      const normUrl = item.url.trim().toLowerCase();
      if (!seenUrls.has(normUrl)) seenUrls.set(normUrl, item.id);
      if (!seenHashes.has(item.hash)) seenHashes.set(item.hash, item.id);
    }
  }

  let duplicadosCount = 0;

  for (const item of backlog.items) {
    if (item.estado !== "pendiente") continue;

    let motivoDuplicado: string | null = null;
    const normUrl = item.url.trim().toLowerCase();

    // A) Dedup contra el propio backlog (si vimos la misma URL o hash antes en otro ID)
    const existingUrlId = seenUrls.get(normUrl);
    if (existingUrlId && existingUrlId !== item.id) {
      motivoDuplicado = `duplicado en backlog: misma url que ${existingUrlId}`;
    }

    if (!motivoDuplicado) {
      const existingHashId = seenHashes.get(item.hash);
      if (existingHashId && existingHashId !== item.id) {
        motivoDuplicado = `duplicado en backlog: mismo hash que ${existingHashId}`;
      }
    }

    // B) Dedup contra el ledger
    if (!motivoDuplicado && ledgerRows.length > 0) {
      const candidateKey = directionKey(item.titulo);

      // Verificar señal duplicateDirections (dirección repetida >= 3 noches)
      if (candidateKey && duplicateDirections.some((d) => d === candidateKey || d.includes(candidateKey) || candidateKey.includes(d))) {
        motivoDuplicado = `dirección duplicada en ledger (señal duplicateDirections: '${candidateKey}')`;
      }

      // Verificar si el hallazgo ya figura en alguna fila del ledger
      if (!motivoDuplicado) {
        for (const row of ledgerRows) {
          const rowFinding = row.finding.trim();
          if (!rowFinding || rowFinding === "NONE") continue;

          const rowKey = directionKey(rowFinding);
          if (
            (candidateKey && rowKey && (candidateKey === rowKey || rowKey.includes(candidateKey) || candidateKey.includes(rowKey))) ||
            rowFinding.toLowerCase().includes(item.titulo.toLowerCase()) ||
            item.titulo.toLowerCase().includes(rowFinding.toLowerCase())
          ) {
            motivoDuplicado = `hallazgo ya figura en el ledger: fila ${row.date} ('${rowFinding.slice(0, 60)}')`;
            break;
          }
        }
      }
    }

    // C) Dedup contra la bóveda usando searchVault de boveda-lector.ts
    if (!motivoDuplicado && vaultPath && existsSync(vaultPath)) {
      try {
        const query = escapeRegex(item.url.trim());
        // Buscar en raw/sources primero
        let vaultFound = false;
        try {
          const sourcesRes = await searchVault(query, { vault: vaultPath, area: "raw/sources", maxResults: 5 });
          if (!sourcesRes.includes("(sin coincidencias)")) {
            vaultFound = true;
            motivoDuplicado = `url encontrada en la bóveda (raw/sources)`;
          }
        } catch {
          // Si el área raw/sources no existe o falla, continuar a wiki
        }

        if (!vaultFound) {
          try {
            const wikiRes = await searchVault(query, { vault: vaultPath, area: "wiki", maxResults: 5 });
            if (!wikiRes.includes("(sin coincidencias)")) {
              motivoDuplicado = `url encontrada en la bóveda (wiki)`;
            }
          } catch {
            // wiki no disponible
          }
        }
      } catch (err) {
        console.warn(`[intake] Falló búsqueda en bóveda para ${item.url}: ${(err as Error).message}`);
      }
    }

    // Si se detectó duplicado, marcarlo
    if (motivoDuplicado) {
      item.estado = "duplicado";
      item.motivo_descarte = motivoDuplicado;
      duplicadosCount++;
      detalles.push({ id: item.id, url: item.url, motivo: motivoDuplicado });
    } else {
      // Registrar como visto para entradas posteriores en la misma corrida
      if (!seenUrls.has(normUrl)) seenUrls.set(normUrl, item.id);
      if (!seenHashes.has(item.hash)) seenHashes.set(item.hash, item.id);
    }
  }

  if (duplicadosCount > 0 && !options.dryRun) {
    writeBacklog(backlogPath, backlog);
  }

  return {
    total: backlog.items.length,
    duplicadosDetectados: duplicadosCount,
    detalles,
  };
}

export interface SiguienteOptions {
  backlogPath?: string;
  ledgerPath?: string;
}

/** Selecciona el siguiente candidato ordenado por score aplicando rotación por capa según el ledger */
export async function siguienteCandidato(options: SiguienteOptions = {}): Promise<BacklogEntry | null> {
  const rootDir = resolve(import.meta.dir, "../..");
  const backlogPath = options.backlogPath ? resolve(options.backlogPath) : join(rootDir, "docs/research/backlog.json");
  const ledgerPath = options.ledgerPath ? resolve(options.ledgerPath) : join(rootDir, "docs/research/ledger.md");

  const backlog = readBacklog(backlogPath);
  const pendientes = backlog.items.filter((item) => item.estado === "pendiente");

  if (pendientes.length === 0) {
    return null;
  }

  // Ordenar por score decreciente (los sin puntuar van al final), desempatando por fecha más reciente
  pendientes.sort((a, b) => {
    const scoreA = scoreEntry(a) ?? -1;
    const scoreB = scoreEntry(b) ?? -1;
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    return b.fecha.localeCompare(a.fecha);
  });

  // Leer la última capa del ledger para rotación
  let lastLayer: string | null = null;
  if (existsSync(ledgerPath)) {
    try {
      const ledgerContent = readFileSync(ledgerPath, "utf8");
      const LEDGER_LIB = join(rootDir, "third_party/dream-machine/ledger/index.ts");
      const { parseLedger } = (await import(LEDGER_LIB)) as {
        parseLedger: (md: string) => { rows: Array<{ date: string; deep: string; finding: string }> };
      };
      const parsed = parseLedger(ledgerContent);
      if (parsed.rows && parsed.rows.length > 0) {
        const lastRow = parsed.rows[parsed.rows.length - 1];
        if (lastRow && lastRow.deep) {
          lastLayer = lastRow.deep.trim();
        }
      }
    } catch (err) {
      console.warn(`[siguiente] Aviso al leer ledger para rotación: ${(err as Error).message}`);
    }
  }

  // Si existe una última capa en el ledger, rotar: no devolver la misma capa si hay otra candidata
  if (lastLayer) {
    const candidatosDistintaCapa = pendientes.filter((item) => item.capa.toUpperCase() !== lastLayer!.toUpperCase());
    if (candidatosDistintaCapa.length > 0) {
      return candidatosDistintaCapa[0]!;
    }
  }

  // Si todos los candidatos pertenecen a la misma capa, devolver el mejor disponible
  return pendientes[0]!;
}

// ---------------- CLI ----------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  const getArg = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const hasFlag = (name: string): boolean => argv.includes(name);

  try {
    if (cmd === "intake") {
      const res = await intakeBacklog({
        backlogPath: getArg("--backlog"),
        ledgerPath: getArg("--ledger"),
        vaultPath: getArg("--vault"),
        dryRun: hasFlag("--dry-run"),
      });
      console.log(`Intake finalizado: ${res.total} entradas analizadas, ${res.duplicadosDetectados} duplicadas marcadas.`);
      for (const d of res.detalles) {
        console.log(` - [${d.id}] ${d.url} -> ${d.motivo}`);
      }
    } else if (cmd === "siguiente") {
      const candidato = await siguienteCandidato({
        backlogPath: getArg("--backlog"),
        ledgerPath: getArg("--ledger"),
      });

      if (!candidato) {
        console.log("No hay candidatos pendientes en el backlog.");
        process.exit(0);
      }

      if (hasFlag("--json")) {
        console.log(JSON.stringify(candidato, null, 2));
      } else {
        const score = scoreEntry(candidato);
        console.log("Candidato seleccionado:");
        console.log(`  ID:       ${candidato.id}`);
        console.log(`  Título:   ${candidato.titulo}`);
        console.log(`  URL:      ${candidato.url}`);
        console.log(`  Capa:     ${candidato.capa}`);
        console.log(`  Score:    ${score !== null ? score.toFixed(2) : "sin puntuar"} (impacto: ${candidato.impacto ?? "-"}, confianza: ${candidato.confianza ?? "-"}, esfuerzo: ${candidato.esfuerzo ?? "-"})`);
        console.log(`  Fecha:    ${candidato.fecha}`);
        console.log(`  Hash:     ${candidato.hash}`);
        console.log("");
        console.log("Siguiente paso del operador:");
        console.log("  ciclo.ts init <hipotesis.json>");
      }
    } else if (cmd === "puntuar") {
      const id = argv[1];
      if (!id || id.startsWith("--")) {
        console.error("Uso: backlog.ts puntuar <id> --impacto <n> --confianza <n> --esfuerzo <n> [--backlog <path>]");
        process.exit(1);
      }
      const impStr = getArg("--impacto");
      const confStr = getArg("--confianza");
      const esfStr = getArg("--esfuerzo");
      if (!impStr || !confStr || !esfStr) {
        console.error("Faltan parámetros obligatorios: --impacto, --confianza, --esfuerzo");
        process.exit(1);
      }
      const impacto = Number(impStr);
      const confianza = Number(confStr);
      const esfuerzo = Number(esfStr);
      const backlogPath = getArg("--backlog") ? resolve(getArg("--backlog")!) : resolve(import.meta.dir, "../../docs/research/backlog.json");
      const data = readBacklog(backlogPath);
      const item = data.items.find((i) => i.id === id);
      if (!item) {
        console.error(`Entrada con id '${id}' no encontrada en el backlog.`);
        process.exit(1);
      }
      item.impacto = impacto;
      item.confianza = confianza;
      item.esfuerzo = esfuerzo;
      item.score = scoreEntry(item);
      writeBacklog(backlogPath, data);
      console.log(`Entrada ${id} puntuada: score = ${item.score?.toFixed(2)}`);
    } else if (cmd === "list") {
      const backlogPath = getArg("--backlog") ? resolve(getArg("--backlog")!) : resolve(import.meta.dir, "../../docs/research/backlog.json");
      const estadoFilter = getArg("--estado");
      const data = readBacklog(backlogPath);
      let items = data.items;
      if (estadoFilter) {
        items = items.filter((i) => i.estado === estadoFilter);
      }
      if (hasFlag("--json")) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`Total: ${items.length} entradas${estadoFilter ? ` (estado: ${estadoFilter})` : ""}`);
        for (const it of items) {
          const sc = scoreEntry(it);
          console.log(`[${it.id}] [${it.capa}] [${it.estado}] score=${sc !== null ? sc.toFixed(2) : "-"} ${it.titulo} (${it.url})`);
        }
      }
    } else {
      console.log("Uso: backlog.ts <intake|siguiente|puntuar|list> [opciones]");
      console.log("  intake     Deduplica entradas pendientes contra backlog, ledger y bóveda");
      console.log("  siguiente  Selecciona el candidato prioritario aplicando rotación por capa");
      console.log("  puntuar    Asigna impacto, confianza y esfuerzo a una entrada");
      console.log("  list       Lista las entradas del backlog");
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(2);
  }
}
