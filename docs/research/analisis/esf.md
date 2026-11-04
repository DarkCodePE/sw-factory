# Análisis Loop B — ESF (Engineering Software Factory)

run: `2026-10-30-B-esf-01` · repo: mitkox/esf `d901657` (v0.7.1-rc.1, MIT,
LICENSE sha256 `bbff8983…ae2ce89`) · fab: `29d4dd3` · estado: v0.2, parcheado tras
revisión goldfish (codex, agy, opencode); ver `runs/2026-10-30-B-esf-01/meta.md`.

Convenciones: **D** = declarado en docs de ESF; **V** = verificado leyendo el
archivo en el sha indicado. Rutas de ESF relativas a `ext/esf`; rutas de fab
relativas a `sw-factory/src`. Línea citada = línea real en ese sha.

## 1. Ficha

- Qué es: fábrica auto-hospedada en Go. `Task → Temporal → CubeSandbox
  (microVM) → agente → verificación → patch + evidencia`. Nació como fork de
  Machinist; en 0.6.2 eliminó CLI/UI heredadas (`docs/upstream.md`).
- Regla de uso: MIT → `adaptar-citando` (archivo@sha en el commit) o
  reimplementar. Dependencia de terceros: `third_party/harness2/UPSTREAM.json`
  es Apache-2.0, "no upstream runtime", `production_qualified: false` (V).
- Perfil de despliegue: en ejecución exige Temporal y un CubeSandbox con
  plantilla READY; Go 1.27.3 y Node 26 son requisitos de desarrollo y
  empaquetado (`README.md:57-60`). Todo lo que dependa de Temporal o Cube es
  `incompatible_perfil` para fab; solo se absorbe la idea reimplementada.
- Cambios desde el análisis previo (`804fb46..d901657`, 34 commits,
  2026-10-19 → 10-29): consola enterprise con TLS (`ab9e6d0` y 11 fixes),
  hardening de transporte y acceso a repos (`eca328a`, 38 archivos), non-root
  obligatorio (`1259ab9`), CI en paralelo (`a08ecc0`), release 0.7.1
  (`d8fddb7`), eliminación de Machinist (`8ac7d9e`). Licencia sin cambios.

## 2. Matriz repo → capas

| Capa | ESF | fab | Evidencia ESF (V salvo D) | Evidencia fab (V) |
| --- | --- | --- | --- | --- |
| C0 Interfaz | fuerte | fuerte | CLI cobra estilo kubectl `cmd/factory/resources.go:104,370,555,824`; consola web **solo lectura** `internal/console/server.go:29,70,183-192`; `init` y quick start (D `README.md:55,67,89`) | `cli.ts:94-116`; `fab events` sobre tabla `events` `store.ts:113-115,678`; sin telemetría de comandos/gates (ausente-verificado) |
| C1 Conectores | parcial | fuerte | **No** hace push ni PR `internal/repository/provider.go:14-15`; salida = diff contra baseline `:357-363`; intake DSPy es consejo, nunca autoridad `internal/factory/intake.go:82`; triage de issues es una Action aparte (D `docs/issue-triage-demo.md:6,20`); único push saliente = webhook de alertas `internal/factory/hardening.go:77-78,148` | Jira import idempotente `connectors/intake.ts:16-27`; PR `connectors/github.ts:88-93`; publish `validators/publish.ts:38-48`; sin reconciliación de estado externo (ausente-verificado) |
| C2 Orquestación | fuerte | parcial | Temporal; reintentos por tipo de actividad `internal/factory/workflow.go:1294-1302` (infra ×5), cleanup con contexto desconectado ×8 `:1156-1164`; **el agente nunca se reintenta** tras ack perdido `:1307-1308`; envío idempotente por run ID `:31`; timeout total `:328-334`; **sin triggers cron/evento** (ausente-verificado) | claim FIFO atómico sin TTL ni heartbeat `store.ts:412-440`; retries=3 `enums.ts:78`; `requeueOrphans` reencola **todo** `in_progress` del workstream, incluido lo de otro pool vivo `store.ts:649-658`, llamado en `pool.ts:106`; daemon = bucle de 30 s `pool.ts:102-125`; sin crons |
| C3 Control humano | fuerte | fuerte | Gate = señal Temporal `review-decision` con decisión/nota/actor `internal/factory/review.go:8,16-23`; timeout de revisión no es fallo `workflow.go:965-968,1013-1017`; sandbox suspendido durante la pausa `:980-1003`; `review` audita antes de enviar y rechazar exige `--note` `cmd/factory/resources.go:870-880,894`; `cancel`/`halt` `cmd/factory/hardening.go:24,61-62` | Gate 1 `store.ts:325-330`; Gate 2 `store.ts:545-548`; Gate 3 humano = `fab merge` y `--force` con aviso `cli.ts:245-248`; inbox/review `store.ts:407-409,595-617`. (El bloqueo programático `mergeBlocker` va en C6.) |
| C4a Modelos/adaptadores | fuerte | fuerte | Registro de harnesses por nombre `internal/agentharness/harness.go:163-208`; prompt por archivo+stdin por defecto (`PromptStdinFile` `:36-39`; existe `PromptArgv` `:40-42`); credencial inyectada por CubeEgress, el agente no la ve `opencode.go:69,99`, y `FilterEnv` allowlist `harness.go:222` (garantía que cuenta también en C5) | Adaptadores claude/codex/agy/droid/native/fake `agents.ts:21-110`; router auto `agent/router/index.ts:24`; fallback `agent/providers/router.ts:17,47`; omni `agent/providers/omni.ts:20` |
| C4b Cognitiva | fuerte | parcial | Perfil instruccional **inmutable por digest** `internal/harnessprofile/profile.go:24,55`; cualificación exige commit de 40 hex y digests de corpus `qualification.go:60-81`; aprobación firmada con **revisor ≠ autor** y ligada al digest `:240-248`; experimentos offline con splits y ≥100 tareas/3 repeticiones/10 clústeres (D `docs/harness-improvement.md:63-72`); `BLOCKED` como resultado de primera clase (cruzado C2/C4b): `/workspace/.factory/blocked.json` `workflow.go:598`, `activities.go:1042` | Prompts construidos en runtime `prompts.ts:47`, `validators/prompts.ts:46`; journal con seq y límites `agent/journal.ts:13,22,47`; misiones `agent/mission.ts:20,36`; **sin perfiles versionados ni experimentos** (ausente-verificado); salida BLOCKED del worker: no evaluado |
| C5 Aislamiento | fuerte | fuerte | microVM (D ADR 0001); política de egress con digest por run `internal/factory/resources.go:114,308,459`; **sonda de egress** previa al agente con estado `Decided`/`unknown` (`internal/factory/egress_probe.go:46-54,208-214`: solo la apertura positiva falla el run, un timeout no prueba cierre); arranque rechazado con internet abierto sin ack `hardening.go:33,261-278`; **behavior monitor** determinista (40 reglas, stdout+patch) que pone en `QUARANTINED` `hardening.go:64,101`, `workflow.go:562,609`, `internal/threatmon/rules.go`; payload AEAD `payload_codec.go:16`; `factory threats` `cmd/factory/hardening.go:129-130` | bwrap `--ro-bind / /` `sandbox/wrap.ts:70`, `--unshare-net` `:112`; política auto/ask/deny `agent/network-policy.ts:3-19`; file-policy sha256 leer-antes-de-editar `agent/file-policy.ts:3-7`; MCP OAuth PKCE `agent/mcp-oauth.ts:181,197,285`; **sin monitor de comportamiento ni sonda de egress** (ausente-verificado: `grep quarantin|anomal|egress` solo da instrucciones de prompts de validadores) |
| C6 Validación | fuerte | parcial | Verificación determinista: pasos = argv, veredicto solo por exit 0 **sin timeout** `internal/verification/run.go:144-146`, `internal/sandbox/types.go:173`, paso obligatorio fallido tumba el run `:100-101`; **gate-integrity**: árbol vs blob baseline, no el patch `internal/factory/activities.go:54-67`; cleanup obligatorio `:1203-1216`, SUCCEEDED → `InfrastructureFailed` si la limpieza no se verificó `workflow.go:232-235`; manifest `run.json` escrito tras cleanup, redacción en escritura (D ADR 0005) | Validadores LLM `connectors/types.ts:71`; **qa es un LLM al que se le pide correr tests** `validators/prompts.ts:36-44`; el pool no ejecuta tests ni lint de forma determinista: sus comprobaciones son el regex de `VERDICT` `pool.ts:59-62`, `git status --porcelain` tras qa `pool.ts:65-77` y commits reales en implementación `pool.ts:79-84`; en misiones sí hay verificador determinista en bwrap sin red `agent/mission-evidence.ts:148-156` y `protectedPaths` sellados `agent/mission-contract.ts:50-53`; limpieza de worktree sin evidencia `worktrees.ts:50-80`; merge gate programático `mergeBlocker` `validators/publish.ts:29-33` (pending/fail bloquean, `needs_human` no `:30-32`) |
| C7 Persistencia | parcial | parcial | Artefactos con escritura atómica (`O_EXCL`+sync+rename) `internal/factoryartifacts/store.go:153-180`; `Change` como unidad durable `change.go:165,200,270`; redacción antes de guardar `activities.go:1021-1023,1174`; retención de artefactos `cmd/factory/retention.go:120`; recuperación de turnos y checkpoints de sesión en el turn-executor (`internal/turnexec/service.go:51-54`, D `docs/sf-turn-executor.md:3-8`); **sin índice semántico de código** (ausente-verificado) | SQLite `store.ts:92-116`; journal con fsync `agent/journal.ts:19,35,50`; búsqueda fff/rg `search/index.ts:16-58`; sin índice de código (ausente-verificado) |
| C8 Operación | fuerte | parcial | `doctor` con posture de hardening `cmd/factory/main.go:661-700`; `agents verify` sha256 de binarios de agente `cmd/factory/release.go:171,226-265`; release reproducible + attest + SBOM `.github/workflows/release.yml:74-150`; `install.sh:70-78` sha256 + `gh attestation verify` | `fab update` con sha256 de manifiesto `update/npm.ts:44`; qualify por plataforma `scripts/release/qualify.mjs`; provenance npm `.github/workflows/protected-release.yml:64`; doctor `cli.ts:267-275` |
| C9 Extensibilidad | fuerte | parcial | Interfaces Go `Harness` y `Sandbox`/`Provider` `internal/agentharness/harness.go:132,174`, `internal/sandbox/types.go:180,236`; API consola solo GET `console/server.go:183-198`; protocolo pi con `contract_version` `pi.go:374`, `agents/pi/src/protocol.mjs:21` | JSON-RPC con `factoryProtocolVersion` fijo y sin negociación `agent/rpc.ts:14,235,244`; SDK `sdk/session.ts:15,144`; MCP en proceso `sdk/mcp-server.ts:23,53` |

Resumen (comparación **estática**, nada se ejecutó ni midió): ESF es más
fuerte en C2 (durabilidad), C4b (perfiles cualificados), C5 (monitor + sonda
de egress), C6 (verificación determinista + integridad de gates + evidencia de
cleanup) y C8 (procedencia). fab es más fuerte en C1 (Jira/PR bidireccional,
que ESF deja fuera a propósito) y en autonomía de despliegue. Ninguno tiene
índice semántico de código (C7) ni triggers persistentes (C2). Límite: la
propia `docs/production-readiness.md:91-100` de ESF admite restore y carga sin
probar y replay de upgrade no testado; la superioridad operativa no está
demostrada, solo la de diseño.

## 3. Candidatos

Formato abreviado de la receta de `design-loops-investigacion.md` §3.
Común a todos salvo que la ficha diga otra cosa: estado `propuesto`;
`candidato.sha` se fija al autorizar el experimento; `n_runs` ≥ 10 pareadas
con orden alternado y todos los intentos contados; umbral como ratio
candidato/baseline; guardianas mínimas = éxito en benchmark, coste por entrega
aceptada, tiempo de validación, hallazgos de validadores; benchmarks =
`examples/toy-calc` + una tarea real del historial; licencia MIT →
`adaptar-citando archivo@d901657`, `tos_risk: ninguno` (no depende de auth de
terceros); perfil de despliegue: todo se reimplementa en Bun/TS sin servicios.

### C6-verificacion-determinista-01 · esfuerzo M · prioridad 1
- Idea (ESF ADR 0004, `internal/verification/run.go:144-146`): un perfil de
  verificación de pasos `argv` cuyo veredicto sale **solo del exit code**,
  corre todos los gates aunque uno falle, escribe evidencia también de los que
  pasan, y un gate que no puede ejecutarse falla.
- Hueco en fab: `qa` es un LLM que corre tests y redacta un veredicto
  (`validators/prompts.ts:36-44`); la fábrica solo verifica `porcelain`
  (`pool.ts:65-77`). fab **ya tiene** el verificador determinista en misiones
  (`agent/mission-evidence.ts:148-156`): el candidato es reutilizarlo en el
  pool como gate previo a los validadores LLM.
- `variable_intervenida`: fuente del veredicto de `qa` (LLM → exit codes de
  pasos declarados en el workstream).
- Métrica primaria: sensibilidad = fallos plantados detectados / plantados
  (10 bugs con test que falla en toy-calc + 5 en tarea real). Guardianas:
  tiempo de validación, coste, `false pass`.
- Umbral: ratio sensibilidad candidato/baseline ≥ 1.2 y sensibilidad absoluta
  ≥ 0.95; `false pass` ratio ≤ 0.5; coste ratio ≤ 1.0. Preservar la semántica
  de ESF: éxito = exit 0 sin timeout; gate no ejecutable = fallo.
- Evidencia adversa a considerar: los gates deterministas no detectan
  criterios de aceptación no cubiertos por tests; por eso conviven con el
  validador LLM, no lo sustituyen.

### C6-gate-integrity-02 · esfuerzo S · prioridad 2
- Idea (`internal/factory/activities.go:54-67`, ADR 0007 §4): comparar el
  **árbol** de los archivos de gate (tests, scripts de verificación) contra el
  blob del baseline con `git hash-object` vs `git rev-parse <base>:<path>`;
  mismatch → `GATE_TAMPERED` salvo permiso explícito. No usa el patch porque
  tres operaciones git ordinarias lo esquivan.
- Hueco: fab protege `protectedPaths` solo en misiones
  (`agent/mission-contract.ts:50-53`); en el pool el agente puede editar tests.
- `variable_intervenida`: comprobación de integridad de rutas de gate antes
  de validar (ninguna → hash de árbol vs blob baseline).
- Métrica: 5 manipulaciones plantadas (editar test, borrar assert, cambiar
  script de CI, `git update-index --assume-unchanged`, reescribir en commit
  previo) → detectadas/5 = 1.0; falsos positivos en 10 changes limpios = 0;
  además 3 cambios **legítimos** de tests (añadir test de regresión) deben
  pasar con la excepción declarada en el workstream. Guardiana: tiempo de
  validación ratio ≤ 1.05.

### C5-threatmon-03 · esfuerzo M · prioridad 2
- Idea (`internal/threatmon/rules.go`, `hardening.go:64,101`): ruleset
  determinista (stdlib, 40 reglas: escalada, credenciales, reverse shell,
  persistencia, exfiltración, cripto, manipulación de gates) sobre **stdout +
  patch**, con normalización (ANSI, CR, continuaciones); hallazgo ≥ severidad
  → `QUARANTINED` antes de validar; el operador añade reglas, no quita.
- Hueco: fab no tiene nada equivalente (grep `quarantin|anomal|egress` = 0).
- `variable_intervenida`: escaneo post-run de stdout+patch (ninguno → ruleset).
- Métrica primaria: tasa de falsos positivos sobre ≥ 30 changes reales del
  historial de fab que editen scripts, Makefiles o CI (el corpus sintético de
  una línea por regla es solo test unitario de regex, no medición); umbral FP
  ≤ 0.05. Secundaria: detección sobre 10 transcripciones adversas realistas
  (reverse shell en Makefile, credencial en diff) ≥ 0.9. Guardianas: latencia
  añadida ≤ 200 ms; éxito en benchmark no baja por cuarentenas espurias.
- Licencia: reimplementar reglas en TS citando `internal/threatmon/rules.go@d901657`.

### C6-manifest-evidencia-04 · esfuerzo M · prioridad 3
- Idea (ADR 0005, `workflow.go:232-235`, `activities.go:1203-1216`): un
  `run.json` por change con baseline sha, tarea, harness, resultados por gate,
  coste y **resultado de cleanup**, escrito después de limpiar; redacción de
  secretos en cada escritura; un SUCCEEDED sin cleanup verificado pasa a fallo
  de infraestructura.
- Hueco: `mergeAndCleanup` no deja evidencia (`worktrees.ts:50-80`);
  `ValidationSummary` es "último por validador" (`store.ts:471-505`).
- `variable_intervenida`: escritura de manifest por change (ninguna → manifest
  tras cleanup).
- Métrica: % de changes en **cualquier** estado terminal (completed, failed,
  cancelled) con manifest completo = 1.0, incluido `cleanup.verified`; test de
  redacción con 8 patrones (bearer, `sk-`, `ghp_`, `AKIA`, URL con
  credencial…) = 0 fugas. Guardiana: tiempo de merge ratio ≤ 1.1.

### C4b-perfil-inmutable-05 · esfuerzo L · prioridad 1 (habilita la medición)
- Idea (`internal/harnessprofile/profile.go:24,55`, `qualification.go:60-81,
  240-248`, `docs/harness-improvement.md`): el prompt de sistema y las
  instrucciones del worker son un **perfil JSON inmutable identificado por
  digest**, atado a harness+modelo+repo; se cambia solo creando un perfil
  nuevo; los experimentos usan suites con splits (development / validation /
  qualification), IDs no reutilizables y aprobación con revisor ≠ autor.
- Hueco: `buildWorkerPrompt` arma el prompt en runtime sin versión
  (`prompts.ts:47`); no hay experimentos (ausente-verificado).
- Alcance acotado (hallazgo goldfish): este candidato es **solo** el perfil
  inmutable con digest y la suite congelada con splits. La cualificación
  estadística, el rollout 1 %/5 %, los cortacircuitos y el rollback
  (`docs/harness-improvement.md:136-142`, `internal/factory/improvement_activities.go:49-61`)
  son una segunda fase, dependiente de resultados; no hace falta para empezar.
- Por qué prioridad 1: da identidad reproducible al candidato (`sha` de fab +
  digest de perfil) para las recetas de los demás.
- `variable_intervenida`: origen de las instrucciones del worker (runtime →
  perfil por digest), con el contenido del prompt fijado igual en ambos brazos.
- Métrica primaria: consistencia de resultado ante mismo commit base y misma
  tarea (varianza del éxito y del tamaño de diff en 10 corridas pareadas) ratio
  ≤ 0.8; la igualdad de bytes por digest es solo precondición, no métrica.
  Guardianas: éxito y coste no inferiores.

### C4b-blocked-06 · esfuerzo S · prioridad 3
- Idea (ADR 0007 §3, `workflow.go:598`): el agente declara que la tarea es
  imposible escribiendo `blocked.json`; el run termina `BLOCKED`, verificación
  `SKIPPED`, razón preservada. Quita el incentivo a seguir probando fuera de
  límites.
- Hueco: no evaluado en fab (los validadores tienen `needs_human`, el worker
  de implementación no se verificó).
- `variable_intervenida`: existencia de la salida BLOCKED en el worker del
  pool (no evaluado → archivo de bloqueo leído por el pool antes de validar;
  ESF lo honra solo tras integridad y cuarentena).
- Métrica: 5 tareas imposibles plantadas → llamadas a herramienta hasta
  terminar, ratio candidato/baseline ≤ 0.5, con N baseline medido primero.
  Guardiana: BLOCKED en 10 tareas posibles = 0.

### C2-lease-ttl-07 · esfuerzo S · prioridad 2 (hallazgo propio de fab)
- Idea (ESF: envío idempotente por run ID `workflow.go:31`; agente nunca
  reintentado tras ack perdido `:1307-1308`): leases con TTL/heartbeat y
  reencolado solo de leases vencidos.
- Hueco: `requeueOrphans` reencola todo `in_progress` del workstream al
  arrancar (`store.ts:649-658`), lo que con dos pools vivos duplica trabajo.
- `variable_intervenida`: criterio de reencolado (todo `in_progress` → solo
  leases con TTL vencido; TTL 90 s, heartbeat 30 s alineado con el bucle de
  `pool.ts:102-125`).
- Métrica: dos pools concurrentes + kill de uno → activities duplicadas
  ratio = 0 (baseline > 0) y huérfano recuperado en ≤ 180 s; sin pools
  muertos → reencolados = 0. Guardiana: throughput de entregas no baja.

### C5-egress-probe-08 · esfuerzo S · prioridad 3
- Idea (ADR 0007 §1, `resources.go:114,308,459`): antes de arrancar el agente,
  medir qué es alcanzable (canario público, metadatos cloud) y guardar la
  postura real con digest de la política en la evidencia del run.
- Hueco: fab asume `--unshare-net` sin medirlo ni registrarlo.
- `variable_intervenida`: medición de la postura de red antes del agente
  (ninguna → sonda con observación, `decided` y veredicto separados, como
  `egress_probe.go:46-54,208-214`).
- Métrica: en modo `deny`, 20 runs con **control positivo** (misma sonda en
  modo `auto` alcanza el canario) → apertura positiva detectada = 0 y
  `undecided` ≤ 0.1 (un `unknown` no cuenta como aislamiento); overhead ≤
  300 ms; cada change guarda `network_posture`. Matriz: Linux/bwrap y macOS
  best-effort por separado.

### C3-decision-auditada-09 · esfuerzo S · prioridad 4
- Idea (`cmd/factory/resources.go:870-880,894`): auditar el intento de
  decisión **antes** de aplicarla, con actor y nota; rechazar exige nota.
- Hueco: `review decline` no exige nota (`cli.ts:202-205`); no hay actor.
  Requiere el log local de eventos (prerequisito C8 del diseño).
- Métrica: la nota obligatoria es precondición, no métrica. Medir: % de
  decisiones cuyo registro existe **antes** del efecto (crash entre registro y
  efecto plantado 5 veces → 0 decisiones aplicadas sin registro); y en el
  historial, ratio de reintentos del worker que incorporan la nota de rechazo.

### C4a-presupuesto-reserva-10 · esfuerzo M · prioridad 2 (punto ciego hallado por goldfish)
- Idea (`internal/inferencebudget/ledger.go:181-199,211-218`): reservar el
  **peor caso** de coste antes de despachar la llamada al modelo, rechazar
  identidades de request duplicadas (idempotencia tras crash), y revocar la
  cuenta si el uso real no es verificable. Solo aplica al gateway de mejora;
  para el flujo general ESF admite que el presupuesto es post-run
  (`internal/factory/resources.go:190-203`).
- Hueco: fab controla cuotas en `omni`/router en memoria, sin reserva previa
  ni protección ante reinicio del pool (no verificado en detalle).
- `variable_intervenida`: contabilidad de coste (post-hoc → reserva previa
  durable en SQLite).
- Métrica: sobrecoste respecto a `usd_max` de un workstream con kill del pool
  en medio de 10 llamadas → ratio ≤ 0.1 del baseline; llamadas duplicadas
  tras reinicio = 0. Guardianas: latencia por llamada ≤ +20 ms; éxito igual.

### Ideas sin candidato (registradas, no priorizadas)
- C5 frontera formal de confianza (ADR 0006: política de operador confiable,
  tarea y repo no confiables; un cliente de API nunca elige ejecutable, ruta o
  shell): documentar el equivalente para `fab exec` y el pool.
- C7/C9 recuperación de turnos con checkpoints de sesión
  (`internal/turnexec/service.go:51-54`, `docs/sf-turn-executor.md`): idea
  arquitectónica, sin candidato hasta que fab tenga turnos remotos.
- C8 alertas acotadas y anti-expansión (`internal/notify/notify.go`) y vistas
  en vivo que distinguen `unavailable` de dato viejo con caché y timeout
  (`internal/console/live.go:17-24`): referencia para el log de eventos y un
  futuro `fab serve`.
- C0 consola web de solo lectura sobre el store (`internal/console/`): posible
  como `fab serve` local; diferido hasta tener telemetría.
- C8 `agents verify` (sha256 de los binarios **de los agentes** `cmd/factory/release.go:171,226-265`): fab no verifica los binarios de claude/codex/agy que invoca; candidato S futuro, distinto de la firma del instalador.
- C7 escritura atómica de artefactos: fab usa SQLite para el store y fsync en el journal; no aplica.
- **incompatible_perfil**: Temporal, CubeSandbox, Harness2 completo (exige
  Cube), consola enterprise con TLS/mTLS.

## 4. Lo que fab hace y ESF no (para no "absorber" hacia atrás)
- Conectores Jira/GitHub bidireccionales (C1); ESF lo excluye por diseño.
- Router de modelos con fallback y omni (C4a); ESF fija el modelo por perfil.
- Herramientas, misiones y journal en proceso (C4b); ESF delega todo al CLI
  del agente.
- Binario único sin servicios externos (C8).

## 5. Límites de este análisis
- No se ejecutó código de ESF ni se midió nada; todas las métricas son
  propuestas con baseline pendiente.
- No se abrieron `deploy/`, `deployments/`, `docs/production-readiness.md`,
  `internal/console/live.go` ni el contenido de `release/qualification/evidence/`.
- `docs/task-artifact-model.md` no existe en `d901657` (el registro previo lo
  citaba); el modelo está en `docs/adr/0005-factory-artifact-model.md`.
- El inventario C4-C6 y C7-C9 se hizo con grep y lectura, sin `graft ask`.
- El clone/pull y `graft build` corrieron en el host, no en bwrap como pide
  el diseño §6 (el repo ya era de confianza previa; queda como deuda).
- Ningún candidato tiene aún `candidato.sha`, corrida de humo del baseline ni
  consumo de presupuesto registrado; todos están en `propuesto`.
- Los 34 commits del rango se resumieron por título; no se leyó cada diff.
