# Aclaraciones Técnicas y Operativas de la Fábrica de Software (`sw-factory`) para Startería Lab

**Destinatarios:** Product Lead y Engineering Lead de Startería<br>
**Remitente:** Equipo de Arquitectura e Implementación de `sw-factory`<br>
**Fecha original:** 18 de octubre de 2026<br>
**Actualización de estado:** 21 de octubre de 2026 (consolidado sobre `main` `f023e47`, v0.1.0-rc.9)<br>
**Documentos de referencia analizados:**
- `01-decision-lab-spec-v0.1.md` (Product Spec de trabajo v0.1)
- `02-master-plan-v1.2.md` (Master Plan de producto y convergencia v1.2)
- `03-e2e-01-10-y-adversariales-anterior.md` (E2E y escenarios adversariales)

---

## 1. Qué es y qué no es la fábrica (en una página)

La fábrica de software (`sw-factory`) es una plataforma local de orquestación técnica que automatiza el ciclo de vida de cambios sobre repositorios de software existentes mediante agentes de inteligencia artificial y gates estrictos de validación humana.

```
Repositorio Git + Señal/Petición técnica
                 │
                 ▼
         [Triage a Change] ──▶ Gate Humano 1: Aprobación del Change
                                       │
                                       ▼
                       Actividad: Investigación (spec)
                       (Agente en modo solo lectura / spec)
                                       │
                                       ▼
                               [Spec generado] ──▶ Gate Humano 2: Aprobación del Spec
                                                           │
                                                           ▼
                                           Actividad: Implementación
                                           (Git Worktree dedicado: rama fab/<id>)
                                           (Agente en sandbox aislado bwrap)
                                                           │
                                                           ▼
                                            Comprobación de commits en rama fab/<id>
                                            (src/pool.ts:40-47; verificationCommands y
                                            protectedPaths aplican únicamente a fab exec --mission)
                                                           │
                                                           ▼
                                           Commit en rama fab/<id>
                                                           │
                                                           ▼
                                             Gate Humano 3: fab merge
```

### Qué ES la fábrica
- **Un ejecutor técnico sobre repositorios Git locales:** Conecta a repositorios locales existentes en el sistema de archivos (`src/worktrees.ts:20-21`) y administra cambios mediante ramas aisladas de trabajo (`fab/<id>`) en directorios independientes bajo `<stateDir>/worktrees/`.
- **Un modelo de dominio estricto y trazable:** Opera sobre la cadena formal `workstream` (flujo de trabajo vinculado a un repositorio) → `signal` (petición de cambio o bug en lenguaje técnico) → `change` (unidad de cambio discreta) → `activities` (`investigation` en solo lectura e `implementation` en código) (`src/enums.ts:5-49`).
- **Un pool de trabajadores desatendidos con agentes desacoplados:** Cuenta con un pool concurrente FIFO respaldado por SQLite local (`~/.fabrica/fabrica.db`) que asigna actividades a agentes de código configurables: motor propio (`native`), Claude Code (`claude`), Codex CLI (`codex`), Antigravity CLI (`agy`) o un mock determinista (`fake`) (`src/agents.ts:17-115`, `src/pool.ts:18-85`).
- **Un entorno con aislamiento de procesos de desarrollo:** Ejecuta comandos mediante `bubblewrap` (`bwrap`) con aislamiento de sistema de archivos raíz en solo lectura, red desconectada por defecto (`--unshare-net`), variables de entorno saneadas (`--clearenv`), y directorios temporales volátiles (`src/sandbox/wrap.ts:40-77`).
- **Un sistema con verificación objetiva en Misiones:** En el modo de misiones de `fab exec` (`--mission`), el runner ejecuta comandos objetivos de validación (`verificationCommands`), supervisa que los tests no hayan sido manipulados (`protectedPaths`) y audita los comandos realmente observados por el runtime antes de dar una tarea por cumplida (`src/agent/mission.ts:133-159`, `src/agent/mission-evidence.ts:80-145`). *(Aclaración crítica: en el flujo normal de la fábrica `src/pool.ts:40-47`, el pool actualmente comprueba únicamente que la actividad de implementación haya dejado commits en la rama `fab/<id>`; la ejecución automática de `verificationCommands` y el bloqueo por `protectedPaths` están activos hoy en el modo de misiones de `fab exec`, pero no en la cola estándar de `signal/change`).*

### Qué NO ES la fábrica
- **NO es un motor de negocio ni de producto:** No genera briefs de negocio, no evalúa modelos comerciales, no calcula retorno de inversión (ROI), ni ayuda al cliente a aclarar su problema estratégico.
- **NO realiza scouting de alternativas tecnológicas:** No compara 1–3 opciones arquitectónicas ni evalúa librerías o proveedores de mercado frente a una necesidad ambigua.
- **NO gestiona pruebas con usuarios reales:** No cuenta con módulos para recolectar feedback cualitativo de usuarios, ni gestiona paneles de prueba, ni valida encaje de mercado (PMF).
- **NO realiza hosting ni despliegues en la nube:** No aprovisiona infraestructura (AWS, GCP, Vercel), no configura dominios ni expone aplicaciones a internet. Su frontera termina en la rama Git local con tests aprobados.
- **NO gestiona rondas de cliente (R1/R2):** La fábrica no tiene noción comercial de "rondas de retroalimentación de cliente". Gestiona reintentos técnicos de actividades ante fallos de agentes (máximo 3 reintentos, `src/enums.ts:79`) y ciclos de re-evaluación si un humano rechaza una propuesta técnica (`src/store.ts:483-506`).
- **NO es multi-tenant ni una plataforma SaaS:** Es una herramienta CLI/TUI monousuario diseñada para ejecutarse en la máquina local o servidor de desarrollo del ingeniero (`src/cli.ts`, `src/tui.ts`).
- **NO es un "Lab bancario":** `sw-factory` es un proyecto de ingeniería de software general. Nunca fue diseñado como una operación bancaria, no procesa datos financieros sensibles ni cuenta con certificaciones bancarias.

### Entradas que acepta
1. Un **repositorio Git inicial existente** accesible en el disco local con configuración funcional básica y suite de pruebas (`src/worktrees.ts:20-21`).
2. Una **definición de workstream** con objetivo técnico claro y configuración de gates (`src/store.ts:84-88`).
3. **Señales o cambios estructurados:** Título claro, descripción técnica detallada, criterios de aceptación observables y comandos de verificación ejecutables (`src/store.ts:89-95`).
*La fábrica RECHAZA como entrada directa documentos ejecutivos, Decision Briefs comerciales o PRDs de negocio no descompuestos en tareas de software.*

### Salidas que produce
1. Una **rama Git dedicada `fab/<id>`** con commits atómicos y trazables listos para inspección o merge (`src/worktrees.ts:16-36`).
2. Un **documento de especificación técnica (`spec.md`)** generado en solo lectura durante la investigación previa (`src/pool.ts:28-39`).
3. **Evidencia objetiva de ejecución:** Salida de ejecución, código de retorno de comandos de verificación independientes (`bun test`, `pytest`, etc.) y reporte de herramientas observadas (`src/agent/mission-evidence.ts:110-145`).
4. **Métricas de consumo técnico:** Tiempo transcurrido en segundos por actividad y tokens acumulados (`src/pool.ts:48-49`, `src/agent/engine.ts`).

### Quién aprueba qué (Gates de aprobación humana)
- **Gate 1 — Aprobación del Cambio (`change_review`):** Un revisor humano aprueba en el Inbox o TUI que un cambio propuesto sea investigado (`src/store.ts:476-506`). Configurable opcionalmente como automático vía `--no-change-approval`.
- **Gate 2 — Aprobación de la Especificación (`investigation` / Spec Review):** Tras la investigación en solo lectura, el worker produce un spec. El sistema se pausa en estado `awaiting` y un humano debe revisar y aprobar la propuesta técnica antes de que se autorice la implementación y modificación de código (`src/store.ts:431-440`, `require_approval`).
- **Gate 3 — Fusión del Cambio (`fab merge`):** El humano revisa el diff final y los tests en verde en la rama `fab/<id>` y autoriza explícitamente la fusión a la rama base del repositorio (`src/cli.ts`, `src/worktrees.ts:38-46`). La fábrica nunca hace merge automático a `main`.

---

## 2. Tabla de afirmaciones suyas vs. Realidad de la fábrica

| Qué dicen en sus documentos | Sección / Cita | Qué hace hoy la fábrica (con evidencia de código) | Estado | Aclaración |
| :--- | :--- | :--- | :---: | :--- |
| "C. Startería Lab → 1–3 soluciones técnicas viables, SOW y paquete elegido → sw-factory como motor técnico candidato + equipo humano → pruebas → hasta 2 iteraciones delimitadas → entrega y decisión" | `02-master-plan-v1.2.md` §0 (líneas 26–28) | La fábrica ejecuta cambios puntuales en ramas `fab/<id>` dentro de un repositorio existente (`src/worktrees.ts:16-30`). No compara soluciones técnicas ni administra iteraciones comerciales R1/R2. | **MATIZAR** | `sw-factory` puede ser el motor que construye el software, pero la preselección de opciones técnicas y la gestión de feedback con el cliente deben ser operadas por el equipo humano del Lab. |
| "Scouting verificable, opciones técnicas comparables y recomendación; la shortlist puede contener 1–3 opciones reales, nunca exigir tres cuando no existen." | `01-decision-lab-spec-v0.1.md` §2.C (línea 33) | La fábrica no tiene módulos de scouting ni acceso a catálogos de mercado. Exige un repo Git ya configurado (`src/worktrees.ts:20`) y un objetivo (`src/store.ts:85`). | **INCORRECTO** *(si se atribuye a sw-factory)* | El scouting tecnológico previo debe ser realizado por el Solution Architect de Startería Lab antes de crear el repositorio y las señales de la fábrica. |
| "Diseño -> construcción en sandbox -> QA técnico y seguridad -> prueba real autorizada -> iteración <=2 -> paquete de transferencia y decisión." | `01-decision-lab-spec-v0.1.md` §2.C (línea 35) | El sandbox es `bwrap` local para aislamiento de procesos en Linux (`src/sandbox/wrap.ts:40-77`). En misiones de `fab exec`, el runner ejecuta comandos objetivos de test (`src/agent/mission.ts:133-158`); en el flujo estándar de la fábrica, `pool.ts` verifica la presencia de commits en la rama `fab/<id>` (`src/pool.ts:40-47`). No gestiona pruebas con usuarios reales ni iteraciones de contrato. | **MATIZAR** | La fábrica cubre únicamente la construcción local y el QA técnico basado en pruebas de código automatizadas. La prueba real y las rondas R1/R2 son responsabilidad externa. |
| "Validación: Funcional y señales reales cuando haya acceso / Técnica + usuarios reales acordados / Operación acotada y seguimiento observacional." | `01-decision-lab-spec-v0.1.md` §3 (línea 41) | La validación técnica objetiva con `verificationCommands` en copia aislada está implementada para `fab exec --mission` (`src/agent/mission-evidence.ts:80-145`); el flujo estándar de `pool.ts` verifica la presencia de commits en la rama `fab/<id>`. | **NO APLICA** *(a la fábrica)* | La validación con usuarios reales es una actividad de producto/negocio del Lab que ocurre fuera de la fábrica de software. |
| "Protocolo de iteración: V0 = primera entrega. R1 = cambios derivados de evidencias/feedback del primer test. R2 = cambios derivados de segunda revisión." | `01-decision-lab-spec-v0.1.md` §3 (líneas 45–46) | La fábrica implementa reintentos automáticos ante errores de agentes (`MAX_ACTIVITY_RETRIES = 3`, `src/enums.ts:79`) y re-planificación humana de specs rechazados (`src/store.ts:476-506`). | **MATIZAR** | R1 y R2 son conceptos comerciales de cara al cliente. Para la fábrica, cada ajuste acordado tras una prueba real debe ingresar como un nuevo `change` técnico regular. |
| "LabSOW (entregable, inclusión/exclusión, presupuesto, tiempo, R0/R1/R2, propiedad intelectual, soporte, hosting y aceptación)." | `01-decision-lab-spec-v0.1.md` §5 (línea 56) | La fábrica no gestiona hosting, no despliega a servidores en la nube ni provisiona infraestructura pública. Produce únicamente ramas locales (`fab/<id>`) con commits (`src/worktrees.ts:32-36`). | **INCORRECTO** *(si se espera hosting de la fábrica)* | El despliegue de infraestructura y hosting debe ser ejecutado por el equipo de ingeniería del Lab o provisto por el cliente. |
| "Inventario de realidad del Lab bancario: NO VERIFICADO. El usuario informa un Lab ad hoc operativo en cliente bancario... no identificaron un repositorio, ejecución, arquitectura y pruebas atribuibles inequívocamente a ese Lab." | `01-decision-lab-spec-v0.1.md` §6 (líneas 59–74) | `sw-factory` es un desarrollo independiente de código abierto/privado. Todo su código está versionado en Git (`DarkCodePE/sw-factory`). Nunca fue ni operó como un "Lab bancario". | **NO APLICA / CONFUSIÓN** | Buscar trazas bancarias en `sw-factory` es un error de contexto. La fábrica no contiene datos, clientes ni secretos de ninguna institución financiera. |
| "sw-factory como motor de desarrollo \| REUSE SUBJECT TO L0 \| repo DarkCodePE/sw-factory@c3eff63, sin evidencia de operación bancaria end-to-end" | `02-master-plan-v1.2.md` §5 (línea 115) | El repositorio y tags publicados (`v0.1.0-rc.1` a `rc.9` en `f023e47`) son auditables en GitHub. La suite cuenta con pruebas exhaustivas (252 pass en 29 archivos) y pruebas P1 reales (`doc/droid-re/runtime/agent-loop-probes/`). | **CORRECTO en repo, MATIZAR en contexto** | El repositorio existe y es auditable en GitHub. La ausencia de "operación bancaria" se debe a que la fábrica jamás tuvo ese propósito. |
| "Fuera ahora: engine autónomo universal de scouting/build/QA/validación de mercado..." | `02-master-plan-v1.2.md` §2 (línea 54) | Coincide exactamente con las capacidades de la fábrica. No existe ningún engine autónomo de scouting ni validación de mercado. | **CORRECTO** | Es un acierto explícito de su planificación dejar esto fuera. |
| "Security gates: Para demo: datos sintéticos y ambientes aislados. Para piloto real: aislamiento entre clientes, autorización server-side, secreto/credencial fuera de prompts/logs..." | `01-decision-lab-spec-v0.1.md` §8 (línea 82) | El sandbox de la fábrica (`bwrap`) aísla la máquina local del desarrollador (`src/sandbox/wrap.ts:40-77`). No provee aislamiento multi-tenant en la nube ni partición entre clientes en un SaaS. | **MATIZAR (Riesgo de seguridad)** | El sandbox protege contra comandos de agentes locales, pero la separación entre clientes debe garantizarse aislando máquinas virtuales o entornos completos en la infraestructura del Lab. |
| "L0-L2 Lab \| smoke real/seguridad sw-factory; adaptador mínimo; primer Essential asistido y pagado \| POR VERIFICAR" | `02-master-plan-v1.2.md` §8 (línea 146) | Los smoke tests reales están ejecutados y documentados (`scripts/native-factory-smoke.ts`). Resultados P1: 3/3 en native+ChatGPT, Claude, Codex, Agy y Qwen local (`p1-subscriptions-v1/summary.txt`, `report-agy-ollama-p1.md`). | **CORRECTO en plan, EVIDENCIADO en fábrica** | La evidencia técnica de smoke y seguridad local ya existe hoy. Solo resta definir el protocolo de traducción entre Startería y el CLI de la fábrica. |
| "C-01: Lab selecciona 1–3 soluciones, SOW, ejecuta un trabajo de software acotado, QA técnico independiente y test real cuando corresponda; R1/R2 no son retries internos." | `02-master-plan-v1.2.md` §10 (línea 164) | Exactamente así opera la fábrica: ejecuta el trabajo de software en ramas `fab/<id>` y verifica la generación de commits (o ejecuta `verificationCommands` independientes en misiones), mientras que los reintentos internos (`retryCount`, `src/store.ts:451-473`) son independientes de R1/R2. | **CORRECTO** | Esta formulación refleja con total precisión la frontera de responsabilidades. |

---

## 3. Dónde encaja de verdad en su flujo C (Lab)

Para que Startería Lab funcione de forma predecible, proponemos un desacoplamiento claro de responsabilidades entre el equipo de Startería (negocio/producto), el Ingeniero del Lab (arquitectura/traducción técnica) y la Fábrica de Software (construcción y verificación automatizada).

### 3.1 Diagrama del flujo E2E

```mermaid
flowchart TD
    subgraph Starteria["Startería (Producto & Negocio)"]
        A[Intake: Reunión con Cliente] --> B[Decision Brief Preliminar]
        B --> C{Elección Modalidad C: Lab}
        C --> D[Acuerdo Comercial & SOW con Cliente]
        K[Prueba Real con Usuarios Acordados] --> L{¿Ajustes requeridos?}
        L -- Sí (R1 / R2) --> M[Feedback Consolidado de Cliente]
        L -- No --> N[Entrega Final & Decision Package]
    end

    subgraph LabHuman["Humano del Lab (Engineering / Solution Architect)"]
        E[Scouting Técnico: 1–3 Soluciones Viables]
        D -. Presupuesto & Alcance .-> E
        E --> F[Diseño Técnico & Scaffolding Inicial en Git]
        F --> G[Traducción a Signals & Criterios de Aceptación]
        M --> G
        J[Revisión de Diff, Tests y Despliegue a Staging]
        J --> K
    end

    subgraph Factory["Fábrica sw-factory (Motor de Ejecución Técnica)"]
        G --> H1[fab signal add / fab triage]
        H1 --> H2[Actividad Investigation: spec en solo lectura]
        H2 --> H3{Gate Humano: Aprobación Spec}
        H3 -- Aprobado --> H4[Actividad Implementation: rama fab/id]
        H4 --> H5[Sandbox bwrap: agente implementa cambios]
        H5 --> H6[Commit en rama fab/id & Verificación de commits (pool.ts)]
        H6 --> J
    end

    C --> E
    H3 -- Observaciones --> H2
```

> **Nota aclaratoria sobre verificación:** En el flujo estándar de la fábrica (`src/pool.ts:40-47`), el pool verifica únicamente que la actividad de implementación haya dejado al menos un commit en la rama `fab/<id>`. La ejecución autónoma de `verificationCommands` independientes y la inmutabilidad forzada de `protectedPaths` corresponden específicamente al modo de misiones de `fab exec` (`--mission`), no a la cola general de signals/changes. Ambos modos son el contrato vigente de la fábrica: el Lab elige flujo de señales (gates humanos) o misión (verificación por el runtime) según el encargo; la fábrica no cambia su contrato por cliente.

### 3.2 Matriz de responsabilidades por etapa

| Etapa del Flujo Lab | Responsable Principal | Qué hace la Fábrica (`sw-factory`) | Qué hace el Humano del Lab / Startería |
| :--- | :--- | :--- | :--- |
| **1. Intake & Brief** | Startería (Product Lead) | **Nada.** | Realiza entrevistas, enmarca el problema, evalúa viabilidad y firma el Decision Brief / SOW. |
| **2. Scouting Técnico** | Humano del Lab (Arquitecto) | **Nada.** | Investiga 1–3 opciones (ej. SaaS existente vs. desarrollo custom vs. template preconstruido) y recomienda el stack. |
| **3. Setup del Proyecto** | Humano del Lab (Ingeniero) | **Nada.** | Inicializa el repositorio Git base (`git init`), estructura carpetas, instala gestor de dependencias y configura harness de tests (`bun test`, `pytest`). |
| **4. Ingesta a Fábrica** | Humano del Lab → Fábrica | Crea el workstream (`fab ws create`), registra señales (`fab signal add`) y ejecuta triage (`fab triage`). | Traduce los requerimientos del SOW en instrucciones técnicas concisas con criterios de éxito objetivos. |
| **5. Investigación (Spec)** | Fábrica (Agente) | Corre en modo spec (solo lectura) en el worktree analizando el repo y redacta el archivo `spec.md` (`src/enums.ts:71`). | Opcional: interactúa si el agente solicita aclaraciones técnicas (`AskUser`). |
| **6. Gate de Spec** | Humano del Lab | Mantiene la actividad en pausa (`awaiting`, `src/store.ts:433`). | Revisa el `spec.md` en el Inbox o TUI (`src/tui.ts`) y decide si aprueba (`approve`), comenta (`comment`) o rechaza (`decline`). |
| **7. Construcción** | Fábrica (Agente) | Modifica código en worktree aislado (`fab/<id>`), ejecuta comandos en sandbox `bwrap` y genera commits atómicos (`src/pool.ts:40-47`). | Supervisa el avance desde la TUI o logs. |
| **8. QA Técnico Autónomo** | Fábrica (Pool) / Humano del Lab | En el flujo normal, `pool.ts:40-47` comprueba que la rama `fab/<id>` contenga commits válidos. La ejecución de `verificationCommands` independientes y protección estricta de `protectedPaths` está disponible en el modo misión de `fab exec` (`src/agent/mission-evidence.ts:80-145`). | En el flujo normal de fábrica, el Humano del Lab inspecciona el diff y corre la suite de pruebas antes de autorizar el merge. |
| **9. Integración y Merge** | Humano del Lab | Aplica la fusión limpia al branch de trabajo mediante `fab merge <changeId>` (`src/worktrees.ts:38-46`). | Revisa el diff final y valida la integración en el entorno local. |
| **10. Despliegue y Staging** | Humano del Lab | **Nada.** | Empaqueta la aplicación (Docker, serverless, etc.) y la despliega a una URL de pruebas para el cliente. |
| **11. Prueba Real de Usuarios** | Startería + Cliente | **Nada.** | Realiza pruebas con usuarios reales de la pyme para validar si la herramienta resuelve el cuello de botella. |
| **12. Rondas R1 / R2** | Humano del Lab → Fábrica | Si se requieren cambios, procesa nuevas señales/changes en la fábrica. | Filtra y prioriza el feedback del cliente dentro de los límites de horas pactados en el paquete. |

### 3.3 Interfaz de Entrada requerida por la fábrica

La interfaz es la de la fábrica tal como existe en `main`; las plantillas DOC-301/302/303 de Startería Lab se adaptan a ella, no al revés. Para que `sw-factory` pueda ejecutar un encargo, el Humano del Lab debe suministrar:
1. **Ruta local al repositorio Git (`repo`):** Un directorio con `.git` inicializado, dependencias instaladas y un comando de test funcional (`src/worktrees.ts:20-21`).
2. **Registro de Workstream:**
   ```bash
   fab ws create <nombre_iniciativa> --repo /ruta/al/proyecto --goal "Objetivo técnico" --agent native
   ```
3. **Payload del Change / Signal (`ExecutionBrief` técnico):**
   - **Título:** Breve y enfocado (ej. `Implementar autenticación JWT y middleware de protección`).
   - **Descripción del problema y alcance:** Explicación técnica de la funcionalidad requerida.
   - **Archivos protegidos (`protectedPaths`):** Archivos que los agentes tienen prohibido modificar (ej. `tests/auth.test.ts`). *Contrato:* se exige mecánicamente en `fab exec --mission` (`src/agent/mission.ts:140`). En el flujo general de señales (`pool.ts`) es una directiva del prompt; la garantía la dan los gates humanos. Si el Lab necesita inmutabilidad verificada por el runtime, el encargo se formula como misión (DOC-303).
   - **Comandos de verificación (`verificationCommands`):** Comandos deterministas que el runner ejecutará en sandbox estricto para juzgar el éxito (ej. `bun test tests/auth.test.ts`, `npx tsc --noEmit`) (`src/agent/mission.ts:135`). *Contrato:* propio del modo de misiones (`fab exec --mission`). El flujo general de `pool.ts:40-47` comprueba que la rama `fab/<id>` contenga commits y deja la verificación al revisor humano del Gate 3; es el diseño de la fábrica, no una carencia transitoria.

### 3.4 Interfaz de Salida devuelta por la fábrica

Al finalizar una actividad, la fábrica devuelve al Ingeniero del Lab:
1. **Rama Git con commits:** Rama `fab/<changeId>` con código probado, commits limpios y sin tocar la rama principal (`src/worktrees.ts:16-36`).
2. **Especificación técnica aprobada (`spec.md`):** Documentación del enfoque técnico adoptado.
3. **Reporte de Verificación Objetivo:** En misiones (`fab exec --mission`), evidencia capturada por el runtime de la salida estándar, salida de error y código de salida (`exitCode: 0`) de los comandos de verificación independientes (`src/agent/mission-evidence.ts:110-145`). En el flujo normal de fábrica (`pool.ts`), registro de commits generados, duración en segundos y estado del change en SQLite (`src/pool.ts:48-49`).
4. **Métricas de consumo:** Registro exacto de segundos de ejecución y tokens acumulados por actividad para costeo del SOW (`src/pool.ts:48-49`).

---

## 4. Respuestas a sus "Decisiones pendientes" e "Inventario NO VERIFICADO"

### 4.1 Contrastación del "Inventario de realidad del Lab bancario" (Spec v0.1 §6)

Startería catalogó 12 ítems como "NO EVIDENCIADO" bajo la premisa de evaluar un "Lab bancario operativo". Respondemos con la realidad técnica de `sw-factory`:

| Ítem Startería | Evidencia exigida por Startería | Estado real en `sw-factory` | Ubicación de la evidencia |
| :--- | :--- | :--- | :--- |
| **1. Repositorio / commit / versiones** | URL, SHA, rama, owner de código | **PUBLICADO EN MAIN (f023e47 / RC.9)** | Repositorio GitHub: `DarkCodePE/sw-factory`. Tags publicados en remoto: `v0.1.0-rc.1` a `v0.1.0-rc.9` (`f023e47`). Ramas locales de investigación experimental: `feat/ollama-p1` (`sw-factory-ollama`). |
| **2. Cliente / contrato / permisos IP** | Contrato o acta de derechos | **ACLARACIÓN / INDEPENDIENTE** | `sw-factory` es un software independiente desarrollado por el equipo de DarkCode. No utiliza propiedad intelectual, contratos ni activos de clientes bancarios. |
| **3. Job bancario / alcance** | SOW/PRD, casos de uso y exclusiones | **NO APLICA** | La fábrica nunca tuvo como objetivo un "job bancario". Es un motor de cambios de código para proyectos de software generales. |
| **4. Flujo de input / brief** | UX, API, schema, prueba | **PUBLICADO EN MAIN (desde RC.1 / 17bd944)** | CLI interactiva y TUI propia (`src/cli.ts`, `src/chat/`). Esquema SQLite de `workstreams`, `signals`, `changes` y `activities` en `src/store.ts:83-106`. |
| **5. Agentes / prompts / modelos** | Código y manifiesto de modelos/prompts | **PUBLICADO EN MAIN (desde RC.1 / 17bd944)** | Prompts estrictos en `src/prompts.ts:1-75`. Conectores de modelos en `src/agent/provider.ts` y adaptadores en `src/agents.ts:17-115` (`native`, `claude`, `codex` con `--sandbox workspace-write` integrado en `d06f108` / RC.1, `agy`, `fake`). Razonamiento local Qwen experimental en rama local `feat/ollama-p1`. |
| **6. Construcción / generación** | Muestras y ejecución reproducible | **PUBLICADO EN MAIN (f023e47 / RC.9)** | Construcción reproducible en worktrees temporales (`src/worktrees.ts:18-30`), ejecutable mediante `scripts/native-factory-smoke.ts` y compilable vía `scripts/build.sh`. |
| **7. QA, pruebas reales e iteraciones** | Test runs, defect log, trazas | **PUBLICADO EN MAIN (técnico)** | Suites de pruebas automatizadas en verde: 252 tests pasando en 29 archivos (`bun test`). Corridas P1 reales registradas en `doc/droid-re/runtime/agent-loop-probes/`. No hay pruebas de usuarios humanos de negocio. |
| **8. Integraciones y credenciales** | Diagrama seguro sin secretos | **PUBLICADO EN MAIN (f023e47 / RC.9)** | Credenciales inyectadas por variables de entorno explícitas (`FABRICA_LLM_API_KEY`). El sandbox limpia el entorno antes de invocar herramientas (`--clearenv`, `src/sandbox/wrap.ts:50`). No se almacenan secretos en SQLite. |
| **9. Infraestructura y tenants** | Arquitectura y pruebas de aislamiento | **PUBLICADO EN MAIN (local mono-tenant)** | Aislamiento local de procesos vía Bubblewrap (`bwrap`, `src/sandbox/wrap.ts:40-77`) y permisos de red por llamada (`fc6fc84`). La base de datos es SQLite monousuario local. No existe capa multi-tenant compartida. |
| **10. Operación, coste por caso, soporte** | Logs anonimizados, costes y horas | **PUBLICADO EN MAIN (parcial)** | Duración medida en tareas P1 (desde 21s hasta 139s). Telemetría de tokens en CLI/TUI (`src/agent/engine.ts`, `src/chat/presentation.ts`). No aplican métricas de soporte de mesa de ayuda. |
| **11. Uso de datos bancarios** | Políticas, retención, DPA | **NO APLICA / PROHIBIDO** | La fábrica no debe ser utilizada con datos financieros reales ni PII de clientes. Solo se admiten fixtures y mocks de desarrollo. |
| **12. Artefactos transferibles** | Muestras anonimizadas, licencias | **PUBLICADO EN MAIN (f023e47 / RC.9)** | Código transferible como commits Git estándar y ramas independientes `fab/<id>` listas para merge (`src/worktrees.ts:32-36`). |

### 4.2 Respuestas a las "Decisiones pendientes obligatorias" (Spec v0.1 §11)

- **Propiedad Intelectual (IP):** El motor `sw-factory` pertenece a sus desarrolladores. Todo el código fuente producido por la fábrica en el repositorio del cliente (los commits de la rama `fab/<id>`) es propiedad íntegra del cliente o de Startería, según estipulen en su SOW.
- **Autorización de despliegue y acceso a datos:** La fábrica **nunca** debe contar con credenciales de despliegue a producción ni acceso a bases de datos con datos reales de clientes. Cualquier despliegue o manipulación de datos debe ser ejecutada por el Ingeniero del Lab fuera de la fábrica.
- **Límites de R1/R2:** Un cambio típico en la fábrica toma entre 1 y 3 minutos de tiempo de cómputo. El límite de esfuerzo de R1/R2 debe pactarse en horas humanas de consultoría del Lab (análisis de feedback y redacción de nuevos changes), no por limitaciones de tiempo de la fábrica.
- **Estrategia de aislamiento:** La fábrica utiliza `bubblewrap` para aislar comandos de agentes en la máquina local. Para aislar clientes comerciales entre sí en Startería Lab, recomendamos ejecutar la fábrica en máquinas virtuales o contenedores independientes por proyecto (ej. una VM Linux ephemeral por cliente).

---

## 5. Riesgos y límites honestos

### 5.1 Publicado en GitHub vs. Trabajo local no publicado
Es fundamental distinguir entre lo publicado y lo que reside en ramas locales de desarrollo:
- **Publicado en remoto (`DarkCodePE/sw-factory` en `main` `f023e47`, v0.1.0-rc.9):**
  - Núcleo de la fábrica: SQLite store, worktrees git, pool de workers FIFO, gates de revisión humana (`fab inbox`, `fab review`, `fab merge`).
  - Sandbox `bwrap` con detección de degradación en AppArmor y red por llamada (`--sandbox-network`, RC.8 `fc6fc84`).
  - Modo YOLO efímero por invocación (`--yolo`, `/yolo`, RC.9 `f023e47`).
  - Motor propio `fab exec` (`src/agent/`) con bucle SSE, correlación de tool calls, compactación y 11 métodos JSON-RPC (`src/agent/rpc.ts`).
  - Misiones con verificadores objetivos (`verificationCommands` y `protectedPaths` en `fab exec --mission`).
  - Adaptadores integrados en `main`: `native`, `claude`, `codex` (con `--sandbox workspace-write` integrado en `d06f108` y publicado en `17bd944` / RC.1), `agy` (Antigravity CLI integrado en `d06f108` / RC.1), `fake`.
  - Conector de suscripción de ChatGPT (`src/agent/chatgpt.ts`) reutilizando sesión de Codex CLI sin filtrar credenciales (integrado en `d06f108` / RC.1).
  - TUI interactiva completa (`src/chat/`) con paleta en vivo de comandos, historial persistente, visualización de diffs, Markdown streaming y `/rewind` local de archivos (integrada en RC.1, consolidada en RC.6 y RC.8).
  - Distribución oficial por canales (`install.sh`, `latest.sh`, `prerelease.sh`), paquete npm `@okuanb/fab` y comando de autoactualización `fab update` (RC.4, RC.5, RC.7).
- **Existente únicamente en ramas locales de investigación (no integrado en main):**
  - `sw-factory-ollama` (`feat/ollama-p1`): Manejo de deltas de razonamiento de Qwen3.5, parser opt-in pythonic/LFM2 para LiquidAI y soporte de modelos locales experimentales (`src/agent/provider.ts:80-130`).

### 5.2 Lo que no está probado ni soportado
- **Monorepos gigantes:** No se ha probado la fábrica en repositorios de decenas de gigabytes. La creación de múltiples worktrees y el indexado de contexto pueden degradar el rendimiento y exceder límites de tokens.
- **Proyectos completamente en blanco (Greenfield desde cero):** La fábrica está diseñada para *hacer cambios sobre código existente*. No es eficiente creando un proyecto de la nada sin un scaffolding base previamente configurado por un humano.
- **Datos confidenciales o sensibles:** Si se usan modelos comerciales en la nube (Anthropic, OpenAI, Google), ningún dato confidencial o PII debe figurar en el repositorio o en las señales.

### 5.3 Dependencias de modelos y suscripciones
- **Suscripciones comerciales:** El rendimiento óptimo se obtiene con modelos de frontera (Claude 3.5 Sonnet vía `claude`, GPT-4o / ChatGPT vía `native`, Gemini vía `agy`). Dependen de cuotas activas de API o CLI autenticado en la máquina.
- **Inferencia 100% local:**
  - **Qwen 2.5 / 3.5 Coder 32k en Ollama:** Viable y probado con éxito (3/3 corridas aprobadas, ~70s por tarea). Requiere hardware con aceleración por GPU para mantener velocidad suficiente (~70 tokens/s en GPU vs ~4.7 tokens/s con capas en CPU, lo cual provoca fallos por timeout de inactividad de 120s; la evidencia en `doc/droid-re/report-agy-ollama-p1.md:120-128` constata esta brecha de velocidad pero no define un requisito mínimo rígido de 12 GB de VRAM).
  - **LiquidAI LFM2.5 2.6B:** **0/7 corridas aprobadas** (`report-agy-lfm25.md:150-173`). Se demostró empíricamente que los modelos ultraligeros de ~2.6B fallan en tareas complejas multi-turno al entrar en bucles de subagentes cuando el runtime les bloquea escrituras en modo spec.

### 5.4 Métricas reales de tiempo y coste (Pruebas de Aceptación P1)
Mediciones exactas registradas en repositorio fixture para corrección de bug aritmético con tests independientes (`doc/droid-re/runtime/agent-loop-probes/p1-subscriptions-v1/summary.txt`):

| Modelo / Adaptador | Tipo de Modelo | Corridas Exitosas | Tiempo Promedio por Tarea | Coste Estimado por Tarea |
| :--- | :--- | :---: | :---: | :---: |
| **Native + ChatGPT** | Suscripción OpenAI | **3 / 3 (100%)** | **22 segundos** | Incluido en cuota / < $0.02 |
| **Codex CLI (v4)** *(1)* | CLI OpenAI | **3 / 3 (100%)** | **71 segundos** | Incluido en suscripción |
| **Antigravity (`agy`)** | Google AI | **3 / 3 (100%)** | **111 segundos** | Incluido en suscripción Google AI |
| **Claude Code (`claude`)** | Anthropic | **3 / 3 (100%)** | **126 segundos** | ~$0.05 – $0.15 de API |
| **Ollama (Qwen3.5-32k)** | Local (GPU CUDA) | **3 / 3 (100%)** | **70 segundos** | $0.00 (Cómputo local) |
| **vLLM (LFM2.5-2.6B)** | Local (2.6B) | **0 / 7 (0%)** | Timeout (>180s) | No apto para este pipeline |

*(1) Nota sobre Codex CLI:* El resultado 3/3 se obtuvo con el adaptador configurado con `--sandbox workspace-write`, integrado en `main` en el commit `d06f108` y publicado en la versión `17bd944` (v0.1.0-rc.1), no en el commit base `c3eff63`.

---

## 6. Preguntas que debemos hacerles para poder colaborar

Para viabilizar una integración técnica exitosa en el marco del P0 comercial de Startería Lab, necesitamos acordar los siguientes puntos:

1. **Rol de traducción técnica:** ¿Quién asumirá en Startería Lab el rol del Ingeniero / Solution Architect que transformará los requerimientos del Decision Brief en un repositorio base y señales técnicas claras con criterios de aceptación?
2. **Estrategia de repositorios para el piloto Essential:** Para el primer cliente de prueba, ¿se trabajará sobre una base de código preexistente del cliente o Startería aportará una plantilla de inicio (scaffolding estándar tipo Next.js/FastAPI) con tests unitarios ya configurados?
3. **Mecanismo de Despliegue y Staging:** ¿Cómo planea Startería alojar el prototipo para que el cliente realice la prueba real, dado que la fábrica entrega exclusivamente ramas Git locales con commits verificados?
4. **Infraestructura de ejecución:** ¿La fábrica se ejecutará en una estación de trabajo Linux administrada por el equipo técnico del Lab, o requieren que preparemos una imagen de servidor / VM dedicada para ejecución remota desatendida?
5. **Proveedor de modelos para el piloto:** ¿El cliente del piloto permite el uso de modelos comerciales de frontera (Claude, OpenAI, Gemini) mediante API segura para maximizar la velocidad (20–120 segundos por cambio), o las políticas del encargo obligan a utilizar inferencia 100% local con Ollama en GPU propia?
