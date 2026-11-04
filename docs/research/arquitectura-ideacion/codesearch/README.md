# Búsqueda en repos grandes: síntesis para el perfil de Probe "repo grande"

Fecha: 2026-11-01. Repo de prueba: `ext/opencode` @ `79469efc` (8 642 archivos, unas 920 k líneas). Las pruebas fueron las mismas cinco tareas (T1–T5) con graft como línea base. Herramientas clonadas e indexadas con graft en `~/Desktop/factory/ext/codesearch/`.

- [grafos.md](grafos.md) (Sonnet): code-graph-rag, codegraph y codebase-memory-mcp.
- [busqueda.md](busqueda.md) (agy): xerj, semble y tgrep, más `rg`.

Auditoría del orquestador: cotejé contra el fuente de opencode las afirmaciones en que los informes se contradecían. La primera versión de `busqueda.md` traía filas de xerj estimadas, no medidas; se corrigió y xerj se ejecutó de verdad con el binario de la release. Las dos ubicaciones de `executeTool` (`session/runner/step.ts:91` y `tool.ts:115`) y el recuento de T3 se verificaron con `rg`.

## Veredicto

| Herramienta | Decisión | Motivo principal |
|---|---|---|
| graft | **Se mantiene como base** | Es la única que reúne `skeleton` (T5), `callers` y ranking con grafo, offline, sin daemon y con cita de línea |
| rg | **Se mantiene para búsquedas exhaustivas** | `graft grep` solo cubre código indexado: 39 de 55 ocurrencias de `permission.asked`. `rg` tarda unos 60 ms sobre 920 k líneas, así que no hace falta acelerarlo |
| codegraph | Complemento **diferido** | Acertó T1 (`context`) y desambigua aristas por archivo (`callers -f`). Solo se añadiría si en Probes reales `graft callers` falla por nombres ambiguos |
| tgrep | Descartar | Es 6–7 veces más rápido que `rg` (9 frente a 61 ms), pero esa ganancia no importa al lector. Sería un índice más que mantener |
| semble | Descartar como dependencia | Es la única con búsqueda semántica offline real (acertó T1), pero falló en T3 y T5 y necesita que el modelo esté ya descargado en caché |
| codebase-memory-mcp | Descartar por ahora | Su índice es el más rápido (14–20 s), pero en T3 encontró solo una fracción de las ocurrencias y no acertó T4. Con `/` montado solo lectura no arranca, porque su daemon usa un directorio fijo en `/tmp` |
| code-graph-rag | Descartar | Tardó 273 s en indexar. Su modo en lenguaje natural requiere un LLM o descargar un modelo |
| xerj | Descartar | Funciona con un daemon HTTP. En T1 devolvió documentación en vez de código y falló T4 y T5 |

## Lo que cambia en el perfil "repo grande"

1. **Partir de símbolos, no de frases.** `graft ask` depende mucho de cómo se redacte la pregunta: con la misma tarea, Sonnet obtuvo resultados parciales o fallos y agy aciertos. La pregunta conceptual T4 (sin nombres de símbolos) no la resolvió bien ninguna herramienta sin embeddings. El lector debe ir en este orden:
   1. `graft map` y `ask` para orientarse;
   2. fijar nombres concretos;
   3. `skeleton` y `callers`;
   4. `rg` para las búsquedas exhaustivas;
   5. leer solo los tramos.
2. **El grafo estático no captura todas las llamadas.** Ninguna herramienta conectó `executeTool` con `Permission.assert` (`permission.ts:214/228`), porque se invoca desde cada plugin con el estilo de Effect. El lector debe confirmar las aristas leyendo los tramos, y el crítico no puede tomar un "no tiene llamadores" como prueba.
3. **Presupuesto.** Una consulta cuesta entre 0,2 y 2 k tokens y entre 0,7 y 2,5 s. El prerregistro del Probe de repo puede fijar un tope de consultas y de líneas leídas.

## Patrones a adoptar (patrón, no dependencia)

- **Resolver `ruta:línea` → símbolo**, como `cgr graph resolve`, para que el crítico verifique una cita sin leer el archivo entero.
- **Ante un nombre ambiguo, devolver sugerencias** en lugar de adivinar (`trace_path` de codebase-memory-mcp) y **filtrar por archivo** (`codegraph callers -f`).
- **Salida con tamaño acotado y declarado** (`--symbols-only`, `--budget`).
- **Penalizar los archivos de test en el ranking** (graft y semble ya lo hacen).
- **Probar que las consultas son deterministas** (mismo md5 en dos corridas) si alguna herramienta entra en el flujo.

## Segunda ronda: qué parte del mapa recibe el agente

Pregunta: el agente no debe recibir el mapa completo, sino la parte que necesita para el cambio. ¿Cómo lo hacen los sistemas de referencia? Fuentes:

- graphicle, Terrain (sucesor de deepwiki-rs), deepwiki-rs y hindsight, clonados e indexados con graft en `ext/codesearch/` y leídos por el orquestador;
- [web-contexto.md](web-contexto.md), de agy con Agent-Reach, corregido en su §4.2 y en lo que dice de deepwiki-rs.

| Sistema | Qué recibe el agente al empezar | Cómo recupera lo relevante | Usa LLM para preparar el mapa |
|---|---|---|---|
| **graphicle** (`code_pack.rs`, `docs/pack.md`) | Nada fijo: arma un **paquete por pregunta** | Ranking BM25 + identificadores + grafo, y un presupuesto repartido por secciones: arquitectura (una línea por carpeta, **~4 %**), focus (archivos ordenados, enteros si son pequeños y extractos si no), llamadores a 2 saltos (≤10 %), tests (≤10 %), docs (≤5 %) y breadth (lo siguiente, como resumen). Por MCP son 32 k tokens por defecto | No |
| **Terrain** (`agent_context.rs:245`, `freshness/compute.rs:47`) | `context.md` ≤ 14 000 caracteres (~3,5 k tokens) | El código empaquetado (`repomix.md`) **no se precarga**: se busca y se lee bajo demanda, y CodeGraph responde las consultas de aristas. Cada capa tiene una puntuación de frescura según los commits de retraso | Sí: `context.md` lo escribe un LLM |
| **deepwiki-rs / Litho** (`preprocess/mod.rs:68`) | Fichas por directorio | Sus agentes leen las fichas desde un `HashMap` del proceso | Sí: fichas y puntuación de cada directorio |
| **Aider** (web) | Repo map de **1 024 tokens** con firmas ordenadas por PageRank | El modelo pide abrir archivos (`/add`) | No |
| **Claude Code, Codex, OpenCode** (web) | `CLAUDE.md`/`AGENTS.md` | Búsqueda agéntica (glob, grep, read) bajo demanda, sin índice | No |
| **Cursor, Copilot, Cody** (web) | Instrucciones | Índice híbrido (semántico + léxico/trigramas) con reranker y tope de tokens | No |
| **hindsight** (README) | Un banco de memoria por repo, construido del historial de git y de sesiones previas | Combina 4 estrategias de recuperación (vectorial, BM25, grafo, temporal), ordena con RRF + cross-encoder y recorta al límite de tokens | **Sí: `retain` extrae hechos con un LLM**, y necesita servidor y API key |

**Conclusión: tu hipótesis es lo que hace la industria.** El mapa sirve para **orientarse**; nadie lo pasa entero:

- Aider entrega 1 k tokens, Terrain unos 3,5 k y graphicle dedica al mapa un 4 % del paquete.
- El resto del contexto se **recupera por pregunta**, con un presupuesto declarado.
- Hay dos escuelas:
  1. **búsqueda agéntica sin índice** (Claude Code y Codex): el modelo hace las consultas;
  2. **paquete armado por el sistema** (graphicle, Cursor, Cody): un recuperador elige los tramos antes de llamar al modelo.

  Según Cursor (web-contexto §3.2), lo mejor es combinar la búsqueda semántica con grep.

**Memoria entre tareas** (hindsight; Stompy en web-contexto §5.2): no mejora la calidad del código, pero reduce entre un 28 y un 40 % los turnos de exploración, y solo en tareas transversales. En tareas acotadas es sobrecoste. Para el lector de fab investigación, cada Probe es una tarea nueva sobre un repo fijado a un commit, así que no compensa ahora. Es una pieza de la etapa de **operación** de fab (capa C7), no de la ideación.

### Propuesta para el lector "repo grande" (insumo para el ADR-0008)

Se compone con lo que ya existe (graft + `rg`) y **sin LLM sobre el repo no confiable** para construir el mapa:

1. **Mapa pequeño (orientarse).** `graft map` recortado a un tope fijo de unos 1–4 k tokens, como Aider y Terrain. Es determinista y no necesita LLM, al contrario que Terrain y Litho; eso evita leer todo el repo no confiable con un modelo (ADR-0007).
2. **Ubicar.** `graft ask` con los términos de la hipótesis → candidatos de subsistema → **medir sus tokens** (umbral del prerregistro).
3. **Paquete con presupuesto y secciones** (patrón de graphicle, construido por el harness y no por el lector): focus (tramos de los símbolos que salieron de `skeleton` y `callers`), llamadores a 2 saltos, tests que tocan esos símbolos y una línea por carpeta del mapa. Tope declarado en el prerregistro, por ejemplo 32 k.
4. **Bajo demanda.** Si el lector necesita más, pide consultas concretas (`skeleton`, `callers`, `rg`) dentro de un tope de consultas. Nunca recibe el repo entero.
5. **Frescura.** El paquete registra el commit fijado; si el pin cambia, se reconstruye (idea de Terrain).

Pendiente de medir antes de adoptarlo: comparar en opencode el paquete del paso 3 con la búsqueda agéntica libre (aciertos de T1–T5 y tokens). Así se decide entre las dos escuelas con datos propios y no por los benchmarks de cada proveedor.

## Tercera ronda: mejoras al flujo "grafo como herramienta" y floorplan

Fuentes: [web-grafo-herramienta.md](web-grafo-herramienta.md) (agy con Agent-Reach) y [floorplan.md](floorplan.md) (Sonnet, con medición en una copia de sw-factory).

**Auditoría.** Se verificaron en el código o en la fuente:

- el parámetro `in` de `graft_trace_calls` (`graft dist/mcp/tools.js:259`);
- la cita de codegraph "partial coverage is WORSE than none" (`AGENTS.md:163`);
- las etiquetas `EXTRACTED/INFERRED/AMBIGUOUS` de graphicle (`graph_tools.rs:767`);
- los pesos de Aider (×10, ×10, ×0,1, ×0,1, ×50, √refs; `repomap.py:493-514`);
- la existencia de RepoGraph, LocAgent y REPOEXEC (y las cifras de LocAgent, 92,7 % y −86 %, en su resumen).

No se verificaron una por una las cifras de las tablas de RepoGraph, REPOEXEC ni BFCL. Se cambiaron 11 enlaces `file://` por citas de ruta.

### floorplan: adoptar el patrón, no la herramienta

- **Qué hace sin LLM.** El escaneo (imports, exports, rutas HTTP, petición web → endpoint) es determinista, aunque **con regex, no con tree-sitter**. Las consultas (`overview`, `find`, `show`, `path`) tardan ~20 ms y devuelven 0,7–3 KB.
- **Qué hace con LLM.** El LLM pone nombres llanos y descripciones a **cada archivo** y escribe la arquitectura. Eso choca con ADR-0007 en el lector.
- **Lo que le falta.** Sin LLM queda un grafo de imports entre archivos, sin aristas de llamada: es inferior a graft.
- **Dónde encaja.** En la etapa de **operación** (el repo de un cliente, con permiso), por las capas petición web → endpoint, health y flujos ("qué pasa en el checkout").
- **Patrones a copiar:**
  - hash de **firma** por archivo para decidir qué se vuelve a describir y para no perder descripciones al renombrar;
  - arista petición → endpoint;
  - cuatro verbos de consulta con salida acotada.

> **Actualización del 2026-11-02 ([medicion/m1-m4.md](medicion/m1-m4.md), [medicion/a2-y-sandbox.md](medicion/a2-y-sandbox.md)):**
> - La prioridad 1 (semillas, M1) se **midió sin efecto** y se retiró.
> - Las prioridades 2–4 (M2–M4) se adoptan.
> - La búsqueda agéntica libre con `rg` acertó 5/5 en T1–T5, frente a 2/9 de graft `ask`. Para localizar va primero la búsqueda agéntica, y graft queda como complemento (ADR-0008 revisado).

### Mejoras priorizadas para el lector "repo grande"

Problemas: P1 redacción de `ask` · P2 preguntas conceptuales · P3 aristas que el análisis estático no ve · P4 nombres ambiguos · P5 recorte del mapa.

| Prioridad | Mejora | Ataca | Evidencia | Sin red ni LLM | Coste |
|---|---|---|---|---|---|
| 1 | **Sembrar la consulta y el mapa con los identificadores de la hipótesis** que existen en el índice (cruce del texto con los símbolos, estilo Aider) | P1, P2, P5 | Aider `repomap.py:493-514`; Rahman & Roy 2023 | Sí | Bajo |
| 2 | **Desambiguar con alcance** (`in: <archivo o módulo>`, ya existe en graft MCP) y **fallar de forma segura**: si hay más de un candidato, devolver la lista con `archivo:línea` | P4 | `graft tools.js:259`; `trace_path` de codebase-memory-mcp | Sí | Bajo |
| 3 | **Salida de firmas por defecto, cuerpos bajo demanda**, y tope por llamada (si se pasa del tope, a un archivo con vista previa) | P5 | REPOEXEC (firmas ≈ contexto completo en tasa de invocación de dependencias); AutoCodeRover; Copilot 20 KiB; SWE-agent 100 líneas | Sí | Bajo |
| 4 | **Frescura O(1)**: guardar el commit del índice y compararlo con `HEAD` antes de consultar; diff para el incremental | Frescura | Terrain `freshness/`; `graft_check_freshness` | Sí | Bajo |
| 5 | **PageRank personalizado** sembrado (pasar las semillas de la prioridad 1 a `graphrank.js`) | P5 | Aider; RepoGraph y LocAgent en localización (SWE-bench Lite) | Sí | Medio |
| 6 | **Etiquetar la confianza de cada arista** (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`). El crítico **nunca** acepta un "no tiene llamadores" como prueba | P3 | graphicle `graph_tools.rs:767`; codegraph `provenance` | Sí | Bajo como regla del crítico; medio en la herramienta |
| 7 | Sintetizadores de dispatch dinámico (callbacks, registros), **solo si se cierra el flujo de punta a punta** | P3 | codegraph `AGENTS.md:163` (con cobertura parcial las lecturas subieron a 5–7; con el flujo completo bajaron a 0–1) | Sí | Alto |
| Más adelante | Reescribir preguntas conceptuales con un modelo local pequeño | P2 | SSQR (+9,9–12,2 % MRR) | Con modelo local | Alto |
| Descartado para el lector | Trazas de ejecución (`cgr trace`) | P3 | code-graph-rag | No: hay que ejecutar los tests del repo no confiable | — |

P3 con Effect sigue sin solución en ninguna herramienta (web-grafo §9). La protección es de proceso: leer el tramo y que el crítico lo verifique sobre el código.

**Decisión de bucle.** Lo que encontró agy sobre subagentes encaja con la separación que ya tenemos (lector frente a implementador): el lector **es** el explorador aislado y entrega solo la receta y la spec. Hay dos cortes que conviene copiar:

- un tope de consultas en el prerregistro (los procedimientos estratificados usan 2–5 consultas);
- colapsar las observaciones antiguas (SWE-agent deja completas solo las 5 últimas).

## Sin verificar

- Que ninguna herramienta ejecute código del repo al indexar: no se auditó con `strace`.
- Go, Python y Rust: el repo de prueba es casi todo TypeScript.
- El tiempo de construcción de graft desde cero y si graft soporta Rust.
- Que el comportamiento sea el mismo en el sandbox real de fab (`src/agent/mcp-sandbox.ts`) y no solo en la emulación con bwrap.
