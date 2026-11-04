# floorplan: ¿sirve como mapa de código para el lector de fab?

Fecha: 2026-11-01. Objeto: `ext/codesearch/floorplan` @ `226cda6` (v0.6.1, MIT, Hayden Smith). Leído con graft (`map`, `skeleton`) y con `rg`/lectura en los tramos citados. Medido con `scan.mjs`, `build.mjs` y `query.mjs` sobre una **copia** de sw-factory (715 archivos versionados, sin `graft/`) en el scratchpad. No se modificó `ext/` ni sw-factory, no se instaló nada y no se registró ningún plugin ni hook.

## 1. Cómo funciona por dentro

**Qué es.** Una skill de Claude Code y de Codex (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` con `"skills": "./skills/"`, `skills/floorplan/SKILL.md`), más scripts Node sin dependencias (`package.json`: solo `node --test`). No es un servidor MCP. Dibuja un mapa HTML interactivo para el **dueño de una app** (por defecto en lenguaje llano, no técnico; `SKILL.md:87`).

**Reparto determinista / LLM** (según `docs/how-it-works.md` y `SKILL.md`, contrastado con el código):

| Etapa | Quién | Evidencia |
|---|---|---|
| Listar archivos (`git ls-files`, respeta `.gitignore`), repos, LOC | Script | `scripts/lib/common.mjs:157-163` (`git`), `scripts/scan.mjs` |
| Imports, exports, rutas HTTP, peticiones web | Script, **con regex, no con parser** | `scripts/lib/extract.mjs:136` (`extractJs`), `:336` (`extractPy`), `:399` (Go), `:422` (Rust), `:439` (JVM); `how-it-works.md`: "It's pattern matching, not a compiler" |
| Emparejar petición → endpoint, prefijos de routers | Script | `how-it-works.md §2`; `scripts/lib/resolve.mjs`, `routes.mjs` |
| Health (claves en código, RLS, CORS, etc.), pantallas | Script | `scripts/lib/health.mjs` (1243 líneas), `screens.mjs` |
| `architecture.json`: partes, servicios externos, flujos, tour | **LLM** (lee resumen del escaneo, READMEs, manifiestos y puntos de entrada) | `SKILL.md:68-89` |
| Nombre y descripción de **cada archivo y endpoint** | **LLM** (relleno de hojas de trabajo; en repos grandes, subagentes en paralelo) | `SKILL.md:99-106`, `describe.mjs` |
| Notas de "trabajo reciente" | **LLM** | `SKILL.md:108-117` |
| Layout, renderizado, validación | Script (ELK embebido) | `build.mjs`, `SKILL.md:180` |

Comprobación en código: el análisis **no usa tree-sitter** (`rg` de `tree-sitter` en `scripts/` y `assets/`: 0 coincidencias). El único `child_process` del escaneo es `git` (`common.mjs:159`); `open.mjs` y `refresh.mjs` lanzan sus propios scripts. No vi ejecución de código del repo analizado (lectura de `scripts/`, no auditoría con `strace`).

**Formato del mapa guardado.** `floorplan/graph.json` (regenerado en cada build), `architecture.json` y `descriptions/*.json` (escritos por el LLM), `.cache/scan.json`, `index.html` autocontenido. Claves de `graph.json` (medido): `schema, meta, project, nodes, files, routes, links, flows, tour, health, screens`. Cada archivo lleva ruta, lenguaje, LOC, nombre, descripción, hash de contenido `h`, hash de firma `sig` y símbolos exportados `[nombre, tipo, línea, ...]`. Los enlaces son `{a, b, k:'import', w, names}`. Esquema documentado en `references/schema.md`.

**Mantenimiento al día.** `refresh.mjs` reescanea, compara huellas (contenido exacto y firma de exports/endpoints, `how-it-works.md §Updates`), arrastra descripciones de archivos movidos y marca para revisión los que cambian de firma; el LLM solo describe lo nuevo. No es incremental en el escaneo (se rehace entero). No medí `refresh.mjs`.

## 2. Qué recibe el agente (medido)

Se consulta, no se pasa entero. Tres puntos de entrada:

- **Resumen del escaneo** (lo único que el agente lee para escribir `architecture.json`): sobre sw-factory, **4 110 bytes** de salida (≈1 k tokens, estimado como bytes/4) y **1,5 s** (`scan.mjs`).
- **`graph.json`**: 374 196 bytes (≈94 k tokens, estimado) con 459 archivos y 1 369 enlaces; `index.html` 2,5 MB. Ninguno está pensado para el prompt.
- **`query.mjs`** (`overview | find | show | path`, `assets/query-cli.mjs`): la superficie de consulta del agente, ~20 ms por llamada, salida JSON con sangría. Medido: `overview` 687 B; `find` entre 2,6 y 3,1 KB; `show <archivo>` 2 538 B (exports con línea y dependencias). Determinista: dos `find` seguidos dan el mismo md5; el `scan.json` solo difiere en `generatedAt` (dos corridas, diferencia confirmada con `diff`).

**Lo que no se midió con descripciones reales.** El `build` se hizo con un `architecture.json` mínimo escrito a mano (3 nodos, 38 % sin asignar) y **sin pasar el LLM por los 459 archivos**. Por eso `description` sale vacío en los archivos y `find "sandbox mcp"` (dos palabras) devolvió `[]`; `find "sandbox"` y `find "router"` sí acertaron, pero por el nombre derivado del archivo. La capa de nombres llanos no se pudo medir sin gastar un LLM sobre el repo (que es justo lo que ADR-0007 prohíbe en fab).

**Granularidad.** Los símbolos son solo los **exportados**, con línea (`s:ruta#i`); los enlaces son únicamente **archivo → archivo por import** (todos los 1 369 son `k: import`). No hay aristas de llamada entre funciones, así que no sustituye a `graft callers`.

## 3. Comparación con nuestro flujo

**Lo que aporta y graft/codegraph no tienen:**

1. **Peticiones web → endpoint** (frontend→backend, incluso entre repos, con prefijos de routers y Firebase callable). Es la capa de "qué pasa en el checkout". Solo la verifiqué por lectura de `extract.mjs`/`how-it-works.md`: sw-factory no tiene rutas HTTP (`routes: 0`), así que **no la medí**.
2. **Health determinista** (secretos, RLS de Supabase, reglas de Firebase, webhooks de Stripe sin firma, CORS, endpoints sin autenticación). Es útil en la etapa de operación; no lo ejercité (en sw-factory: 0 importantes).
3. **Pantallas** (Next, React Router, Vue, etc.) y **flujos guiados**.
4. **Hash de firma por archivo** para detectar cambios de API y arrastrar descripciones: es un patrón reutilizable para la frescura.
5. **`blueprint`**: mapa de algo aún sin construir a partir de un PRD (no evaluado).

**Lo que le falta frente a graft:** ranking (BM25 + PageRank), `callers` por símbolo, `skeleton` con rangos de todos los símbolos, soporte tree-sitter (aquí, regex), búsqueda por frase libre (`find` es léxico sobre nombres y descripciones). Con la misma tarea T4 del informe previo (consulta conceptual) no esperaría mejor resultado.

**Restricciones del lector:**

| Restricción | ¿Cumple? |
|---|---|
| Sandbox sin red | El escaneo, el build y `query.mjs` no usan red (el mapa inlinea ELK y fuentes, `SKILL.md:180`; `privacy-and-security.md:20` declara no tener telemetría). `serve.mjs` escucha en 127.0.0.1. Solo ejecuté escaneo, build y query, **sin red bloqueada con bwrap**: no verificado en el sandbox real. |
| Sin LLM leyendo todo el repo no confiable (ADR-0007) | **Se rompe en el diseño.** Describir "cada archivo y endpoint" es un paso del LLM (`SKILL.md:99-106`), y `architecture.json` lo escribe un LLM tras leer READMEs y entry points. Lo determinista (escaneo + `query.mjs`) sí se puede usar sin LLM, pero entonces se pierde la capa de nombres llanos, que es lo que lo distingue. |
| Cita `archivo:línea` | Parcial: `show`/`find` dan `ruta:línea` para símbolos exportados; los archivos solo ruta. |
| Determinismo | Escaneo y consultas sí (medido). Las descripciones del LLM no. |
| Coste en tokens | Escaneo ≈1 k tokens y consultas 0,2–0,8 k (estimado, bytes/4). Pero el mapa completo con descripciones exige tokens de LLM proporcionales al nº de archivos (no medido). |

Riesgo adicional para repos no confiables: `scan.mjs` lee contenido del repo y lo imprime/serializa; el LLM del paso de descripciones recibe docstrings y comentarios del repo ajeno (vector de inyección de prompt). No lo probé.

## 4. Veredicto

**Adoptar la idea como patrón; no adoptar la herramienta para el lector de fab investigación.**

- **Paso 2 (mapa recortado de 1–4 k tokens) → no.** Su valor diferencial pasa por un LLM sobre el repo, lo que ADR-0007 excluye, y sin él queda un grafo solo de imports a nivel de archivo con regex, inferior a `graft map`/`skeleton`/`callers`. La parte determinista (≈1 k tokens de resumen) ya la cubre graft.
- **Etapa de operación (entender el repo de un cliente) → sí, como candidato a evaluar.** Ahí el repo es del cliente y hay autorización explícita, el público incluye gente no técnica y importan las peticiones frontend→backend, el Health y los flujos ("qué pasa en el checkout"). Conviene probarlo allí con un repo real que tenga rutas.
- **Patrones a copiar** (sin dependencia):
  1. hash de **firma** (exports/endpoints, no cuerpos) por archivo para decidir qué se re-describe y arrastrar descripciones en renombrados (`refresh.mjs`);
  2. capa **petición web → endpoint** como arista aparte, con prefijos de routers resueltos;
  3. `query.mjs` con cuatro verbos (`overview`, `find`, `show`, `path`) y salida acotada;
  4. validación del mapa que sugiere nombres ("did you mean …").
- **Descartar** como dependencia de fab: no por calidad, sino porque es una skill atada a Claude Code/Codex y su unidad de trabajo es el LLM.

## 5. Sin verificar

- Calidad de los nombres y descripciones del LLM, y su coste en tokens sobre un repo completo (no se ejecutó ningún LLM).
- Extracción de rutas HTTP y emparejamiento petición→endpoint: sw-factory no tiene rutas; solo lectura del código y de la documentación.
- Health, pantallas, blueprints, `refresh.mjs`, `serve.mjs`/Ask: no ejecutados.
- Comportamiento en el sandbox real de fab (`src/agent/mcp-sandbox.ts`) y con la red cortada: solo se ejecutó en máquina normal.
- Que no ejecute código del repo analizado y que no haga conexiones (lectura de `scripts/`, sin `strace`).
- Cobertura de Go, Rust y JVM: solo leí las funciones, no las probé. En sw-factory, TypeScript domina.
- Tokens: todo es bytes/4, sin tokenizador.
- `ext/codesearch/floorplan` tiene `.gitignore` modificado y `.ignore.graph/` sin seguir: son del indexado previo con graft, no míos.
- Lo medido es una sola corrida en un solo repo.
