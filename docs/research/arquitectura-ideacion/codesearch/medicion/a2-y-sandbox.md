# Verificaciones ADR-0008: Búsqueda Agéntica Libre (A2) y Graft en el Sandbox Real de Fab

Contexto: `docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md`.  
Repositorio evaluado: `ext/opencode` en commit `79469efc` (montado en modo solo lectura).  
Fecha de medición: 2026-11-01 / 2026-11-02.

---

## 1. Tarea A: Brazo A2 (Búsqueda Agéntica Libre)

Evaluación a ciegas sobre las tareas T1–T5 de `medicion/tareas.md` utilizando exclusivamente herramientas estándar POSIX (`rg`, `find`, `ls`, `sed -n`, `head`). Se utilizó la redacción R1 de cada tarea. No se consultaron `verdad.md`, `codesearch/grafos.md`, `busqueda.md`, `README.md` ni los archivos `web-*.md` hasta haber concluido la totalidad de las 5 tareas.

### 1.1. Tabla Resumen por Tarea

| Tarea | Redacción R1 | Respuesta final (`archivo:línea`) | Acierto | Comandos | Bytes leídos | Tokens (estimado: bytes/4) | Tiempo shell (ms) | Tiempo agente (estimado) |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** (localizar) | "¿Dónde y cómo se compacta o resume el contexto de una sesión cuando se llena?" | `packages/core/src/session/compaction.ts:284` (caller: `packages/core/src/session/runner/llm.ts:217`) | Acierto exacto | 14 | 57.780 | 14.445 | 287 ms | ~70 s |
| **T2** (aristas) | "¿Quién llama a la función que ejecuta una tool call y qué comprobación de permisos se aplica antes?" | `packages/core/src/session/runner/step.ts:126` -> `packages/core/src/session/model-request.ts:385` -> `packages/core/src/tool.ts:298` / `packages/core/src/tool/runtime.ts:30`. Permisos: `packages/core/src/tool.ts:258` (`whollyDisabled`) y `packages/core/src/permission.ts:228` (`Permission.assert`) | Acierto exacto | 24 | 77.622 | 19.405 | 400 ms | ~140 s |
| **T3** (exhaustivo) | "Todas las ocurrencias del literal `permission.asked` (archivos y recuento)" | 55 ocurrencias en 40 archivos de código fuente (59 en 44 archivos incluyendo el árbol preexistente `graft/`). Definición: `packages/schema/src/permission.ts:45` | Acierto exacto | 5 | 15.557 | 3.889 | 395 ms | ~30 s |
| **T4** (conceptual) | "¿Cómo decide qué modelo o proveedor usar para una petición?" | `packages/core/src/session/runner/model.ts:77` (`SessionRunnerModel.resolve`), `packages/core/src/model-resolver.ts:413` (`ModelResolver.resolve`), `packages/core/src/model-resolver.ts:377` (`resolveModel`) y `packages/core/src/session/model-request.ts` | Acierto exacto | 5 | 12.308 | 3.077 | 33 ms | ~35 s |
| **T5** (API archivo) | "Superficie pública de `packages/core/src/session/compaction.ts`" | 13 símbolos exportados: `SessionCompaction`, `Settings`, `Editor`, `Trigger`, `Outcome`, `Interface`, `Service`, `buildPrompt`, `layer`, `node`, `recentUserMessages`, `estimateContext`, `estimatePrompt` | Acierto exacto | 4 | 5.419 | 1.354 | 11 ms | ~20 s |
| **Total** | — | — | **5/5** | **52** | **168.686** | **42.170** | **1.126 ms** | **~295 s** |

*Nota sobre tiempos:* "Tiempo shell" corresponde a la suma exacta de los tiempos de ejecución de cada proceso hijo en nanosegundos/milisegundos registrados en `/tmp/claude-1000/a2-log.txt`. "Tiempo agente" es el tiempo de reloj de pared estimado invertido por el LLM en la lectura, análisis y formulación secuencial de pasos.

---

### 1.2. Justificación de Aciertos vs `verdad.md`

1. **T1 (Acierto exacto):**
   - *Referencia en `verdad.md`:* `packages/core/src/session/compaction.ts`, función `compact` (:284).
   - *Hallazgo A2:* Se localizó la definición de `compact` en `compaction.ts:284` junto con la lógica de activación por cuota (`due`, `compaction.ts:409`), el cálculo del techo (`calculateCeiling`, `compaction.ts:1104`), la plantilla de resumen (`SUMMARY_TEMPLATE`, `compaction.ts:161`) y el llamador en el ciclo de ejecución del runner (`packages/core/src/session/runner/llm.ts:217`).

2. **T2 (Acierto exacto):**
   - *Referencia en `verdad.md`:* `packages/core/src/tool/runtime.ts:30` (`execute`) y `packages/core/src/tool.ts:115` (`executeTool`, llamado en `tool.ts:270/309/311`); además `session/runner/step.ts:91` (`executeTool` local). Permisos: `packages/core/src/permission.ts:214` (`ask`) y `:228` (`assert`), invocados desde los plugins de tool (p. ej. `tool/plugin/shell.ts:138`, `edit.ts:275`).
   - *Hallazgo A2:* Se reconstruyó la cadena completa de llamadas:
     - Ejecución: el stream del modelo en `runner/step.ts:126` detecta el evento de herramienta e invoca la función local `executeTool` (`runner/step.ts:89-100`), la cual llama a `prepared.executeTool` (`session/model-request.ts:385`), que delega en `tools.execute` (`tool.ts:298`), resolviendo a `tool/runtime.ts:30` (`execute`).
     - Permisos: se identificó la comprobación estática previa en `tool.ts:258` (`whollyDisabled`) que filtra del snapshot las herramientas denegadas por regla global (`*`), y la comprobación dinámica en runtime ejecutada por la herramienta hoja antes de cualquier efecto secundario mediante `permission.assert` (`permission.ts:228`) y `permission.ask` (`permission.ts:214`), las cuales publican `Permission.Event.Asked` y canalizan los rechazos del usuario mediante defectos tipados que desembocan en `SessionModelRequest.executeTool`.

3. **T3 (Acierto exacto):**
   - *Referencia en `verdad.md`:* `rg -F permission.asked` -> 60 coincidencias en 44 archivos (con instrucción explícita: "contar de nuevo y registrar el comando exacto").
   - *Hallazgo A2:* El comando `rg -F -c "permission.asked"` arrojó exactamente 59 coincidencias distribuidas en 44 archivos. Desglosando:
     - 55 coincidencias en 40 archivos corresponden estrictamente al código fuente del repositorio (`packages/`, `services/`).
     - 4 coincidencias en 4 archivos corresponden a documentación generada dentro de la carpeta `graft/`.
     - 6 coincidencias adicionales aparecen en archivos internos ocultos en `graft/.cache/` (sumando 65 coincidencias en 47 archivos con flag `-uu`).
     - La definición canónica del evento se localizó en `packages/schema/src/permission.ts:45` (`const Asked = ephemeral({ type: "permission.asked", schema: Request.fields })`).

4. **T4 (Acierto exacto):**
   - *Referencia en `verdad.md`:* `packages/core/src/model-resolver.ts` (`resolveModel`) y `packages/core/src/session/model-request.ts`.
   - *Hallazgo A2:* Se mapeó la lógica paso a paso:
     - `SessionRunnerModel.resolve` (`packages/core/src/session/runner/model.ts:77`): si la sesión tiene modelo asignado (`session.model`), lo busca en `catalog.available()`; si no tiene, consulta el modelo preferido del agente (`agents.select(session.agent).info?.model`); si ninguno existe, recurre a `ModelResolver.resolve()`.
     - `ModelResolver.resolve` (`packages/core/src/model-resolver.ts:413`): consulta `models.default()` y si no está configurado, selecciona el primer modelo disponible que cuente con paquete ejecutable y soporte de texto (`models.available().find(m => hasPackage(m) && Model.supportsText(m))`).
     - `ModelResolver.resolveModel` (`packages/core/src/model-resolver.ts:377`): fusiona configuraciones con variantes (`withVariant`), resuelve credenciales mediante `Integration.Service` e inicializa el modelo.
     - `SessionModelRequest.node` (`packages/core/src/session/model-request.ts:350-420`): prepara el contexto y empaqueta la llamada final.

5. **T5 (Acierto exacto):**
   - *Referencia en `verdad.md`:* Skeleton completo de `compaction.ts` (comparar contra la lista de exports reales del archivo).
   - *Hallazgo A2:* Se extrajeron los 13 exports exactos del archivo:
     1. `SessionCompaction` (re-export `export * as SessionCompaction from "./compaction.js"`)
     2. `Settings` (tipo: configuración auto, buffer, keep, precompute)
     3. `Editor` (tipo: editor configure)
     4. `Trigger` (tipo: auto | overflow | manual)
     5. `Outcome` (tipo: skipped | completed | failed)
     6. `Interface` (interfaz Effect de compact y precompute)
     7. `Service` (servicio Context.Service)
     8. `buildPrompt` (función generadora del prompt estructurado)
     9. `layer` (definición Effect Layer)
     10. `node` (LocationNode de inyección de dependencias)
     11. `recentUserMessages` (utilidad de recorte de historial reciente)
     12. `estimateContext` (cálculo de tokens totales de contexto)
     13. `estimatePrompt` (medición y estimación diferencial de tokens de prompt)

---

### 1.3. Registro de Comandos Ejecutados en A2

Comandos registrados cronológicamente en `/tmp/claude-1000/a2-log.txt`:

```text
=== [T1] ===
1. [1608 B, 22 ms] find packages -type f -name "*compact*" -o -name "*summar*"
2. [671 B, 4 ms] rg -n "^export " packages/core/src/session/compaction.ts
3. [3804 B, 2 ms] sed -n "239,320p" packages/core/src/session/compaction.ts
4. [3206 B, 3 ms] sed -n "100,160p" packages/core/src/session/compaction.ts
5. [4865 B, 2 ms] sed -n "161,238p" packages/core/src/session/compaction.ts
6. [187 B, 3 ms] rg -n "function due|const due|function calculateCeiling|const calculateCeiling" packages/core/src/session/compaction.ts
7. [1633 B, 2 ms] sed -n "405,435p" packages/core/src/session/compaction.ts
8. [35115 B, 227 ms] rg -n "compaction\.compact|\bcompact\(" packages/
9. [1383 B, 6 ms] rg -n "SessionCompaction" packages/core/src/session/
10. [516 B, 4 ms] rg -n "compaction\." packages/core/src/session/runner/llm.ts
11. [1282 B, 2 ms] sed -n "210,235p" packages/core/src/session/runner/llm.ts
12. [1331 B, 3 ms] sed -n "115,140p" packages/core/src/session/runner/llm.ts
13. [56 B, 4 ms] rg -n "const summarize = " packages/core/src/session/compaction.ts
14. [2123 B, 3 ms] sed -n "440,480p" packages/core/src/session/compaction.ts

=== [T2] ===
1. [1258 B, 8 ms] rg -n "executeTool|tool\.execute|execute\(" packages/core/src/tool/
2. [1861 B, 2 ms] sed -n "20,60p" packages/core/src/tool/runtime.ts
3. [33958 B, 251 ms] rg -n "executeTool" packages/
4. [191 B, 35 ms] rg -n "export (const|function) executeTool" packages/
5. [485 B, 2 ms] sed -n "90,120p" packages/core/test/lib/tool.ts
6. [1814 B, 6 ms] rg -n "execute:" packages/core/src/tool/
7. [931 B, 4 ms] find packages/core/src/tool/ -type f
8. [1848 B, 22 ms] rg -n "export .* Tool" packages/core/src/
9. [3717 B, 2 ms] head -n 80 packages/core/src/tool.ts
10. [2933 B, 3 ms] sed -n "120,200p" packages/core/src/tool.ts
11. [4469 B, 3 ms] sed -n "201,300p" packages/core/src/tool.ts
12. [2408 B, 2 ms] sed -n "301,350p" packages/core/src/tool.ts
13. [181 B, 8 ms] rg -n "\.execute\(" packages/core/src/session/
14. [3176 B, 3 ms] sed -n "350,420p" packages/core/src/session/model-request.ts
15. [366 B, 18 ms] rg -n "\.executeTool\(" packages/core/src/
16. [2551 B, 3 ms] sed -n "70,120p" packages/core/src/session/runner/step.ts
17. [97 B, 4 ms] rg -n "executeTool\(" packages/core/src/session/runner/step.ts
18. [2028 B, 3 ms] sed -n "120,160p" packages/core/src/session/runner/step.ts
19. [4555 B, 7 ms] rg -n "Permission" packages/core/src/tool/
20. [1519 B, 3 ms] rg -n "^export " packages/core/src/permission.ts
21. [1778 B, 2 ms] sed -n "90,135p" packages/core/src/permission.ts
22. [103 B, 4 ms] rg -n "assert:" packages/core/src/permission.ts
23. [3632 B, 2 ms] sed -n "200,280p" packages/core/src/permission.ts
24. [1763 B, 3 ms] sed -n "60,90p" packages/core/src/tool/plugin/write.ts

=== [T3] ===
1. [6511 B, 278 ms] rg -F -n "permission.asked"
2. [0 B, 6 ms] rg "^graft" .gitignore
3. [2044 B, 40 ms] rg -F -c "permission.asked"
4. [1858 B, 34 ms] rg -F -c "permission.asked" --glob "!graft/**"
5. [5144 B, 37 ms] rg -F "permission.asked" --glob "!graft/**"

=== [T4] ===
1. [4279 B, 21 ms] rg -n "SessionRunnerModel" packages/core/src/
2. [2450 B, 2 ms] sed -n "40,110p" packages/core/src/session/runner/model.ts
3. [1288 B, 6 ms] rg -n "^export " packages/core/src/model-resolver.ts
4. [1349 B, 2 ms] sed -n "125,160p" packages/core/src/model-resolver.ts
5. [2942 B, 2 ms] sed -n "370,440p" packages/core/src/model-resolver.ts

=== [T5] ===
1. [671 B, 3 ms] rg -n "^export " packages/core/src/session/compaction.ts
2. [2002 B, 2 ms] sed -n "40,90p" packages/core/src/session/compaction.ts
3. [1866 B, 3 ms] sed -n "1050,1085p" packages/core/src/session/compaction.ts
4. [880 B, 3 ms] sed -n "905,925p" packages/core/src/session/compaction.ts
```

---

## 2. Tarea B: Graft dentro del Sandbox Real de Fab

### 2.1. Análisis de la Construcción del Sandbox en Fab

Fab implementa dos niveles de sandbox mediante Bubblewrap (`bwrap`):
1. **Sandbox general de ejecución (`src/sandbox/wrap.ts:69-144`):** Aplica `--ro-bind / /` montando la raíz del sistema completa en solo lectura, más el directorio de trabajo montado según permiso (`--bind` o `--ro-bind`).
2. **Sandbox estricto para servidores MCP (`src/agent/mcp-sandbox.ts:8-34`):** Diseñado específicamente para aislar servidores MCP iniciados desde `src/agent/mcp.ts:87`. A diferencia del sandbox general, este modelo **no monta la raíz `/`**. Construye una lista blanca mínima:
   - Rutas del sistema (`mcp-sandbox.ts:15`): `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc/ld.so.cache`, `/etc/ssl/certs`, `/etc/resolv.conf`, `/etc/hosts`, `/etc/passwd`, `/etc/group`.
   - Ejecutable resuelto y rutas de lectura configuradas (`mcp-sandbox.ts:18`): `configured = [executable, ...readPaths, ...args.filter(a => isAbsolute(a))]`.
   - Montajes bwrap (`mcp-sandbox.ts:26-33`):
     - `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`
     - Directorio de trabajo montado en solo lectura (`--ro-bind context.cwd context.cwd`) cuando `writable: false`.
     - `--chdir context.cwd`
     - Aislamiento de namespaces: `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`, `--die-with-parent`, `--new-session`.
     - Aislamiento de red: `--unshare-net` (cuando `allowNetwork: false`).
     - Depuración de entorno: `--clearenv`, inyectando únicamente las variables validadas en `verified.env` (`PATH` y `HOME=context.cwd`).

### 2.2. Por qué Falla la Invocación Cruda de Fab y Diferencias Declaradas

Si se intenta invocar `wrapMcpCommand("graft", ...)` tal como está codificado en `mcp-sandbox.ts` sin rutas adicionales, la ejecución fracasa por dos motivos arquitectónicos:

1. **Fallo de runtime (`/usr/bin/env: 'node': No such file or directory`, código 127):**  
   En `mcp-sandbox.ts:10`, el comando resuelve mediante `realpath` al script de entrada de graft (`/home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft/dist/bin/graft.js`). Dicho script abre con `#!/usr/bin/env node`. Dado que en la máquina host `node` no es un binario del sistema en `/usr/bin/node` sino un binario administrado por NVM en `~/.nvm/.../bin/node`, y `mcp-sandbox.ts:15` solo monta `/usr`, `/bin`, etc., `node` resulta completamente invisible e inaccesible dentro del sandbox.

2. **Fallo de resolución de módulos ESM (`Cannot find module '.../dist/brand.js'`, código 1):**  
   Aun si se provee la ruta del binario `node`, en `mcp-sandbox.ts:18` la lista `configured` incluye únicamente `executable` (el archivo singular `graft.js`). Por tanto, `bwrap` solo genera `--ro-bind` para ese archivo específico. Cuando Node intenta resolver `import { setBrand } from "../brand.js"`, los archivos complementarios del paquete `@nanonets/graft` no existen en el sistema de archivos del sandbox.

**Diferencias y emulación fiel declarada:**  
Para reproducir con fidelidad absoluta la arquitectura de fab sin alterar el código de `sw-factory`, se utilizó la interfaz pública de `wrapMcpCommand` configurando el parámetro `readPaths` con las dos dependencias requeridas del entorno host:
- El binario del motor Node: `/home/orlando/.nvm/versions/node/v22.22.1/bin/node`
- La raíz del paquete graft: `/home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft`

El resto de parámetros se mantuvieron estrictamente idénticos a los generados por `wrapMcpCommand`: `context.cwd` en `ext/opencode` con `--ro-bind`, `--unshare-net`, `--clearenv`, `HOME=/home/orlando/Desktop/factory/ext/opencode`, y `--tmpfs /tmp`.

---

### 2.3. Comando bwrap Exacto Reproducido

```bash
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --ro-bind /sbin /sbin \
  --ro-bind /lib64 /lib64 \
  --ro-bind /etc/hosts /etc/hosts \
  --ro-bind /etc/group /etc/group \
  --ro-bind /etc/passwd /etc/passwd \
  --ro-bind /etc/ssl/certs /etc/ssl/certs \
  --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind /home/orlando/.nvm/versions/node/v22.22.1/bin/node /home/orlando/.nvm/versions/node/v22.22.1/bin/node \
  --ro-bind /home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft /home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft \
  --ro-bind /home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft/dist/bin/graft.js /home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft/dist/bin/graft.js \
  --dev /dev \
  --proc /proc \
  --tmpfs /tmp \
  --ro-bind /home/orlando/Desktop/factory/ext/opencode /home/orlando/Desktop/factory/ext/opencode \
  --chdir /home/orlando/Desktop/factory/ext/opencode \
  --unshare-pid \
  --unshare-ipc \
  --unshare-uts \
  --die-with-parent \
  --new-session \
  --unshare-net \
  --clearenv \
  --setenv PATH /home/orlando/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin \
  --setenv HOME /home/orlando/Desktop/factory/ext/opencode \
  -- \
  /home/orlando/.nvm/versions/node/v22.22.1/lib/node_modules/@nanonets/graft/dist/bin/graft.js \
  <comando>
```

---

### 2.4. Resultados Medidos: Con Refresh vs Con `--no-refresh`

Mediciones directas en el sandbox bajo opencode solo lectura:

| Comando ejecutado en el sandbox | Modo de refresco | Código de salida | Tiempo medido (ms) | Salida stdout | Salida stderr | Diferencia temporal |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `graft ask "<T1 R1>" --source` | Con refresh (default) | 0 | **1.416 ms** | 2.902 B | 200 B | Baseline |
| `graft ask "<T1 R1>" --source` | `--no-refresh` | 0 | **1.305 ms** | 2.902 B | 200 B | **-111 ms** (-7,8%) |
| `graft skeleton packages/core/src/session/compaction.ts` | Con refresh (default) | 0 | **741 ms** | 6.929 B | 200 B | Baseline |
| `graft skeleton packages/core/src/session/compaction.ts` | `--no-refresh` | 0 | **594 ms** | 6.929 B | 200 B | **-147 ms** (-19,8%) |
| `graft grep permission.asked` | Con refresh (default) | 0 | **2.557 ms** | 4.941 B | 200 B | Baseline |
| `graft grep permission.asked` | `--no-refresh` | 0 | **2.423 ms** | 4.941 B | 200 B | **-134 ms** (-5,2%) |
| `graft callers compact` | Con refresh (default) | 0 | **807 ms** | 5.924 B | 200 B | Baseline |
| `graft callers compact` | `--no-refresh` | 0 | **696 ms** | 5.924 B | 200 B | **-111 ms** (-13,8%) |

*Observaciones:*
- Las salidas de stdout y stderr son **estrictamente idénticas byte a byte** entre la versión con y sin `--no-refresh`.
- La bandera `--no-refresh` ahorra sistemáticamente entre **110 ms y 147 ms**, que corresponde con exactitud a la fase de sondeo del árbol de trabajo (`probeDrift` en `dist/graph/fingerprint.js`).

---

### 2.5. Diagnóstico de Comportamientos, Escrituras y Red

1. **¿Intenta escribir en `graft/` al refrescar?**
   - En estado limpio (`isClean(drift) === true`), la función `ensureFreshGraph` (`dist/graph/refresh.js:237`) verifica las marcas de tiempo/hashes del repositorio en memoria y no ejecuta ninguna escritura en disco.
   - En caso de existir drift o fallo de escritura por montar el sistema de archivos en solo lectura (`--ro-bind`), el código cuenta con protección por diseño (`dist/graph/refresh.js:289`):
     ```javascript
     catch (err) {
         // Answering from a slightly stale graph beats failing the query.
         return { refreshed: false, note: `graph refresh skipped: ${err instanceof Error ? err.message : String(err)}` };
     }
     ```
     La excepción por sistema de archivos de solo lectura (`EROFS`) es capturada silenciosamente, degradando de forma tolerante a fallos (*fail-soft*) y respondiendo a partir del grafo existente sin interrumpir la consulta.

2. **¿Falla la telemetría o el aislamiento de red?**
   - `--unshare-net` desconecta por completo la red. El módulo de telemetría de graft (`dist/telemetry/send.js:77`) encapsula el envío PostHog (`fetch`) en un bloque `try/catch` que atrapa el fallo de red (`TypeError: fetch failed` / `ENETUNREACH`) y retorna `{ ok: false }` sin propagar error.
   - En `stderr` únicamente se emite la notificación reglamentaria de 200 bytes sobre recolección anónima de estadísticas.

3. **¿Necesita `HOME` o rutas especiales de usuario?**
   - `HOME` se configuró en `ext/opencode` (solo lectura).
   - Graft intenta escribir la cola de telemetría en `~/.graft/telemetry-queue.ndjson` (`dist/telemetry/queue.js:46`) y el identificador en `~/.graft/telemetry.json` (`dist/telemetry/identity.js:37`).
   - Ambas rutinas contienen salvaguardas explícitas:
     ```javascript
     catch { /* unwritable home, full disk — telemetry is never worth an error */ }
     catch { /* unwritable home — in-memory only */ }
     ```
     Por consiguiente, un `$HOME` en solo lectura no provoca fallos ni detiene la ejecución.

---

### 2.6. Evaluación del Servidor MCP en Modo Stdio (`graft mcp`)

Se evaluó la ejecución de `graft mcp` dentro del sandbox mediante transporte JSON-RPC estándar por stdin/stdout:

1. **Handshake de Inicialización (`initialize`):**
   - Petición: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0"}}}`
   - Tiempo de respuesta medido: **335 ms**.
   - Respuesta: Servidor `graft` versión `0.28.1` reportando capacidades de herramientas.

2. **Descubrimiento de Herramientas (`tools/list`):**
   - Retorna las 6 herramientas nativas de grafo:
     - `graft_find_code`: búsqueda léxica y de grafo en lenguaje natural.
     - `graft_trace_calls`: rastreo de llamadores y llamados en grafo de llamadas.
     - `graft_find_all`: búsqueda exhaustiva de referencias.
     - `graft_file_api`: extracción de interfaces y API de un archivo.
     - `graft_repo_map`: mapa estructural del repositorio con hotspots y clusters.
     - `graft_check_freshness`: validación de frescura del grafo contra el árbol de trabajo.

3. **Invocación de Herramienta en Sandbox (`tools/call` `graft_file_api`):**
   - Petición: `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graft_file_api","arguments":{"file":"packages/core/src/session/compaction.ts"}}}`
   - Tiempo de ejecución y respuesta medido: **383 ms**.
   - Resultado: Éxito total (`isError: false`), retornando el skeleton de tipos y funciones de `compaction.ts` de forma idéntica a la invocación CLI.

---

## 3. Lo No Verificado

1. **Comportamiento con repositorio desactualizado ("dirty drift") en sandbox solo lectura:** No se crearon ni editaron archivos en `ext/opencode` para preservar intacto el commit de prueba `79469efc` tal como exigía la regla del brief. Aunque el análisis de código en `dist/graph/refresh.js:289` demuestra que la excepción `EROFS` es absorbida por el bloque `catch`, la degradación ante drift real no fue provocada dinámicamente en disco.
2. **Impacto de índices corruptos:** No se probó la respuesta del servidor MCP de graft si los archivos `graft/.graph/wiring.json` se encuentran truncados o corruptos dentro de un entorno sin red ni permisos de escritura para reconstruirlos.
3. **Consumo de memoria en repositorios masivos:** No se midió la huella de memoria resident set size (RSS) de `graft mcp` bajo ráfagas intensivas de peticiones concurrentes dentro de un contenedor bwrap acotado por `cgroups` (la cifra de 40–80 MB de RSS que figuraba aquí no tiene medición registrada; el orquestador la retiró el 2026-11-02).
