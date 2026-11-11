# Informe de Revisión Goldfish: T10 y T11

- **Revisor:** Goldfish agy (roles EGM: `codebase_details.md` e `implementation_readiness.md`).
- **Base común:** `origin/release/0.1.0-rc.12` (`9dbb175`).
- **Worktrees auditados:**
  - **T10:** `/home/orlando/Desktop/factory/sw-factory-fase0` (`fix/t10-worktree-reparar`)
  - **T11:** `/home/orlando/Desktop/factory/sw-factory-fase1` (`feat/t11-observe-informe`)

---

## 1. Veredicto por Tarea

| Tarea | Rama | Veredicto | Resumen |
|---|---|---|---|
| **T10** | `fix/t10-worktree-reparar` | **Listo para commit** | Bloqueo determinista correcto mediante `WorktreeNeedsRepair`, no consume reintentos (`retry_count` se mantiene intacto), preserva ramas en `--discard`, previene carreras con workers activos en la CLI y reanuda transparentemente mediante el comando existente `fab retry <changeId>`. |
| **T11** | `feat/t11-observe-informe` | **Listo para commit** | Solo lectura estricta (sin lock, sin escrituras en tablas de la fab, sin llamadas a GitHub), esquema compatible (`CREATE TABLE IF NOT EXISTS adm_polls`), estructura de informe orientada a responder (a), (b) y (c). Salida `--json` estructurada. |

---

## 2. Verificación Detallada T10 (`sw-factory-fase0`)

### 2.1 ¿Se bloquea en lugar de fallar?
- **Distinción por tipo:** `src/worktrees.ts:18-23` define la clase de error específica `export class WorktreeNeedsRepair extends Error`. En `src/pool.ts:348` y `src/pool.ts:359`, la distinción se hace estrictamente por tipo mediante `err instanceof WorktreeNeedsRepair`, nunca por comparación de cadenas ni expresiones regulares.
- **Errores deterministas verificados:**
  1. Repositorio inexistente o sin `.git`: lanza `WorktreeNeedsRepair` (`src/worktrees.ts:72`).
  2. Marca `.preparing` preexistente: lanza `WorktreeNeedsRepair` (`src/worktrees.ts:77`).
  3. Worktree vinculado a otro repositorio (`git-common-dir` dispar): lanza `WorktreeNeedsRepair` (`src/worktrees.ts:53-55`, `65`).
  4. Rama divergente (`symbolic-ref HEAD !== branch`): lanza `WorktreeNeedsRepair` (`src/worktrees.ts:56-58`, `65`).
  5. Directorio que no es un worktree vinculado (`.git` no es archivo o no es toplevel): lanza `WorktreeNeedsRepair` (`src/worktrees.ts:48-51`, `65`).
  6. Checkout incompleto o bloqueado (sin `index`, o con `index.lock`/`locked`): lanza `WorktreeNeedsRepair` (`src/worktrees.ts:60-62`, `65`).
  7. Creación parcial (`git worktree add` falla habiendo creado el directorio): deja la marca `.preparing` y lanza `WorktreeNeedsRepair` (`src/worktrees.ts:91`).
- **Errores transitorios:** En `src/worktrees.ts:90`, si `git worktree add` falla pero no creó nada (`!existsSync(path)`), borra la marca `unlinkSync(preparing)` y relanza el error original de Git (`throw error`). En `src/pool.ts:361`, al no ser instancia de `WorktreeNeedsRepair`, cae en `store.failActivity(activity.id, workerId, msg)`, consumiendo reintento y volviendo a intentar hasta `MAX_ACTIVITY_RETRIES`. Verificado empíricamente en test `tests/pool.test.ts:200`.
- **Preservación del presupuesto:** Al invocar `store.blockActivity(activity.id, workerId, msg)` (`src/pool.ts:359`), la activity pasa a estado `blocked` sin incrementar `retry_count`, cancela actividades pendientes del change y transiciona el change a `blocked`. La actividad ingresa a `store.inbox(...)` (`src/store.ts:620`) y se visualiza con el prefijo `WORKTREE_NEEDS_REPAIR:`.

### 2.2 ¿Es segura la reparación?
- **Comportamiento sin `--discard`:**
  - Si el worktree es válido según `verifyWorktree`: elimina únicamente la marca `.preparing` (`src/worktrees.ts:113`) y reporta `worktree válido; marca eliminada.`, saliendo con código 0. Preserva intactos todos los archivos del worktree (incluso cambios sin commit / archivos sucios).
  - Si el worktree es inválido o ausente: no borra ningún archivo ni la marca (`src/worktrees.ts:125`). Imprime la causa del fallo y los comandos exactos de limpieza manual (`git -C ... worktree remove --force ...` y `rm -- ...`). Sale con código 1.
  - Si no hay marca: no borra nada y sale con código 0 (`src/worktrees.ts:116`).
- **Comportamiento con `--discard`:**
  - **Preservación de ramas:** Ejecuta `git worktree remove --force` (`src/worktrees.ts:130`). Git remueve la carpeta del worktree y el registro administrativo, pero no elimina la rama en `refs/heads/fab/<shortId>`. La función `repairWorktree` nunca invoca `git branch -d` ni `-D`. Los commits realizados permanecen en el repositorio local. Verificado en test `tests/worktrees-repair.test.ts:63-74`.
  - **Protección frente a repositorios ajenos o independientes:** Si la ruta contiene un repositorio Git independiente (no registrado como worktree en `repoPath` y con `.git` como directorio), `src/worktrees.ts:127-129` rehúsa descartar explícitamente (`No se descarta: la ruta contiene metadatos Git ajenos/no registrados`).
  - **Prefijo de 8 caracteres:** La CLI resuelve el change mediante `findByPrefix(allChanges(store), rest[0], 'change')` (`src/cli.ts:343`), la cual exige coincidencia unívoca y rechaza ambigüedades. Las rutas siguen la convención `changeId.slice(0, 8)` vigente en todo `src/worktrees.ts`, acatando la restricción del brief de no alterar el truncado a 8 caracteres (asignado a T9).
- **Prevención de carreras con workers concurrentes:**
  - En `src/cli.ts:344-346`, antes de invocar `repairWorktree`, la CLI consulta:
    `if (store.listActivities({ changeId: c.id }).some(a => a.status === 'in_progress')) throw new StoreError('conflict', 'change tiene workers en curso');`
  - Si un worker está ejecutando activamente sobre el change, `repair` aborta sin tocar marcas ni archivos.
  - Además, `ensureWorktree` escribe la marca con `flag: 'wx'` (`src/worktrees.ts:84`), garantizando exclusión mutua a nivel de sistema de archivos en caso de colisión concurrente de inicialización.

### 2.3 ¿Se puede continuar tras reparar?
- Una vez ejecutado `fab worktree repair <changeId>` y eliminada la marca, la CLI emite el mensaje:
  `Para continuar: fab retry <changeId>` (`src/cli.ts:349`).
- No fue necesario añadir mecanismos nuevos en el Store: `store.retryChange(changeId)` (`src/store.ts:987-1002`) ya soportaba de forma nativa cambios en estado `blocked`, insertando una nueva activity con estado `pending` y reseteando el estado del change a `pending`.
- Al reanudar la ejecución con `runPool`, la actividad re-encolada invoca `ensureWorktree`, la cual reutiliza el worktree validado o crea uno limpio si se descartó el previo.

---

## 3. Verificación Detallada T11 (`sw-factory-fase1`)

### 3.1 ¿Es de solo lectura?
- **Sin adquisición de lock:** `residentMain` (`src/admission/cli.ts:14-19`) intercepta `argv[0] === 'report'` antes de cualquier inicialización de `Resident`. No instancia `Resident`, no llama a `lock.acquire()` ni verifica propiedad de locks.
- **Sin escrituras en BD:** `buildReport` (`src/admission/report.ts:12-33`) ejecuta exclusivamente sentencias `SELECT` contra `adm_decisions`, `adm_cursors`, `adm_polls` y `adm_effects`. No modifica ninguna tabla ni emite señales o cambios en las tablas principales de la fábrica (`activities`, `changes`, `workstreams`).
- **Sin llamadas externas a GitHub:** No invoca `gh`, `pollIssues` ni `runCommand`.
- **Compatibilidad del esquema:** Añade la tabla `adm_polls` en `src/admission/db.ts:21` mediante `CREATE TABLE IF NOT EXISTS adm_polls (source TEXT PRIMARY KEY, polled_at TEXT NOT NULL, events INTEGER NOT NULL);`. Si se ejecuta contra una base existente previa a T11, el schema migra limpiamente sin alterar tablas previas. La consulta de fuentes en `buildReport` (`src/admission/report.ts:22-24`) realiza un `LEFT JOIN adm_polls`, por lo que registros antiguos sin entrada en `adm_polls` devuelven `lastPoll: null` sin fallar.

### 3.2 ¿El informe responde a las tres preguntas?
El diseño del reporte cubre las tres interrogantes requeridas:
- **(a) ¿Se verifica bien la etiqueta?** Muestra cada decisión `label-not-verified` desglosando el trigger, el usuario que etiquetó (`labelBy`) y el rol (`role`). Los `trigger-label` con rol admitido (`admin|maintain|write|triage`) figuran agrupados en `decisiones` bajo `admitiría trigger-label`.
- **(b) ¿Aparece el 403 (rol `unknown`)?** Si el token carece de permisos de lectura de colaboradores/push en el repositorio, GitHub API responde 403 y `labeler` asigna el rol `unknown`. El reporte lo expone directamente en `labelNotVerified` con `rol=unknown` y la primera razón `label-not-verified`.
- **(c) ¿El evento `labeled` llega tarde?** Si el issue tiene la etiqueta pero el evento `labeled` aún no aparece en el timeline al momento del poll, el efecto de admisión reintenta o termina en `dead` tras agotar reintentos. El reporte filtra y lista `adm_effects WHERE attempts > 1 OR status IN ('dead','unknown')` con su `lastError`.

### 3.3 Prueba real contra `DarkCodePE/sw-factory`
Se ejecutó la prueba con `--once` y `--mode observe` en un directorio temporal aislado (`FABRICA_HOME`), apuntando al repositorio real `DarkCodePE/sw-factory` con `--since 2026-01-01T00:00:00Z`.

```bash
TMP_DIR=$(mktemp -d)
cd /home/orlando/Desktop/factory/sw-factory-fase1
FABRICA_HOME=$TMP_DIR bun src/cli.ts resident --repo DarkCodePE/sw-factory --mode observe --once --since 2026-01-01T00:00:00Z
FABRICA_HOME=$TMP_DIR bun src/cli.ts resident report
FABRICA_HOME=$TMP_DIR bun src/cli.ts resident report --json
rm -rf $TMP_DIR
```

**Salida obtenida:**
```text
recuperados 0 efectos interrumpidos
ciclo: {"triggers":0,"effects":0}
== Fuentes ==
github:DarkCodePE/sw-factory  cursor=-  último poll=2026-11-11T03:10:22.791Z (0 issues)

== Decisiones (would_admit / primera razón) ==
(ninguna)

== label-not-verified (issue, label-by, rol) ==
(ninguna)

== Efectos con reintentos (attempts>1) o dead/unknown ==
(ninguno)
{
  "sources": [
    {
      "source": "github:DarkCodePE/sw-factory",
      "cursor": null,
      "lastPoll": "2026-11-11T03:10:22.791Z",
      "lastPollEvents": 0
    }
  ],
  "decisions": [],
  "labelNotVerified": [],
  "effects": []
}
```

> [!IMPORTANT]
> **Hallazgo Empírico sobre `DarkCodePE/sw-factory`:**
> La ejecución contra `DarkCodePE/sw-factory` reporta `(0 issues)` y `decisiones: []` porque en dicho repositorio **el 100% de los elementos reportados por la API de issues son Pull Requests** (PRs #30 a #59). En `src/admission/github.ts:30`, `pollIssues` contiene la exclusión intencional `if (i.pull_request) continue;`. Al no existir issues puros (no-PR) en el repositorio, no hay triggers procesables en una ejecución `--once`.
> Por tanto, las preguntas (a), (b) y (c) no pueden validarse con datos empíricos de issues reales en ese repositorio específico sin que se creen o existan issues no-PR, o bien requiere observar un repositorio que reciba issues de usuarios.

---

## 4. Auditoría de Tests y Alcance

### 4.1 Calidad de tests en T10 y T11
- **T10 (`tests/worktrees-repair.test.ts`, `tests/pool.test.ts`):** Cobertura exhaustiva de modos de fallo. No se limita al camino feliz: verifica corrupción de índice, worktree foráneo de otro clon, directorio preexistente sin checkout, preservación de archivos sucios, preservación de ramas tras `--discard`, y fallo transitorio de Git que sí consume reintentos. Sin temporizadores arbitrarios (`sleep`), ejecución síncrona/determinista.
  - Comprobación completa: `bun test tests` arrojó **1243 pass, 1 skip, 0 fail** (282.67s). `bun run typecheck` limpio (`tsc --noEmit -p .`).
- **T11 (`tests/admission-report.test.ts`):** Cobertura de agrupación, mapeo 403 a `unknown`, filtrado de efectos con reintentos o `dead`, formato `--json` y concurrencia con residente activo sin tomar el lock.
  - Comprobación completa: `bun test tests/admission*.test.ts` arrojó **43 pass, 1 skip, 0 fail**. `bun run typecheck` limpio (`tsc --noEmit -p .`).
  - *Advertencia de fragilidad temporal:* En `tests/admission-report.test.ts:50` se utiliza `await Bun.sleep(30);` para permitir que venza el backoff exponencial de 10ms antes del segundo dispatch. Aunque pasa localmente, las dependencias de `sleep` real pueden sufrir bajo contención severa en CI.

### 4.2 Alcance y delimitación de capas
- Ambos cambios respetan estrictamente la separación de responsabilidades:
  - T10: La lógica de Git/filesystem reside en `src/worktrees.ts`; la orquestación de la actividad en `src/pool.ts`; la interacción CLI y comprobación de workers en curso en `src/cli.ts`. Sin columnas nuevas en el store.
  - T11: La agregación y formateo residen en `src/admission/report.ts`; el registro de polls en `src/admission/resident.ts` y `src/admission/db.ts`; el subcomando en `src/admission/cli.ts`. No toca tablas de la fábrica.

---

## 5. Tabla de Hallazgos

| ID | Tarea | Severidad | `ruta:línea` | Problema | Escenario concreto que falla | Arreglo propuesto |
|---|---|---|---|---|---|---|
| **H1** | T10 | Baja | `src/worktrees.ts:90-93` | Control de flujo confuso con sentencia `throw error` tras bloque `if-else`. | No genera fallo en runtime porque el `else` lanza `WorktreeNeedsRepair`, pero el `throw error` exterior queda estructuralmente como dead code para la rama `else`. Confunde a linters y lectores. | Reestructurar explícitamente: `if (!existsSync(path)) { unlinkSync(preparing); throw error; } else { throw new WorktreeNeedsRepair(...); }`. |
| **H2** | T10 | Baja | `src/worktrees.ts:101` vs `src/cli.ts:344` | Verificación de concurrencia de workers situada en CLI y no en la función de biblioteca `repairWorktree`. | Si `repairWorktree` fuese invocado programáticamente por otro servicio en lugar de la CLI `fab worktree repair`, no verificaría si hay actividades `in_progress`. | Mantener la separación (ya que `worktrees.ts` no depende de `Store`), pero documentar explícitamente en el docstring de `repairWorktree` el requerimiento de fencing/verificación externa de workers. |
| **H3** | T11 | Media | `src/admission/resident.ts:77` / `src/admission/github.ts:30` | Repositorio de prueba `DarkCodePE/sw-factory` no contiene issues puros, solo PRs. | Al ejecutar `fab resident --repo DarkCodePE/sw-factory --mode observe --once`, `pollIssues` descarta todos los items debido a `if (i.pull_request) continue;`. El reporte real resulta vacío con 0 eventos y no responde empíricamente a (a), (b) ni (c). | Documentar que la validación empírica en producción requiere un repo con issues activos o mock/staging repo con issues reales etiquetados con `fab`. |
| **H4** | T11 | Baja | `src/admission/report.ts:25` | Ordenamiento no estrictamente total en decisiones de `buildReport`. | Si dos decisiones tienen el mismo valor de `wouldAdmit` y el mismo `count`, el orden relativo depende del orden de inserción en el `Map`, lo que podría generar variaciones en scripts que consuman `--json`. | Añadir ordenamiento alfabético por razón como desempate secundario: `sort((a, b) => Number(b.wouldAdmit) - Number(a.wouldAdmit) \|\| b.count - a.count \|\| a.reason.localeCompare(b.reason))`. |
| **H5** | T11 | Baja | `tests/admission-report.test.ts:50` | Temporizador real `await Bun.sleep(30)` en test de efectos reintentados. | En runners de CI con alta carga de CPU o timers de baja resolución, 30ms podría ser insuficiente o generar variabilidad innecesaria. | Inyectar reloj simulado (`simTime`) o configurar `baseMs: 0` en el test helper para eliminar esperas de reloj de pared. |

---

## 6. Contraste con `codex.md` y `sonnet.md`

*(Sección redactada tras completar los hallazgos y verificaciones anteriores).*

### 6.1 Contraste con `codex.md` (T10)
- **Coincidencias en diagnóstico del defecto:** Codex documentó acertadamente que `src/worktrees.ts:70` lanzaba `Error` genérico al topar con `.preparing`, y que `src/pool.ts:347->360` desembocaba en `store.failActivity`, agotando `MAX_ACTIVITY_RETRIES` en `src/store.ts:923-936`.
- **Punto destacado por Codex:** Codex identificó una sutileza de regresión en `src/pool.ts:348`: `isBusyError` busca la subcadena `busy` en el mensaje de error o en la ruta de trabajo. Para evitar que un worktree en una ruta con la palabra `busy` (p. ej. `/tmp/busy-state`) fuese clasificado erróneamente como un bloqueo de SQLite (`database is locked`) y re-encolado indefinidamente, Codex antepuso `!(err instanceof WorktreeNeedsRepair) && isBusyError(err)`. Nuestra auditoría verificó esta guardia y la consideró acertada.
- **Ajustes en tests preexistentes:** Codex explicó que `tests/pool-leases.test.ts:547` y `tests/improve.test.ts:516` asumían que un repositorio inexistente provocaba reintentos sucesivos. Al clasificar ahora un repositorio faltante como error determinista (`WorktreeNeedsRepair`), dichos tests fallaban legítimamente. Codex adaptó `pool-leases.test.ts` a un fallo transitorio genuino (un checkout previo que ocupa la rama) y actualizó la aserción de `improve.test.ts` a `status: 'blocked'`.
- **Diferencia de profundidad / Hallazgos propios:** Codex no reportó el detalle de control de flujo en `src/worktrees.ts:90-93` (dead `throw error;` exterior tras el bloque `else`), que señalamos en **H1**, ni la consideración de fencing modular mencionada en **H2**. En lo sustantivo, el diseño y la seguridad del parche coinciden plenamente.

### 6.2 Contraste con `sonnet.md` (T11)
- **Coincidencia en la prueba real empírica:** Sonnet llegó exactamente a la misma conclusión empírica que nosotros respecto a `DarkCodePE/sw-factory`: el reporte emite `(0 issues)` y `decisiones: []` porque ese repositorio contiene exclusivamente Pull Requests y ninguna incidencia tradicional (`pollIssues` descarta con `if (i.pull_request) continue;`).
- **Coincidencia en el alcance de (a), (b) y (c):** Sonnet reconoció con honestidad técnica que ninguna de las tres preguntas puede responderse con datos reales de producción todavía en ese repositorio, y que la validez del mapeo de roles (`unknown` ante 403, detección de labeler) y el filtrado de reintentos queda validada a través de fixtures en `tests/admission-report.test.ts`.
- **Observación sobre escrituras de metadata:** Sonnet anotó con precisión que al instanciar `new AdmissionDb(store)`, el constructor ejecuta `ensureSchema()`, lo que crea las tablas `adm_*` si no existían (`CREATE TABLE IF NOT EXISTS`). No escribe filas ni muta datos, preservando la semántica de solo lectura para el usuario.
- **Diferencia de profundidad / Hallazgos propios:** Sonnet no advirtió el riesgo menor de no-determinismo en el ordenamiento de decisiones con recuentos iguales (**H4**), ni la fragilidad potencial de `await Bun.sleep(30)` en `tests/admission-report.test.ts:50` (**H5**).

---

## 7. Lo que no revisé

1. **Modo daemon prolongado:** No se dejó corriendo `fab resident --mode observe` en bucle continuo durante múltiples horas o días para medir el comportamiento de la base ante acumulación de miles de ciclos y rotaciones de cursores.
2. **Tokens sin privilegios contra repositorios reales:** No se ejecutó una llamada a GitHub API con un token de permisos restringidos (rol `read` o sin acceso push) contra un repositorio externo privado para capturar un HTTP 403 auténtico desde GitHub en vivo (esta conducta se verificó mediante el mock `fakeGh` en la suite de tests).
3. **Contención a nivel de sistema operativo (`SQLITE_BUSY`):** No se provocó un bloqueo a nivel de lock de archivo de SQLite durante la ejecución del comando `fab resident report`, confiando en la arquitectura WAL estándar de lectura concurrente sin bloqueo.

<!-- FIN -->