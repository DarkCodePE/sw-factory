# Brief: revisión de la fase 0 (goldfish)

Eres un revisor sin contexto previo. Revisa un cambio **sin commit** en el worktree `/home/orlando/Desktop/factory/sw-factory-fase0` (rama `feat/fase0-endurecer`, base `ce84fc4`). Míralo con `git -C /home/orlando/Desktop/factory/sw-factory-fase0 diff` y `git status` (incluye el archivo nuevo `tests/agents-stdin.test.ts`).

**Solo lectura.** No edites ningún archivo de ningún worktree, no hagas commit y no lances subagentes. Puedes ejecutar tests y typecheck. Lo único que escribes es tu informe.

## Roles EGM
Los roles de `/home/orlando/Desktop/ia-master/elephant-goldfish-model/agents/` que te indique tu prompt; si no indica ninguno, `codebase_details.md` e `implementation_readiness.md`.

## Qué pedía el cambio
Lee el encargo original en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase0/BRIEF-FASE0.md`. Son cinco tareas: tope de reintentos en `requeueOrphans`, token por claim, verificación de worktrees reutilizados, `withRetry` en `importIssue` y prompt por stdin. **No leas el informe del implementador (`fase0/codex.md`) hasta haber escrito tus hallazgos**; después puedes contrastarlo en una sección aparte.

## Qué buscar
1. **Corrección**: ¿cada arreglo cierra de verdad su defecto? Busca casos que se escapan, como carreras entre procesos, transacciones que lanzan a mitad del bucle de recuperación o estados del change que cambian de comportamiento sin quererlo.
2. **Regresiones**: lee los **llamadores** de cada función tocada (`graft callers`) y busca qué cambió para ellos.
   - `recordActivityFailure` ahora también la usa `requeueOrphans`. Antes, reencolar solo ponía el change en `pending` si estaba `in_progress`.
   - `ensureWorktree` escribe y borra una marca `.preparing`.
   - `runAgent` envía el prompt por stdin y `manifest-capture` hereda stdin.
3. **Compatibilidad**: hay dos ramas que envuelven `runAgent`, y el cambio de stdin no debe romperlas:
   - `/home/orlando/Desktop/factory/sw-factory-live-claude/src/live/claude.ts`
   - `/home/orlando/Desktop/factory/sw-factory-live-native/src/live/native.ts`
4. **Tests**: ¿prueban el defecto o solo el camino feliz? ¿Hay tests frágiles por tiempos?
5. **Alcance**: ¿hay cambios no pedidos, abstracciones de más o algo que debería ir en otra capa?

## Método
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos.
- Cita cada hallazgo como `ruta:línea`. Distingue lo **verificado**, leído o ejecutado, de lo **inferido**.
- Si ejecutas tests, pega el comando y la salida.

## Salida
Escribe en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase0/<tu-nombre>.md`, con el nombre que te da tu prompt (agy, opencode, haiku). No leas los informes de los otros revisores:
- **Veredicto**: listo para commit / listo con cambios / no listo.
- **Tabla de hallazgos**: id, severidad (alta, media o baja), `ruta:línea`, problema, escenario concreto que falla y arreglo propuesto.
- **Contraste con `codex.md`**, escrito después de tus hallazgos.
- **Lo que no revisaste.**

Última línea, exactamente: `<!-- FIN -->`.
