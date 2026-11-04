# Evaluación de Alternativas de Búsqueda de Código para el Lector de Repos Grandes en Fab Investigación

**Fecha de evaluación:** 2026-11-01  
**Repositorio de prueba:** `/home/orlando/Desktop/factory/ext/opencode` (commit `79469efc`, **8.642 archivos versionados** en Git, ~920.000 líneas de TS, Go, CSS y otros)  
**Herramientas analizadas:** `graft` (línea base contextual), `ripgrep` (`rg`, línea base grep), `tgrep` (Microsoft), `semble` (MinishLab) y `xerj` (xerj-org).

---

## 1. Análisis Individual por Herramienta

### 1.1 graft (`@nanonets/graft` v0.28.1)
* **Qué es:** Motor de grafo de contexto local para agentes de IA que analiza el código fuente con Tree-sitter, construye un grafo de cableado (wiring graph: símbolos, llamadas, importaciones, exportaciones) y lo proyecta como un directorio de fichas markdown vinculadas y JSON (`dist/index.js`).
* **Estructura interna y algoritmos:**
  * **Parser AST:** Usa Tree-sitter nativo y WebAssembly (`tree-sitter`, `tree-sitter-typescript`, `tree-sitter-go`, `tree-sitter-python`, etc.) en `dist/graph/extract.js:L1-L120` para extraer nodos de símbolos, firmas, llamadas entrantes/salientes y relaciones de alcance (scopes).
  * **Índice léxico y ranking:** Implementa un scoring TF-IDF término a término en `dist/ask/ask.js:L80-L98` (`score(query, doc, idf)`). Aplica una penalización multiplicativa estricta a rutas de prueba (`TEST_RANK_PENALTY = 0.35`, `dist/ask/ask.js:L89`) para que los archivos de test no desplacen a las definiciones reales.
  * **GraphRank:** Combina el puntaje léxico con Personalized PageRank (`dist/ask/graphrank.js`, función `personalizedPageRank`) sobre el grafo de cableado para potenciar símbolos arquitectónicamente centrales.
* **Uso de embeddings o LLM:**
  * **Cero embeddings, cero LLM para consultas:** `graft ask`, `callers`, `skeleton`, `grep` y `map` son 100% locales, deterministas y de coste $0.
  * **Solo `build --deep` usa LLM:** La generación opcional de resúmenes de propósito ("crux") y mapa conceptual invoca un LLM externo (`dist/graph/build.js:L288`). Sin `--deep`, no se requiere ninguna API key ni conexión a red.
* **Superficie:**
  * CLI directa: `graft ask <query>`, `graft callers <sym>`, `graft skeleton <file>`, `graft grep <pat>`, `graft map`.
  * MCP: Servidor stdio nativo exponiendo `graft_find_code`, `graft_trace_calls`, `graft_file_api`, `graft_find_all`, `graft_repo_map` y `graft_check_freshness` (`dist/mcp/`).
  * Sin daemon de fondo obligatorio: opera directamente leyendo la carpeta `graft/` del repositorio o una ruta arbitraria con `--dir`.
* **Lenguajes:** TypeScript/JavaScript, Python, Go, Java, Kotlin, PHP, R (vía gramáticas Tree-sitter de Node.js).
* **Licencia:** MIT (`package.json:L19`).
* **Madurez:** v0.28.1, suite de pruebas automatizadas en `scripts/run-tests.mjs`, integrado y probado en flujos de trabajo con agentes (Claude Code, Codex, Cursor).

---

### 1.2 tgrep (v1.2.6, Microsoft)
* **Qué es:** Herramienta de búsqueda regex acelerada mediante índices de trigramas de bytes en disco y memoria, desarrollada en Rust por Microsoft y adoptada internamente en GitHub Copilot CLI (`README.md:L1-L8`).
* **Estructura interna y algoritmos:**
  * **Extracción de trigramas:** Extrae ventanas solapadas de 3 bytes en cada archivo (`tgrep-core/src/trigram.rs:L1-L6`). Cada trigrama se empaqueta sin colisiones en un entero de 24/32 bits: `(a << 16) | (b << 8) | c`.
  * **Hashing ultrarrápido:** Emplea `TrigramHasher` con una multiplicación xorshift de 64 bits (`0x9E37_79B9_7F4A_7C15`) en `tgrep-core/src/trigram.rs:L23-L46`, eliminando la sobrecarga de SipHash para alcanzar tasas de indexación de decenas de miles de archivos por segundo.
  * **Planificación de consultas regex:** En `tgrep-core/src/query.rs:L41-L60`, descompone cualquier patrón regex utilizando el HIR de `regex-syntax`, extrayendo los literales necesarios y ensamblando un árbol de consultas `QueryPlan` (`And`/`Or`). Intersecta las listas de ocurrencias de trigramas (`Postings`) para acotar los archivos candidatos y delega en el motor de expresiones regulares multihilo (`regex` / `fancy-regex`) la validación final línea por línea.
  * **Almacenamiento en disco:** Formato binario compacto en `.tgrep/` o ruta personalizada con `--index-path` (`index.bin`, `lookup.bin`, `files.bin`, `filestamps.json` y `meta.json`).
  * **Aclaración sobre conteo de archivos:** El repositorio `opencode` contiene exactamente **8.642 archivos versionados** en Git. Durante la prueba de indexación directa sin exclusión, `tgrep index` reportó 13.447 archivos debido a que recorrió también el directorio local no versionado `opencode/graft/` (que acumulaba ~4.800 tarjetas markdown y ficheros de grafo generados previamente).
* **Uso de embeddings o LLM:** Cero embeddings, cero LLM. Búsqueda exacta 100% determinista basada en coincidencia de bytes y regex.
* **Superficie:**
  * CLI compatible con ripgrep: acepta banderas de formato, conteo y filtrado idénticas (`-i`, `-s`, `-F`, `-n`, `-c`, `-l`, `--json`, `--vimgrep`).
  * Puede operar como CLI sin daemon (`tgrep index <path> --index-path <dir>` y `tgrep <pat> <path> --index-path <dir>`), o mediante un servidor opcional persistente (`tgrep serve`) con monitorización de cambios vía inotify/ReadDirectoryChangesW (`tgrep-core/src/live.rs`).
  * Integración MCP disponible mediante script externo en `scripts/agent/runtime.py`.
* **Lenguajes:** Universal / Agnóstico de lenguaje. Trata el código a nivel de flujo de bytes. Importa la tabla completa de extensiones y tipos de ripgrep (`tgrep-core/src/filetypes.rs:L1-L50`).
* **Licencia:** MIT (`LICENSE:L1-L25`, Copyright (c) Microsoft Corporation).
* **Madurez:** v1.2.6 (commit `df30218`), 133.621 líneas de Rust en `tgrep-core` y `tgrep-cli`. Incluye suite de fuzzing en `fuzz/`, benchmarks exhaustivos de árbol de trabajo compartido (`SHARED_INDEX_BENCHMARKS.md`) y suite de pruebas unitarias/integración.

---

### 1.3 semble (v0.7.1, MinishLab)
* **Qué es:** Biblioteca, CLI y servidor MCP en Python de búsqueda de código diseñada específicamente para agentes de codificación, enfocada en minimizar el consumo de tokens devolviendo fragmentos delimitados en lugar de archivos completos (`README.md:L1-L28`).
* **Estructura interna y algoritmos:**
  * **Chunking sintáctico por AST:** En `src/semble/chunking/core.py:L1-L60`, invoca Tree-sitter mediante el paquete `semble_grammars` para identificar fronteras de bloques lógicos (funciones, clases, métodos), combinando fragmentos adyacentes hasta un umbral de longitud deseado (`_merge_adjacent_chunks`).
  * **Índice híbrido (BM25 + Denso):** Almacenado en `~/.cache/semble/<hash>/index`:
    * Índice invertido BM25 léxico (`src/semble/index/bm25.py`).
    * Índice vectorial kNN (`vicinity`) con representaciones densas generadas en CPU (`src/semble/index/dense.py`).
    * Almacén de fragmentos `chunks.json` y metadatos de hashes para invalidación incremental en `metadata.json`.
  * **Heurísticas de re-ranking:** 
    * Detección de símbolos e identificadores (CamelCase, snake_case, palabras clave de definición) para otorgar un multiplicador de relevancia en `src/semble/ranking/boosting.py:L1-L60`.
    * Penalización explícita de archivos de prueba (`src/semble/ranking/penalties.py:L7-L50`) que cubre patrones de test en más de 15 lenguajes.
* **Uso de embeddings o LLM:**
  * **Sin LLM:** No utiliza modelos generativos.
  * **Embeddings estáticos locales (model2vec):** Utiliza por defecto el modelo estático `minishlab/potion-code-16M-v2` (`src/semble/utils.py:L11`), con un tamaño de apenas 1,1 MB en disco (`src/semble/index/dense.py:L25-L45`). Se ejecuta exclusivamente en CPU con latencias inferiores a 5 ms sin requerir GPU.
  * **Dependencia de red en primer arranque:** Si los pesos del modelo no están presentes localmente en la caché de Hugging Face (`~/.cache/huggingface/hub/`), intenta descargarlos de la red en la primera consulta, arrojando `RuntimeError` en un entorno estrictamente aislado salvo que se pre-cargue el modelo o se configure la variable de entorno `SEMBLE_MODEL_NAME`.
* **Superficie:**
  * CLI directa: `semble search <query> [path] --format json|text`.
  * Servidor MCP stdio nativo en Python (`src/semble/mcp.py`).
  * Sin daemon en segundo plano: cada llamada lee el índice en caché directamente desde disco.
* **Lenguajes:** Más de 70 lenguajes gracias a las gramáticas precompiladas de `semble_grammars` (TypeScript, Python, Go, Rust, C, Java, C#, Zig, etc.).
* **Licencia:** MIT (`LICENSE:L1-L22`, Copyright (c) 2026 Thomas van Dongen).
* **Madurez:** v0.7.1 (commit `4633ee7`), suite de pruebas con pytest en `tests/`, tipado estricto verificado con mypy y ruff.

---

### 1.4 xerj (v1.0.0-rc.100, xerj-org)
* **Qué es:** Motor de búsqueda local y servidor MCP de gran escala escrito en Rust, compatible con la API de Elasticsearch, diseñado para indexar código fuente, documentación, especificaciones técnicas y memoria persistente de agentes (`README.md:L1-L35`).
* **Estructura interna y algoritmos:**
  * **Monorepo distribuido en 18 crates (`engine/crates/`):**
    * `xerj-fts`: motor de búsqueda de texto completo con índices invertidos BM25 y filtros de tokens.
    * `xerj-vector`: búsqueda vectorial aproximada mediante grafos HNSW.
    * `xerj-autoindex`: crawler de sistema de archivos, parseo multihilo, control de presupuesto y sincronización (`engine/crates/xerj-autoindex/src/`).
    * `xerj-server`: servidor HTTP REST asíncrono sobre `tokio` y `axum` con compatibilidad con el dialecto JSON de Elasticsearch.
    * `xerj-storage`: motor de almacenamiento basado en segmentos inmutables, compresión Zstandard y Write-Ahead Log (WAL).
  * **Protocolo cliente/servidor:** El cliente de línea de comandos (`xerj autoindex`, `xerj search`) no busca directamente en disco: se comunica vía HTTP/JSON (`esclient.rs`) contra el daemon `xerj-server` en localhost (`engine/crates/xerj-autoindex/src/cli.rs:L30-L50`).
* **Instalación y ejecución verificada:**
  * Se descargó el binario oficial precompilado para Linux x86_64 (`xerj-1.0.0-rc.100-x86_64-unknown-linux-gnu.tar.gz`) directamente desde GitHub Releases con `gh release download` en menos de 10 segundos, alojándolo en `/tmp/claude-1000/xerj-eval/`.
  * Se ejecutó el servidor en modo daemon con almacenamiento aislado (`--insecure --data-dir /tmp/claude-1000/xerj-data --port 9450`), sin modificar en ningún momento la configuración global del usuario.
  * La indexación con `xerj autoindex` sobre `opencode` procesó 8.016 archivos (55.211 registros) en **66,9 s**, consumiendo **208 MB** en disco.
* **Uso de embeddings o LLM:**
  * Incluye un embedder léxico por defecto que funciona 100% offline sin descargas adicionales (`README.md:L33`), el cual fue el utilizado en las pruebas.
  * Ofrece un embedder neuronal opcional que descarga un modelo de aproximadamente 90 MB (`README.md:L34`).
  * No requiere LLM externo para indexación ni consultas.
* **Superficie:**
  * Daemon HTTP persistente (`xerj --insecure --data-dir <dir> --port <p> &`).
  * CLI cliente: `xerj autoindex <path>`, `xerj search <query>`, `xerj def <symbol>`.
  * MCP: servidor MCP integrado en la distribución (`crates/xerj-mcp`).
* **Lenguajes:** Múltiples lenguajes (soporta TS, Go, Python, Rust, C/C++, Java y analizadores sintácticos de texto plano/Markdown/PDF/JSONL).
* **Licencia:** Apache-2.0 (`LICENSE:L1-L30`).
* **Madurez:** 662.338 líneas de código en Rust, 1.444 tests de compatibilidad de ES-YAML superados, versión candidata `v1.0.0-rc.100`.

---

## 2. Tabla Comparativa contra graft (8 Restricciones)

| Criterio / Restricción | graft | tgrep | semble | xerj | ripgrep (`rg`) |
|---|---|---|---|---|---|
| **1. Sin red / sandbox bwrap (`--unshare-net`)** | **Cumple totalmente.** $0, sin red ni API key para el 100% de consultas (`ask`, `callers`, `skeleton`, `grep`). Solo `build --deep` opcional usa LLM. | **Cumple totalmente.** Binario nativo 100% offline, sin dependencias de red ni claves. | **Condicional.** Una vez descargado el modelo estático de 1,1 MB en caché local opera offline sin LLM. Falla al arrancar de cero sin red si no se pre-siembra el modelo. | **Cumple (modo léxico).** Funciona offline con su embedder léxico local. Modo neuronal requiere descarga previa de 90 MB. | **Cumple totalmente.** 100% offline, sin red, sin modelos. |
| **2. Repo no confiable (seguridad de ejecución)** | **Seguro.** Solo parseo AST estático con Tree-sitter. No ejecuta builds ni scripts del repo. | **Seguro.** Lectura pasiva de bytes y cómputo de trigramas. Cero ejecución de código. | **Seguro.** Parseo sintáctico pasivo con Tree-sitter (`semble_grammars`). Cero ejecución de código. | **Seguro.** Ingesta estática de texto y tokens. Cero ejecución de código. | **Seguro.** Búsqueda pasiva de texto plano. |
| **3. Cita exacta `archivo:línea`** | **Excelente.** Todas las herramientas devuelven rangos exactos `archivo:Lstart-Lend` con enlaces limpios. | **Excelente.** Salida exacta estilo grep `archivo:línea:contenido` (compatible con `--vimgrep`). | **Excelente.** Salida estructurada JSON y texto con `file_path`, `start_line` y `end_line`. | **Excelente.** Salida de pasajes con `file_path:line`. | **Excelente.** Salida clásica `archivo:línea:contenido`. |
| **4. Determinismo** | **100% determinista.** Ranking léxico TF-IDF y PageRank algebraico sin muestreo estocástico. | **100% determinista.** Filtrado booleano de trigramas y motor de expresiones regulares. | **100% determinista.** Embeddings estáticos (`model2vec` fijos) y BM25 sin temperatura. | **100% determinista.** BM25 e índice HNSW determinista. | **100% determinista.** Coincidencia regex pura. |
| **5. Coste sobre 8.642 archivos (`opencode`)** | - Índice: **No medido** (el repo ya venía pre-indexado en `opencode/graft/`)<br>- Tamaño: 326 MB<br>- Incremental: Sí (hash caché)<br>- Tokens consulta: ~150–350 | - Índice: **1,36 s**<br>- Tamaño: **100 MB**<br>- Incremental: Sí (`filestamps`)<br>- Tokens consulta: Ilimitado (~7k si no se filtra) | - Índice: 13,1 s<br>- Tamaño: 138 MB<br>- Incremental: Sí (`metadata`)<br>- Tokens consulta: **~600–900** | - Índice: **66,9 s**<br>- Tamaño: **208 MB**<br>- Incremental: Sí (WAL/Reconcile)<br>- Tokens consulta: **~350–800** | - Índice: **0 s**<br>- Tamaño: **0 MB**<br>- Incremental: N/A (escanea siempre)<br>- Tokens consulta: Ilimitado (~7k) |
| **6. Lenguajes mínimos (TS, Go, Python, Rust)** | Cubre TS, Go, Python con Tree-sitter. Rust parser es genérico en AST actual. | **Universal.** Cualquier lenguaje de texto o UTF-8 a nivel de trigramas de bytes. | **Cubre todos.** TS, Go, Python, Rust y 66 más en `semble_grammars`. | **Cubre todos.** Analizadores léxicos políglotas en Rust. | **Universal.** Cualquier lenguaje. |
| **7. Licencia** | **MIT** | **MIT** | **MIT** | **Apache-2.0** | **MIT / Unlicense** |
| **8. Superficie operativa para el lector** | **Ideal.** CLI directa y MCP stdio nativo. Sin daemon. | **Muy buena.** CLI directa con `--index-path`. Servidor opcional no requerido. MCP vía script externo. | **Ideal.** CLI directa y MCP stdio nativo en Python. Sin daemon. | **Deficiente.** Requiere daemon persistente en segundo plano (`xerj-server`). | **Básica.** CLI directa. No tiene MCP nativo. |

---

## 3. Resultados Experimentales en `opencode` (Tareas T1–T5)

Las pruebas se ejecutaron sobre `/home/orlando/Desktop/factory/ext/opencode` (commit `79469efc`, **8.642 archivos versionados**, ~920.000 líneas). Todas las mediciones de `xerj` corresponden a ejecuciones reales contra el servidor local levantado en `/tmp/claude-1000/xerj-data`.

### Resumen de Resultados por Herramienta y Tarea

| Tarea | Herramienta | ¿Acertó? | Cita exacta verificada en el fuente | Tokens / Líneas devueltos | Tiempo | Red / LLM |
|---|---|---|---|---|---|---|
| **T1 (Localizar)**<br>Compactación/resumen de sesión cuando se llena el contexto | **graft** (`ask`) | **Sí** (#1 directo) | `packages/core/src/session/compaction.ts:L1` | ~350 tokens (22 líneas de contexto curado) | 1,70 s | $0 / Local / Sin LLM |
| | **semble** (`search`) | **Sí** (#1 directo) | `packages/core/src/session/compaction.ts:67-81` (interfaz del servicio `compact` y `precompute`) | ~650 tokens (5 fragmentos JSON estructurados) | 2,70 s (13,1 s primera indexación) | CPU local (modelo 1,1 MB en caché) |
| | **tgrep** (consulta texto) | **No** (0 hits) | N/A (búsqueda literal no resuelve lenguaje natural) | 0 tokens | 0,012 s (12 ms) | $0 / Sin red / Sin LLM |
| | **tgrep** (`-i compaction`) | **Parcial** | 409 archivos encontrados (coincidencia bruta sin ranking) | ~1.200 tokens (lista de rutas) | **0,044 s** (44 ms) | $0 / Sin red / Sin LLM |
| | **rg** (`-i compaction`) | **Parcial** | 409 archivos encontrados | ~1.200 tokens (lista de rutas) | 0,094 s (94 ms) | $0 / Sin red / Sin LLM |
| | **xerj** (`search`) | **Parcial** | `services/www/src/docs/content/compaction.mdx:7` (score 86.30; localiza la doc de diseño de compactación, pero omite el fuente `packages/core/src/session/compaction.ts`) | ~750 tokens (5 pasajes) | 0,685 s (685 ms) | Local / Embedder léxico |
| **T2 (Aristas)**<br>Quién llama a la función de tool call y check de permisos | **graft** (`callers`) | **Parcial (solo invocador local)** | `packages/core/src/session/runner/step.ts:L91-L101` llamado por `step.ts:L126`. **Ninguna herramienta encontró el check de permisos.** | **223 tokens** | 1,05 s | $0 / Sin red / Sin LLM |
| | **semble** (`search`) | **No** | Devuelve `codemode/tool-runtime.ts` y fragmentos de UI sueltos. Carece de grafo de llamadas. | ~850 tokens | 2,10 s | CPU local |
| | **tgrep** (`"executeTool"`) | **No** (volcado ciego) | 48 archivos con 80+ ocurrencias en tests, UI y adaptadores sin discernir invocadores | ~7.200 tokens (26 KB de texto) | **0,012 s** (12 ms) | $0 / Sin red / Sin LLM |
| | **rg** (`"executeTool"`) | **No** (volcado ciego) | Mismo resultado que `tgrep` sin estructura relacional | ~7.200 tokens (26 KB de texto) | 0,065 s | $0 / Sin red / Sin LLM |
| | **xerj** (`def` / `search`) | **No** | `xerj def` halla la definición en `step.ts:91` y `codemode/tool-runtime.ts:399` en 0,039 s (~180 tok), pero carece de comando de aristas entrantes (`callers`) y no halla el permiso. `xerj search` devuelve fragmentos de `step.ts:91` en 0,571 s (~700 tok). | ~700 tokens | 0,571 s | Local / Embedder léxico |
| **T3 (Exhaustivo)**<br>Ocurrencias de `Permission.Event.Replied` | **graft** (`grep`) | **Sí** (5 hits) | 4 en `packages/core/src/permission.ts` (L124, 261, 275, 306), 1 en `packages/schema/test/event-manifest.test.ts:L63` | 136 tokens (agrupados por símbolo contenedor) | 2,46 s | $0 / Sin red / Sin LLM |
| | **semble** (`search`) | **No** (0 hits reales) | Devuelve 5 fragmentos que contienen `"permission.replied"` o `"Permission.Reply"`, pero omite el símbolo exacto por tokenización y truncamiento top-k. | ~900 tokens | 2,20 s | CPU local |
| | **tgrep** (`-c`) | **Sí** (5 hits) | **Conteo exacto idéntico a `rg`:** 4 en `permission.ts`, 1 en `event-manifest.test.ts` | **40 tokens** | **0,009 s** (9 ms, 6,7× más rápido que `rg`) | $0 / Sin red / Sin LLM |
| | **rg** (`-c`) | **Sí** (5 hits) | 4 en `permission.ts`, 1 en `event-manifest.test.ts` | 40 tokens | 0,061 s (61 ms) | $0 / Sin red / Sin LLM |
| | **xerj** (`search`) | **Parcial** | Halla los 2 archivos (`permission.ts:261` y `event-manifest.test.ts:63`), pero devuelve solo 2 pasajes agrupados en lugar de las 5 ocurrencias exactas. | ~350 tokens (2 pasajes) | 0,584 s | Local / Embedder léxico |
| **T4 (Conceptual)**<br>"¿Cómo decide qué modelo o proveedor usar para una petición?" | **graft** (`ask`) | **Sí** (#2 y #7) | `packages/core/src/session/model-request.ts` y `packages/core/src/model-resolver.ts:L1` | ~380 tokens | 1,62 s | $0 / Sin red / Sin LLM |
| | **semble** (`search`) | **Parcial** | Acierta `packages/core/src/models-dev.ts:234`, pero cuela texto de marketing de `console/app/src/i18n/en.ts` | ~920 tokens | 2,15 s | CPU local |
| | **tgrep** | **No** (0 hits) | Patrón de lenguaje natural falla contra índice de trigramas de texto plano. | 0 tokens | 0,012 s | $0 / Sin red / Sin LLM |
| | **rg** | **No** (0 hits) | Imposible resolver con regex ciego sin conocer los nombres de símbolos de antemano. | 0 tokens | 0,075 s | $0 / Sin red / Sin LLM |
| | **xerj** (`search`) | **No / Parcial disperso** | Recupera pasajes de protocolos multimedia de IA (`packages/ai/src/protocols/cloudflare-workers-ai-images.ts:63`), pero no el enrutador o resolvedor de modelo central. | ~800 tokens (5 pasajes) | 0,588 s | Local / Embedder léxico |
| **T5 (API de un archivo)**<br>Superficie pública de `packages/core/src/agent.ts` | **graft** (`skeleton`) | **Sí** (Exacto) | Signaturas completas de tipos (`ID`, `Name`, `Info`), interfaces (`Selection`, `Interface`), `Editor`, `Service` y funciones (`selectable`, `list`) con `Lstart-Lend` | **244 tokens** | 0,73 s | $0 / Sin red / Sin LLM |
| | **semble** | **No** | No tiene funcionalidad de esquema o esquemas sintácticos; buscar la ruta devuelve menciones cruzadas y 1 sola línea (`agent.ts:115`). | ~800 tokens | 2,20 s | CPU local |
| | **tgrep** (`"^export "`) | **Parcial** | Filtra líneas que arrancan con `export`, pero sin parsing de firmas, métodos internos de interfaces ni tipos. | 180 tokens | **0,010 s** | $0 / Sin red / Sin LLM |
| | **rg** (`"^export "`) | **Parcial** | Mismo comportamiento de regex plano sin semántica de lenguaje. | 180 tokens | 0,055 s | $0 / Sin red / Sin LLM |
| | **xerj** (`def` / `search`) | **No** | Carece de comando para proyectar la superficie pública de un archivo. Buscar la ruta devuelve pasajes no relacionados (`artifact-view.tsx:706`). | ~300 tokens | 0,580 s | Local / Embedder léxico |

---

### 3.2 Análisis Detallado de la Tarea T2 (Aristas y Comprobación de Permisos)

La tarea T2 pone de manifiesto una limitación estructural compartida por todos los motores de búsqueda estáticos:

1. **Definiciones encontradas:**
   * `graft callers` localizó el `executeTool` local a nivel de ejecución de pasos en `packages/core/src/session/runner/step.ts:91` (`const executeTool = (call: ToolCall) => ...`), llamado por `step.ts:126` (`restore(executeTool(event))`).
   * Sin embargo, existe la función principal `executeTool` del subsistema de herramientas en `packages/core/src/tool.ts:115` (`const executeTool = Effect.fn("Tool.execute")(function* (tool, name, input, context) { ... })`), la cual es invocada internamente en `packages/core/src/tool.ts:270`, `tool.ts:309` y `tool.ts:311`.
2. **La comprobación de permisos no fue localizada por ninguna herramienta:**
   * La verificación de permisos reside en `packages/core/src/permission.ts`: `const ask = Effect.fn("Permission.ask")` en la línea 214 y `const assert = Effect.fn("Permission.assert")` en la línea 228.
   * **Ninguna herramienta (`graft`, `semble`, `tgrep`, `rg`, `xerj`) fue capaz de conectar la llamada a `executeTool` con `Permission.assert` ni `Permission.ask`.**
   * **Por qué fallaron:** En la arquitectura de `opencode`, la comprobación de permisos no se invoca como un paso lineal previo estático dentro del cuerpo de `executeTool`. En su lugar, se delega de dos formas desacopladas:
     a) Dentro de cada herramienta individual ("leaf tools"), que invoca `Permission.assert` de forma aislada.
     b) A través de canales de defectos (`Cause.isDieReason`, `Deferred.fail`) que escapan intencionadamente del flujo ordinario de control para evitar que los modelos capturen el rechazo como texto normal (`packages/core/src/session/model-request.ts:381-395`).
   * Para rastrear este flujo, un agente no puede depender únicamente de grafos de llamadas directos de primer orden; requiere explorar el túnel de defectos y los contratos declarados en los docstrings de arquitectura (`packages/core/src/tool/AGENTS.md:29`).

---

## 4. Veredicto para el Lector "Repo Grande" en Fab Investigación

### 4.1 ¿Alguna herramienta reemplaza a graft?
**NO.** Ninguna de las herramientas evaluadas puede reemplazar a `graft` en el rol de lector de repositorios grandes.
* **Por qué falla el reemplazo:**
  1. **Ausencia de Grafo de Cableado (Wiring Graph):** `tgrep`, `semble` y `xerj` son motores de recuperación de texto o de fragmentos aislados. Ninguno construye aristas semánticas entre símbolos (llamantes, invocados, interfaces implementadas). Tareas indispensables para el lector de fab como T2 resultan imposibles con ellas sin inundar la ventana de contexto con decenas de llamadas falsas o tests.
  2. **Ausencia de Vistas Esqueléticas (`skeleton`):** La tarea T5 demuestra que `graft skeleton` es imbatible en relación economía/información: extrae la superficie de tipos y firmas de un archivo de 500 líneas en apenas ~240 tokens en 0,7 s. Ni `semble`, ni `tgrep`, ni `xerj` tienen esta capacidad.
  3. **Ranking Híbrido Estructural:** `graft ask` combina TF-IDF con Personalized PageRank, lo que permite que una consulta sobre "compaction" o "model resolution" posicione en el puesto #1 o #2 archivos arquitectónicamente vitales de `packages/core/src/` en lugar de fragmentos irrelevantes de historias de Storybook, archivos CSS o páginas de documentación web (como ocurrió con `semble` y `xerj`).

---

### 4.2 ¿Alguna herramienta complementa a graft?
**SÍ: `tgrep` complementa a `graft` (y supera a `rg`) como acelerador de búsqueda exhaustiva de literales (T3).**

* **El nicho de `tgrep`:**
  * En repositorios masivos (8.642 archivos versionados), `tgrep` construyó su índice completo en **1,36 segundos** y consumió solo **100 MB** en disco.
  * En búsquedas literales de símbolos y eventos (`Permission.Event.Replied`), resolvió la consulta exacta en **9 milisegundos**, siendo **6,7× más rápido que `rg`** (61 ms) y **270× más rápido que `graft grep`** (2,46 s).
  * Funciona en modo sin servidor (`tgrep <pattern> <path> --index-path /tmp/<idx>`), respetando `.gitignore`, corriendo 100% offline dentro del sandbox bwrap, con licencia MIT y sin escribir en el repo de origen montado como solo lectura.
* **Propuesta de integración complementaria:**
  * Cuando el lector necesita rastrear **todos los usos de una constante, cadena o evento literal** a través del monorepo, puede delegar en `tgrep --index-path /tmp/...` en lugar de lanzar escaneos completos de `rg`.

---

### 4.3 Herramientas a descartar
* **`semble`:** **Descartar.** A pesar de que su precisión en T1 fue impecable localizando el rango exacto de compactación, sufre de tres desventajas críticas para fab:
  1. Dependencia de red encubierta al arrancar por primera vez para descargar los pesos de `potion-code-16M-v2` desde Hugging Face, lo que rompe la regla de aislamiento del sandbox bwrap (`--unshare-net`) salvo pre-empaquetado explícito.
  2. Al truncar a top-k fragmentos y operar sobre vectores/BM25, es incapaz de realizar búsquedas literales exhaustivas (T3).
  3. No aporta grafo de llamadas (T2) ni vistas de firmas (T5).
* **`xerj`:** **Descartar.** A pesar de contar con binario oficial precompilado que indexó en 66,9 s, su diseño está acoplado obligatoriamente a un daemon HTTP en segundo plano (`xerj-server`) que debe mantenerse activo en un puerto local. Además, en las pruebas reales no superó a `graft` en precisión arquitectónica (T1 recuperó documentación web en vez de código, T4 devolvió protocolos multimedia y T5 falló por completo al carecer de extracción de firmas AST).

---

### 4.4 Ideas y Patrones a Adoptar en Fab (Patrones, no dependencias)

Aunque se descarte la incorporación de estas herramientas como dependencias externas, sus diseños aportan patrones de alto valor que fab puede incorporar a sus herramientas nativas:

1. **Índice de Trigramas en Enteros `u32` con Hashing Multiply-Xorshift (de `tgrep`):**
   * *Patrón:* Empaquetar 3 bytes en un `u32` (`(a << 16) | (b << 8) | c`) y usar un hasher multiplicativo rápido (`val * K ^ (val >> 32)`).
   * *Beneficio:* Permite indexar un árbol de 1 millón de líneas en 1 segundo y acotar búsquedas literales mediante intersección de conjuntos de bits sin la sobrecarga de un motor FTS completo.
2. **Chunking Sintáctico por Nodos AST con Fusión Adyacente (de `semble`):**
   * *Patrón:* En lugar de dividir el código por ventanas fijas de líneas o tokens, utilizar Tree-sitter para delimitar funciones, clases o bloques de declaraciones completas, fusionando nodos pequeños contiguos hasta alcanzar una longitud óptima (ej. 30–60 líneas).
   * *Beneficio:* Evita cortar definiciones a la mitad y garantiza que cada fragmento inspeccionado por el crítico o el lector conserve contexto semántico autocontenido.
3. **Penalización Rigurosa de Archivos de Prueba y Artefactos (de `graft` y `semble`):**
   * *Patrón:* Ambas herramientas aplican filtros deterministas mediante regex compiladas sobre rutas de tests (`_test.go`, `.test.ts`, `__tests__/`, `.spec.`).
   * *Beneficio:* En consultas de arquitectura o localización de subsistemas, amortigua las coincidencias espurias en suites de pruebas unitarias o mocks, que tienden a duplicar las firmas de los componentes reales.
4. **Embeddings Estáticos en CPU Ultra-ligeros (`model2vec`):**
   * *Patrón:* Si en el futuro el lector requiere capacidades de búsqueda semántica difusa ("fuzzy concept search") sin recurrir a llamadas costosas a un LLM, el uso de tablas estáticas de embeddings vectoriales (pesos fijos de ~1 MB evaluados como sumas vectoriales en CPU) es el único enfoque viable dentro de un sandbox desconectado de la red.

---

## 5. Aspectos No Verificados Explícitamente

Para mantener la integridad técnica del informe, se identifican explícitamente los siguientes puntos no verificados empíricamente:
1. **Comportamiento de `xerj` con embedder neuronal ONNX:** Se evaluó con el binario precompilado utilizando el embedder léxico predeterminado (offline). No se evaluó el backend neuronal ONNX opcional que requiere descargar pesos adicionales de ~90 MB.
2. **Comportamiento de `tgrep serve` en estrés prolongado:** Se probó la indexación y consulta estática con `--index-path`, pero no se evaluó la resiliencia del demonio `tgrep serve` bajo ráfagas masivas de eventos inotify concurrentes durante múltiples horas de edición activa.
3. **Compatibilidad de `semble` en plataformas sin precompilados:** No se probó el rendimiento de `semble_grammars` en arquitecturas donde las librerías compartidas de Tree-sitter no estén precompiladas (escenario que forzaría el fallback a line chunking).
