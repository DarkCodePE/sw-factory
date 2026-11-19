# Brief: `fab web` F2, decisiones desde la web (Codex)

Eres un implementador sin contexto previo.

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-webf2`, rama `feat/fab-web-f2`, creada desde `feat/fab-web` (PR #80, aún sin fusionar). `node_modules` es un symlink: no lo toques.
- **Antes de empezar, lee:**
  - `AGENTS.md`;
  - en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/`: `catalogo-fable.md` (§5 y §6), `impl-codex.md` y `verif-fable.md`. Ahí está cómo se hizo F0/F1 y qué encontró la verificación.
- **Trabajo en paralelo:** otro agente hace F3 (métricas) en `sw-factory-webf3`. Para no chocar:
  - pon todo lo tuyo en módulos nuevos (`src/web-actions.ts`, `src/web-auth.ts`, etc.);
  - en `src/web.ts` toca solo el despacho de rutas y los botones de las vistas existentes.

## Objetivo
Que el humano pueda actuar desde la web, como en Warp (follow-up y respuestas), pero con las puertas en el código de fab y no en un prompt.

Acciones:
1. **Resolver una revisión:** aprobar, pedir cambios con comentario o rechazar → `Store.resolveReview` (`src/store.ts:1075`). Úsala igual que la CLI (`src/cli.ts:291`).
2. **Reintentar un change** → `Store.retryChange` (`src/store.ts:1129`, CLI `src/cli.ts:377`).
3. **Responder una pregunta pendiente** → `answerQuestion` (`src/admission/answers.ts:14`).

**Fuera de alcance, explícitamente:** `merge`, `gate allow`, crear trabajo nuevo, editar perfiles y prompts, y parar agentes. La web no gana más poder que la CLI en ningún caso.

## Decisiones ya tomadas
1. **La escritura es opcional:** solo con `fab web --write`. Sin la opción, la web sigue siendo de solo lectura (F0/F1 intacto: 405 y Store `readonly`). Con ella, usa un Store escritor solo para las mutaciones; las lecturas siguen como están.
2. **Autenticación local:**
   - Al arrancar con `--write`, se imprime en la terminal una URL con un token aleatorio de un solo uso (32 bytes, `crypto`).
   - Al abrirla, el token se cambia por una cookie de sesión `HttpOnly`, `SameSite=Strict` y `Path=/`, y se redirige quitando el token de la URL.
   - La sesión dura lo que dure el proceso.
   - Sin sesión, los POST dan 401.
3. **CSRF:**
   - token por sesión en un campo oculto de cada formulario;
   - además se exige `Origin` igual a `http://127.0.0.1:<port>` o `http://localhost:<port>`;
   - si falta o no coincide, 403.
   - Se mantiene el filtro de `Host` de F0.
4. **Formularios HTML normales** con POST y redirección 303: patrón PRG, sin JS obligatorio. El sondeo de 2 s no debe borrar un comentario a medio escribir.
5. **Actor:** cada mutación queda registrada con un actor `web` en `events`, igual que la CLI registra el suyo. Mira cómo se rellena `actor` hoy y sigue el patrón.
6. **Errores del dominio** (`invalid_transition`, `conflict`, `not_found` y demás):
   - se muestran como mensaje en la página;
   - nunca exponen el stack;
   - un doble envío no aplica la acción dos veces: debe dar `conflict` por el CAS del Store, y hay que probarlo.
7. **Límites de entrada:** comentario y respuesta de hasta 8 KiB; ids validados con la misma regex de F0. El cuerpo POST, de hasta 16 KiB y solo `application/x-www-form-urlencoded`; si no, 413 o 415.

## Pruebas
- Tests en `tests/web-actions*.test.ts`. Cubre:
  - sin `--write`, todo POST da 405;
  - sin sesión, 401;
  - token reutilizado rechazado;
  - CSRF ausente o erróneo, 403;
  - `Origin` ausente o ajeno, 403;
  - cada acción feliz, con su estado y evento resultantes;
  - doble envío y transición inválida;
  - límites de tamaño y tipo;
  - escapado del comentario al volver a mostrarlo.
- **Mutaciones propias** en una copia temporal (`git archive`), nunca en el worktree: quita cada defensa por separado y comprueba que algún test falla. Pon la tabla en el informe.
- `tsc --noEmit -p .` y `bun test tests`.
  - La máquina va justa de RAM: ejecuta la suite completa **una sola vez**, al final.
  - Si falla un test de red o de carga, repítelo aislado y anótalo.
- **Recorrido manual con agent-browser:**
  - sesión `fabf2`, con `--args "--no-sandbox"` si hace falta;
  - sobre un `stateDir` temporal con datos sintéticos;
  - **nunca** `~/.fabrica` ni `~/.fabrica-t11`;
  - captura aprobar, pedir cambios, reintentar y responder en `docs/research/warp-platform/web-capturas-f2/`.

## Reglas
- Commits pequeños en español, **sin `Co-Authored-By`**, sin push, sin escribir en GitHub, sin subagentes, sin secretos.
- No toques las reglas del dominio (el Store, el gate o los validadores) salvo que una acción lo exija. En ese caso, para y explícalo en el informe.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/impl-f2-codex.md` con estas secciones:
- veredicto;
- rutas nuevas;
- commits;
- cambios por fichero;
- seguridad, con cada requisito y el test que lo prueba;
- mutaciones;
- tests;
- prueba manual;
- lo que no hiciste;
- riesgos.

Última línea, exactamente: `<!-- FIN -->`.
