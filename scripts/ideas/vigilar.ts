import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defang } from "./ciclo.ts";
import { readBacklog, writeBacklog, type BacklogEntry } from "./backlog.ts";

export const DEFAULT_INBOX = process.env.FAB_VAULT_INBOX || "/home/orlando/Desktop/VAUL-FAB/FAB-inbox";

export interface FeedItem {
  titulo: string;
  url: string;
  resumen: string;
  fecha: string; // YYYY-MM-DD
  capa: string;
  hash: string;
  origen: string;
}

export interface VigilarOptions {
  registryPath?: string;
  backlogPath?: string;
  inboxPath?: string;
  fuentesMax?: number;
  writeInbox?: boolean;
  dryRun?: boolean;
  fetchFn?: (url: string) => Promise<string>;
}

export interface VigilarResult {
  totalVistas: number;
  nuevasEntradas: number;
  clipsEscritos: number;
  entradas: BacklogEntry[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function cleanHtml(text: string): string {
  const unescaped = unescapeXml(text);
  // Remover solo etiquetas HTML comunes, preservando texto que pueda contener pseudotags
  return unescaped.replace(/<\/?(?:p|br|a|div|span|h[1-6]|ul|ol|li|strong|em|b|i|tt|pre|code)(?:\s+[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim();
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clip"
  );
}

function normalizeDate(raw: string): string {
  try {
    const dt = new Date(raw);
    if (!isNaN(dt.getTime())) {
      return dt.toISOString().slice(0, 10);
    }
  } catch {
    // fallback
  }
  return new Date().toISOString().slice(0, 10);
}

export function suggestLayer(categoria?: string, title?: string, summary?: string, repoLayers?: string[]): string {
  if (repoLayers && repoLayers.length > 0 && repoLayers[0]) {
    return repoLayers[0];
  }

  const text = `${title ?? ""} ${summary ?? ""}`.toLowerCase();

  if (/triage|intake|filtrado de issues/i.test(text)) return "C1";
  if (/workflow|temporal|orquest|pipeline|state machine/i.test(text)) return "C2";
  if (/human-in-the-loop|review|critique|revisor/i.test(text)) return "C3";
  if (/prompt|harness|instruction|system prompt|agent/i.test(text)) return "C4a";
  if (/eval|benchmark|metric|qualification|experiment|test/i.test(text)) return "C4b";
  if (/search|retrieval|code search|grep|indexing|graft/i.test(text)) return "C5";
  if (/synthesis|patch|edit|repair|generation|coder/i.test(text)) return "C6";
  if (/wiki|vault|memory|knowledge|bóveda|graph/i.test(text)) return "C7";
  if (/cron|daemon|automation|poller|watch/i.test(text)) return "C8";
  if (/gate|release|merge|deployment|qualification/i.test(text)) return "C9";

  if (categoria) {
    if (categoria.includes("SE")) return "C4b";
    if (categoria.includes("AI")) return "C4a";
    if (categoria.includes("CL")) return "C4b";
    if (categoria.includes("PL")) return "C6";
  }

  return "C4b";
}

/** Parsea un feed RSS de arXiv */
export function parseArxivRss(xml: string, category: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRegex = /<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]!;

    const titleMatch = /<title(?:\s+[^>]*)?>([\s\S]*?)<\/title>/i.exec(block);
    const linkMatch = /<link(?:\s+[^>]*)?>([\s\S]*?)<\/link>/i.exec(block);
    const descMatch = /<description(?:\s+[^>]*)?>([\s\S]*?)<\/description>/i.exec(block);
    const dateMatch = /<pubDate(?:\s+[^>]*)?>([\s\S]*?)<\/pubDate>/i.exec(block);

    if (!titleMatch || !linkMatch) continue;

    const rawTitle = unescapeXml(titleMatch[1]!).trim();
    const rawLink = unescapeXml(linkMatch[1]!).trim();
    let rawDesc = descMatch ? unescapeXml(descMatch[1]!).trim() : "";

    // Limpiar cabeceras de arXiv en la descripción
    rawDesc = rawDesc.replace(/^arXiv:\S+\s+Announce Type:\s*\w+\s*(?:Abstract:\s*)?/i, "");
    rawDesc = cleanHtml(rawDesc);

    const titulo = defang(rawTitle);
    const resumen = defang(rawDesc);
    const url = rawLink;
    const fecha = normalizeDate(dateMatch ? dateMatch[1]!.trim() : "");
    const capa = suggestLayer(category, titulo, resumen);
    const hash = sha256(`${url}\n${titulo}\n${resumen}`);

    items.push({
      titulo,
      url,
      resumen,
      fecha,
      capa,
      hash,
      origen: `arxiv:${category}`,
    });
  }

  return items;
}

/** Parsea la respuesta JSON de Hugging Face Daily Papers */
export function parseHfDaily(jsonStr: string): FeedItem[] {
  const items: FeedItem[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return items;
  }

  if (!Array.isArray(parsed)) return items;

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const paper = (entry.paper ?? entry) as Record<string, unknown>;

    const id = typeof paper.id === "string" ? paper.id.trim() : "";
    const rawTitle = typeof paper.title === "string" ? paper.title.trim() : "";
    const rawSummary = typeof paper.summary === "string" ? paper.summary.trim() : "";
    const rawDate = typeof paper.publishedAt === "string" ? paper.publishedAt : "";

    if (!rawTitle || !id) continue;

    const titulo = defang(rawTitle);
    const resumen = defang(rawSummary);
    const url = `https://arxiv.org/abs/${id}`;
    const fecha = normalizeDate(rawDate);
    const capa = suggestLayer("HF", titulo, resumen);
    const hash = sha256(`${url}\n${titulo}\n${resumen}`);

    items.push({
      titulo,
      url,
      resumen,
      fecha,
      capa,
      hash,
      origen: "hf-daily-papers",
    });
  }

  return items;
}

/** Parsea un feed Atom de releases de GitHub */
export function parseGithubReleasesAtom(xml: string, repoName: string, repoLayers: string[] = []): FeedItem[] {
  const items: FeedItem[] = [];
  const entryRegex = /<entry(?:\s+[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1]!;

    const titleMatch = /<title(?:\s+[^>]*)?>([\s\S]*?)<\/title>/i.exec(block);
    const linkMatch = /<link\s+[^>]*href="([^"]+)"[^>]*>/i.exec(block) || /<link(?:\s+[^>]*)?>([\s\S]*?)<\/link>/i.exec(block);
    const contentMatch = /<content(?:\s+[^>]*)?>([\s\S]*?)<\/content>/i.exec(block) || /<summary(?:\s+[^>]*)?>([\s\S]*?)<\/summary>/i.exec(block);
    const dateMatch = /<updated(?:\s+[^>]*)?>([\s\S]*?)<\/updated>/i.exec(block) || /<published(?:\s+[^>]*)?>([\s\S]*?)<\/published>/i.exec(block);

    if (!titleMatch || !linkMatch) continue;

    const rawTitle = unescapeXml(titleMatch[1]!).trim();
    const rawLink = unescapeXml(linkMatch[1]!).trim();
    const rawDesc = contentMatch ? cleanHtml(contentMatch[1]!) : "";

    const titulo = defang(`${repoName} release: ${rawTitle}`);
    const resumen = defang(rawDesc);
    const url = rawLink;
    const fecha = normalizeDate(dateMatch ? dateMatch[1]!.trim() : "");
    const capa = suggestLayer(undefined, titulo, resumen, repoLayers);
    const hash = sha256(`${url}\n${titulo}\n${resumen}`);

    items.push({
      titulo,
      url,
      resumen,
      fecha,
      capa,
      hash,
      origen: `release:${repoName}`,
    });
  }

  return items;
}

/** Escribe el clip en la carpeta de entrada (FAB_VAULT_INBOX), NUNCA en raw/sources/ */
export function writeClipToInbox(item: FeedItem, inboxDir: string): string {
  const normalizedInbox = resolve(inboxDir);
  if (normalizedInbox.includes("raw/sources")) {
    throw new Error(`Violación de seguridad: la vigilancia nunca escribe directo en raw/sources/: ${normalizedInbox}`);
  }

  mkdirSync(normalizedInbox, { recursive: true });

  const fileName = `${item.fecha}-${slugify(item.titulo)}-${item.hash.slice(0, 8)}.md`;
  const filePath = join(normalizedInbox, fileName);

  // Una sola línea y entre comillas JSON (YAML válido): un título del feed no puede cerrar la cabecera ni inyectar claves como trust.
  const yaml = (v: string) => JSON.stringify(v.replace(/\s+/g, " ").trim());
  const defangedTitle = defang(item.titulo).replace(/\s+/g, " ").trim();
  const defangedUrl = defang(item.url).replace(/["\s]/g, encodeURIComponent);
  const defangedResumen = defang(item.resumen || "Sin resumen disponible.");

  const content = [
    "---",
    "type: clip",
    "trust: clip",
    `source: ${yaml(item.url)}`,
    `published: ${yaml(item.fecha)}`,
    `title: ${yaml(defangedTitle)}`,
    `category: ${item.capa}`,
    `content_hash: ${item.hash}`,
    `origin: ${yaml(item.origen)}`,
    "---",
    "",
    `# ${defangedTitle}`,
    "",
    `<untrusted-source url="${defangedUrl}">`,
    defangedResumen,
    "</untrusted-source>",
    "",
  ].join("\n");

  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** Ejecuta el ciclo de vigilancia según ADR-0003 y especificación T8 */
export async function vigilar(options: VigilarOptions = {}): Promise<VigilarResult> {
  const rootDir = resolve(import.meta.dir, "../..");
  const registryPath = options.registryPath ? resolve(options.registryPath) : join(rootDir, "docs/research/registry.json");
  const backlogPath = options.backlogPath ? resolve(options.backlogPath) : join(rootDir, "docs/research/backlog.json");
  const inboxPath = options.inboxPath ? resolve(options.inboxPath) : DEFAULT_INBOX;
  const writeInbox = options.writeInbox ?? true;
  const fetchFn = options.fetchFn ?? (async (u: string) => {
    const res = await fetch(u, {
      headers: { "User-Agent": "fab-vigilancia/1.0 (+https://github.com/DarkCodePE/sw-factory)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al obtener ${u}`);
    return await res.text();
  });

  if (!existsSync(registryPath)) {
    throw new Error(`Archivo de registro no existe: ${registryPath}`);
  }

  const registryText = readFileSync(registryPath, "utf8");
  const registry = JSON.parse(registryText) as {
    fuentes_max?: number;
    watch_sources?: {
      arxiv?: Array<{ categoria: string; url: string }>;
      hf_daily_papers?: { nombre?: string; url: string };
      [k: string]: unknown;
    } | Array<{ tipo?: string; categoria?: string; nombre?: string; url: string }>;
    repos?: Array<{
      name: string;
      url: string;
      watch?: boolean;
      layers?: Record<string, unknown>;
    }>;
  };

  const fuentesMax = options.fuentesMax ?? registry.fuentes_max ?? 20;

  // Leer backlog existente
  let backlogData = { schema_version: 1, items: [] as BacklogEntry[] };
  if (existsSync(backlogPath)) {
    backlogData = readBacklog(backlogPath);
  }

  const existingUrls = new Set<string>(backlogData.items.map((i) => i.url.trim().toLowerCase()));
  const existingHashes = new Set<string>(backlogData.items.map((i) => i.hash));

  const itemsRecogidos: FeedItem[] = [];

  // 1. Feeds arXiv
  let arxivList: Array<{ categoria: string; url: string }> = [];
  if (registry.watch_sources) {
    if (Array.isArray(registry.watch_sources)) {
      arxivList = registry.watch_sources
        .filter((s) => s.tipo === "arxiv" || s.categoria)
        .map((s) => ({ categoria: s.categoria || "cs.AI", url: s.url }));
    } else if (Array.isArray(registry.watch_sources.arxiv)) {
      arxivList = registry.watch_sources.arxiv;
    }
  }

  for (const src of arxivList) {
    try {
      const xml = await fetchFn(src.url);
      const parsed = parseArxivRss(xml, src.categoria);
      for (const it of parsed) {
        itemsRecogidos.push(it);
      }
    } catch (err) {
      console.warn(`[vigilar] Error al consultar feed arXiv ${src.categoria}: ${(err as Error).message}`);
    }
  }

  // 2. Feed Hugging Face Daily Papers
  let hfUrl: string | null = null;
  if (registry.watch_sources) {
    if (Array.isArray(registry.watch_sources)) {
      const hf = registry.watch_sources.find((s) => s.tipo === "hf" || s.tipo === "hf_daily" || s.nombre?.includes("hf"));
      if (hf) hfUrl = hf.url;
    } else if (registry.watch_sources.hf_daily_papers && typeof registry.watch_sources.hf_daily_papers.url === "string") {
      hfUrl = registry.watch_sources.hf_daily_papers.url;
    }
  }

  if (hfUrl) {
    try {
      const jsonStr = await fetchFn(hfUrl);
      const parsed = parseHfDaily(jsonStr);
      for (const it of parsed) {
        itemsRecogidos.push(it);
      }
    } catch (err) {
      console.warn(`[vigilar] Error al consultar feed HF daily: ${(err as Error).message}`);
    }
  }

  // 3. Releases de repos con watch: true
  const reposToWatch = (registry.repos || []).filter((r) => r.watch === true);
  for (const repo of reposToWatch) {
    const ghMatch = /github\.com\/([^\/\s]+\/[^\/\s]+)/i.exec(repo.url);
    if (!ghMatch) continue;

    const repoSlug = ghMatch[1]!.replace(/\.git$/i, "").replace(/\/+$/, "");
    const releasesAtomUrl = `https://github.com/${repoSlug}/releases.atom`;
    const repoLayers = repo.layers ? Object.keys(repo.layers) : [];

    try {
      const xml = await fetchFn(releasesAtomUrl);
      const parsed = parseGithubReleasesAtom(xml, repo.name, repoLayers);
      for (const it of parsed) {
        itemsRecogidos.push(it);
      }
    } catch (err) {
      console.warn(`[vigilar] Error al consultar releases de ${repo.name}: ${(err as Error).message}`);
    }
  }

  // Filtrar novedades no vistas
  const nuevasParaAgregar: FeedItem[] = [];
  const seenInBatchUrls = new Set<string>();
  const seenInBatchHashes = new Set<string>();

  for (const it of itemsRecogidos) {
    const normUrl = it.url.trim().toLowerCase();
    if (existingUrls.has(normUrl) || seenInBatchUrls.has(normUrl)) continue;
    if (existingHashes.has(it.hash) || seenInBatchHashes.has(it.hash)) continue;

    seenInBatchUrls.add(normUrl);
    seenInBatchHashes.add(it.hash);
    nuevasParaAgregar.push(it);

    if (nuevasParaAgregar.length >= fuentesMax) {
      break;
    }
  }

  // Agregar al backlog y escribir en la carpeta de entrada si corresponde
  const nuevasEntradasBacklog: BacklogEntry[] = [];
  let clipsEscritos = 0;

  for (const item of nuevasParaAgregar) {
    const entry: BacklogEntry = {
      id: `bck-${item.hash.slice(0, 8)}`,
      url: item.url,
      fecha: item.fecha,
      hash: item.hash,
      titulo: item.titulo,
      resumen: item.resumen,
      capa: item.capa,
      impacto: null,
      confianza: null,
      esfuerzo: null,
      score: null,
      estado: "pendiente",
      motivo_descarte: null,
      origen: item.origen,
    };

    nuevasEntradasBacklog.push(entry);
    backlogData.items.push(entry);

    if (writeInbox && !options.dryRun) {
      writeClipToInbox(item, inboxPath);
      clipsEscritos++;
    }
  }

  if (nuevasEntradasBacklog.length > 0 && !options.dryRun) {
    writeBacklog(backlogPath, backlogData);
  }

  return {
    totalVistas: itemsRecogidos.length,
    nuevasEntradas: nuevasEntradasBacklog.length,
    clipsEscritos,
    entradas: nuevasEntradasBacklog,
  };
}

// ---------------- CLI ----------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const hasFlag = (name: string): boolean => argv.includes(name);

  try {
    const fuentesMaxArg = getArg("--fuentes-max");
    const result = await vigilar({
      registryPath: getArg("--registry"),
      backlogPath: getArg("--backlog"),
      inboxPath: getArg("--inbox"),
      fuentesMax: fuentesMaxArg ? Number(fuentesMaxArg) : undefined,
      writeInbox: !hasFlag("--no-inbox"),
      dryRun: hasFlag("--dry-run"),
    });

    console.log(`Vigilancia completada:`);
    console.log(`  Fuentes analizadas:  ${result.totalVistas}`);
    console.log(`  Nuevas entradas:     ${result.nuevasEntradas}`);
    console.log(`  Clips en entrada:    ${result.clipsEscritos}`);
    for (const e of result.entradas) {
      console.log(`  + [${e.id}] [${e.capa}] ${e.titulo} (${e.url})`);
    }
  } catch (err) {
    console.error(`Error en vigilancia: ${(err as Error).message}`);
    process.exit(2);
  }
}
