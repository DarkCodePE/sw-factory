# 12 · Prerrequisitos Pendientes de fab exec

Para que la propuesta v0.2 de `fab investigación` pueda ejecutarse de forma desatendida y medir con rigor empírico tanto hipótesis de instrucciones como mejoras en el propio motor de código, es necesario resolver **cuatro prerrequisitos de código** en el agente nativo [`fab exec`](../exec/index.md) y completar la **conexión operativa** del servidor MCP de `graft` en el sandbox.

---

## 1. Mapa de Prerrequisitos y Dependencias

```mermaid
flowchart TD
    subgraph P1 ["Prerrequisito 1: Reporte de Coste en native"]
        E1["engine.ts: cuenta tokens en memoria"] --> A1["exec.ts: no emite bloque de coste en texto"]
        A1 --> AG1["agents.ts: native carece de parse()"]
        AG1 --> P1_RES["pool.ts y improve.ts reciben usage = NULL"]
    end

    subgraph P2 ["Prerrequisito 2: Montaje RO de Bóveda"]
        B2["Sandbox bwrap solo monta workspace cwd"] --> F2["Falta flag CLI --ro-bind-dir en exec-flags.ts"]
        F2 --> P2_RES["Lector no puede leer wiki/*.md sin red ni app"]
    end

    subgraph P3 ["Prerrequisito 3: Bloqueo de ExitSpecMode"]
        S3["session-tools.ts: allowExitSpecMode"] --> F3["Falta exponer flag CLI --disable-exit-spec"]
        F3 --> P3_RES["Garantía incondicional de solo lectura para el Lector"]
    end

    subgraph P4 ["Prerrequisito 4: Runner de Dos Builds"]
        I4["improve.ts solo compara digests de perfiles"] --> F4["Falta runner binario baseline vs candidate"]
        F4 --> P4_RES["Ideas de motor quedan INCONCLUSIVE(sin runner)"]
    end

    subgraph P5 ["Conexión MCP: graft en mcp-sandbox"]
        C1["mcp.ts:38, 87 y rpc.ts:118 ya soportan readPaths"] --> C2["lector-fab.ts genera config con node y paquete graft"]
        C2 --> C3["tests/lector-fab.test.ts valida ejecución en bwrap"]
        C3 --> P5_RES["Pendiente: conectar graft mcp a un agente de fab real"]
    end
```

---

## 2. Prerrequisito 1: Reporte de Coste y Tokens en el Adaptador `native`

Es el bloqueo más crítico para la evaluación económica de los experimentos (ADR-0004, `docs/research/arquitectura-ideacion/REVISION.md`).

### Estado Actual en el Código

!!! success "Implementado: Conteo Interno"
    El bucle del motor `runCodingAgent` acumula rigurosamente los tokens reportados por los proveedores en cada turno conversacional:
    ```typescript
    const usage = { inputTokens: 0, outputTokens: 0 };
    // ...
    if (response.usage) for (const key of ['inputTokens', 'outputTokens'] as const) {
      const n = response.usage[key]; if (Number.isSafeInteger(n) && n >= 0) usage[key] += n;
    }
    ```
    (`src/agent/engine.ts:42, 165-168`). El objeto terminal `AgentResult` contiene el registro `{ usage }`.

!!! warning "Hueco en la Salida CLI y en la Factory"
    1. **Salida Texto de `fab exec`:** Cuando se ejecuta en modo texto (`--output-format text`, valor por defecto), el CLI imprime exclusivamente `result.text` (`src/agent/exec.ts:292-295`); no incluye los tokens consumidos ni calcula el coste en dólares.
    2. **Ausencia de Parser en el Adaptador:** En `src/agents.ts:29-37`, solo el adaptador `claude` define la función `parse` (`parseClaudeJson`, `src/agents.ts:60, 64-74`). El adaptador `native` (`src/agents.ts:131-140`) carece de función `parse`.
    3. **Impacto en `improve.ts`:**
       Al terminar la actividad, el pool escribe `usage: run.usage ?? null` (`src/pool.ts:223-226`). Dado que `run.usage` es `undefined`, se persiste como `NULL`. En consecuencia, la función `armCost` (`src/improve.ts:116-129`) reporta `costUsd: null`.

**Consecuencia:** Si el implementador corre con `native`, `improve.ts` no puede medir el coste por brazo. El gate de gasto ×1.2 de ESF produce invariablemente `INCONCLUSIVE(coste NULL)`.

### Solución Requerida
- Modificar el adaptador `native` en `src/agents.ts` para invocar `fab exec --output-format json` o incorporar un bloque estructurado de telemetría al final de la salida estándar:
  ```text
  USAGE: input_tokens=1420 output_tokens=312 cost_usd=0.0142
  ```
- Implementar la función `parseNativeOutput(stdout: string): { text: string; usage?: AgentUsage }` en `src/agents.ts`, permitiendo que el pool registre el consumo real de `native`.

---

## 3. Prerrequisito 2: Montaje de la Bóveda en el Sandbox (`--ro-bind-dir`)

Para cumplir con el diseño de fuentes no confiables (ADR-0002, ADR-0007), el rol de lector debe consultar las páginas de la bóveda (`<proyecto>/wiki/*.md`) sin acceso a red y sin arrancar la aplicación de escritorio `llm_wiki`.

### Estado Actual en el Código
- El sandbox Bubblewrap monta el sistema de archivos del SO en solo lectura y el directorio de trabajo actual en lectura/escritura (`src/agent/mcp-sandbox.ts:28`).
- No existe un parámetro CLI en `src/agent/exec-flags.ts` para suministrar rutas adicionales que deban montarse en modo de solo lectura dentro del espacio de nombres del proceso.

### Solución Requerida
- Agregar la opción CLI `--ro-bind-dir <ruta_host>[:<ruta_contenedor>]` a `src/agent/exec-flags.ts`.
- Trasladar esta lista de montajes a `wrapCommand` en `src/sandbox/wrap.ts` para que `bwrap` añada directivas `--ro-bind <ruta_host> <ruta_contenedor>`, permitiendo que el lector ejecute `Grep` o `ripgrep` sobre las notas de la bóveda de forma segura.

---

## 4. Prerrequisito 3: Confinamiento Irreversible de Solo Lectura

El hallazgo de la Fase 1 demostró que únicamente `codex` y `native` aplican restricciones reales de solo lectura en la fábrica (`src/agents.ts:83-85, 139`).

### Estado Actual en el Código
- Al pasar `--use-spec`, el motor bloquea las herramientas mutadoras (`src/agent/engine.ts:94`).
- Sin embargo, el catálogo inyecta la herramienta `ExitSpecMode` (`src/agent/session-tools.ts:10-27`). Aunque en autonomía `medium` o `low` la transición exige confirmación interactiva humana, en ejecuciones desatendidas o si la autonomía se configurara alta, el modelo podría solicitar la salida del modo spec.
- El código ya contempla la propiedad `allowExitSpecMode: false` (`src/agent/session-tools.ts:13`), pero dicha opción se asigna internamente en subagentes o validadores; no está cableada a un flag CLI expuesto en `exec.ts`.

### Solución Requerida
- Añadir el flag `--disable-exit-spec` en `src/agent/exec-flags.ts`.
- Mapearlo a `opts.allowExitSpecMode = false` en `src/agent/exec.ts:244-271`, sellando de forma irreversible el modo de solo lectura para el rol de lector.

---

## 5. Prerrequisito 4: Runner de Dos Builds de `fab`

Actualmente, el ciclo de ideación está restringido a medir mejoras de **prompts, perfiles de instrucciones o habilidades** (ADR-0004, `ARQUITECTURA.md` §6).

### Estado Actual en el Código
- La herramienta de medición empírica `improve.ts` compara dos configuraciones recibiendo el `digest` de dos perfiles sobre la misma instalación de la fábrica:
  ```typescript
  async function runArm(
    split: SuiteSplit,
    digest: string,
    agent: string,
    // ...
  )
  ```
  (`src/improve.ts:132`).
- Si una hipótesis plantea una modificación en el código del propio agente (por ejemplo, un nuevo algoritmo de compactación en `engine.ts` o una mejora en `patch.ts`), `improve.ts` no tiene capacidad de evaluar el impacto porque ambos brazos (`baseline` y `candidate`) ejecutarían el mismo código TypeScript subyacente.
- Toda idea orientada a la arquitectura interna del motor debe catalogarse actualmente como `INCONCLUSIVE(sin runner)` (ADR-0004).

### Solución Requerida
- Desarrollar una extensión para `improve.ts` (o un subcomando `fab improve-engine`) que admita dos binarios compilados o dos ramas de código distintas (`--baseline-binary dist/fab-baseline --candidate-binary dist/fab-candidate`), ejecutando los brazos pareados de las suites contra sus respectivos ejecutables.

---

## 6. Conexión de graft en el Sandbox: Configuración Nativa Resuelta

La auditoría de ejecución de herramientas externas en Bubblewrap (`docs/research/arquitectura-ideacion/codesearch/medicion/a2-y-sandbox.md:145-216`) identificó que programas Node.js como `graft` requieren acceso al binario `node` (frecuentemente instalado bajo NVM) y a los módulos ESM relativos de su paquete npm (`brand.js`).

### El Código de fab ya Soporta `readPaths`

A diferencia de los prerrequisitos 1 a 4, **no hace falta modificar el código fuente de fab** (`docs/research/arquitectura-ideacion/codesearch/plan-implementacion-adr-0008.md:7`):
- `src/agent/mcp.ts:38` define `readPaths?: string[]` dentro de la interfaz `McpConfig`.
- `src/agent/mcp.ts:87-88` pasa incondicionalmente `config.readPaths` al constructor del sandbox `wrapMcpCommand`.
- `src/agent/rpc.ts:118` incluye `'readPaths'` en el conjunto estricto de campos permitidos en la configuración RPC de servidores MCP.
- `src/agent/mcp-sandbox.ts:18, 27` genera las directivas `--ro-bind` correspondientes para cada ruta configurada en `readPaths`.

### Estado de la Implementación
- El adaptador `scripts/ideas/lector-fab.ts:8-16` implementa la función `buildMcpConfig(graftBin, nodeBin)`, que resuelve mediante `realpathSync` el binario de Node y la raíz del paquete npm `@nanonets/graft`.
- La prueba `tests/lector-fab.test.ts:11-20` verifica que `wrapMcpCommand` arranca `graft --version` con éxito en un contenedor aislado con `--unshare-net` y directorio de trabajo efímero.

!!! info "Tarea Operativa Pendiente"
    La arquitectura del sandbox está **resuelta y probada**. Lo único que resta es un paso operativo: **conectar `graft mcp` a un agente de fab real** configurando la entrada generada por `lector-fab.ts` en `mcpServers` durante una sesión real de producción (ADR-0008, seguimiento 4).

---

## Resumen de Estado de Prerrequisitos

| Prerrequisito | Qué Falta | Archivo Afectado | Impacto en la Propuesta v0.2 |
| :--- | :--- | :--- | :--- |
| **Coste en `native`** | Exponer métricas de consumo en salida CLI y crear `parse` en adapter | `src/agent/exec.ts`, `src/agents.ts` | **Bloqueante**: sin esto, el gate de gasto da `INCONCLUSIVE` en `improve.ts`. |
| **Montaje de Bóveda** | Flag CLI `--ro-bind-dir` para inyectar directorios externos en `bwrap` | `src/agent/exec-flags.ts`, `src/sandbox/wrap.ts` | **Bloqueante**: impide lectura headless de `wiki/*.md` en sandbox. |
| **Sello de Spec** | Flag CLI `--disable-exit-spec` para deshabilitar `ExitSpecMode` | `src/agent/exec-flags.ts`, `src/agent/exec.ts` | **Seguridad**: garantiza que el Lector no mute el workspace. |
| **Runner de 2 Builds** | Comparar dos binarios ejecutables en brazos pareados de `improve.ts` | `src/improve.ts` | **Alcance**: sin esto, solo se miden perfiles y prompts, no motor. |
| **Conexión graft en Sandbox** | Conectar `graft mcp` en `mcpServers` de un agente real (código resuelto en fab) | `scripts/ideas/lector-fab.ts`, `src/agent/mcp.ts` | **Operativo**: el código de fab ya soporta `readPaths`; falta enlazar en sesión. |

---

## Archivos

| Archivo | Responsabilidad |
| :--- | :--- |
| `src/agent/engine.ts` | Conteo de tokens en memoria (`usage`, `:42, 165-168`). |
| `src/agent/exec.ts` | Formateo de salida en CLI (`:291-295`). |
| `src/agents.ts` | Definición de adaptadores de agentes; falta `parse` en `native` (`:131-140`). |
| `src/improve.ts` | Acumulación de costes (`armCost`, `:116-129`) y comparación pareada de perfiles (`:132`). |
| `src/agent/session-tools.ts` | Guarda `allowExitSpecMode` en la herramienta `ExitSpecMode` (`:13`). |
| `src/sandbox/wrap.ts` | Construcción de argumentos de Bubblewrap (`bwrap`). |
| `src/agent/mcp.ts` | Soporte nativo de `readPaths` en `McpConfig` (`:38`) y pase a `wrapMcpCommand` (`:87-88`). |
| `src/agent/rpc.ts` | Validación de campos permitidos en configuración MCP (`:118`). |
| `src/agent/mcp-sandbox.ts` | Aislamiento de servidores MCP en Bubblewrap (`:10, 15, 18, 27`). |
| `scripts/ideas/lector-fab.ts` | Adaptador que genera configuración MCP con `readPaths` para graft (`:8-16`). |
| `tests/lector-fab.test.ts` | Test de integración que valida `wrapMcpCommand` con `readPaths` (`:11-20`). |
| `docs/research/arquitectura-ideacion/adr/ADR-0004-evaluacion-no-es-promocion.md` | Decisión de diseño: evaluación escalonada T0/T1/T2 y prerrequisitos. |
| `docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md` | Decisión formal aceptada: lectura con umbral medido e integración de sandbox. |
