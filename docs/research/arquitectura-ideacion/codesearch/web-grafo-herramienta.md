# Investigación Web: Mejoras del Flujo "Grafo como Herramienta, no como Contexto"

**Fecha de elaboración:** 1 de noviembre de 2026  
**Contexto del proyecto:** Flujo de búsqueda de código en repositorios grandes para el lector de `fab` investigación (`ARQUITECTURA.md`, `codesearch/README.md`, `grafos.md`, `busqueda.md`, `web-contexto.md`).  
**Restricciones operativas de `fab`:** Sandbox sin red (`bwrap --unshare-net`), repositorio no confiable (no ejecutar código ni scripts de build arbitrarios), y sin LLM para la construcción del mapa estático inicial.  
**Herramientas de recolección:** Agent-Reach (Exa semantic search vía mcporter, Jina Reader, GitHub, inspección de código fuente y documentación técnica de `ext/codesearch/`).

---

## 0. Resumen del Flujo y Problemas Abordados

El flujo adoptado en `fab` establece una separación estricta entre orientación y consulta:
1. **Árbol de sintaxis (Tree-sitter) → Grafo de código → Almacenamiento en disco** (sin red ni LLM).
2. **Mapa recortado en el prompt inicial:** 1–4 k tokens con los módulos más centrales (PageRank).
3. **Consulta bajo demanda:** El agente usa herramientas puntuales (`graft ask "<hipótesis>"`, `callers X`, `skeleton archivo`, y `rg` para búsquedas exhaustivas).
4. **Respuesta acotada:** Al contexto del modelo solo ingresan fragmentos mínimos con `archivo:línea`.

Los 5 problemas conocidos identificados en las pruebas previas sobre `opencode` (commit `79469efc`, 8.642 archivos) son:
- **P1.** Sensibilidad de redacción en `graft ask`: variaciones menores en la frase alternan entre acierto y fallo.
- **P2.** Consultas conceptuales sin identificadores ("¿cómo decide qué modelo usar?"): fallan sin embeddings.
- **P3.** Pérdida de llamadas en grafos estáticos: inyección de dependencias, estilo Effect (`yield*`), dispatch dinámico y callbacks no generan aristas.
- **P4.** Nombres ambiguos: llamadas a funciones comunes (ej. 55 definiciones de `execute`) colapsan o confunden herramientas como `callers`.
- **P5.** Recorte del mapa inicial (1–4 k tokens) sin excluir el subsistema crítico para la hipótesis.

---

## 1. Personalizar el Mapa por Tarea (P5)

### 1.1. PageRank Personalizado Sembrado con Términos de la Tarea (Caso Aider)

- **Hecho documentado (Código fuente):** En [aider/repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) (versión 2024–2025), Aider implementa un algoritmo de PageRank Personalizado (PPR) sobre un multidigrafo de dependencias construido con Tree-sitter:
  1. *Vector de personalización:* Inicializa el vector base como `personalize = 100 / len(fnames)`. Si un archivo aparece en los mencionados en el chat (`mentioned_fnames`), su peso sube a `max(current_pers, personalize)`. Si algún componente de la ruta coincide con un identificador mencionado en el prompt (`mentioned_idents`), se suma `personalize` al nodo.
  2. *Ponderación de aristas:* Cada arista `referencer -> definer` recibe un multiplicador base `mul = 1.0`:
     - Si el identificador coincide con `mentioned_idents`: `mul *= 10`.
     - Si además tiene formato `snake_case` o `camelCase` y longitud $\ge 8$ caracteres: `mul *= 10` adicional (multiplicador acumulado de **100x** para identificadores específicos).
     - Si empieza por guion bajo `_` (privado/interno): penalización `mul *= 0.1`.
     - Si el símbolo tiene más de 5 definiciones en el repo (`len(defines[ident]) > 5`): penalización `mul *= 0.1` para mitigar ambigüedad.
     - Si el archivo referenciador está abierto o activo en el chat: `mul *= 50`.
     - Amortiguación de alta frecuencia: las referencias repetidas se amortiguan con raíz cuadrada (`num_refs = math.sqrt(num_refs)`) para evitar que símbolos utilitarios dominen el ranking.
  3. *Distribución y exclusión:* `nx.pagerank(G, weight="weight", personalization=personalization, dangling=personalization)`. El rango del nodo fuente se distribuye a sus aristas salientes (`src_rank * data["weight"] / total_weight`). Los símbolos que ya pertenecen a los archivos presentes en el chat se **excluyen** del mapa final para no duplicar tokens.
  4. *Presupuesto:* Genera firmas hasta agotar exactamente el presupuesto configurado (**1 024 tokens** por defecto; 2 048 si no hay archivos en el chat).

### 1.2. Literatura Académica sobre Localización con Grafos (2024–2026)

- **RepoGraph (ICLR 2025 / arXiv:2410.14684v2, 24 de octubre de 2024):**  
  *Fuente:* [arXiv:2410.14684](https://arxiv.org/abs/2410.14684) / [ICLR 2025 Proceedings](https://proceedings.iclr.cc/paper_files/paper/2025/hash/4a4a3c197deac042461c677219efd36c-Abstract-Conference.html).  
  *Hecho documentado:* Propone un grafo a nivel de línea con extracción de subgrafos egocéntricos (*ego-graphs*) centrados en palabras clave del issue. Evaluado en **SWE-bench Lite** (300 instancias), midió mejoras consistentes de localización sobre cuatro arquitecturas base (Tabla 3 del paper):
  - **Agentless (GPT-4o):**
    - Archivo (*file-level*): **68.7% → 74.3%** (+5.6 puntos porcentuales).
    - Función (*function-level*): **51.0% → 54.0%** (+3.0 pp).
    - Línea (*line-level*): **34.3% → 36.7%** (+2.4 pp).
  - **AutoCodeRover (GPT-4):**
    - Archivo: **62.3% → 69.0%** (+4.7 pp).
    - Función: **42.3% → 45.7%** (+3.4 pp).
    - Línea: **29.0% → 31.7%** (+2.7 pp).
  - **SWE-agent (GPT-4o):**
    - Archivo: **61.7% → 67.3%** (+5.6 pp).
    - Función: **46.3% → 49.3%** (+3.0 pp).
    - Línea: **32.3% → 35.0%** (+2.7 pp).
  - **RAG tradicional (GPT-4):**
    - Archivo: **47.3% → 51.7%** (+4.4 pp); Función: **23.3% → 25.3%** (+2.0 pp).
  - *Tasa de resolución:* RepoGraph logró una mejora relativa promedio del **32.8%** en la tasa de resolución final (*resolve rate*) en SWE-bench Lite. Los autores destacan que la ganancia es mayor a nivel de archivo (+4.4 a +5.6 pp) que a nivel de línea (+1.6 a +2.7 pp).

- **LocAgent (ACL 2025 / arXiv:2503.09089v2, 29 de abril de 2025):**  
  *Fuente:* [arXiv:2503.09089](https://arxiv.org/abs/2503.09089) / [ACL Anthology 2025.acl-long.426](https://aclanthology.org/2025.acl-long.426.pdf).  
  *Hecho documentado:* Modela el repositorio como un grafo heterogéneo dirigido (nodos: archivos, clases, funciones; aristas: importación, invocación, herencia) y ejecuta razonamiento multi-salto con agentes guiados por grafo. En **SWE-bench Lite** (subconjunto de 274 instancias con funciones modificadas, Tabla 4):
  - **LocAgent (Claude-3.5-Sonnet):**
    - Archivo: **Acc@1 = 77.74%**, **Acc@3 = 91.97%**, **Acc@5 = 94.16%**.
    - Función: **Acc@5 = 73.36%**, **Acc@10 = 77.37%**.
  - **LocAgent con modelo local abierto (Qwen2.5-Coder-32B fine-tuned):**
    - Archivo: **Acc@1 = 75.91%**, **Acc@3 = 90.51%**, **Acc@5 = 92.70%**.
    - Función: **Acc@5 = 71.90%**, **Acc@10 = 77.01%**.
    - Coste: reducción del **86%** en coste de inferencia respecto a APIs propietarias, superando en localización a Agentless con GPT-4o (Acc@1 Archivo 67.15%, Acc@5 Función 55.47%).

- **CodexGraph (NAACL 2025 / arXiv:2408.03910v3, agosto de 2024 / enero de 2025):**  
  *Fuente:* [arXiv:2408.03910](https://arxiv.org/abs/2408.03910) / [NAACL 2025.naacl-long.7](https://aclanthology.org/2025.naacl-long.7/).  
  *Hecho documentado:* Construye esquemas de grafos de código sobre bases de datos de grafos (Neo4j) consultadas mediante Cypher por agentes LLM. Evaluado sobre 257 instancias de SWE-bench Lite (43 instancias de SymPy fallaron durante la indexación por agotamiento de memoria):
  - Con GPT-4o alcanzó un **22.96% Pass@1** en SWE-bench Lite (empatando con AutoCodeRover en 22.96%, frente al 3.11% de BM25 puro).
  - *Estrategia de consulta medida:* La formulación de una **consulta única por ronda** (*single query*) superó a la generación de múltiples consultas (*multiple queries*) en tareas de razonamiento complejo como SWE-bench Lite (**22.96% vs 17.90% Pass@1**), debido a que múltiples consultas introducen ruido en el contexto recuperado.

- **OrcaLoca (ICML 2025 / arXiv:2502.00350, 1 de febrero de 2025):**  
  *Fuente:* [arXiv:2502.00350](https://arxiv.org/abs/2502.00350) / [PMLR v267: yu25x](https://proceedings.mlr.press/v267/yu25x.html).  
  *Hecho documentado:* Integra planificación por prioridades de acciones, descomposición con puntuación de relevancia y poda de contexto consciente de distancia. Estableció el estado del arte de código abierto en SWE-bench Lite con un **65.33% de acierto a nivel de función** (*function match rate*) y mejoró la resolución final de parches en **6.33 puntos porcentuales**.

- **MutaGReP (arXiv:2502.15872, 21 de febrero de 2025):**  
  *Fuente:* [arXiv:2502.15872](https://arxiv.org/abs/2502.15872).  
  *Hecho documentado:* Propone búsqueda de planes grounded mediante mutación de árboles y recuperación de símbolos para repositorios grandes en el benchmark LongCodeArena (LCA). Sus planes consumen **menos del 5% de la ventana de contexto de 128 k tokens** de GPT-4o, igualando el rendimiento de modelos que cargan el repositorio completo.

- **Agentless (arXiv:2407.01489, julio–octubre de 2024):**  
  *Fuente:* [arXiv:2407.01489](https://arxiv.org/abs/2407.01489).  
  *Hecho documentado:* Procedimiento jerárquico determinista en 3 fases (archivos sospechosos → elementos relacionados → líneas de edición). En SWE-bench Lite reportó:
  - Localización con Claude 3.5 Sonnet: Archivo **72.0%**, Función **58.7%**, Línea **41.7%**.
  - Localización con GPT-4o: Archivo **68.7%**, Función **51.0%**, Línea **34.3%**.
  - Resolución final: **32.00%** de problemas resueltos a un coste medio de **$0.70 por issue**.

---

## 2. Reformular la Consulta antes de Buscar (P1, P2)

### 2.1. Expansión de Consulta con Nombres Propios del Repositorio

- **Hecho documentado (Aider):** La extracción de identificadores candidatos no requiere LLM: Aider escanea el texto del prompt contra el conjunto exhaustivo de identificadores (`idents`) extraídos estáticamente por Tree-sitter durante el parseo inicial del repositorio. Si un token del issue coincide con un identificador declarado en el AST, se activa el sesgo hacia su archivo (`repomap.py:L140-L160`). Coste: **0 tokens de LLM, 0 ms de red, determinista**.
- **Hecho documentado (Literatura de recuperación en código):** Rahman y Roy (*A Systematic Review of Automated Query Reformulations in Source Code Search*, ACM TOSEM, septiembre de 2023, DOI: [10.1145/3607179](https://dl.acm.org/doi/full/10.1145/3607179)):
  - Analizaron 70 estudios primarios. Constatan que los desarrolladores **fallan hasta el 88% de las veces** en formular la consulta adecuada al buscar código; hasta el **76% de las consultas** requieren expansión para recuperar el elemento correcto.
  - *Técnicas sin LLM:* Expansión basada en Pseudo-Relevance Feedback (PRF / algoritmo de Rocchio), co-ocurrencia de identificadores en AST y filtrado de ruido. Regla léxica documentada: palabras clave que aparecen en más del **25% de los archivos** del corpus carecen de poder discriminativo y deben suprimirse de la consulta (*query reduction*).

### 2.2. HyDE (Hypothetical Document Embeddings) para Código

- **Hecho documentado (Li et al., 2024 / ReCo):** En *Rewriting the Code: A Simple Method for Large Language Model Augmented Code Search* ([arXiv:2401.04514](https://arxiv.org/html/2401.04514), enero de 2024), evaluarón la generación de fragmentos hipotéticos de código (GAR / HyDE) para acortar la brecha semántica entre lenguaje natural y código:
  - La generación de código hipotético mejora la recuperación dispersa (*sparse*) hasta en un **35.7%** y la densa hasta en un **27.6%**.
  - Sin embargo, documentan que el código generado frecuentemente sufre de desajuste de estilo sintáctico respecto a la base de código real, requiriendo normalización.
- **Hecho documentado (CodeRAG / Neverdecel, 2025):** En el informe técnico de recuperación de [CodeRAG](https://github.com/Neverdecel/CodeRAG/blob/master/docs/research/code-retrieval-strategy.md) citando evaluaciones sobre consultas ambiguas ([arXiv:2505.12694]):
  - HyDE genera degradaciones severas en consultas sobre código privado o APIs desconocidas para el modelo: **-10 puntos de NDCG@10** en consultas con identificadores no familiares y **-17 puntos de Recall@100** en alta ambigüedad.
  - Sobrecarga de latencia: **+25% a +60%** por la inferencia adicional.
  - *Regla documentada:* Bloquear HyDE taxativamente para consultas que contengan identificadores; aplicarlo única y exclusivamente a preguntas conceptuales en lenguaje natural puro ("¿dónde se gestiona la compresión de contexto?").

### 2.3. Extracción de Candidatos desde el Issue y Modelos Locales Pequeños

- **Hecho documentado (AutoCodeRover, 2024):** En [arXiv:2404.05427](https://arxiv.org/abs/2404.05427), AutoCodeRover extrae pistas léxicas (*hints*: nombres de métodos, clases y rutas) directamente del issue mediante análisis estructural de texto y llamadas iterativas a APIs AST.
- **Hecho documentado (Modelos locales pequeños para reformulación):**
  - En *Self-Supervised Query Reformulation for Code Search* (SSQR, [arXiv:2307.00267](https://arxiv.org/html/2307.00267), 2023), un modelo T5 pequeño entrenado con tareas de enmascaramiento (*Corrupted Query Completion*) sin datos supervisados mejoró el MRR entre un **9.90% y un 12.23%** en motores de búsqueda de código.
  - Para `fab` (entorno sin red), modelos SLM locales cuantizados (ej. `Qwen2.5-Coder-1.5B` o `0.5B` ejecutados en CPU local mediante llama.cpp) pueden reescribir consultas conceptuales extrayendo palabras clave del vocabulario del repositorio sin romper la restricción de red.

---

## 3. Aristas que el Análisis Estático no Ve (P3)

### 3.1. LSP y SCIP para Resolución de Tipos

- **SCIP (Sourcegraph Code Intelligence Protocol):** Protocolo basado en Protobuf ([Sourcegraph SCIP](https://github.com/sourcegraph/scip), 2022–2026) que reemplazó a LSIF. Indexadores como `scip-typescript` y `scip-python` resuelven símbolos y referencias de forma exacta mediante el compilador real (`tsc`).  
  *Limitación documentada para `fab`:* Requiere el entorno de ejecución completo del repositorio (`node_modules`, dependencias instaladas, scripts de build), lo que resulta inviable y peligroso en un sandbox sin red sobre repositorios no confiables.
- **Hybrid LSP de `codebase-memory-mcp` (v0.10.8):**  
  *Fuente:* ext/codesearch/codebase-memory-mcp/README.md (`ext/codesearch/codebase-memory-mcp/README.md:400-402,L1092-1120`).  
  *Hecho documentado:* Implementa en C puro algoritmos ligeros de resolución de tipos inspirados en `tsserver`, `pyright`, `gopls` y `rust-analyzer`, integrados directamente en el binario sin lanzar procesos daemon externos del lenguaje:
  - Resuelve encadenamiento de métodos mediante propagación de tipos de retorno, resolución de genéricos, despacho de componentes JSX, importaciones cruzadas entre módulos y `.d.ts`.
  - Emite aristas `RESOLVED_CALLS` y `CALL_REFERENCE` (manteniendo referencias ambiguas como `USAGE`).
  - Opera sobre 162 lenguajes a nivel sintáctico y 10 lenguajes con resolución semántica profunda sin ejecutar código del repositorio.

### 3.2. Resolución Heurística de Inyección de Dependencias (DI) y Dispatch Dinámico

- **Hecho documentado (`codegraph` AGENTS.md y código fuente):** En ext/codesearch/codegraph/AGENTS.md (`ext/codesearch/codegraph/AGENTS.md:159-165`) y src/resolution/frameworks/ (`ext/codesearch/codegraph/src/resolution/frameworks/python.ts:40-46`), `codegraph` incorpora sintetizadores estáticos para salvar las brechas de despacho dinámico:
  - Canales sintetizados: callbacks/observers, `EventEmitter`, re-renders de React (`setState -> render`), componentes hijos JSX (`render -> child`), puente de eventos nativos en React Native y despacho ORM de Django (`QuerySet._fetch_all -> ModelIterable.__iter__`).
  - Despacho por registro de literales de objetos (`codegraph/src/extraction/languages/`): reconoce patrones de tablas de comandos `this.commands[cmd].execute()` y enlaza la función despachadora a cada handler registrado en el mismo archivo.
  - **Principio empírico medido en `codegraph`:**  
    > *"Partial coverage is WORSE than none. Bridging one boundary but not the next reveals a hop the agent then drills + reads to finish. Measured on excalidraw: react-render alone raised reads to 5–7; only completing the flow (adding the jsx-child hop) dropped it to 0–1. Always close the flow end-to-end and re-measure."*  
    (Cita textual de `AGENTS.md:L163`).

### 3.3. Marcado de Confianza de Aristas

- **Hecho documentado (`graphicle`):** En crates/graphicle/src/graph_tools.rs (`ext/codesearch/graphicle/crates/graphicle/src/graph_tools.rs:765-772`), `graphicle` clasifica explícitamente la confianza de cada arista en tres niveles:
  1. `EXTRACTED`: arista obtenida directamente del árbol sintáctico (AST) o importación explícita (certeza estructural).
  2. `INFERRED`: arista deducida mediante heurísticas de resolución de llamadas a través de módulos o coincidencias de nombres.
  3. `AMBIGUOUS`: existen múltiples candidatos plausibles sin resolución unívoca.
- **Hecho documentado (`codegraph`):** Toda arista sintetizada se etiqueta con `provenance: 'heuristic'`, registrando además `metadata.synthesizedBy` y `registeredAt` (archivo y línea del punto de enganche).

### 3.4. Aristas Aprendidas de Trazas de Ejecución (Dynamic Call Tracing)

- **Hecho documentado (`code-graph-rag`):** En la documentación oficial de [Code-Graph-RAG: Dynamic Tracing](https://docs.code-graph-rag.com/guide/dynamic-tracing/) (Vitali Avagyan, 2025):
  - Registra llamadas reales durante la ejecución de pruebas mediante `pytest --cgr-trace` (utilizando `sys.monitoring` en Python 3.12+), agente Java (`java.lang.classfile`), Node.js (conversión de V8 `cpuprofile`), Go (`pprof`), Rust (`pprof-rs`) o perfiles continuos eBPF (OpenTelemetry/Pyroscope).
  - La herramienta `cgr trace ingest` inyecta las llamadas observadas al grafo estático anotándolas con propiedades de procedencia:
    - `dynamic: true` (arista observada en tiempo de ejecución).
    - `dynamic_call_count`: número de invocaciones observadas.
    - `dynamic_workloads`: identificadores de los tests que dispararon la llamada.
    - `static_missed: true`: flag que indica que el análisis estático **no detectó la arista** (debido a dispatch dinámico, Effect, DI, reflexión o monkey-patching).
    - `dynamic_stale: true`: flag automático cuando el código fuente de las funciones cambia en commits posteriores.
  - *Viabilidad en `fab`:* Requiere ejecutar la suite de pruebas del repositorio. En repositorios no confiables sin red, **no es viable construirlo en la fase de mapeo estático inicial**, salvo que se disponga de trazas pregrabadas o se ejecute en un runner efímero aislado tras verificar la seguridad del commit.

---

## 4. Desambiguar Nombres Ambiguos (P4)

Cuando un símbolo cuenta con múltiples definiciones (ej. 55 definiciones de `execute` en `opencode`), herramientas ingenuas fallan o eligen un candidato incorrecto.

### 4.1. Nombres Calificados y Resolución `archivo:línea`

- **Hecho documentado (`codebase-memory-mcp`):** La herramienta `resolve_symbol` y el comando `trace_path` aplican la política *fail-closed*: si un nombre es ambiguo, no adivina; responde con un listado estructurado de identificadores calificados (`qualified_name`s) con la forma `ruta/archivo.ts::Clase.metodo` o `ruta/archivo.ts:L10-L40`.
- **Hecho documentado (`code-graph-rag`):** El comando determinista `cgr graph resolve <ruta>:<línea>` toma una cita exacta de línea y resuelve el identificador unívoco dentro del grafo, evitando colisiones de nombres genéricos.

### 4.2. Filtros por Archivo o Módulo

- **Hecho documentado (`codegraph`):** Incorpora el parámetro `-f` / `--file` en `codegraph callers -f <archivo> <símbolo>`. Esto permite al agente restringir la búsqueda de llamadores a una instancia concreta del símbolo (ej. `codegraph callers -f packages/core/src/tool/runtime.ts execute`), reduciendo la respuesta de cientos de líneas a un único registro de 0.3 KB en 0.6 s.
- **Hecho documentado (`graft`):** En `graft_trace_calls` (mcp/tools.js:L259 (`graft:dist/mcp/tools.js:259-260`)), la función `resolveSymbol(w, symbol, inOpt)` acepta la opción `in: <archivo/directorio>` para acotar la resolución cuando un símbolo tiene múltiples definiciones.

### 4.3. Devolver Candidatos en lugar de Adivinar

- **Hecho documentado (`pi-cbm` y `codebase-memory-mcp`):** En [alexykn/pi-cbm](https://github.com/alexykn/pi-cbm/), las herramientas `read_symbol` y `trace_path` devuelven una advertencia y la lista de candidatos disponibles:
  > *"trace_path auto-resolves short function/method names when there is a single unambiguous match; otherwise it returns candidate qualified_names."*  
  El agente recibe la lista y puede reintentar con el `qualified_name` exacto sin perder turnos con datos erróneos.

---

## 5. Formato de la Respuesta de la Herramienta (P1, P5)

### 5.1. Firmas frente a Cuerpos: Evidencia Empírica Medida

- **Benchmark REPOEXEC (NAACL Findings 2025 / arXiv:2406.11927, junio de 2024 / marzo de 2025):**  
  *Fuente:* [arXiv:2406.11927](https://aclanthology.org/2025.findings-naacl.82/) / [REPOEXEC Dataset](https://www.alphaxiv.org/benchmarks/fpt-software-ai-center/repoexec).  
  *Hecho documentado:* Evaluó el impacto del tamaño del contexto en 18 modelos de código sobre 355 tareas reales a nivel de repositorio, comparando tres niveles de contexto:
  1. *Small context:* Solo firmas de clases y funciones (cuerpos y docstrings eliminados; **179.66 tokens** promedio por prompt).
  2. *Medium context:* Firmas + docstrings en lenguaje natural (cuerpos eliminados; **253.05 tokens** promedio).
  3. *Full context:* Cuerpos completos de funciones e implementaciones (**362.92 tokens** promedio).
  
  *Resultados medidos (Tabla 4 del paper):*
  - En tasa de invocación de dependencias (*Dependency Invocation Rate*, DIR): el contexto pequeño (*Small*) obtuvo un **DIR del 62.67%** (con CodeLlama-13B), prácticamente empatando con el contexto completo (*Full*, **DIR 62.26%**).
  - En corrección funcional (*Pass@1*): *Small context* (**35.66%**) superó significativamente a *Medium context* (**32.96%**).  
  *Hallazgo documentado:* Los autores concluyen que incluir docstrings en lenguaje natural a menudo confunde al modelo haciéndole interpretar las funciones como ejemplos *few-shot*, mientras que **entregar únicamente las firmas preserva casi el 100% de la capacidad de invocar dependencias correctas reduciendo el tamaño del contexto a la mitad**.
- **Hecho documentado (AutoCodeRover, 2024):** Confirma este principio en sus APIs (`search_class`):
  > *"Returning the signature to shorten context is a better approach than cutting off the context at a certain bound. Upon receiving the class signature, the agent could then invoke another API to search for the relevant methods / snippets inside the class."* ([arXiv:2404.05427](https://arxiv.org/html/2404.05427)).

### 5.2. Líneas de Contexto y Salidas de Búsqueda

- **Hecho documentado (SWE-agent / ACI, NeurIPS 2024):** En [arXiv:2405.15793](https://arxiv.org/abs/2405.15793) y su [documentación de ACI](https://swe-agent.com/latest/background/aci/):
  - *Visor de archivos:* Descubrieron que el visor opera de forma óptima mostrando una ventana fija de un máximo de **100 líneas** por turno con numeración de líneas e indicación explícita de cuántas líneas quedan omitidas antes y después.
  - *Búsqueda en directorios:* Al buscar cadenas en el repositorio, determinaron que la herramienta debe listar **únicamente los nombres de archivos con al menos una coincidencia**:
    > *"We found that it was important for this tool to succinctly list the matches - we simply list each file that had at least one match. Showing the model more context about each match proved to be too confusing for the model."*

### 5.3. Sintaxis de Formato: JSON vs XML vs Markdown

- **Berkeley Function Calling Leaderboard (BFCL V4, Huanzhi Mao, UC Berkeley, 2025):**  
  *Fuente:* [Gorilla BFCL V4 Blog](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html).  
  *Hecho documentado:* Evaluó variaciones sistemáticas de sintaxis en modelos frontera y abiertos:
  - *Formato de retorno:* Los modelos (especialmente modelos de 7B a 70B y familias Claude) obtienen un rendimiento significativamente superior cuando devuelven llamadas en formato **JSON o Python** frente a formatos **XML**. En modelos grandes como Claude 3.7 Sonnet y Watt-Tool-70B se registraron caídas medibles de precisión cuando se les forzó a usar sintaxis XML de respuesta.
  - *Formato de documentación de herramientas en el prompt:* El rendimiento más alto y estable se obtuvo con esquemas en **JSON**, seguido de **XML**, siendo la descripción en texto plano/Python la menos precisa.
- **gptme Architecture Benchmarks (Erik Bjäreholt, 2024–2025):**  
  *Fuente:* [gptme Docs: Tool Formats](https://gptme.org/docs/tool-formats.html).  
  *Hecho documentado:* Markdown cercado (fenced blocks) ofrece la mayor resistencia a *Context Rot* en sesiones largas con modelos de razonamiento, pero falla cuando los argumentos de la herramienta contienen a su vez bloques de código. XML es más robusto como delimitador de llamadas cuando intervienen bloques de código anidados.

### 5.4. Presupuesto de Tokens por Llamada

- **GitHub Copilot CLI:** Fija la variable `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES = 20 KiB` (~5 k tokens). Si la salida de una herramienta supera los 20 KiB, el contenido completo se desvía a un archivo temporal en disco y al prompt solo ingresa una vista previa acotada con la ruta del archivo.
- **OpenCode:** La herramienta `codesearch` parametriza `tokensNum` con un valor por defecto de **5 000 tokens** (rango permitido: 1 000 a 50 000 tokens).
- **graphicle:** Fija un presupuesto total por paquete de **32 k tokens** por MCP, asignando aproximadamente un **4%** (~1.2 k tokens) a la estructura del mapa y reservando el grueso para tramos focales.
- **Aider:** Repo map estricto de **1 024 tokens** de firmas seleccionadas por PageRank.

---

## 6. Bucle del Agente sobre el Grafo

### 6.1. Número Típico de Consultas

- **Procedural / Localización Estratificada (AutoCodeRover, CoSIL, Agentless):**
  - Requieren típicamente entre **2 y 5 consultas estructuradas** para aislar los archivos y métodos relevantes antes de pasar a la generación del parche ([arXiv:2404.05427](https://arxiv.org/abs/2404.05427); [arXiv:2503.22424](https://arxiv.org/abs/2503.22424)).
- **Agentes Abiertos / Búsqueda Agéntica Libre (SWE-agent, OpenHands, Stompy Benchmark):**
  - En tareas de resolución de issues en SWE-bench, los agentes libres promedian entre **10 y 30 turnos de exploración y ejecución** por tarea ([Stompy Memory Benchmark Report, 2025](https://www.stompy.ai/stompy-memory-benchmark-report.pdf); [SWE-agent NeurIPS 2024](https://arxiv.org/abs/2405.15793)).

### 6.2. Mecanismos de Corte (Límites de Pasos y Tokens)

- **Límites de pasos:** SWE-agent impone un corte estricto de 30 a 50 turnos (*max steps*) para abortar bucles infinitos.
- **Colapso de observaciones previas:** SWE-agent implementa un procesador de historial que **colapsa todas las observaciones de herramientas anteriores a las últimas 5 en una sola línea de resumen**. Esto previene la acumulación de miles de tokens de búsquedas obsoletas y evita el deterioro de atención (*Context Rot*).
- **Límites de saturación de ventana:** Copilot compacta automáticamente al alcanzar el **80% de la ventana de contexto** y detiene la interacción de forma preventiva al **95%**.

### 6.3. ¿Cuándo Conviene un Subagente Explorador frente a Consultar Directamente?

- **Hecho documentado (Claude Code Docs: Subagents y Prompt Caching):**  
  *Fuentes:* [Claude Code Docs: Subagents](https://code.claude.com/docs/en/sub-agents) / [Prompt Caching](https://code.claude.com/docs/en/prompt-caching) (2025–2026).
  
  **Conviene usar un Subagente Explorador (`Explore` en Claude Code, `explore` en OpenCode):**
  1. *Aislamiento del contexto principal:* La exploración genera una gran cantidad de resultados de grep, listados de directorios y lecturas exploratorias que no volverán a referenciarse durante la edición de código. El subagente ejecuta este trabajo en una ventana aislada y devuelve únicamente el resumen con las rutas y funciones clave.
  2. *Preservación de la caché de prefijo (Prompt Caching):* En modelos con tarifas reducidas por prefijo en caché (Anthropic Prompt Caching), 15 llamadas sucesivas de herramientas invalidan y modifican el prefijo del agente principal en cada turno. Delegar la exploración mantiene intacto el prefijo del agente principal.
  3. *Optimización de costes:* El subagente explorador puede configurarse para ejecutarse en un modelo rápido y económico (ej. Claude 3.5 Haiku o Qwen2.5-Coder local), reservando el modelo insignia (Sonnet/Opus) para la síntesis del cambio.

  **Conviene Consultar Directamente (sin subagente):**
  1. *Consultas dirigidas de 1 salto:* Comandos específicos como `callers symbol` o `skeleton file.ts` donde el agente principal ya conoce el identificador y solo requiere la firma o los llamadores inmediatos.
  2. *Bucles interactivos estrechos:* Cuando el resultado de la consulta determina inmediatamente la siguiente línea a editar. La sobrecarga de inicializar un subagente (latencia de prompt de delegación + síntesis de respuesta) supera el coste de tokens de una consulta directa.

---

## 7. Mantenerlo Fresco cuando Cambia el Commit

### 7.1. Técnicas de Índice Incremental

- **`codegraph` (`sync`):**  
  *Hecho documentado (Medido en `grafos.md`):* En `opencode` (8.600 archivos), el comando `init` tardó 47 s en construir el índice SQLite (295 MB). Tras modificar 1 archivo, el comando `sync` tardó únicamente **7.0 s** en total (con solo **926 ms** de indexación efectiva), re-parseando solo el archivo sucio y actualizando sus aristas en SQLite.
- **`codebase-memory-mcp`:**  
  *Hecho documentado (Medido en `grafos.md`):* Mantiene una tabla SQLite de hashes de archivo (`file_hashes`). La reindexación incremental sin cambios o con cambios mínimos tomó **5.5 s** frente a los 19.6 s de la indexación completa.
- **`Code-Graph-RAG` (`anchor_hash`):**  
  *Hecho documentado:* Calcula un hash canónico del cuerpo de cada definición AST excluyendo espacios en blanco y comentarios (`anchor_hash`). Si el hash no cambia, las aristas estáticas y dinámicas asociadas al símbolo se preservan sin recalcular.
- **Cursor:**  
  *Hecho documentado:* Emplea árboles de Merkle de hashes de archivos para sincronizar de forma incremental los cambios locales y disparar re-indexación únicamente de las ramas modificadas ([Cursor Blog: Secure Indexing](https://cursor.com/blog/secure-codebase-indexing), 2026).

### 7.2. Detección de Desfase (*Staleness / Drift Detection*)

- **Sistema Terrain (`crates/terrain-core/src/freshness/`):**  
  *Fuente:* ext/codesearch/terrain/.terrain/human/4.Deep-Exploration/freshness.md (`ext/codesearch/terrain/.terrain/human/4.Deep-Exploration/freshness.md:10-48`).  
  *Hecho documentado:* Terrain implementa un modelo de frescura desacoplado que no requiere re-escanear todo el árbol:
  1. *Cálculo O(1) vía libro mayor (`FreshnessLedger`):* Almacena el hash del commit Git de la última indexación y el estado del árbol de trabajo. La verificación de frescura comprueba si `git rev-parse HEAD` coincide y si el árbol está limpio (`git status --porcelain`). Si coincide, la respuesta es inmediata $O(1)$ desde caché.
  2. *Vectores de deriva (`drift_factors.rs`):* Si el commit ha cambiado, `git_diff_source_paths` extrae únicamente los archivos fuente modificados mediante `git diff` contra el commit base registrado.
  3. *Puntuación dual:* Evalúa independientemente `agent_freshness` (si los cambios tocan archivos empaquetados o módulos centrales del agente) y `human_freshness` (documentación). Si la puntuación cae por debajo del umbral, se alerta al agente o se dispara una actualización incremental.
- **Herramienta `graft_check_freshness` en `graft`:**  
  *Fuente:* dist/mcp/tools.js:L61,L175-L177 (`graft:dist/mcp/tools.js:61-64,L175-177`).  
  *Hecho documentado:* Expone la herramienta MCP `graft_check_freshness` que compara el estado del grafo en disco contra el código fuente del árbol de trabajo, reportando discrepancias sin ejecutar una reconstrucción automática.

---

## 8. Tabla Final de Mejoras para el Lector de `fab`

A continuación se sintetizan las mejoras analizadas, mapeadas a los problemas P1–P5, su evidencia empírica, su viabilidad en un entorno sin red ni LLM, y su coste de implementación en `fab`:

| # | Mejora | Problema que ataca | Evidencia (URL y métrica) | Viable sin red ni LLM | Coste en `fab` |
|---|---|---|---|---|---|
| **M1** | **PageRank Personalizado sembrado con identificadores del prompt** | **P5** (mapa inicial) | Aider ([repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)): multiplicador x10 en menciones, x10 en camel/snake $\ge 8$, penalización x0.1 en privados y ambiguos (>5 defs). | **Sí** (léxico + Tree-sitter sobre el AST de símbolos) | **Medio** (adaptar `dist/ask/graphrank.js` de graft para recibir identificadores semilla) |
| **M2** | **Expansión de consulta cruzando con diccionario AST local** | **P1, P2** (vocabulario) | Rahman & Roy 2023 ([ACM TOSEM](https://dl.acm.org/doi/full/10.1145/3607179)): 76% de consultas requieren expansión. Aider cruza tokens del prompt con `idents` de Tree-sitter. | **Sí** (intersección pura de conjuntos de tokens en memoria) | **Bajo** (regex de identificadores del issue cruzada contra el índice de símbolos) |
| **M3** | **Filtro de ámbito en llamadores (`callers -f <archivo>` o `in: <módulo>`)** | **P4** (ambigüedad) | `codegraph callers -f` (grafos.md §3 (`sw-factory/docs/research/arquitectura-ideacion/codesearch/grafos.md:65`)): reduce de 55 definiciones a 1 coincidencia exacta (0.3 KB vs 12 KB). | **Sí** (filtrado en grafo SQLite/memoria) | **Bajo** (graft ya dispone del parámetro `in` en `graft_trace_calls`; falta exponerlo limpiamente en CLI) |
| **M4** | **Política "Fail-Closed" con sugerencias ante nombres ambiguos** | **P4** (ambigüedad) | `codebase-memory-mcp` y `pi-cbm` ([pi-cbm](https://github.com/alexykn/pi-cbm/)): si un símbolo tiene $>1$ definición, devuelve lista de candidatos calificados (`archivo:línea`) en vez de adivinar o fallar en silencio. | **Sí** (conteo de nodos en índice) | **Bajo** (comprobar `matches.length > 1` y emitir lista de candidatos con rangos) |
| **M5** | **Salida de herramientas en formato sólo firmas (sin cuerpos ni docstrings)** | **P5, P1** (presupuesto) | REPOEXEC ([arXiv:2406.11927](https://aclanthology.org/2025.findings-naacl.82/)): solo firmas obtuvo DIR 62.67% (vs 62.26% full) y Pass@1 35.66% (vs 32.96% con docstrings), ahorrando ~50% tokens. | **Sí** (extracción AST con Tree-sitter) | **Bajo** (`graft skeleton` ya emite firmas; asegurar flag `--signatures-only`) |
| **M6** | **Tope estricto de salida por llamada con desvío a archivo si > 20 KiB** | **P5** (presupuesto) | GitHub Copilot CLI (web-contexto §2 (`sw-factory/docs/research/arquitectura-ideacion/codesearch/web-contexto.md:27`)): umbral 20 KiB; SWE-agent ([arXiv:2405.15793](https://arxiv.org/abs/2405.15793)): visor de max 100 líneas. | **Sí** (buffer en memoria / disco) | **Bajo** (truncar o escribir a archivo temporal en harness) |
| **M7** | **Sintetizadores estáticos de despacho dinámico (callbacks, registros)** | **P3** (aristas perdidas) | `codegraph` (AGENTS.md:L163 (`ext/codesearch/codegraph/AGENTS.md:163`)): cerrar el flujo completo redujo lecturas de archivo de 5–7 a 0–1 en Excalidraw. Aristas marcadas como `INFERRED` / `heuristic`. | **Sí** (reglas de AST sobre patrones de registros de comandos y callbacks) | **Alto** (requiere analizadores específicos por framework/patrón en Tree-sitter) |
| **M8** | **Comprobación de frescura O(1) basada en Git HEAD y diff incremental** | **Mantenimiento** | Terrain (freshness.md (`ext/codesearch/terrain/.terrain/human/4.Deep-Exploration/freshness.md:10`)): validación inmediata `git rev-parse HEAD`; `codegraph sync`: 7 s incremental vs 47 s completo. | **Sí** (comandos `git rev-parse` y `git diff --name-only`) | **Bajo** (guardar commit hash en metadatos del índice y comparar antes de cada consulta) |
| **M9** | **Subagente explorador aislado para navegación multi-salto** | **P1, P5** (context rot) | Claude Code Docs ([sub-agents](https://code.claude.com/docs/en/sub-agents)): aísla ruidos de exploración, preserva la caché de prefijo y reduce el context rot en tareas complejas. | **No** (requiere LLM / agente orquestador) | **Medio** (integrar subagente explorador en el harness de `fab`) |
| **M10** | **Reescritura de consultas conceptuales mediante SLM local cuantizado** | **P2** (consultas conceptuales) | SSQR ([arXiv:2307.00267](https://arxiv.org/html/2307.00267)): +9.9% a +12.2% MRR con modelo T5 local; LocAgent ([arXiv:2503.09089](https://arxiv.org/abs/2503.09089)): Qwen2.5-Coder-32B local alcanza 75.9% en Acc@1. | **Con modelo local** (ej. Qwen2.5-Coder-1.5B en CPU con llama.cpp en sandbox) | **Alto** (integrar runtime de inferencia local offline en el sandbox de fab) |
| **M11** | **Trazas de ejecución dinámicas integradas en el grafo** | **P3** (aristas perdidas) | `code-graph-rag` ([dynamic-tracing](https://docs.code-graph-rag.com/guide/dynamic-tracing/)): detecta llamadas perdidas por reflexión y Effect (`static_missed: true`). | **No en sandbox de mapeo** (requiere ejecutar la suite de pruebas del repo) | **Inviable para mapeo estático seguro**; solo viable si se suministran trazas previas |

---

## 9. Lo No Encontrado

1. **Evidencia empírica medida de HyDE para código fuente privado:** No existen benchmarks públicos que demuestren que generar código hipotético mejore la localización en repositorios privados con nombres propios específicos; por el contrario, la evidencia documentada ([arXiv:2505.12694]) indica que degrada la recuperación en APIs no vistas en pre-entrenamiento (-10 NDCG@10).
2. **Resolución de tipos de Effect (`Effect.fn`, `yield*`) en herramientas estáticas existentes:** Ninguna herramienta de código abierto analizada (`graft`, `codegraph`, `codebase-memory-mcp`, `code-graph-rag`) posee reglas de AST específicas para desentrañar el despacho monádico de Effect en TypeScript de forma nativa sin ejecutar el código.
3. **Presupuesto exacto de tokens por consulta en Devin:** Cognition no ha publicado métricas numéricas oficiales sobre el tope de tokens de las herramientas de búsqueda interna de Devin.
