# T11: informe de observe y prueba real del residente

Worktree `/home/orlando/Desktop/factory/sw-factory-fase1`, rama `feat/t11-observe-informe`. Sin commit, push ni merge.

## Qué construí

- **`fab resident report [--json]`**, solo lectura, sin lock. Se despacha antes del parseo normal en `src/admission/cli.ts:14-20`; ayuda en `src/cli.ts:92`.
- **`src/admission/report.ts`** (nuevo, ~55 líneas): `buildReport` (`:12`) y `formatReport` (`:35`). Cubre:
  - cursor y último poll por fuente;
  - decisiones agrupadas por `would_admit` + primera razón;
  - cada `label-not-verified` con issue, `label-by` y rol (se parsea de `reasons[1]`, `label-by:login(rol)`);
  - efectos con `attempts > 1` o `dead`/`unknown`, con `last_error`.
- **Dato que faltaba (fecha del último poll)**: tabla nueva `adm_polls(source, polled_at, events)` en `src/admission/db.ts:21`, y un upsert tras cada `pollIssues` en `src/admission/resident.ts:78-79`. No se toca ninguna tabla de la fab.
- **Guía**: sección «Residente en observe» en `techdocs/docs/factory/11-integraciones.md:76` (no existía documentación de `fab resident`; ese capítulo ya documenta conectores GitHub). Explica lanzar con `FABRICA_HOME` aparte, leer el informe y qué mirar para (a), (b), (c).
- **Tests**: `tests/admission-report.test.ts`, 5 tests con el `fakeGh` del helper:
  - agrupación, cursor y último poll;
  - `label-not-verified` con labeler y rol (`403` → `unknown`);
  - efectos `dead` y reintentados, y que uno hecho a la primera no aparece;
  - `--json` válido e idéntico a `buildReport`, y el texto muestra los mismos datos;
  - `report` con un residente activo (lock tomado por otra conexión): funciona y no lo toca.

## Comandos y salida

Línea base, antes de editar: `bun test tests` → `1226 pass, 1 skip, 1 fail, 1 error` (1228 tests, 305 s). El fallo era `corrupt final record ignored and repaired… 10000 records [30000ms]`: un timeout de 30 s ajeno a admission. Salida guardada en el scratchpad (`base-tests.txt`).

Al terminar:
- `bun run typecheck` → limpio.
- `bun test tests/admission` → `43 pass, 0 fail`.
- `bun test tests` → `1232 pass, 1 skip, 0 fail` (1233 tests, 290 s). No empeora; el test de 30 s pasó esta vez, así que es flaky por tiempo.

### Prueba real (solo lectura, `FABRICA_HOME` en el scratchpad)

```
$ FABRICA_HOME=<scratchpad>/fab-home bun src/cli.ts resident --repo DarkCodePE/sw-factory --mode observe --once --since 2026-10-01T00:00:00Z
recuperados 0 efectos interrumpidos
ciclo: {"triggers":0,"effects":0}
$ FABRICA_HOME=<scratchpad>/fab-home bun src/cli.ts resident report
== Fuentes ==
github:DarkCodePE/sw-factory  cursor=-  último poll=2026-11-11T02:44:07.945Z (0 issues)

== Decisiones (would_admit / primera razón) ==
(ninguna)

== label-not-verified (issue, label-by, rol) ==
(ninguna)

== Efectos con reintentos (attempts>1) o dead/unknown ==
(ninguno)
```

Repetí con `--since 2020-01-01T00:00:00Z` en otra base: mismo resultado (0 issues). Lo único que se llamó en GitHub fue el `GET repos/.../issues` del poller. Nunca usé `~/.fabrica`.

## Qué responden ya los datos

**Ninguna de (a), (b), (c) con datos reales todavía.** `DarkCodePE/sw-factory` no tiene issues (solo PRs, que el poller descarta), así que no hubo triggers, decisiones ni efectos. Lo que sí quedó demostrado con la prueba real:
- `gh api` y el poller funcionan contra el repo real (0 errores, el último poll queda registrado).
- `report` funciona sobre una base real recién creada.

Con fixtures (tests) se ve que el informe distingue correctamente rol `read` (labeler sin permiso) de `unknown` (403) y muestra los reintentos. Eso valida el informe, no el comportamiento de GitHub.

Falta para responder, y necesita días de observe contra un repo con issues y alguien que etiquete `fab`:
- **(a)** issues etiquetados reales: comparar `label-by`/rol del informe con lo que muestra GitHub.
- **(b)** un repo donde el token no tenga push: confirmar rol `unknown`. Con este token (admin) no puede salir.
- **(c)** etiquetar un issue y ver si el efecto `admit` reintenta («no se encontró el evento labeled»). Requiere crear datos en GitHub, que el brief prohíbe.

## Lo que no hice

- No etiquetar, crear ni modificar nada en GitHub; no commit/push/merge; no subagentes; no tocar otros worktrees.
- No probé (b) ni (c) contra GitHub real.
- `adm_polls` solo registra el último poll por fuente, no un historial. Un poll fallido no actualiza la fecha.
- `AdmissionDb` hace `CREATE TABLE IF NOT EXISTS` al abrirse, así que `report` sobre una base antigua crea las tablas `adm_*` vacías (no es una escritura de datos).

<!-- FIN -->
