# Investigación Web: Cómo seleccionan contexto de código los agentes de referencia en repositorios grandes (≥ 500k líneas)

**Fecha de elaboración:** 1 de noviembre de 2026  
**Contexto:** Complemento a la investigación técnica local de `fab` sobre herramientas de codesearch (`ARQUITECTURA.md`, `codesearch/README.md`).  
**Herramienta de recolección:** Agent-Reach (Exa semantic search vía mcporter, Jina Reader, GitHub, HN, Reddit).

---

## 1. Hipótesis evaluada y planteamiento

En un repositorio grande (≥ 500 k líneas de código), ningún agente de codificación moderno carga el árbol ni el código completo en la ventana de contexto. La hipótesis planteada es:
> *El mapa estructural sirve para **ubicar** la sección exacta del repositorio, y posteriormente se emplea un mecanismo de búsqueda de código (codesearch léxico, semántico o agéntico) para transferir al modelo **únicamente el tramo relevante**.*

La evidencia recopilada en productos y publicaciones de ingeniería confirma plenamente esta hipótesis: la industria ha convergido en patrones de **recuperación jerárquica en dos o tres niveles** ("mapa estructural / esqueleto" → "búsqueda dirigida" → "lectura acotada de tramos"), abandonando masivamente el volcado plano de repositorios y superando las limitaciones del RAG vectorial ingenuo.

---

## 2. Tabla comparativa por producto

| Producto | Mecanismo (Índice/Grafo vs Búsqueda Agéntica) | Qué entra al prompt | Presupuesto de tokens / Ventana | Fuente URL y Fecha |
|---|---|---|---|---|
| **Claude Code** (Anthropic) | **Búsqueda agéntica bajo demanda**. Sin índice vectorial ni RAG persistente en disco. Usa bucles agénticos con `GlobTool`, `GrepTool` (ripgrep/ugrep/bfs) y `FileReadTool`, más servidor LSP bajo demanda. | `CLAUDE.md` jerárquicos (raíz y subdirectorios), system prompt, rutas y líneas relativas de grep/glob, y tramos de archivos leídos selectivamente. | Ventana estándar (200k tokens). Compactación automática en segundo plano al llegar al umbral de saturación (~80%). | [Hacker News #43164089](https://news.ycombinator.com/item?id=43164089) (Boris Cherny, 2025-02-24); [Semlith Docs](https://semlith.com/docs/guides/claude-code-grep-vs-semantic-search) (2026); [Claude Code Docs](https://code.claude.com/docs/en/context-window) (2026). |
| **Codex CLI** (OpenAI) | **Búsqueda agéntica bajo demanda**. Emplea `rg` y `rg --files` / `glob_file_search` con llamadas paralelas (`multi_tool_use.parallel`), `read_file` y `list_dir`. No incluye índice vectorial nativo por defecto en CLI. | Instrucciones de sistema, salidas de ripgrep (rutas y líneas con prefijo `Lxxx:`), lotes paralelos de tramos de archivo leídos. | Ventana del modelo subyacente (ej. 128k–200k tokens). No hay presupuesto estático para mapa. | [OpenAI Cookbook: Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) (2025); [GitHub Issue openai/codex#5181](https://github.com/openai/codex/issues/5181) (2025). |
| **Cursor** | **Híbrido (Índice semántico + grep)**. Entrena modelos de embeddings propios sobre trazas de agentes. Sincronización incremental con árboles de Merkle. Búsqueda semántica combinada con ripgrep y reordenamiento (*reranking*). | Chunks sintácticos derivados del AST, filtrados por reranker tras búsqueda semántica; archivos y símbolos `@file`, `@codebase`. | Presupuesto configurable según modelo (ventana de 200k). Los chunks recuperados por búsqueda semántica se acotan antes de inyectarse. | [Cursor Blog: Semantic Search](https://cursor.com/blog/semsearch) (Stefan Heule et al., 2025-11-06); [Cursor Blog: Secure Indexing](https://cursor.com/blog/secure-codebase-indexing) (Jeremy Stribling, 2026-01-27). |
| **Aider** | **Grafo de dependencias con PageRank**. Extrae definiciones y referencias con Tree-sitter (`py-tree-sitter-languages`). Construye un multidigrafo ponderado (`networkx.pagerank`) ponderando x10 menciones en chat y x50 archivos activos. | *Repo map* esquelético: firmas de funciones, clases, métodos y tipos relevantes ordenados por PageRank. Sin cuerpos de función. | **1 024 tokens por defecto** (`--map-tokens 1024`). Se duplica automáticamente a 2 048 tokens si no hay archivos en el chat (`--map-multiplier-no-files 2`). | [Aider Blog: Repository Map with Tree Sitter](https://aider.chat/2023/10/22/repomap.html) (Paul Gauthier, 2023-10-22); [Aider Source repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) (2024-2025). |
| **Sourcegraph Cody / Amp** | **Cody: 2 etapas (Zoekt + Code Graph SCIP + BM25)**. Dejó embeddings en Feb 2024 por latencia y frescura. **Amp: Orbs aislados + cross-thread memory**. | Cody: Snippets ordenados por ranker puntual de relevancia. Amp: System prompt, `@archivos`, y fragmentos sintéticos extraídos con `read_thread` mediante un segundo modelo. | Cody: Presupuesto estricto de tokens por política administrativa y SLAs de latencia. Amp: Gestión por hilo (*thread*), con comando `/handoff` para depurar contexto. | [Sourcegraph Blog: How Cody Understands Codebase](https://sourcegraph.com/blog/how-cody-understands-your-codebase) (2024-02-15); [Sourcegraph Blog: Designing a Context Engine](https://sourcegraph.com/blog/designing-a-context-engine-for-code) (2024-11-12); [Amp Context Management](https://ampcode.com/guides/context-management) (2025-2026). |
| **GitHub Copilot** (Agente / @workspace) | **Híbrido de 3 capas**. (1) Búsqueda semántica en Knowledge Graph (Blackbird con embeddings InfoNCE/Matryoshka); (2) Búsqueda léxica local; (3) Inteligencia de lenguaje VS Code (LSP). | Snippets clasificados, recortados (*sliced*) y resumidos. Si una herramienta devuelve > 20 KiB, se guarda a disco temporal y el prompt solo recibe preview y ruta. | Compactación automática al alcanzar ~80% de ventana; pausa de seguridad al ~95%. Umbral `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` = 20 KiB por defecto. | [GitHub Docs: Context Management](https://docs.github.com/en/copilot/concepts/prompting-and-context/context-management) (2025); [GitHub Blog: New Embedding Model](https://github.blog/news-insights/product-news/copilot-new-embedding-model-vs-code/) (Shengyu Fu, 2025-09-24). |
| **Augment Code** | **Context Engine en tiempo real**. Modelos propios de embeddings alojados en Google Cloud (PubSub, BigTable, AI Hypercomputer) con Approximate Nearest Neighbor (ANN) acelerado por cuantización de vectores. Proof-of-possession criptográfico. | Rutas de relaciones cruzadas entre microservicios/componentes, firmas e interfaces necesarias para el cambio; lectura de archivos completos delegada a MCP. | No publicado el valor numérico en tokens ("no encontrado"). Arquitectura diseñada para entregar el mínimo slice semántico necesario sin gastar turnos exploratorios. | [Augment Blog: Real-time index](https://www.augmentcode.com/blog/a-real-time-index-for-your-codebase-secure-personal-scalable) (Dirk Meister, Markus Rabe, 2025-01-01); [Augment Docs: Context Connectors](https://docs.augmentcode.com/context-services/context-connectors/how-it-works) (2025). |
| **Devin / DeepWiki** (Cognition) | **RAG optimizado ("M-Query") + Wiki estructurada**. Devin indexa el repo y crea wikis automáticas (`.devin/wiki.json`). (sopaco/deepwiki-rs es un proyecto **independiente** que toma el nombre de DeepWiki; no es la implementación de Cognition.) | Diagramas de arquitectura, dossiers de directorios, resúmenes de módulos clave y fragmentos devueltos por búsqueda semántica; soporte para fijar (*pin*) archivos. | No publicado el tope en Devin Core ("no encontrado"). En `deepwiki-rs`, DataFormatter aplica recorte de emergencia (*emergency truncation*) si se supera el presupuesto del LLM. | [Devin Docs: DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki) (2025); [Cognition Blog: DeepWiki](https://cognition.com/blog/deepwiki) (2025-05-05); [GitHub sopaco/deepwiki-rs](https://github.com/sopaco/deepwiki-rs) (2025-2026). |
| **Windsurf** (Codeium) | **Cascade: Inferencia distribuida vs Embeddings**. Rechaza la similitud de embeddings pura. Parsea con AST en bloques funcionales y calcula relevancia con LLMs en paralelo sobre cientos de GPUs en tiempo de inferencia (4x precisión). Búsqueda híbrida (densa + BM25 dispersa). | Bloques sintácticos completos (funciones o clases enteras, nunca tramos de líneas arbitrarias rotas) obtenidos de una caché local de 100s–1000s de entidades recientes. | Presupuesto dinámico por modelo; caché en memoria de 100s a 1000s de entidades candidatas reordenadas sincrónicamente en milisegundos. | [NVIDIA GTC 2025 Session S71317](https://www.nvidia.com/en-us/on-demand/session/gtc25-S71317/) (Codeium / Windsurf, 2025); [Reddit r/Codeium: Context Retrieval Thread](https://www.reddit.com/r/Codeium/comments/1jactfd/context_retrieval_thread/) (2025-03-13). |
| **OpenCode** (Anomaly Innovations / SST) | **Búsqueda agéntica reactiva delegada**. Agente principal delega la exploración al subagente `explore` (read-only: `glob`, `grep`, `read`, `lsp`). Herramienta `codesearch` externa conectada a Exa vía MCP. | Rutas de archivos descubiertas, resultados de expresiones regulares y bloques leídos bajo demanda. Para búsquedas web/docs, snippets de Exa. | Herramienta `codesearch`: parámetro `tokensNum` configurable de **1 000 a 50 000 tokens** (por defecto **5 000 tokens**). Subagente `compaction` para resumir sesiones saturadas. | [GitHub sst/opencode: codesearch.ts](https://github.com/sst/opencode/blob/b2baddcd/packages/opencode/src/tool/codesearch.ts) (2025); [OpenCode Docs: Agents](https://opencode.ai/docs/agents/) (2025-2026). |

---

## 3. Evidencia comparativa: RAG / Embeddings frente a Búsqueda Agéntica

### 3.1. Por qué Claude Code abandonó el RAG tradicional
En los inicios de Claude Code, el equipo de Anthropic experimentó con RAG local apoyado en bases vectoriales. Sin embargo, lo descartaron deliberadamente en favor de la búsqueda agéntica directa sobre el sistema de archivos:
- **Hecho documentado:** Boris Cherny (creador de Claude Code) declaró públicamente:
  > *"Right -- Claude Code doesn't use RAG currently. In our testing we found that agentic search out-performed RAG for the kinds of things people use Code for."*  
  — **Fuente:** [Hacker News comment #43164253](https://news.ycombinator.com/item?id=43164089#43164253), 2025-02-24.
- **Motivos técnicos documentados:**
  1. *Desactualización del índice (Index drift):* Un repositorio vivo cambia constantemente. Un índice vectorial puede quedar desfasado con cada commit o cambio local, provocando que el modelo cite funciones ya renombradas o archivos borrados.
  2. *Sobrecarga de infraestructura y privacidad:* Requiere almacenar y sincronizar vectores localmente o enviarlos a APIs de terceros.
  3. *Precisión léxica y de navegación:* Cuando un desarrollador o agente busca un símbolo exacto (`executeTool`, `permission.assert`), ripgrep/grep resuelve la ocurrencia exacta en ~60 ms sin falsos positivos semánticos.

### 3.2. La perspectiva de Cursor: Búsqueda Semántica como complemento necesario a grep
Cursor sostiene la postura complementaria: en bases de código grandes, la búsqueda por palabras clave no basta si la consulta del usuario se formula en lenguaje natural conceptual ("¿dónde gestionamos la autenticación de usuarios?").
- **Hecho documentado:** Cursor evaluó empíricamente el impacto de dotar a su agente de búsqueda semántica entrenada sobre trazas reales:
  > Logró en promedio un **12.5% más de precisión** en respuestas (entre 6.5% y 23.5% según el modelo), menor número de iteraciones para resolver tareas y mayor tasa de código retenido en producción.
  > Subrayan taxativamente: *semantic search no sustituye a grep; el mejor rendimiento se obtiene usando ambos* (búsqueda semántica para localizar el área general cuando no se conocen los identificadores exactos, y grep/LSP para navegar referencias exactas).  
  — **Fuente:** [Cursor Blog: Improving agent with semantic search](https://cursor.com/blog/semsearch) (Stefan Heule, Emily Jia, Naman Jain, 2025-11-06).

### 3.3. Windsurf / Codeium: El límite de los embeddings y el paso a inferencia distribuida
Codeium sostiene que los embeddings vectoriales clásicos fallan en tareas agénticas de código porque colapsan la estructura relacional y sufren con la "rareza de entidades" (*entity rarity*).
- **Hecho documentado:** En su presentación técnica en NVIDIA GTC 2025 (*Session S71317*), Codeium demostró que pasar de embeddings estáticos a **análisis sintáctico AST + evaluación de relevancia con LLMs en paralelo sobre cientos de GPUs en tiempo de inferencia** multiplicó por 4 la precisión de recuperación respecto a modelos de embeddings del estado del arte.
- Emplean recuperación híbrida (densa + dispersa) asegurando que los trozos de código recuperados respeten siempre las fronteras de clases o funciones, evitando cortes arbitrarios de líneas.  
  — **Fuente:** [NVIDIA GTC 2025: Embeddings are Limiting AI Agents](https://www.nvidia.com/en-us/on-demand/session/gtc25-S71317/) (2025); [Reddit r/Codeium: Context Retrieval Thread](https://www.reddit.com/r/Codeium/comments/1jactfd/context_retrieval_thread/) (2025-03-13).

### 3.4. Evidencia académica y Benchmarks (SWE-bench / CodeRAG)
- **Kovrigin et al. (JetBrains Research / HSE, 2024):** En el artículo *"On The Importance of Reasoning for Context Retrieval in Repository-Level Code Editing"*, los autores demuestran que en tareas a nivel de repositorio como SWE-bench, los sistemas RAG convencionales basados en BM25 o similitud vectorial fracasan rotundamente al no poder razonar sobre el flujo de dependencias. Suministrar el contexto real exacto frente a un RAG simple supuso un incremento del **144.9% en problemas resueltos** con Claude 2 (**no verificado**: la cifra no aparece en el resumen de arXiv; habría que confirmarla en el cuerpo del paper). Concluyen que la navegación iterativa con herramientas (agéntica) y grafos de llamadas es imprescindible para editar código real.  
  — **Fuente:** [arXiv:2406.04464](https://doi.org/10.48550/arxiv.2406.04464) (2024-06-06).
- **Anthropic Research: Context Engineering vs Prompt Engineering:**
  Anthropic formaliza el concepto de *Context Engineering* como la disciplina de suministrar y preservar el conjunto óptimo de tokens de alta señal en inferencia, en contraposición a "volcar todo el contexto previo".
  - Alertan sobre el **"Context Rot"** (deterioro de contexto): la degradación progresiva de la capacidad de razonamiento del LLM a medida que la ventana se satura de tokens irrelevantes, estáticos o de baja señal.
  - Abogan por la recuperación *Just-in-Time* (JIT): mantener identificadores ligeros (rutas, cabeceras) y cargar los tramos exactos bajo demanda con herramientas.  
  — **Fuente:** [Anthropic Research: Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) (2025-09-29).

---

## 4. El Patrón "Mapa → Ubicar → Recuperar lo justo"

### 4.1. Fases del patrón documentadas en la industria
Diversos proyectos y motores documentan este flujo exacto en sus especificaciones:

1. **Caso `deepwiki-rs` (Litho / Sopaco):**
   Pipeline de 5 fases en su preprocesamiento. **No es determinista:** las fichas de directorio y su puntuación las genera un LLM (`src/generator/preprocess/mod.rs:68`, `agents/directory_scoring.rs:45`). La "memoria" es un `HashMap` del proceso (`src/memory/mod.rs`), no persiste entre tareas. Corrección del orquestador.
   - **Fase 1 (Escaneo y descubrimiento):** `Code Scanning & Discovery` (recorrido de archivos respetando ignore).
   - **Fase 2 (Análisis sintáctico AST):** `Multi-Language Syntax Analysis` (extracción de nodos clave con parsers de lenguaje).
   - **Fase 3 (Extracción de estructura y dependencias):** `Structure & Dependency Extraction` (grafo de relaciones y jerarquía de directorios).
   - **Fase 4 (Generación de Code Insights):** `Code Insight Generation` y generación de *Directory Dossiers*.
   - **Fase 5 (Inicialización de chunks en memoria):** `Agent Memory Chunk Initialization` (almacenamiento estructurado en `context.store_to_memory` para consulta de los agentes ReAct).  
   — **Fuente:** [sopaco/deepwiki-rs README y source mod.rs](https://github.com/sopaco/deepwiki-rs/blob/main/src/generator/preprocess/mod.rs) (2025).

2. **Caso Aider (Repo-map dinámico):**
   - **Fase 1:** Análisis de AST mediante Tree-sitter para recolectar definiciones y referencias en todo el repo.
   - **Fase 2:** Construcción del grafo de dependencias entre archivos y ejecución de PageRank sesgado por los archivos abiertos y los términos del prompt.
   - **Fase 3:** Generación de un esqueleto sintáctico ordenado por importancia que rellena el presupuesto exacto asignado (1 024 tokens).
   - **Fase 4:** El LLM inspecciona las firmas y, si requiere implementar, emite la orden de abrir el archivo completo (`/add`).  
   — **Fuente:** [Aider Blog: Building a better repository map](https://aider.chat/2023/10/22/repomap.html) (2023-10-22).

3. **Caso Sourcegraph Cody:**
   - **Fase 1 (Recuperación / Recall):** Múltiples fuentes en paralelo (Zoekt trigram, Code Graph SCIP, Symf local) devuelven miles de candidatos potenciales.
   - **Fase 2 (Ranking / Precision):** Modelo clasificador puntual filtra y selecciona solo los fragmentos que caben en el presupuesto de tokens asignado.  
   — **Fuente:** [Sourcegraph: Designing a Context Engine for Code](https://sourcegraph.com/blog/designing-a-context-engine-for-code) (2024-11-12).

### 4.2. Tamaño típico del contexto final entregado al LLM
> **Corrección del orquestador (2026-11-01):** la versión original de esta sección daba rangos (2–8 k tokens de tramos, 15–30 k de archivos y una "regla empírica" del 10–20 % de la ventana) **sin fuente**. Se eliminaron. Solo quedan cifras con fuente o medidas:

- **Aider:** mapa de 1 024 tokens; se multiplica por 2 si no hay archivos en el chat (`--map-multiplier-no-files`, default 2, `aider/args.py:263`). En `args.py` el flag `--map-tokens` tiene `default=None`; el valor efectivo de 1 k sale de la documentación de Aider.
- **OpenCode `codesearch`:** `tokensNum` 1 000–50 000, default 5 000, según el commit `b2baddcd` citado. Ese archivo **ya no existe** en el clon local (`79469efc`).
- **GitHub Copilot:** la salida de una herramienta de más de 20 KiB va a disco; compacta al 80 % y se detiene al 95 % (verificado en la página de docs citada).
- **graft (medido en `grafos.md`):** de 1,2 a 2 k tokens por `ask`; `skeleton` ~1,7 k en un archivo grande.
- **graphicle (código local):** paquete por MCP de 32 k tokens por defecto (`code_pack.rs:57`); hook de prompt de 8 400 caracteres; reparto por secciones (mapa ~4 %, ver `README.md` de esta carpeta).
- **Terrain (código local):** `context.md` del agente de ≤ 14 000 caracteres (`agent_context.rs:245`), unos 3,5 k tokens.

---

## 5. Memoria del agente sobre código entre tareas

### 5.1. Herramientas existentes
- **Letta Code (antes MemGPT):** Agente de codificación con memoria persistente en bloques editables en el contexto (`/init`, `/remember`), archivo vectorial secundario y aprendizaje de habilidades (*skill learning*) acumuladas tras resolver tareas.  
  — **Fuente:** [Letta Code Blog](https://www.letta.com/blog/letta-code/) (2025-12-16).
- **Zep / Graphiti:** Memoria episódica basada en grafo de conocimiento temporal con nodos de entidades y relaciones válidas en el tiempo.  
  — **Fuente:** [Zep / Graphiti Docs](https://infranodus.com/docs/llm-memory-tools-comparison) (2025-2026).
- **Mem0:** Extracción de hechos y preferencias con almacenamiento a nivel de usuario, sesión y agente mediante vector store + BM25 + Graph Memory.

### 5.2. ¿Se usa para no re-explorar el repositorio? ¿Funciona?
Existe evidencia empírica directa y rigurosa en el informe de evaluación controlada de **Stompy** (2025):
- **Hecho documentado:** Stompy evaluó el uso de memoria persistente de repositorio (vía MCP) frente a contexto estático y sin memoria en una base de código de producción Python/FastAPI:
  1. **La memoria NO mejora la calidad final del código:** Las tres condiciones alcanzaron el mismo techo de calidad funcional (**84%–96%**). La corrección la determina la capacidad intrínseca del modelo, no la memoria.
  2. **La memoria SÍ reduce drásticamente la sobrecarga de exploración (*exploration overhead*):** En tareas complejas y transversales que requerían conocer la arquitectura general, el agente con memoria persistente requirió entre un **28% y un 40% menos de turnos** y completó las tareas con un coste entre un **22% y un 32% menor**, al no tener que redescubrir convenciones ni dependencias ya mapeadas.
  3. **Existe un umbral de complejidad:** En tareas simples o bien acotadas, la memoria persistente fue **puro overhead innecesario** (mayor latencia y consumo de tokens en consultas). La memoria solo compensa su coste cuando el repositorio y la tarea presentan alta complejidad arquitectónica.  
  — **Fuente:** [Stompy AI: Does AI Memory Actually Work for Coding Agents? Memory Benchmark Report](https://www.stompy.ai/stompy-memory-benchmark-report.pdf) (2025).

---

## 6. Riesgos documentados

### 6.1. Índice desactualizado (*Stale Index / Drift*)
- Si el índice de embeddings o grafo no se invalida en tiempo real tras modificaciones de archivos locales o cambios de rama (`git checkout`), el agente recupera fragmentos que ya no existen o nombres antiguos de variables y funciones.
- Boris Cherny señaló este riesgo como uno de los motivos principales para prescindir de RAG en Claude Code ([HN #43164089](https://news.ycombinator.com/item?id=43164089)).
- Augment Code y Cursor han tenido que diseñar infraestructuras complejas con árboles de Merkle y colas en GPU para mitigar el desfase temporal entre ramas ([Augment Blog](https://www.augmentcode.com/blog/a-real-time-index-for-your-codebase-secure-personal-scalable); [Cursor Blog](https://cursor.com/blog/secure-codebase-indexing)).

### 6.2. Inyección indirecta de prompts por contenido del repositorio (*Indirect Prompt Injection*)
- **Hecho documentado:** Cuando un agente lee archivos de código, issues de GitHub, mensajes de commit, PRs, dependencias o archivos de configuración (`CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `AGENTS.md`), un atacante externo puede incluir instrucciones ocultas que el LLM acata como si fueran del sistema.
- En pruebas de seguridad de GitHub y NVIDIA (Black Hat 2025), se demostró cómo un issue o comentario malicioso puede forzar al agente a ejecutar comandos de terminal (`curl | bash`), exfiltrar variables de entorno (`.env`) o alterar los pipelines de CI/CD.
- OWASP incluye este vector como una de las principales amenazas en asistentes de desarrollo.  
  — **Fuentes:** [OWASP Secure Coding with AI Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html); [GitHub Security Blog: Safeguarding VS Code against prompt injections](https://github.blog/security/vulnerability-research/safeguarding-vs-code-against-prompt-injections/) (Michael Stepankin, 2025-08-25); [NVIDIA Technical Blog: Exploiting Agentic AI Developer Tools](https://developer.nvidia.com/blog/from-assistant-to-adversary-exploiting-agentic-ai-developer-tools/) (Becca Lynch, 2025-10-09).

### 6.3. Pérdida de contexto en la ventana (*Lost in the Middle* y *Context Rot*)
- **Hecho documentado:** El estudio canónico de Liu et al. (*Lost in the Middle: How Language Models Use Long Contexts*, arXiv:2307.03172) demostró que el rendimiento de los LLMs cae notablemente cuando la información clave se encuentra en el medio de un contexto extenso, en lugar de al principio o al final.
- Anthropic formalizó además el fenómeno de **Context Rot**: a medida que la ventana se llena de tokens irrelevantes resultantes de búsquedas exhaustivas o volcados masivos, la atención del modelo se dispersa, produciendo alucinaciones y degradación del razonamiento ([Anthropic Research, 2025](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)).

### 6.4. Costes y latencia acumulada
- En agentes que realizan múltiples turnos (10 a 30 turnos por tarea), mantener un contexto inflado (ej. 150k tokens en cada paso) dispara el gasto de inferencia de forma lineal por turno y cuadrática en tiempo de atención en proveedores que no aplican prefijos de caché estrictos.
- Herramientas como GitHub Copilot imponen límites estrictos como `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` (20 KiB) y compactación al 80% para evitar el colapso presupuestario y de latencia.

---

## 7. Separación explícita: Hechos documentados vs. Opiniones o rumores

### Hechos documentados (Docs oficiales, código fuente o papers)
1. **Claude Code** no utiliza RAG vectorial ni bases de datos de embeddings; su núcleo de navegación se basa en ugrep/ripgrep, bfs y herramientas dedicadas (`GlobTool`, `GrepTool`, `FileReadTool`) sobre el sistema de archivos vivo (Boris Cherny en HN; Semlith; Claude Code Docs).
2. **Aider** calcula su *repo map* utilizando un grafo de dependencias procesado con `networkx.pagerank`, limitando por defecto el esqueleto sintáctico a 1 024 tokens (código abierto en `aider/repomap.py` y blog de Octubre 2023).
3. **Cursor** demostró que la búsqueda semántica basada en embeddings personalizados mejora un 12.5% la precisión de respuestas, pero funciona como complemento indispensable de grep, no como sustituto (Blog oficial de ingeniería de Cursor, Nov 2025).
4. **Sourcegraph Cody** retiró los embeddings como columna vertebral de Cody Enterprise en Febrero de 2024 para basar su recuperación en Zoekt (trigramas) y Code Graph (SCIP/LSIF) debido a latencia y costes (Blog oficial de Sourcegraph).
5. **Codeium / Windsurf** demostró que los embeddings fallan con entidades raras y relaciones complejas de código, sustituyendo el espacio vectorial por AST parsing y evaluación paralela en inferencia mediante LLMs sobre GPUs (NVIDIA GTC 2025).
6. **Stompy** publicó el primer benchmark controlado de memoria persistente en un repo de producción, demostrando que la memoria reduce entre 28% y 40% los turnos de exploración pero no eleva la calidad intrínseca del código (Reporte Stompy, 2025).
7. La inyección indirecta de prompts a través de archivos del repo, issues y PRs es una vulnerabilidad probada capaz de lograr ejecución de comandos en agentes con permisos automáticos (GitHub Security, NVIDIA, OWASP).

### Opiniones o rumores (Hilos de debate en Reddit, Twitter/X y foros)
1. **Debate sobre la superioridad absoluta de Windsurf vs Cursor:** En foros (`r/Codeium`, Twitter/X), usuarios afirman que el motor de contexto de Windsurf (Cascade) "entiende el repositorio mucho mejor que Cursor". No existen benchmarks públicos independientes estandarizados (como SWE-bench verificado a ciegas con el mismo modelo base) que aíslen el efecto del recuperador entre ambos productos.
2. **Rumor sobre el "fin total del RAG" en desarrollo de software:** A raíz de los comentarios de Anthropic sobre Claude Code, en redes sociales se popularizó la afirmación de que "el RAG ha muerto en agentes de código". La evidencia empírica (Cursor, Codeium, Augment, JetBrains) contradice este rumor: lo que ha muerto es el RAG *ingenuo* (troceado plano por líneas y similitud coseno sobre embeddings genéricos de texto); los índices semánticos enriquecidos con AST y grafos siguen siendo fundamentales en repositorios masivos donde el usuario formula preguntas conceptuales.

---

## 8. Lo que no se pudo confirmar ("No encontrado")

1. **Presupuesto exacto de tokens del mapa en Devin / Augment Code:** Aunque ambas compañías describen extensamente su arquitectura de "Context Engine" y "DeepWiki", ninguna publica la cifra exacta fija en tokens que asignan al mapa estructural en el prompt del sistema (*"no encontrado"*). Sus sistemas operan con presupuestos dinámicos propietarios gestionados por sus respectivos backends en la nube.
2. **Impacto cuantitativo de la memoria de Letta Code en SWE-bench:** Letta publicó métricas de persistencia en TerminalBench, pero no se encontró un desglose público que aísle el ahorro de tokens exclusivamente derivado del módulo de memoria en tareas completas de SWE-bench (*"no encontrado"*).
