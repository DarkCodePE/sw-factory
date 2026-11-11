# Brief T11: informe de observe y prueba real del residente

Worktree: `/home/orlando/Desktop/factory/sw-factory-fase1`, rama `feat/t11-observe-informe`, base `origin/release/0.1.0-rc.12` (`9dbb175`). Trabaja **solo** ahí. `node_modules` ya está enlazado; no lo toques.

## Contexto
`fab resident --mode observe` (`src/admission/`) hace poll de los issues de un repo de GitHub y registra en las tablas `adm_*` de `fabrica.db` si los admitiría (`would_admit`), sin crear changes. Lee primero:
- `src/admission/*.ts`;
- `tests/admission-*.test.ts`;
- las decisiones D1-D3 en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/task.json`. En resumen: solo se admite con la etiqueta `fab` verificada (rol triage o superior de quien la puso), y sin cursor se lee el último día.

Antes de pasar a la fase 2, en la que la fab creará changes de verdad, hay que dejarlo corriendo unos días contra un repo real y responder con datos tres preguntas:
- **(a)** ¿Se verifica bien la etiqueta?
- **(b)** ¿Aparece el 403 en repos donde el token no tiene acceso push? Entonces el rol queda `unknown`.
- **(c)** ¿El evento `labeled` llega tarde? Entonces el efecto `admit` reintenta o queda `dead`.

Hoy no hay forma de leer eso sin escribir SQL a mano.

## Qué construir
1. **`fab resident report`**, o el subcomando que encaje en `src/admission/cli.ts`. Es de solo lectura y no necesita el lock del residente. Debe mostrar:
   - el cursor de cada fuente y la fecha del último poll registrado;
   - las decisiones agrupadas por `would_admit` y por la primera razón (`no-trigger-label`, `label-not-verified`, `trigger-label`…), con su recuento;
   - cada decisión `label-not-verified`, con issue, `label-by` y rol, para responder (a) y (b);
   - los efectos con `attempts > 1` o en estado `dead`/`unknown`, con su `last_error`, para responder (c);
   - una opción `--json` con la misma información, para scripts.
   - Si para la fecha del último poll falta un dato, añade solo lo mínimo en las tablas `adm_` del propio módulo (`CREATE TABLE IF NOT EXISTS` o una columna nueva en una tabla `adm_` creada por ti). **No toques** tablas de la fab.
2. **Una guía corta**, en una sección de `techdocs/docs/factory/` o donde se documente `fab resident`. Busca con graft si ya existe ese sitio. Debe explicar:
   - cómo lanzarlo en observe contra un repo real con una base aparte (`FABRICA_HOME=<dir> fab resident --repo O/R --mode observe`);
   - cómo leer el informe;
   - qué mirar para (a), (b) y (c).
3. **Prueba real con `--once`, solo de lectura**, contra `DarkCodePE/sw-factory`, donde el token tiene acceso admin, usando `FABRICA_HOME` en un directorio temporal del scratchpad. **Nunca** uses el `~/.fabrica` real. Pega en el informe la salida de `report`. Si quieres ver issues etiquetados, usa `--since` hacia atrás. **No crees, etiquetes ni modifiques issues en GitHub.**

## Tests (`tests/admission-report.test.ts`)
- Con fixtures, usando el runner `gh` falso de `tests/helpers/admission.ts`:
  - el informe agrupa bien;
  - lista los `label-not-verified` con su labeler;
  - lista los efectos `dead` y los reintentados;
  - `--json` es JSON válido con esos mismos datos.
- `report` funciona aunque haya un residente activo, porque no toma el lock.

## Reglas
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos.
- **Cambio mínimo.** Sin dependencias nuevas, sin tocar tablas de la fab y sin crear signals ni changes.
- **Prohibido:**
  - tocar otros worktrees o el repo principal (salvo tu informe);
  - escribir en GitHub;
  - hacer commit, push o merge;
  - lanzar subagentes.
- **Comprobaciones:**
  - **antes de editar:** `bun test tests` en la base; guarda la salida;
  - **al terminar:** `bun run typecheck`, tus tests y otra vez `bun test tests`. La suite completa no debe empeorar.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase2-prep/sonnet.md` e incluye:
- qué construiste, citando `ruta:línea`;
- la salida real de `report`, tras el `--once` contra `DarkCodePE/sw-factory`;
- qué responden ya los datos a (a), (b) y (c), y qué necesitará días de observe;
- los comandos que ejecutaste, con su salida pegada;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
