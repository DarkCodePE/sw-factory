# Búsqueda de código basada en grafo: code-graph-rag, codegraph y codebase-memory-mcp frente a graft

Evaluación para el lector de fab investigación en el perfil "repo grande" (ver `ARQUITECTURA.md` pasos 0 y 5, ADR-0002, ADR-0007). Repo de prueba: `ext/opencode` @ `79469efc` (8 600 archivos, ~920 k líneas). Fecha de la prueba: 2026-11-01. **Una sola ejecución por celda, un solo repo, una sola máquina**: los tiempos y aciertos son indicativos, no un benchmark.

## 0. Cómo se probó

- Cada herramienta se instaló o ejecutó **aislada**: codegraph con `npm install --prefix <tmp> --ignore-scripts`; code-graph-rag en un `uv venv` en `/tmp/claude-1000/…/scratchpad`; codebase-memory-mcp ya estaba en `~/.local/bin` (v0.10.8) y se usó **solo por CLI** con `CBM_CACHE_DIR` apuntando a un directorio temporal (no se tocó `~/.cache/codebase-memory-mcp` ni su config; `install` no se ejecutó).
- codegraph y code-graph-rag escriben su índice dentro del repo o en un grafo compartido, así que se indexó una **copia** de opencode (`rsync` sin `.git`, `graft/`, `node_modules/`: 8 600 archivos). opencode y los repos de `ext/codesearch/` no se modificaron.
- Las consultas y los índices de codegraph y code-graph-rag se ejecutaron **dentro de bwrap sin red** (`--unshare-net --tmpfs /` + `--ro-bind` de `/usr` y binarios, raíz tmpfs como en `src/agent/mcp-sandbox.ts`). codebase-memory-mcp y graft se consultaron también en ese sandbox con el repo en solo lectura.
- Verdad de referencia (leída en el fuente de opencode): compactación en `packages/core/src/session/compaction.ts` (`compact`, `:284`); ejecución de tools en `packages/core/src/tool/runtime.ts:30` (`execute`) y `packages/core/src/tool.ts:115` (`executeTool`); comprobación de permisos en `packages/core/src/permission.ts:214` (`ask`) y `:228` (`assert`), invocada por cada plugin de tool (p. ej. `tool/plugin/shell.ts:138`, `edit.ts:275`); selección de modelo en `packages/core/src/model-resolver.ts`; el evento `permission.asked` aparece **55 veces en 40 archivos** según `rg` (incluye `.mdx`, pruebas y e2e).
- Tokens: no hay tokenizador común; se estiman como bytes de salida / 4.

## 1. Por herramienta

### 1.1 graft (línea base) 0.28.1, MIT

- **Qué es**: construye `graft/` con tarjetas markdown por archivo y un grafo de cableado; `ask` fusiona búsqueda léxica (BM25, `dist/ask/ask.js:135`) con PageRank personalizado (`dist/ask/graphrank.js:16`) y la fusión de `dist/ask/fuse.js`. El LLM solo interviene en `build --deep` (`dist/graph/build.js:288` guarda el resultado por `body_hash`). Parser: tree-sitter (`package.json`: `tree-sitter`, `-go`, `-python`, `-typescript`, `web-tree-sitter`).
- **Superficie**: CLI (`ask`, `grep`, `skeleton`, `callers`, `map`) y MCP, sin daemon. Las consultas corrieron en bwrap sin red con el repo en solo lectura.
- **Índice**: directorio `graft/` de 326 MB para opencode.
- **Observaciones**: la primera consulta de la sesión tardó 77 s porque refrescó el grafo ("refreshed the graph"); las siguientes, 0,7–2,5 s. Imprime un aviso de telemetría anónima (desactivable con `graft telemetry disable`); sin red no falla. Rust como lenguaje: **no verificado** (la lista de dependencias que leí no incluye `tree-sitter-rust`).

### 1.2 codebase-memory-mcp 0.10.8, MIT

- **Qué es**: binario C que indexa en SQLite (`src/store/store.c:345-404`: tablas `projects`, `file_hashes`, `nodes`, `edges`, `lsp_surface`; búsqueda FTS5/BM25 en `nodes_fts`, `:563`). Parser tree-sitter con 162 gramáticas vendorizadas (`internal/cbm/cbm.c:564`, README:397) más resolución de tipos "LSP híbrida" para TS, Python, Go y Rust, entre otros (README:400). Los embeddings (Nomic, 768d int8) vienen **compilados en el binario** (`src/semantic/semantic.c:445`, README:318): sin API key ni red.
- **Superficie**: MCP stdio y `cli <tool>`. Cada invocación CLI arranca un **daemon temporal** (el propio CLI lo avisa: "this command started a temporary CBM daemon").
- **Madurez**: el clon es `--depth 1` (1 commit visible): historial **no verificable**. 959 archivos de test (`find`), sin ejecutarlos.
- **Sandbox**: con `--ro-bind / /` **falló** (`secure CLI coordination could not be created … /tmp/cbm-daemon-1000: the directory CONTAINING 'tmp' is not a usable private-directory parent`, hay un directorio de coordinación fijo en `/tmp`); con raíz tmpfs funcionó. El motor de fab (`mcp-sandbox.ts`) usa raíz tmpfs, así que encaja, pero hay que probarlo en el sandbox real.
- **Índice (opencode)**: modo `fast` 13,6 s, 44 710 nodos, 216 243 aristas, 151 MB; modo `full` (por defecto) 19,6 s, 81 003 nodos, 339 580 aristas, 279 MB. Re-indexar sin cambios en bwrap: 5,5 s.

### 1.3 codegraph 1.6.2, MIT

- **Qué es**: binario Node 24 empaquetado (el paquete npm trae el runtime, 117 MB, `npm-shim.js`), SQLite vía `node:sqlite` (`src/db/index.ts:552`; esquema `src/db/schema.sql:20` nodos, `:45` aristas), tree-sitter en WASM (`src/extraction/tree-sitter-helpers.ts:8`). Sin embeddings ni LLM en el camino de consulta (README:295 "100% Local"). Hay una fase de "resolving refs" y "linking dynamic dispatch" tras el parseo.
- **Superficie**: CLI (`init`, `sync`, `context`, `explore`, `node`, `callers`, `callees`, `impact`, `query`, `files`, `status`) y MCP; sin daemon obligatorio para la CLI (existen `daemon`/`daemons` opcionales).
- **Privacidad**: telemetría activa por defecto (`TELEMETRY.md`: `CODEGRAPH_TELEMETRY=0` o `DO_NOT_TRACK=1`). Se probó con ambas variables.
- **Madurez**: clon superficial (1 commit); 1 772 archivos de test; `CHANGELOG.md` de 687 KB sugiere ritmo alto, **sin verificar**.
- **Índice**: `init` en bwrap sin red: 47 s totales (4,8 s de indexado interno), 5 336 archivos indexados (de 8 600: respeta ignores y tipos), 83 405 nodos, 234 185 aristas, `.codegraph/` 295 MB. `sync` tras tocar 1 archivo: 7,0 s en total (926 ms de indexado).

### 1.4 code-graph-rag (PyPI 0.4.5; el repo clonado es 0.4.18), MIT

- **Qué es**: grafo en SQLite embebido (`SQLITE_GRAPH_PATH`; Memgraph/Neo4j opcionales), parseo tree-sitter por lenguaje (TS, Go y Rust exigen el extra `treesitter-full`, `pyproject.toml:164-169`) más un nivel ast-grep (`codebase_rag/parsers/ast_grep_tier.py`). Consultas deterministas sin LLM con `cgr graph …` (`resolve`, `definition`, `callers`, `callees`, `implementors`, `overrides`, `importers`, `tests-reaching`; `codebase_rag/graph_query.py:728`). `cgr context` y `start` (lenguaje natural → Cypher) necesitan LLM (`pydantic-ai`) y/o búsqueda semántica: el extra `semantic` instala `torch` + `sentence-transformers` y descarga UniXcoder (`codebase_rag/embedder.py:190,231`) → **requiere red la primera vez**.
- **Superficie**: CLI (`cgr`) y MCP (`cgr mcp-server`); sin daemon con el backend SQLite.
- **Observaciones**: la versión de PyPI (0.4.5) va por detrás del clon (0.4.18): lo ejecutado **no es exactamente** el código leído. `cgr context` con texto libre sin el extra semántico devuelve `resolved: null` ("Nothing in the graph matches"). Intenta descargar la codificación `cl100k_base` de tiktoken (sin red cae a una estimación; hay que fijar `TIKTOKEN_CACHE_DIR`).
- **Índice**: `--update-graph` en bwrap sin red: **273 s**, 225 MB de SQLite, 44 241 aristas IMPORTS verificadas; `cgr stats` tardó 104 s. 7 archivos (bash, nix) quedaron como `File` sin símbolos. Incremental: **no medido** (el estado de hash está en `$HOME/.cgr/state`, que en mi sandbox era tmpfs y se perdía; la reindexación tras tocar un archivo superó los 10 minutos y la cancelé). 1 388 archivos de test; clon superficial.

## 2. Tabla comparativa contra graft (8 restricciones)

| # | Restricción | graft | codebase-memory-mcp | codegraph | code-graph-rag |
|---|---|---|---|---|---|
| 1 | Offline, sin LLM/API key | Sí (LLM solo en `build --deep`). Aviso de telemetría | Sí (embeddings compilados). Sandbox con raíz tmpfs; con `/` ro falla por el directorio `/tmp/cbm-daemon-<uid>` | Sí. Desactivar telemetría | Indexar y `graph …`: sí. Texto libre/`start`: LLM o embeddings con descarga (red). tiktoken intenta red |
| 2 | No ejecuta código del repo | No observado que lo haga; **no verificado** a fondo | Igual: solo parseo (no auditado) | Igual: parseo WASM; `--ignore-scripts` en la instalación | Igual; **no auditado** (tiene modos "optimize"/"edit" que no se usaron) |
| 3 | Cita `archivo:línea` | Sí (`file:L1-L2`) | Sí (archivo + rango) | Sí (`archivo:línea` y rango en nodos) | Sí en `graph`/`context` (path, `start_line`, columna) |
| 4 | Determinismo | No medido en repetición | Sí (mismo md5 en 2 corridas) | Sí (mismo md5 en 2 corridas) | Sí (mismo md5 en 2 corridas de `graph resolve`) |
| 5 | Coste (índice, incremental, tokens) | `graft/` 326 MB; consultas 0,7–2,5 s; ~1,2–2 k tokens; construcción desde cero **no medida** | 13,6 s (fast) / 19,6 s (full); 151/279 MB; consulta ~3,7 s (arranque de daemon); 0,4–0,6 k tokens | 47 s; 295 MB; consulta 0,4–1,5 s; `sync` de 1 archivo 7 s; 0,07–6 k tokens | 273 s; 225 MB; consulta 0,7–10 s; incremental no medido; hasta ~3 k tokens |
| 6 | TS, Go, Python, Rust | TS, Go, Python sí; Rust no verificado | Sí (162 gramáticas) | Sí | Sí con extra `treesitter-full` |
| 7 | Licencia MIT/Apache | MIT | MIT | MIT | MIT |
| 8 | CLI sin daemon | Sí | CLI, pero arranca un daemon temporal por llamada | Sí | Sí (SQLite) |

## 3. Resultados T1–T5

Leyenda: ✔ acierta (verificado en el fuente), ◐ parcial, ✘ falla, n/a no soportado. "Red/LLM": todas las consultas se ejecutaron sin red; se anota si la función exigiría LLM o red.

| Tarea | graft | codebase-memory-mcp | codegraph | code-graph-rag |
|---|---|---|---|---|
| **T1** localizar compactación | ◐ `ask` literal: ruido (Figma) y, con otra frase, `compaction.ts` como archivo nº 1; 7,6 KB (~1,9 k tok), 1,6 s | ◐ `search_graph` BM25: `estimateContext` en `compaction.ts:1067` entre ruido; `search_code` añade `previousCompaction`, `spend`; 2–2,5 KB, 3,6–3,9 s | ✔ `context`: punto de entrada `compact` en `compaction.ts:284` con cuerpo; 4,2 KB (~1 k tok), 0,8 s | ✘ `context` texto libre: `resolved: null` (requiere extra semántico). `graph resolve compaction` devuelve solo coincidencias de nombre (1,8 KB) |
| **T2** quién llama a `execute` + permisos | ✘ `ask`: ruido; `callers permission.assert` sin llamadores (nombre ambiguo, 8 `Assert`) | ◐ `search_graph` halla `tool/runtime.ts:30-62` (nº 1); `trace_path` da solo el módulo `tool.ts`, sin línea; permiso no aparece | ◐ `callers -f tool/runtime.ts execute` → `executeTool` en `tool.ts:115` (0,3 KB, 0,6 s) pero hay que conocer el archivo (55 definiciones de `execute`); `context` en lenguaje natural falla; permiso no aparece | ◐ `graph resolve runtime.ts:30` → `…runtime.execute` (0,2 KB); `graph callers` da 407 líneas JSON con línea y columna de cada llamada, 12 KB; permiso no aparece |
| **T3** exhaustivo `permission.asked` (rg: 55 en 40 archivos) | ◐ `grep`: 39 aciertos en 21 archivos (solo código indexado), agrupados por símbolo; 4,9 KB, 2,5 s | ✘ `search_code`: 11 archivos / 15 coincidencias; 1 KB | ✘ `query`: 4 símbolos (no hace grep de texto) | n/a (sin búsqueda de texto) |
| **T4** conceptual, modelo/proveedor | ◐ `model-resolver.ts` aparece como nº 7 entre ruido | ✘ BM25: funciones `request` de plugins de proveedor; `semantic_query` devolvió ruido (colores, migraciones) | ◐ `context` ✘ (UI); `explore` ✔ llega a `model-resolver.ts` (`resolveModel`, `fromCatalogModel`, líneas citadas) pero con 25 KB (~6 k tok), 1,5 s | n/a sin LLM/embeddings; no ejecutado (ver §3.1) |
| **T5** API de un archivo | ✔ `skeleton compaction.ts`: 54 líneas, 6,9 KB, 0,7 s, con rangos | ✔ `search_graph --file-pattern`: 84 símbolos con rango, 3,9 KB, 3,6 s | ✔ `node -f … --symbols-only`: 100 símbolos con línea, 8 KB, 0,4 s | ◐ `context path:línea`: devuelve una función, no el archivo (4,4 KB, 9,8 s) |

Observaciones transversales:

- Ninguna herramienta, graft incluido, devolvió la comprobación de permisos (`Permission.assert`, llamada desde cada plugin de tool) ante la pregunta T2 completa. Lo mejor fue encadenar dos consultas con nombres exactos.
- En opencode los arneses de tools están escritos con Effect (`Effect.fn`, `yield*`): el grafo estático pierde llamadas hechas a través de ese estilo. Es una limitación de las cuatro herramientas, no de una.
- `graft ask` y el grueso de las consultas lingüísticas fallan cuando el vocabulario de la pregunta difiere del código (T4); ninguna herramienta sin embeddings/LLM lo resolvió bien.

### 3.1 Lo que no pude ejecutar

- **code-graph-rag, modo semántico y `start`/`--ask-agent`**: exigen el extra `semantic` (torch + descarga de UniXcoder desde Hugging Face) o una API key de LLM. Supera los 10 minutos de instalación/descarga y rompe la regla de "sin red"; evaluado solo por el código (`embedder.py`, `pyproject.toml:189-195`). T4 queda sin medir.
- **code-graph-rag, actualización incremental**: no medida (ver §1.4).
- **graft, construcción desde cero**: no medida; ya estaba indexado y el índice de 326 MB se reutilizó.
- **codebase-memory-mcp con `--ro-bind / /`**: no funciona; solo se probó con raíz tmpfs.
- **Ejecución de los tests de las cuatro herramientas**: no ejecutados; solo conté archivos.

## 4. Veredicto para el lector "repo grande"

- **Ninguna reemplaza a graft.** En T5 y en el trabajo de "dame el mapa de este archivo" graft empata o mejora (0,7 s, salida compacta), y en T1/T4 ninguna alternativa es claramente mejor de forma consistente: codegraph acierta T1 y T4 solo con el comando `explore`/`context` correcto, y a costa de 4–25 KB por consulta. El número de pruebas (5 tareas, 1 repo) no justifica sustituir la base actual.
- **Complemento recomendado: codegraph** para dos tareas del lector: (a) **aristas** (`callers -f <archivo> <símbolo>`, `callees`, `impact`) con respuesta mínima y cita de línea, y (b) **leer el tramo**: `context` y `node` devuelven el cuerpo de la función con su `archivo:línea`. Cumple las 8 restricciones sin LLM, sin red y sin daemon; el coste es una segunda base de 295 MB y ~47 s de indexado por commit (más la telemetría, a desactivar). Condición: añadirlo solo si el crítico/ledger necesitan esas aristas; si no, es duplicar graft.
- **code-graph-rag: descartar para el lector.** Indexar tarda 273 s, el incremental no se pudo medir, y lo que lo hace distinto (lenguaje natural, semántica) exige LLM o descarga de modelo, lo que choca con las restricciones 1 y 5. Sus consultas `graph …` deterministas son buenas, pero igualables con codegraph.
- **codebase-memory-mcp: descartar por ahora.** El índice es el más rápido (14–20 s) y tiene la mayor cobertura de lenguajes, pero T3 devolvió una fracción de las ocurrencias, T4 y la búsqueda semántica fallaron, y el CLI depende de un daemon con un directorio fijo en `/tmp` que no arrancó con `--ro-bind / /`. Reconsiderar si se valida en el sandbox real de fab y en otros repos.
- **Ideas para adoptar como patrón (no dependencia):**
  1. **Resolver `path:line` a símbolo** (`cgr graph resolve`) para que el crítico verifique una cita sin leer el archivo.
  2. **Filas por llamada con línea y columna** (`cgr graph callers`) y **filtro por archivo** para desambiguar (`codegraph callers -f`).
  3. **`--symbols-only`** (codegraph) y **`--budget` de tokens** (`cgr context`): salida acotada y declarada.
  4. **Salida ambigua con sugerencias** (codebase-memory-mcp `trace_path`: "63 matches… pick a qualified_name") en vez de adivinar.
  5. **Códigos de salida distintos** para "no indexado" y "nombre ausente" (`cgr graph`: 3 y 4).
  6. **Bloque "blast radius"** de `codegraph explore`.
  7. **Todas las consultas deterministas** (mismo md5 en dos corridas): conviene fijarlo como prueba en la integración de fab.

## 5. No verificado

- Historial de commits y ritmo de mantenimiento de las cuatro herramientas (clones `--depth 1`).
- Que las herramientas no ejecuten código del repo al indexar (restricción 2): solo se observó que no hubo ejecución visible; no se auditó el código ni se usó `strace`.
- Calidad de resolución de aristas en lenguajes distintos de TypeScript; Go, Python y Rust no se probaron (el repo de prueba es casi todo TS).
- Soporte de Rust en graft.
- Tiempo de construcción de graft desde cero y su incremental.
- Comportamiento en el sandbox real de fab (`mcp-sandbox.ts`) con el repo en solo lectura para codegraph, cgr y cbm: se emuló con bwrap y raíz tmpfs, y codegraph/cgr escribieron el índice en una copia con permiso de escritura.
- Los números de tokens son bytes / 4, no un tokenizador.
- La ruta T2 correcta (`runtime.ts:30` → `tool.ts:115`) la señalaron tres herramientas; leí el fuente de `permission.ts` y de la compactación, pero no abrí `tool.ts:115`.
- Versión de code-graph-rag: PyPI 0.4.5 frente al clon 0.4.18.

## Archivos

| Archivo | Responsabilidad |
|---|---|
| `docs/research/arquitectura-ideacion/codesearch/grafos.md` | Este informe. |
| `ext/codesearch/codebase-memory-mcp/` (`src/store/store.c`, `src/semantic/semantic.c`, `internal/cbm/cbm.c`) | Fuente citado de codebase-memory-mcp. |
| `ext/codesearch/codegraph/` (`src/db/`, `src/extraction/`, `TELEMETRY.md`) | Fuente citado de codegraph. |
| `ext/codesearch/code-graph-rag/` (`codebase_rag/graph_query.py`, `embedder.py`, `pyproject.toml`) | Fuente citado de code-graph-rag. |
| `/home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft/dist/` | Fuente citado de graft. |
