# Reporte ola 1 — codex: 06 → 09 → 02

Fecha: 2026-10-30 (America/Lima; ejecución también registrada como 2026-10-31 UTC).
Repositorio: `/home/orlando/Desktop/factory/sw-factory-ola1-codex`.
Rama: `fab/research-ola1-codex`. Base: `main@7783845`.
Resultado: fichas implementadas, verificadas y comprometidas en el orden requerido. No se hizo merge, push ni cambio de rama en el repositorio de trabajo.

## Commits

1. `ccc9564` — `feat(pool): detener bloqueos declarados y habilitar resolución humana` (06).
2. `bfe6ed3` — `feat(auditoría): exigir motivo de rechazo y registrar actor` (09).
3. `f0c4195` — `feat(integridad): proteger rutas y auditar aprobaciones selectivas` (02, con regresiones de integración de 06/09).

Sin trailers `Co-Authored-By`, dependencias nuevas ni modificaciones de manifiestos/lockfiles.

## Cambios por archivo y comportamiento

| Evidencia | Cambio |
| --- | --- |
| `src/store.ts:32` | Extensiones locales de los tipos de activity/change con `blocked`, respetando la propiedad que excluye `src/enums.ts`. |
| `src/store.ts:220` | Migraciones con `addColumn`: actor, protected_paths, base_sha y protected_baseline. INSERT con columnas nombradas. |
| `src/store.ts:245` | Lista protegida por defecto; `protectedPaths` añade globs y solo `protectNone` permite desactivar los predeterminados. |
| `src/store.ts:395` | `setChangeBase` guarda el SHA una sola vez mediante `WHERE base_sha IS NULL`. |
| `src/store.ts:400` | `allowGate` actualiza exclusivamente las rutas aprobadas, reencola e invalida resultados de validación anteriores en una transacción con evento auditado. |
| `src/store.ts:472` | Inbox incluye el bloqueo vigente por change, con su razón completa; evita duplicar bloqueos históricos tras retry. |
| `src/store.ts:540` | Un validador blocked se resume como fallo sin veredicto; la barrera existente de merge continúa cerrada. |
| `src/store.ts:634` | Nuevo `blockActivity`: terminal sin consumir reintentos, razón completa, cancelación de actividades pendientes del change, evento y protección frente a resultados tardíos. |
| `src/store.ts:651` | Cambio mínimo en el CAS de `failActivity`: no reencolar sobre un change terminal, incluido blocked. |
| `src/store.ts:680` | `decline` exige motivo no vacío en el Store, cubriendo CLI y TUI. |
| `src/store.ts:726` | Retry admite blocked y conserva kind/validator; restaura implemented para validadores y pending para workers. |
| `src/store.ts:785` | Todos los eventos nuevos llevan `FAB_ACTOR ?? userInfo().username`; eventos históricos conservan actor NULL. |
| `src/pool.ts:21` | Captura base antes del agente. Después de implementación o cualquier validador comprueba integridad antes de STATUS y exit. Solo un blocked declarado detiene los reintentos; missing sigue consumiendo el presupuesto de tres intentos. |
| `src/validators/integrity.ts:6` | Predeterminados exactos del contrato y tipos de snapshots de aprobación. |
| `src/validators/integrity.ts:56` | Unión de archivos base/disco/HEAD; comparación de blobs y modos. Detecta altas, bajas, modificaciones y cambios solo en commit. Lee enlaces sin seguirlos, también enlaces nuevos en raíces tests/.github. Incluye archivos ignorados de disco. |
| `src/worktrees.ts:21` | `ensureWorktree` devuelve el SHA de HEAD antes de ejecutar al primer worker, que se persiste en el change. |
| `src/worktrees.ts:46` | Aprobaciones con cambios sin commit registran exclusivamente las rutas aprobadas mediante commit --only y pathspecs literales; conservan staged ajeno y flags Git seguros. |
| `src/cli.ts:197` | Inbox imprime razón completa y salidas retry/reject. |
| `src/cli.ts:253` | Audita merge --force antes de invocar Git, incluso si no había un impedimento. |
| `src/cli.ts:266` | `fab gate allow <changeId> <ruta…> --comment <motivo>` valida rutas exactas protegidas, estado y ausencia de workers activos; registra cambios aprobados, toma snapshot y reencola. |
| `src/cli.ts:297` | Audita reject con actor. La cancelación/espera y aborto de workers siguen siendo propiedad de 07. |
| `src/tui.ts:27` | Color, marca y contador de bandeja para blocked. |
| `src/tui.ts:148` | Input distingue comentario/motivo; d abre motivo y rechaza entrada vacía. |
| `src/tui.ts:215` | r sobre failed, blocked e implemented con validador agotado; conserva contexto de validación. |

## Verificación final

Comando ejecutado en el worktree, sobre `f0c4195`:

```text
$ bun test
 795 pass
 0 fail
 4329 expect() calls
Ran 795 tests across 82 files. [204.86s]

$ bunx tsc --noEmit
(sin salida; exit 0)

$ git diff --check
(sin salida; exit 0)
```

La línea base del contrato era 762: hay 33 pruebas nuevas. La primera pasada completa dio 791 pass; la pasada final incluye las regresiones añadidas después y es la de 795 indicada arriba. No hubo tests omitidos ni fallos en la pasada final.

Cobertura específica:

- 06: fake con `FABRICA_FAKE_STATUS='blocked - cannot reproduce'` ejecuta exactamente una sesión, retryCount=0 y estado blocked en activity/change. Razón extensa íntegra en inbox, retry humano y TUI, mismo validator al reintentar, merge cerrado para validador blocked, y missing reintentado tres veces.
- 02: seis manipulaciones detectadas: editar test, borrar assert, añadir conftest.py ignorado, cambiar bunfig.toml, modificar test solo en commit restaurando el disco y reemplazar test por symlink. Diez changes limpios, alternando cambios solo en disco y cambios commiteados, sin falsos positivos.
- Regresiones adicionales: enlaces nuevos tests/.github; guardia en los tres validadores aun con STATUS blocked/exit fallido; retry sin allow vuelve a bloquear; allow con actor y comentario; SHA conservado tras avanzar main; invalidación de un pass anterior; aprobación parcial no autoriza la otra ruta; allow de validador deja sus rutas aprobadas limpias y conserva porcelain; commit selectivo conserva staged ajeno.
- 09: actor explícito y fallback del sistema, decline sin motivo rechazado sin transición/evento, TUI exige motivo, CLI reject auditado y CLI merge --force auditado al saltar validación en un repositorio temporal.
- Se actualizaron los tests existentes de §5: `tests/pool.test.ts`, `tests/worktrees.test.ts`, `tests/tui.test.ts`. Nuevos: `tests/blocked.test.ts`, `tests/decisions.test.ts`, `tests/integrity.test.ts`.

Logs locales: `/tmp/fab-ola1-bun-test-final.log`, `/tmp/fab-ola1-tsc-final.log`, `/tmp/fab-ola1-demo-final.log`. La transcripción real queda pegada debajo para que el reporte no dependa de conservar /tmp.

## Sesión real de fab sobre toy-calc

El ejemplo estaba en `/home/orlando/Desktop/factory/examples/toy-calc`, no dentro de sw-factory. Se copió completo, incluyendo su repositorio Git, a una carpeta temporal. No se modificó el original. El script real de reproducción quedó en `/tmp/fab-ola1-demo.py` y se ejecutó con `python3 /tmp/fab-ola1-demo.py`.

Se usó el adaptador real fake sin editar `src/agents.ts`. Para que ese fake dejara un cambio determinista en el test durante implementación, únicamente esa invocación antepuso un wrapper de sh a PATH; el contenido está en la transcripción. El wrapper delega al sh original, que genera el reporte normal del adaptador. Los comandos comparten FABRICA_HOME y FAB_ACTOR indicados al inicio. En el comando con PATH, "$PATH" representa el PATH heredado.

Resultado observado: bloqueo declarado visible en inbox; edición de test bloqueada por GATE_TAMPERED; retry vuelve a bloquear; gate allow auditado autoriza solo ese archivo; implementación termina implemented y QA posterior produce PASS. No se fusionó el change de la demostración.

```text
DEMO_ROOT=/tmp/fab-ola1-demo-yt7zo9b0
Entorno común: FABRICA_HOME=/tmp/fab-ola1-demo-yt7zo9b0/state FAB_ACTOR=ola1-operator
$ git -C /tmp/fab-ola1-demo-yt7zo9b0/toy-calc config user.name demo
$ git -C /tmp/fab-ola1-demo-yt7zo9b0/toy-calc config user.email demo@localhost
$ git -C /tmp/fab-ola1-demo-yt7zo9b0/toy-calc add -A
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts ws create declared --repo /tmp/fab-ola1-demo-yt7zo9b0/toy-calc --goal 'bloqueo declarado' --agent fake --concurrency 1 --no-change-approval --no-spec-approval
workstream declared (13cb271c) creado en draft; actívalo con: fab ws state declared active
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts ws state declared active
declared -> active
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts signal add declared 'No puedo reproducir'
signal 71287fc9 añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts triage --all declared
signal 71287fc9 -> change e72244bd (pending)
$ FABRICA_FAKE_STATUS='blocked - falta evidencia del operador' bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts run declared --once
[w1-3633695] investigation "No puedo reproducir" -> fake in /tmp/fab-ola1-demo-yt7zo9b0/state/worktrees/e72244bd
[w1-3633695] investigation blocked: blocked - falta evidencia del operador
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts inbox declared

== 1aee3525  investigation  change e72244bd: No puedo reproducir
blocked: blocked - falta evidencia del operador
-> fab retry e72244bd | fab reject e72244bd
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts ws create integrity --repo /tmp/fab-ola1-demo-yt7zo9b0/toy-calc --goal 'proteger tests' --agent fake --concurrency 1 --no-change-approval
workstream integrity (5099f62e) creado en draft; actívalo con: fab ws state integrity active
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts ws state integrity active
integrity -> active
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts signal add integrity 'Cambio de test revisable'
signal e6124e18 añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts triage --all integrity
signal e6124e18 -> change a5b2fff9 (pending)
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts run integrity --once
[w1-3633844] investigation "Cambio de test revisable" -> fake in /tmp/fab-ola1-demo-yt7zo9b0/state/worktrees/a5b2fff9
[w1-3633844] investigation done in 0s
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts review 55724626-964a-4606-94f9-7d2ddae83631 approve
investigation 55724626: approve
$ cat /tmp/fab-ola1-demo-yt7zo9b0/fake-bin/sh
#!/bin/bash
if [[ "${FAB_DEMO_EDIT_TEST:-}" == 1 ]]; then
  printf "\n# test edit by deterministic fake fixture\n" >> tests/test_calc.py
fi
exec /bin/sh "$@"

$ PATH=/tmp/fab-ola1-demo-yt7zo9b0/fake-bin:"$PATH" FAB_DEMO_EDIT_TEST=1 bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts run integrity --once
[w1-3633898] implementation "Cambio de test revisable" -> fake in /tmp/fab-ola1-demo-yt7zo9b0/state/worktrees/a5b2fff9
[w1-3633898] GATE_TAMPERED: tests/test_calc.py
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts inbox integrity

== 3f2abd60  implementation  change a5b2fff9: Cambio de test revisable
blocked: GATE_TAMPERED: tests/test_calc.py
-> fab retry a5b2fff9 | fab reject a5b2fff9
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts retry a5b2fff9-8c22-4423-aa54-6dbc810072f7
change a5b2fff9: implementation re-encolada
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts run integrity --once
[w1-3633992] implementation "Cambio de test revisable" -> fake in /tmp/fab-ola1-demo-yt7zo9b0/state/worktrees/a5b2fff9
[w1-3633992] GATE_TAMPERED: tests/test_calc.py
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts inbox integrity

== cf53de12  implementation  change a5b2fff9: Cambio de test revisable
blocked: GATE_TAMPERED: tests/test_calc.py
-> fab retry a5b2fff9 | fab reject a5b2fff9
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts gate allow a5b2fff9-8c22-4423-aa54-6dbc810072f7 tests/test_calc.py --comment 'Revisé el cambio del test; autorizado'
change a5b2fff9: gate allow registrado; actividad re-encolada
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts run integrity --once
[w1-3634175] implementation "Cambio de test revisable" -> fake in /tmp/fab-ola1-demo-yt7zo9b0/state/worktrees/a5b2fff9
[w1-3634175] implementation done in 0s
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts status integrity
integrity [active] agent=fake — proteger tests
  a5b2fff9 implemented  Cambio de test revisable  [implementation:completed]
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts validate a5b2fff9-8c22-4423-aa54-6dbc810072f7 --only qa
Encolados 1 validadores para change a5b2fff9: qa
$ FABRICA_FAKE_STATUS='done
VERDICT: pass
Revisado por fake' bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts run integrity --once
[w1-3634255] qa "Cambio de test revisable" -> fake in /tmp/fab-ola1-demo-yt7zo9b0/state/worktrees/a5b2fff9
[w1-3634255] change_review done in 0s
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts validate status a5b2fff9-8c22-4423-aa54-6dbc810072f7
### Validación de fab change `a5b2fff9` [APROBADO]

| Validador | Veredicto | Resumen |
| --- | --- | --- |
| `qa` | **PASS** | Revisado por fake |
$ bun /home/orlando/Desktop/factory/sw-factory-ola1-codex/src/cli.ts events integrity
2026-10-31T01:56:56.113Z info    [ola1-operator] workstream integrity created (draft)
2026-10-31T01:56:56.180Z info    [ola1-operator] workstream draft -> active
2026-10-31T01:56:56.313Z info    [ola1-operator] change created: Cambio de test revisable
2026-10-31T01:56:56.377Z info    [ola1-operator] investigation claimed by w1-3633844
2026-10-31T01:56:56.407Z info    [ola1-operator] investigation awaiting spec review
2026-10-31T01:56:56.469Z info    [ola1-operator] investigation approved
2026-10-31T01:56:56.534Z info    [ola1-operator] implementation claimed by w1-3633898
2026-10-31T01:56:56.552Z warning [ola1-operator] blocked: GATE_TAMPERED: tests/test_calc.py
2026-10-31T01:56:56.671Z info    [ola1-operator] change retried (implementation)
2026-10-31T01:56:56.743Z info    [ola1-operator] implementation claimed by w1-3633992
2026-10-31T01:56:56.761Z warning [ola1-operator] blocked: GATE_TAMPERED: tests/test_calc.py
2026-10-31T01:56:56.920Z info    [ola1-operator] change retried (implementation)
2026-10-31T01:56:56.920Z warning [ola1-operator] gate allow: ["tests/test_calc.py"]: Revisé el cambio del test; autorizado
2026-10-31T01:56:56.987Z info    [ola1-operator] implementation claimed by w1-3634175
2026-10-31T01:56:57.009Z info    [ola1-operator] implementation done; change implemented
2026-10-31T01:56:57.144Z info    [ola1-operator] validation requested: qa
2026-10-31T01:56:57.206Z info    [ola1-operator] validator qa claimed by w1-3634255
2026-10-31T01:56:57.230Z info    [ola1-operator] validator qa completed: approved
DEMO_OK

```

## Decisiones mínimas y límites

1. **Propiedad de enums:** `src/enums.ts` no estaba autorizado. Extendí los tipos en Store y su método isTerminal, sin tocar ese archivo. El integrador puede consolidar el vocabulario compartido después, si lo desea.
2. **Snapshot de aprobaciones:** además de base_sha, changes guarda protected_baseline como JSON por ruta exacta, con identidades de disco/HEAD. Aprobar una ruta no mueve el SHA original ni autoriza el resto del árbol. Una identidad de disco aprobada puede pasar a HEAD por un commit posterior de la fábrica.
3. **Allow y worktree sucio:** solo cambiar el snapshot dejaba atrapado a un validador en la comprobación porcelain. Por eso la CLI registra las rutas explícitamente aprobadas en un commit selectivo de fab antes del snapshot. Es un commit dentro de la rama del change, con hooks desactivados; no incluye staged ajeno. La prueba de este borde pasa. No se elimina la barrera de worktree sucio.
4. **Validaciones anteriores:** se conservan sus activities para auditoría, pero se ponen failed y se borran veredictos/comentarios; no pueden seguir contando como pass. Se reencola la activity bloqueada. Los otros validadores invalidados deben solicitarse otra vez con fab validate; no se lanzan automáticamente antes de que termine una implementación reintentada.
5. **Migración:** workstreams antiguos con protected_paths NULL obtienen los predeterminados al leerlos. Para changes antiguos sin base_sha, se fija el HEAD del worktree en su primer procesamiento por esta versión. No se puede reconstruir de forma fiable el SHA original de un change anterior a la migración: para garantías históricas estrictas, recrear esos changes. Los nuevos changes sí capturan el SHA antes del primer agente y lo conservan en reintentos.
6. **Seguridad del alcance:** esta es integridad post-hoc, como exige la ficha; no confina adaptadores externos ni impide efectos en el host. Threatmon, manifests, aborto y leases no se implementan aquí.
7. **Referencias:** implementación propia a partir del contrato y patrones existentes de fab; no se copió ni adaptó código concreto de ESF, por lo que no hay un archivo ESF concreto que atribuir en los commits.
8. **Descubrimiento:** se consultaron list_projects y check_index_coverage; el worktree no estaba indexado en MCP. Se usaron graft y lectura directa como fallback (sin atribuir una generación inexistente). La revisión de lectura adicional detectó los bordes de symlink raíz y allow de validador; ambos quedaron cubiertos por tests. Su segunda revisión no terminó por cuota, por lo que no se presenta como una segunda aprobación independiente.

No quedan preguntas para el operador; las decisiones anteriores documentan las ambigüedades resueltas.

## Integración con 07: superficies que pueden chocar

- **No se editaron** `src/agents.ts`, `claimActivity`, `heartbeat`, `completeActivity`, `requeueOrphans` ni leases.
- **Store:** migraciones y mapeadores añaden columnas/campos; reconciliar junto a la migración de leases usando siempre addColumn. Nuevos blockActivity/allowGate/setChangeBase; cambios en inbox, validationSummary, retryChange, resolveReview, event e isTerminal.
- **Excepción mínima permitida de failActivity:** solo cambia el predicado CAS, añadiendo EXISTS contra changes para rechazar resultados sobre completed/failed/canceled/declined/blocked. Mantenerlo al integrar para que un error tardío no deshaga un bloqueo. completeActivity no fue modificado.
- **Pool:** processActivity obtiene/persiste baseSha y comprueba integridad justo después de runAgent, antes de exit/STATUS/veredicto/completeActivity. Mantener ese orden al añadir signal/lease/heartbeat. runPool no fue modificado.
- **Terminales:** las barreras de 07 para claim, heartbeat y completeActivity deben incluir blocked entre los estados que detienen el trabajo. blockActivity cancela hermanos pendientes; la exclusión por change de 07 evita validadores ya activos sobre el mismo worktree. No interpretar el bloqueo humano como un lease recuperable.
- **CLI reject:** aquí solo se añadió auditoría; al integrar 07, mantener su cancelación antes del borrado y espera del worker, preservando el evento con actor.
- **Prueba conjunta pendiente de integración:** no se afirma que 07 esté validado en esta rama. El coordinador debe volver a ejecutar la suite tras combinar los cambios y sus pruebas de carreras/leases/aborto.

## Estado de entrega

Los tres commits están en la rama asignada. Árbol de archivos tracked limpio. El symlink `node_modules` ya era un archivo no rastreado al comenzar y se dejó intacto. Este reporte se escribió únicamente en la ruta externa autorizada; no se comprometió en otra rama.
