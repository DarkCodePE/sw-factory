# ADR-0008: Probe con umbral medido por tipo de fuente; en repos grandes, el grafo es una herramienta, no el contexto

Estado: **aceptado (2026-11-02)**, con seguimientos no bloqueantes (ver final) · Fecha: 2026-11-01 · Capa principal: C5 · Afectadas: C4b, C7

## Contexto
El paso 5 (Probe) de `ARQUITECTURA.md` trata igual cualquier fuente: un lector lee "wiki RO, graft sobre `ext/`" y produce receta y spec. Un paper cabe en el contexto; un repo grande no. Medido en `ext/opencode` @ `79469efc` (evidencia en `codesearch/README.md`):

- el código son 37,8 MB, unos 9,5 M tokens (bytes/4);
- el grafo completo de graft (`wiring.json`) son 32,3 MB, con 32 188 símbolos y 80 077 aristas;
- solo el subsistema `packages/core/src/session/` son ~117 k tokens.

Leerlo todo no cabe, degrada el razonamiento, multiplica la superficie de inyección (ADR-0007) y deja conclusiones sin una cita que el crítico pueda verificar.

Se evaluaron 12 herramientas y sistemas en tres rondas (`codesearch/`):

- graft frente a code-graph-rag, codegraph, codebase-memory-mcp, xerj, semble y tgrep, con las tareas T1–T5 sobre opencode;
- graphicle, Terrain, deepwiki-rs, hindsight y floorplan, por lectura de código;
- Aider, Claude Code, Codex, Cursor, Cody, Copilot y la literatura de localización con grafos (RepoGraph, LocAgent, Agentless), en la web.

Conclusiones verificadas:

- ninguna herramienta reemplaza a graft + `rg`;
- los sistemas de referencia **no pasan el mapa completo**: Aider pasa 1 024 tokens, el `context.md` de Terrain tiene ≤ 14 000 caracteres y graphicle dedica ~4 % de un paquete de 32 k;
- el resto se recupera **por consulta**.

## Decisión
1. **Un solo procedimiento de Probe con umbral medido**, no tres flujos por tipo de fuente. El prerregistro (paso 3) añade `tipo_fuente` (`paper | articulo | repo`), `tokens_medidos` (bytes/4, determinista) y `presupuesto_lectura` (por defecto 128 k).
   - Si la fuente cabe en el presupuesto, el lector la lee entera (paper, artículo o repo pequeño).
   - Si no cabe, se baja de nivel: repo → subsistema (`graft ask` con los términos de la hipótesis; se mide de nuevo y se lee entero si cabe) → símbolos (`skeleton`, `callers`) y tramos.
   - La exhaustividad se aplica al alcance de la pregunta ("todas las llamadas a X", con `rg` o `callers`), nunca al repo.
2. **Repo grande: el grafo es una herramienta, no el contexto.** *(Revisado el 2026-11-02: para **localizar** y **seguir llamadas**, la herramienta principal es la búsqueda agéntica con `rg` y lectura de tramos; graft queda como complemento barato. Ver resultados.)*
   - tree-sitter → grafo de graft guardado en disco, construido **sin LLM** (`graft build`, sin `--deep`), así ningún modelo lee el repo no confiable entero para hacer el mapa;
   - el lector recibe solo un **mapa recortado** con tope fijo (≤ 4 k tokens);
   - el lector **consulta** (`graft ask`, `skeleton`, `callers`, `rg`) y al contexto entra solo la respuesta, con `archivo:línea`;
   - el contenido sigue llegando envuelto como no confiable (ADR-0007).
3. **Cuatro mejoras del harness** (envolturas sobre la CLI de graft; no se modifica graft):
   - **M1. Semillas** *(retirada el 2026-11-02: medida sin efecto)*: los identificadores de la hipótesis que existen en el índice se pasan como términos de `ask` y para priorizar el mapa (patrón Aider, `repomap.py:493-514`).
   - **M2. Desambiguar:** consultas con alcance (`in:` de `graft_trace_calls`, `graft dist/mcp/tools.js:259`). Si hay más de un candidato, se devuelve la lista con `archivo:línea` y no se elige ninguno.
   - **M3. Salida acotada:** firmas por defecto, cuerpos bajo demanda. Tope por llamada; si se supera, la salida va a un archivo con vista previa.
   - **M4. Frescura:** el índice guarda el commit fijado; antes de consultar se compara con `HEAD` del pin y, si difiere, se reconstruye.
4. **Topes en el prerregistro:** número máximo de consultas al grafo y de líneas leídas. El historial colapsa las observaciones antiguas.
5. **Regla del crítico:** una arista ausente en el grafo estático no prueba nada; DI, Effect y el dispatch dinámico se pierden (en opencode, ninguna herramienta conectó `executeTool` con `Permission.assert`). El crítico verifica las afirmaciones de llamada leyendo el tramo citado.

## Alternativas
- **Pasar el grafo o el mapa completo al lector:** ~8 M tokens el grafo o ~880 k las fichas de graft. No cabe y añade ruido.
- **Leer el repo entero por trozos:** pierde las conexiones entre piezas, y su coste y su superficie de inyección escalan con el tamaño del repo.
- **Un mapa escrito por un LLM** (Terrain, deepwiki-rs, floorplan): un modelo lee todo el repo no confiable, lo que choca con ADR-0007. Además no es determinista. floorplan queda como candidato para la etapa de **operación**.
- **Añadir codegraph:** queda diferido hasta que `graft callers` falle en Probes reales por nombres ambiguos (M2 mitiga ese caso).
- **Búsqueda semántica con embeddings** (semble, codebase-memory-mcp): falló en T3/T5 o necesita un modelo descargado. Reconsiderarla para P2 con un modelo local, más adelante.
- **Memoria entre tareas** (hindsight): reduce exploración solo en tareas transversales; cada Probe es una tarea nueva sobre un pin. Es de la etapa de operación (C7).

## Consecuencias
+ El coste y el riesgo del Probe de repo dejan de crecer con el tamaño del repo: los fija el presupuesto prerregistrado.
+ Cada afirmación del lector lleva `archivo:línea` que el crítico puede verificar.
+ Un `INCONCLUSIVE` por contexto insuficiente se puede diagnosticar en el ledger (`tokens_medidos` frente a `presupuesto_lectura`).
− `graft ask` depende de cómo se redacte la pregunta (P1) y las preguntas conceptuales sin nombres fallan (P2). M1 lo mitiga, pero no lo resuelve.
− Las aristas dinámicas (P3) siguen sin cubrirse; la protección es de proceso (crítico) y no técnica.
− Se añade una envoltura del harness sobre graft que hay que mantener.

## Resultados de la verificación (2026-11-02)
Prerregistro: `codesearch/medicion/tareas.md` (sha256 `d142cc92…`) y `verdad.md` (`1f45d4fa…`), sin cambios antes ni después. Informes:

- `codesearch/medicion/m1-m4.md` (Sonnet 5.5): brazos A0 = graft tal cual y A1 = envoltura `scripts/ideas/graft-lector.ts`. Lleva 4 tests y `tsc` limpio.
- `codesearch/medicion/a2-y-sandbox.md` (agy): brazo A2 = búsqueda libre con `rg`/`find`/`sed`, a ciegas y con la redacción R1; más graft en el sandbox de fab.

Las consultas de los brazos A0 y A1 se ejecutaron en bwrap sin red, con el repo en solo lectura, y con md5 estable en 2 corridas.

| Brazo | Acierto | Coste |
|---|---|---|
| A0 graft `ask` (T1, T2, T4 × R1–R3) | archivo hit@1 1/9, hit@5 2/9; símbolo 0/9 | 17,5 KB en 9 llamadas |
| A1 envoltura (M1–M4) | **igual que A0** (1/9, 2/9, 0/9) | 10,3 KB (**−41 %**) |
| A2 búsqueda libre (`rg`, `sed`) | **5/5** (incluida la cadena de permisos de T2) | 52 comandos, 168,7 KB (~42 k tokens; máx. ~19 k por tarea) |
| T3 exhaustivo | `rg`: 44 archivos, 60 ocurrencias; `graft grep`: 21 archivos, 36 aciertos | — |
| T5 API | `rg '^export'` 13/13; `graft skeleton` 10/12 exports (faltan `layer` y `node`) más ~40 internas | 0,7 KB frente a 6,9 KB |

Causa verificada del fallo de graft en T2: el índice no registra los símbolos definidos dentro de `Effect.fn`. `wiring.json` no tiene `ask` ni `assert` de `permission.ts`, ni `executeTool` de `tool.ts`; la verificación del orquestador lo confirmó. En un repo con ese estilo, `ask` y `callers` no pueden llegar a la respuesta y A2 sí.

**Por mejora:**

| Mejora | Resultado | Veredicto |
|---|---|---|
| M1 semillas | Sin efecto en hit@1/@5; produce semillas espurias (`resume`, `Call`, `decide`) | **Descartada como está.** Solo se retomaría con semillas con forma de identificador y una nueva medición |
| M2 desambiguar | En 3 de 3 nombres ambiguos devuelve candidatos sin elegir, con el 18–28 % de los bytes. La lista puede no contener la definición buscada (índice incompleto) | **Adoptada.** La lista no prueba existencia; el crítico verifica en el fuente |
| M3 salida acotada | −41 % de bytes en `ask` sin cambiar el acierto; con un tope bajo, la vista previa corta datos de T3/T5 | **Adoptada**; ajustar la vista previa para priorizar exports y conteos |
| M4 frescura | Detecta un commit distinto (código 3); falla sin sidecar; no escribe | **Adoptada** |

**Sandbox real** (`src/agent/mcp-sandbox.ts`):

- graft **no arranca tal cual**, por dos motivos:
  - solo se monta el archivo ejecutable resuelto (`:10`, `:18`), no el paquete;
  - `node` (instalado con nvm) queda fuera de las rutas del sistema montadas (`:15`).
- Funciona, CLI y `graft mcp`, añadiendo a `readPaths` el binario de `node` y la raíz del paquete graft.
- Con el repo en solo lectura, el refresh y la telemetría fallan sin romper la consulta (`dist/graph/refresh.js:289`; `dist/telemetry/*`).
- `--no-refresh` ahorra ~110–150 ms y evita intentos de escritura.

**Cambios en la decisión:**

- **Decisión 2 (revisada):** en un repo grande, el lector **localiza y sigue llamadas con búsqueda agéntica** (`rg`, `find`, lectura de tramos con `sed -n`), dentro del presupuesto prerregistrado. graft queda como **complemento**: mapa recortado de orientación, `skeleton` y `callers` cuando los símbolos están indexados, siempre con `--no-refresh`.
  - El "mapa en lugar del repo" sigue en pie: A2 leyó ~42 k tokens en total, frente a ~9,5 M del repo.
  - Lo que cambia es **quién localiza**: el modelo con `rg`, no el ranking de graft.
- **Decisión 3:** M2, M3 y M4 se mantienen; **M1 se retira**.
- **Prerrequisito nuevo:** para ejecutar graft en el sandbox de fab hacen falta `readPaths` con `node` y el paquete graft, o un binario autocontenido.

**Límites de la evidencia:**

- un solo repo, y con mucho estilo Effect, que es el peor caso para el grafo estático;
- A2 es una sola corrida de un agente; la ceguera es autodeclarada (el log de 52 comandos sí existe);
- A0/A1 usan una llamada por celda, mientras que A2 hace un bucle de varias. No es una comparación de igual coste, sino de qué llega a la respuesta.

## Segundo repo e implementación (2026-11-02)
**deer-flow** (`ext/deer-flow` @ `35656d6`, Python, ~871 k líneas `.py`). Informe: `codesearch/medicion/deerflow.md`, de agy. Prerregistro: `tareas-deerflow.md` (`2fe5fd0a…`) y `verdad-deerflow.md` (`6352c69d…`), sin cambios.

| | opencode (TS/Effect) | deer-flow (Python) |
|---|---|---|
| A2 búsqueda libre | 5/5; 52 comandos; ~42 k tokens | **5/5**; 39 comandos; ~18 k tokens |
| A0 `ask`, archivo en hit@5 | 2/9 | 4/9 (todos con redacción en inglés; R1 en español: 0/3 en los dos repos) |
| A0 `ask`, símbolo en hit@5 | 0/9 | 4/9 |
| A0 `callers` | símbolos ausentes del índice (`Effect.fn`) | símbolos **presentes** (verificado en `wiring.json`), pero con 25–30 definiciones homónimas graft descarta las aristas entre archivos |
| `graft grep` frente a `rg` | 21 de 44 archivos | 10 de 11 (omite `docs/GUARDRAILS.md`) |
| `skeleton` | 10/12 exports | API completa |

**Conclusión:** el patrón se repite en un repo sin Effect. La búsqueda agéntica acierta siempre con un coste acotado. `graft ask` depende de la redacción y del idioma, y `callers` falla por razones distintas en cada lenguaje. **La Decisión 2 revisada queda validada en dos repos.**

**Fase A implementada** (`codesearch/medicion/implementacion-fase-a.md`; Sonnet 5.5): `scripts/ideas/graft-lector.ts`.

- **Lo que hace:**
  - M1 retirada;
  - `rg` acotado como localizador principal;
  - vista previa que conserva los conteos y los exports;
  - `measure`;
  - `ProbeBudget` con sesión que corta con código 5;
  - M2 y M4.
- **Independencia de fab:** el núcleo solo importa `node:*`. El adaptador de fab (`mcp-config` con `readPaths`) está en `scripts/ideas/lector-fab.ts`. Un test falla si el núcleo importa algo de `src/`.
- **Pruebas:** 10 tests, `tsc` limpio. El test de `lector-fab` ejecuta `graft --version` a través de `wrapMcpCommand` sin red.

## Seguimientos (no bloqueantes)
- ~~**Filtro de `measure`**~~ **hecho (2026-11-02):** descarta los binarios que git marca como `i/-text` y los informa en `binarios_excluidos`. opencode baja de 34,5 M a 18,9 M tokens (336 binarios fuera); `session/` sigue en 117 057. No filtra por extensión: el texto restante incluye JSON, MDX y TXT (el código `.ts`+`.tsx` mide ~9,4 M). La decisión no cambia lejos del umbral; solo importaría cerca de 128 k.
- ~~**Ruido en `rg`**~~ **hecho (2026-11-02):** `rg` añade `-g !/graft/` solo si existe `graft/.graph` (así no oculta un `graft/` que sea código). `permission.asked` en opencode pasa de 59 líneas/44 archivos a 55/40; las 4 que sobraban eran fichas del índice. `verdad.md` contaba esas fichas.
- ~~**Medir A2 con la envoltura como apoyo**~~ **hecho (2026-11-03), `codesearch/medicion/a2-vs-a2g.md`:** 3 sujetos (Sonnet 5.5, agy, Codex) × 2 brazos × 10 tareas, con una ejecución por celda. Acierto: A2 27A 3P, A2g 25A 5P. Bytes de herramientas: Sonnet −11 %, agy −26 %, Codex −33 %. El grafo se queda como complemento opcional (sobre todo `skeleton`), no como paso obligatorio. Pendiente: revisar la verdad de deer-flow T4, en la que fallaron las 6 sesiones.
- **Conectar `graft mcp` a un agente de fab real** con la entrada de `lector-fab.ts`; hoy solo se probó `graft --version` en el sandbox.
- **`exportedNames` (prioridad de M3) solo entiende TS/JS;** falta Python y Go.
- **Modo MCP del lector**, para que lo use cualquier harness. Extraerlo a su propio repo cuando haya un segundo consumidor.
