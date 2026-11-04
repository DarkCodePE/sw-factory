# Medición Fase B (ADR-0008): A0 (Graft) y A2 (Búsqueda Libre) sobre deer-flow

Fecha: 2026-11-02.  
Repositorio evaluado: `ext/deer-flow` en commit `35656d6` (Python, ~871 k líneas `.py`, montado en modo solo lectura).  
Herramientas: graft 0.28.1 bajo Node v22.22.1 y Bubblewrap (`bwrap`); utilidades estándar POSIX (`rg`, `find`, `ls`, `sed -n`, `head`).  
Metodología: 2 repeticiones idénticas por celda en A0 con comprobación estricta de hash `md5`; registro cronológico de comandos, bytes y tiempos de A2 en `/tmp/claude-1000/a2-deerflow-log.txt`.

---

## 1. Verificación del Prerregistro y Estado del Repositorio

Antes de ejecutar cualquier búsqueda o consulta de graft se comprobó la integridad criptográfica de los archivos de tareas y de referencia mediante `sha256sum`. La verdad de referencia (`verdad-deerflow.md`) permaneció sellada y no fue leída hasta concluir la totalidad de las fases de ejecución de A2 y A0.

| Archivo | Hash sha256 medido | Hash esperado | Estado |
| :--- | :--- | :--- | :---: |
| `medicion/tareas-deerflow.md` | `2fe5fd0a6e8e2df8f285e4dd1b9064a3abba01d1df9b78b6ef717a475885754f` | `2fe5fd0a…` | ✔ Válido |
| `medicion/verdad-deerflow.md` | `6352c69d416da3beb3d730caf04a9f55dfcf212ae65a4d32d8ea5678fab137aa` | `6352c69d…` | ✔ Válido (sellado) |

Estado del repositorio evaluado (`ext/deer-flow`):
- Commit: `35656d6` (verificado con `git rev-parse --short HEAD`).
- `git status --short`: no modificado durante la evaluación (`M .gitignore` y `?? .ignore` eran preexistentes a la prueba).
- El índice de graft preexistente se ubica en `deer-flow/graft/` con un grafo `wiring.json` de 62.890 nodos.

---

## 2. Brazo A2: Búsqueda Agéntica Libre (a ciegas)

Búsqueda interactiva realizada sin conocimiento previo de `verdad-deerflow.md`, utilizando exclusivamente la redacción R1 de cada tarea y herramientas estándar POSIX (`rg`, `find`, `ls`, `sed -n`, `head`). Sin invocación alguna de `graft`. Cada comando fue monitorizado en nanosegundos y registrado con sus bytes de salida en `/tmp/claude-1000/a2-deerflow-log.txt`.

### 2.1. Tabla Resumen A2

| Tarea | Redacción R1 | Respuesta final (`archivo:línea`) | Acierto | Comandos | Bytes | Tokens (bytes/4) | Tiempo shell (ms) |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **T1** (localizar) | "¿Dónde y cómo se compacta o resume el contexto del agente cuando la conversación se hace demasiado larga?" | `backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py`: clase `DeerFlowSummarizationMiddleware` (:122), métodos `before_model` (:721) / `abefore_model` (:724), `compact_state` (:858) / `acompact_state` (:911), trigger `_prepare_compaction` (:727), notificación `_record_compaction` (:799). Punto de entrada manual: `backend/packages/harness/deerflow/runtime/context_compaction.py:146` (`compact_thread_context`). | Acierto exacto | 10 | 14.521 | 3.630 | 62 ms |
| **T2** (aristas) | "¿Qué comprobación de seguridad o política se aplica antes de ejecutar una tool call y dónde se instala?" | `backend/packages/harness/deerflow/guardrails/middleware.py`: clase `GuardrailMiddleware` (:25), métodos `wrap_tool_call` (:182) y `awrap_tool_call` (:232), que delegan en `provider.evaluate` (:190) y `provider.aevaluate` (:240), aplicando OAP codes y política fail-closed (:196) / fail-open (:207). Se instala en `backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py:456` (autorización) y `:487` (guardrails explícitos) dentro de `_build_runtime_middlewares` (:350). | Acierto exacto | 9 | 30.117 | 7.529 | 104 ms |
| **T3** (exhaustivo) | "Todas las ocurrencias del literal `GuardrailDecision` bajo `backend/` (archivos y recuento)" | 74 ocurrencias en 74 líneas distribuidas en 11 archivos bajo `backend/` (10 archivos de código Python con 64 ocurrencias + `backend/docs/GUARDRAILS.md` con 10 ocurrencias). Idéntico con `--hidden` y `--no-ignore`. | Acierto exacto | 5 | 1.149 | 287 | 90 ms |
| **T4** (conceptual) | "¿Cómo se crea y elige el modelo de chat para una petición?" | Resolución y precedencia: `backend/packages/harness/deerflow/agents/lead_agent/agent.py:1076` (`_resolve_model_name`: petición → configuración de agente → valor por defecto global) y autorización en `backend/packages/harness/deerflow/models/selection.py:93` (`authorize_selected_model`) y `:52` (`resolve_model_control`). Normalización de razonamiento en `:1090`. Factoría de instanciación: `backend/packages/harness/deerflow/models/factory.py:536` (`create_chat_model`), que resuelve proveedor por reflexión (`resolve_class`), credenciales, Thinking dialect y retorna `BaseChatModel`. | Acierto exacto | 12 | 23.527 | 5.881 | 50 ms |
| **T5** (API archivo) | "Superficie pública de `backend/packages/harness/deerflow/guardrails/provider.py`" | Archivo de 74 líneas sin `__all__`. Superficie completa compuesta por 4 clases: `GuardrailRequest` (:10, dataclass de contexto), `GuardrailReason` (:41, dataclass OAP reason), `GuardrailDecision` (:48, dataclass de veredicto), y `GuardrailProvider` (:58, Protocol con `name: str`, `evaluate` :68 y `aevaluate` :72). | Acierto exacto | 3 | 3.079 | 769 | 7 ms |
| **Total** | — | — | **5/5** | **39** | **72.393** | **18.098** | **313 ms** |

---

## 3. Brazo A0: Graft tal cual en Sandbox Aislado

Todas las celdas se ejecutaron en `bwrap` sin acceso a red (`--unshare-net`), con la raíz del sistema en solo lectura, un tmpfs efímero en `/tmp` y el repositorio montado estrictamente en solo lectura (`--ro-bind /home/orlando/Desktop/factory/ext/deer-flow`). Todas las llamadas incluyeron la bandera `--no-refresh` para garantizar que no se intentara escritura sobre el grafo.

Cada celda se ejecutó en 2 repeticiones consecutivas. En el 100 % de las celdas el hash `md5` de la salida de la corrida 1 coincidió bit a bit con el de la corrida 2 (`md5_match = True`).

### 3.1. Evaluación de `ask` (T1, T2, T4 × R1–R3)

Rango del primer hit que contiene la verdad de referencia (en una ventana de 8 hits por respuesta).  
- "Archivo": ruta del archivo de referencia indicada en `verdad-deerflow.md`.  
- "Símbolo": hit de símbolo cuyo rango de líneas contiene la definición de la verdad.  
- "—": no apareció entre los 8 hits devueltos.

| Celda | Redacción | Primer hit Archivo | Primer hit Símbolo | Bytes | Tokens | Tiempo (s) | md5 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1·R1** | "¿Dónde y cómo se compacta o resume el contexto del agente cuando la conversación se hace demasiado larga?" | — | — | 2.099 | 524 | 3,34 s | `7136a10d` |
| **T1·R2** | "conversation context summarization when too many tokens" | **2** (`summarization_middleware.py`) | **2** (`DeerFlowSummarizationMiddleware` :122-1062) | 3.781 | 945 | 3,25 s | `1f3ae0ae` |
| **T1·R3** | "compact agent state to free context" | **2** (`summarization_middleware.py`) | **2** (`compact_state` :858-909) | 3.256 | 814 | 3,57 s | `275e188e` |
| **T2·R1** | "¿Qué comprobación de seguridad o política se aplica antes de ejecutar una tool call y dónde se instala?" | — | — | 3.243 | 810 | 3,39 s | `e3d04862` |
| **T2·R2** | "guardrail check before tool execution" | **4** (`guardrails/middleware.py`) | **4** (`GuardrailMiddleware` :25-279) | 2.696 | 674 | 3,43 s | `3efddc45` |
| **T2·R3** | "who evaluates tool call policy and where is it wired" | — | — | 3.299 | 824 | 3,75 s | `617a65fc` |
| **T4·R1** | "¿Cómo se crea y elige el modelo de chat para una petición?" | — | — | 1.669 | 417 | 3,30 s | `027f1b67` |
| **T4·R2** | "how is the chat model created and selected" | **1** (`selection.py`) / **5** (`factory.py`) | **5** (`create_chat_model` :536-731) | 2.848 | 712 | 3,56 s | `370c4c66` |
| **T4·R3** | "model instantiation logic" | — | — | 2.295 | 573 | 3,42 s | `8d92b3d2` |

**Resumen de métricas de `ask` en deer-flow:**
- **hit@1 de archivo**: 1 / 9 (11,1 %, en T4·R2 con `models/selection.py`).
- **hit@5 de archivo**: 4 / 9 (44,4 %: T1·R2, T1·R3, T2·R2, T4·R2).
- **hit@1 de símbolo**: 0 / 9 (0 %).
- **hit@5 de símbolo**: 4 / 9 (44,4 %: T1·R2, T1·R3, T2·R2, T4·R2).
- **Sensibilidad por idioma**:
  - **R1 (español conceptual)**: **0 / 3 aciertos** (0 %). En T1·R1 la palabra "resume" provocó falsos positivos léxicos vinculados al verbo inglés *resume* (`PatchedChatMiMo`, `reportResumeError`, `resume`); en T2·R1 y T4·R1 devolvió componentes no relacionados o componentes de frontend (`DanglingToolCallMiddleware`, `chat-page.tsx`).
  - **R2 (inglés temático directo)**: **3 / 3 aciertos en hit@5** (100 %).
  - **R3 (inglés variado)**: **1 / 3 aciertos en hit@5** (33,3 %, acierto en T1·R3 por los términos `compact` y `state`; fallo en T2·R3 y T4·R3).
- **Volumen total de las 9 celdas `ask`**: 25.186 bytes (6.293 tokens), tiempo acumulado de ejecución de 30.938 ms (~30,9 s).

---

### 3.2. Celdas Estructurales: T3 (`grep`), T5 (`skeleton`) y T2 (`callers`)

| Celda | Comando exacto | Salida medida | Bytes | Tokens | Tiempo (s) | md5 |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **T3** (grep) | `graft grep --fixed GuardrailDecision --no-refresh` | Cabecera: *"64 hits in 45 symbols across 10 files (searched 3631 indexed files)"*. Encuentra exactamente los 10 archivos de código Python que contienen el literal (64 ocurrencias). Omite el archivo de documentación `backend/docs/GUARDRAILS.md` (10 ocurrencias). | 10.960 | 2.740 | 3,29 s | `4bf4fa9e` |
| **T5** (skeleton) | `graft skeleton backend/packages/harness/deerflow/guardrails/provider.py --no-refresh` | Lista 6 entidades estructuradas: `GuardrailRequest` (:10-36), `GuardrailReason` (:40-44), `GuardrailDecision` (:48-54), `GuardrailProvider` (:58-74), y métodos `evaluate` (:68-70), `aevaluate` (:72-74). Cobertura del 100 % de la API pública. | 822 | 205 | 0,87 s | `f4b31ad9` |
| **T2** (callers 1) | `graft callers evaluate --no-refresh` | Vuelca **25 definiciones** con nombre `evaluate` (17.609 bytes). En `backend/packages/harness/deerflow/guardrails/provider.py:L68-L70` reporta: *"no indexed callers — 25 definitions share the name 'evaluate'; a cross-file caller of an ambiguous name is dropped rather than guessed"*. No detecta la llamada de `GuardrailMiddleware.wrap_tool_call` (:190). | 17.609 | 4.402 | 1,43 s | `64ac0f6e` |
| **T2** (callers 2) | `graft callers wrap_tool_call --no-refresh` | Vuelca **30 definiciones** con nombre `wrap_tool_call` (39.849 bytes). Para `GuardrailMiddleware.wrap_tool_call` (:182-229) lista únicamente invocaciones desde tests unitarios (`test_guardrail_middleware.py`), sin aristas hacia el flujo de ejecución del agente. | 39.849 | 9.962 | 1,42 s | `a6f69ddd` |

---

## 4. Cobertura del Índice (`wiring.json`)

Se analizó exhaustivamente el grafo generado por graft en `ext/deer-flow/graft/.graph/wiring.json`.

- **Volumen total del grafo**: 62.890 nodos indexados.
- **Búsqueda de los símbolos de la verdad en `wiring.json`**:
  - `DeerFlowSummarizationMiddleware` en `summarization_middleware.py`: **Presente** (`kind: class`).
  - `before_model` y `abefore_model` en `summarization_middleware.py`: **Presentes** (`kind: method`).
  - `compact_state` y `acompact_state` en `summarization_middleware.py`: **Presentes** (`kind: method`).
  - `_record_compaction` en `summarization_middleware.py`: **Presente** (`kind: method`).
  - `compact_thread_context` en `context_compaction.py`: **Presente** (`kind: function`).
  - `GuardrailMiddleware` en `guardrails/middleware.py`: **Presente** (`kind: class`).
  - `wrap_tool_call` y `awrap_tool_call` en `guardrails/middleware.py`: **Presentes** (`kind: method`).
  - `evaluate` y `aevaluate` en `guardrails/provider.py`: **Presentes** (`kind: method`).
  - `create_chat_model` en `models/factory.py`: **Presente** (`kind: function`).
  - `resolve_model_control` en `models/selection.py`: **Presente** (`kind: function`).
  - `GuardrailRequest`, `GuardrailReason`, `GuardrailDecision`, `GuardrailProvider` en `provider.py`: **Presentes** (`kind: class`).
  - `notify_context_compacted`: presente en `extensions/notify.py` (su archivo de definición original).

### Diagnóstico de la Cobertura:
A diferencia de lo observado en `opencode` (TypeScript con Effect), donde los símbolos anidados en closures funcionales (`Effect.fn`) no eran extraídos por el parser AST, en Python el parser de graft extrajo prácticamente el **100 % de las clases, funciones y métodos** hacia el grafo `wiring.json`.

Sin embargo, a pesar de que los símbolos existen en el índice, **los problemas de recuperación persisten**:
1. **En `ask`**: El motor clasifica por coincidencia léxica superficial y acoplamiento de grafo sin comprensión semántica. Si la consulta está en español o usa vocabulario que no coincide literalmente con los identificadores en snake_case/PascalCase de Python, el ranking se dispersa hacia falsos positivos (como la colisión léxica del término en español "resume" con métodos y variables de reanudación).
2. **En `callers`**: El tipado dinámico y la inyección de dependencias en Python generan colisiones masivas de nombres. Con 25 métodos llamados `evaluate` y 30 llamados `wrap_tool_call`, la heurística conservadora de graft descarta las aristas entre archivos para evitar conjeturas erróneas. Por diseño, graft no puede enlazar `self.provider.evaluate()` con la definición de la interfaz `GuardrailProvider`.

---

## 5. Comparación Cruzada: deer-flow (Python) vs opencode (TypeScript/Effect)

| Dimensión | opencode (`m1-m4.md`, `a2-y-sandbox.md`) | deer-flow (este informe) | Interpretación |
| :--- | :---: | :---: | :--- |
| **Lenguaje y paradigma** | TypeScript, funcional / Effect-TS | Python, orientado a objetos / protocolos | Paradigmas radicalmente distintos. |
| **A2: Tasa de acierto** | **5 / 5** (100 %) | **5 / 5** (100 %) | La búsqueda libre agéntica con herramientas estándar resuelve consistentemente el 100 % de las tareas en ambos ecosistemas. |
| **A2: Consumo y comandos** | 52 comandos, 168.686 B (~42 k tok), 1.126 ms shell | 39 comandos, 72.393 B (~18 k tok), 313 ms shell | A2 requirió menos bytes y menos comandos en deer-flow debido a una estructura de módulos más canónica. |
| **A0 `ask`: hit@1 de archivo** | 1 / 9 (11,1 %) | 1 / 9 (11,1 %) | Rendimiento idéntico en el primer resultado. |
| **A0 `ask`: hit@5 de archivo** | 2 / 9 (22,2 %) | 4 / 9 (44,4 %) | Mejora en deer-flow al tener nombres de módulo temáticos (`summarization_middleware.py`). |
| **A0 `ask`: hit@1 de símbolo** | 0 / 9 (0 %) | 0 / 9 (0 %) | Ningún brazo A0 colocó el símbolo exacto en el primer lugar. |
| **A0 `ask`: hit@5 de símbolo** | 0 / 9 (0 %) | 4 / 9 (44,4 %) | En opencode los hits carecían de rangos o símbolos; en deer-flow las clases indexadas permitieron aciertos dentro de los 5 primeros cuando el prompt era en inglés. |
| **A0 `ask`: R1 (español)** | 0 / 3 (0 %) | 0 / 3 (0 %) | **Fallo total y sistemático en lenguaje natural / español** en ambos repositorios. |
| **A0 `callers`: desambiguación** | Falló (símbolos ausentes del grafo por `Effect.fn`) | Falló (25-30 definiciones ambiguas; aristas descartadas) | En opencode el fallo era del *parser*; en deer-flow es del *modelo de enlace estático ante polimorfismo dinámico*. |
| **A0 `grep`: exhaustividad** | 36 coincidencias en 21 archivos (omitió archivos no indexados) | 64 coincidencias en 10 archivos (omitió `docs/GUARDRAILS.md`) | `graft grep` solo busca en archivos de código fuente indexados, perdiendo referencias en documentación o especificaciones. |
| **A0 `skeleton`: fidelidad** | ~83 % (perdió constantes `layer` y `node`) | 100 % (4 clases, 2 métodos) | El skeleton en Python es fiel cuando las clases siguen la sintaxis estándar. |

---

## 6. Conclusión: ¿El Patrón de opencode se Repite o No?

**Sí, el patrón estructural de opencode se repite.** La medición en `deer-flow` confirma de manera contundente las siguientes conclusiones del ADR-0008:

1. **La búsqueda agéntica libre (A2) es superior en fiabilidad**: Logra un **5 de 5 (100 % de aciertos exactos)** en ambos repositorios, consumiendo un presupuesto acotado de tokens (18 k en deer-flow frente a 42 k en opencode) y tiempos de ejecución mínimos en shell (<350 ms).
2. **`graft ask` no sustituye a la búsqueda agéntica**:
   - Sigue mostrando una dependencia crítica de las palabras clave exactas en inglés.
   - En redacción en español (R1) tiene una efectividad nula (**0 de 3** en opencode, **0 de 3** en deerflow).
   - Incluso en inglés, si la formulación es indirecta o conceptual (R3), falla en 2 de 3 casos.
3. **El fallo de `callers` no era un defecto exclusivo del estilo Effect**:
   - En `opencode` se atribuyó parte de la limitación a que `Effect.fn` ocultaba las definiciones ante el parser.
   - En `deer-flow`, a pesar de que el 100 % de los símbolos están perfectamente indexados en `wiring.json`, `graft callers` colapsa igualmente debido a la ambigüedad polimórfica (25 definiciones de `evaluate`, 30 de `wrap_tool_call`), descartando las aristas reales de llamada en tiempo de ejecución.
4. **Validación del diseño de Probe en el ADR-0008**:
   - Se ratifica la **Decisión 2 del ADR-0008**: el localizador agéntico principal debe ser un buscador de texto y patrones sobre archivos reales (`rg` acotado con presupuesto y spill), relegando a `graft ask` y `callers` a un papel complementario y estrictamente opcional.
   - Se ratifica la necesidad de la envoltura M3 para contener salidas desbordadas (como los ~40 KB de `callers wrap_tool_call`).

---

## 7. Lo No Verificado

1. **Ejecución de A1 (envoltura `graft-lector.ts`) sobre deer-flow**: La medición evaluó A0 (graft directo) y A2 (búsqueda libre). No se ejecutó la envoltura A1 sobre deer-flow ya que el script actual está parametrizado para TypeScript y el plan priorizó la comparación de los dos enfoques base (A0 vs A2).
2. **Variaciones sintácticas en `callers`**: Se midió `graft callers evaluate` tal como especificaba el brief; no se exploraron variantes cualificadas como `graft callers GuardrailProvider.evaluate` que pudieran haber reducido la ambigüedad en el grafo.
3. **Consultas semánticas con modelos de lenguaje integrados**: Todas las consultas a graft operaron bajo la premisa de coste $0 y sin LLM (`--no-refresh`), evaluando exclusivamente el grafo determinista y el índice léxico.
4. **Archivos ocultos o extensiones fuera de código**: Se confirmó que `graft grep` omite `backend/docs/GUARDRAILS.md`, pero no se verificó exhaustivamente qué otras extensiones no convencionales (ej. plantillas YAML, prompts en Markdown) quedan fuera de la cobertura de indexación de graft.
