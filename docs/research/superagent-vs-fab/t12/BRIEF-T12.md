# Brief T12: integrar en el pool la fase 2 (contrato vivo) y un modo `auto` mínimo

Worktree: `/home/orlando/Desktop/factory/sw-factory-r3`, rama `feat/t12-fase2-integracion`, base `origin/release/0.1.0-rc.12` (`5c4a9ac`). Trabaja **solo** ahí. Si `node_modules` no existe, enlázalo con `ln -s ../sw-factory/node_modules node_modules` y no lo añadas al commit.

## Contexto
La fab es una fábrica de cambios local: el pool ejecuta activities de un change con agentes CLI. Las fases 0 y 1 están hechas.

El PR #62 añadió las **piezas** de la fase 2, todas con tests propios pero **sin conectar al pool**:
- sesiones (`src/admission/sessions.ts`);
- report durable (`reports.ts`);
- planificación y recuperación de turnos (`recovery.ts`);
- preguntas y respuestas (`answers.ts`);
- Outbox (`outbox.ts`);
- aplicación de la admisión (`apply.ts`);
- vínculo hilo-change (`links.ts`);
- confinamiento obligatorio para changes de canal (`channel.ts`);
- backend vivo de claude (`src/live/`).

Tu tarea es **conectarlas** para que la costura funcione de punta a punta.

Lee primero:
1. **Diseño:** `/home/orlando/Desktop/factory/sw-factory-r3/techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md`, sobre todo §5, §5.1 y §5.3. Las decisiones S1-S8 están **aprobadas**; no las reabras.
2. **Hallazgos y fronteras de fallo:** `07-ronda3-hallazgos-fase2.md` §6, en el mismo directorio.
3. **Qué hizo el PR #62 y qué dejó pendiente:** `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review3/impl-sonnet.md` y `review3/verif-fable.md`. Contienen las observaciones abiertas A4, A5, A6, A8, B1, B2, M1, M2 y M4.
4. **Tareas:** `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/task.json`. Mira T12 y su lista `open_items`.

## Qué construir
1. **Turno vivo en el pool (S1, S2, S4, S6).**
   - En `processActivity` (`src/pool.ts`), una rama para activities cuyo agente tiene backend vivo:
     1. `SessionStore.begin` antes de lanzar;
     2. `planTurn`;
     3. `runLiveTurn`/`LiveBackend.run`, con `onReport` que persiste por intento;
     4. al acabar, `liveOutcome` + `applyReport` en una transacción.
   - El pool sigue siendo quien lanza; el residente no lanza nada.
   - El camino de un disparo actual sigue intacto para los adaptadores sin backend vivo.
   - Elige un criterio claro y explícito para usar la rama viva, por ejemplo un flag del workstream o del agente. No la actives por defecto para todo.
2. **Sesión perdida (S3).**
   - `isSessionLoss` → `supersede` → `reconstructPrompt`, con evento y tope.
   - Los errores transitorios no abren sesión nueva.
3. **Turno huérfano (S4).** Recuperación: aplicar el report guardado si existe; si no, reanudar con `CONTINUE_PROMPT`.
4. **Espera (S5).** `waiting_reply`:
   - el residente entrega la respuesta (`answerQuestion`) y reencola;
   - el pool reanuda con la respuesta (`markAnswerDelivered`);
   - el plazo vence a `blocked`.
5. **Outbox (S7).** El residente despacha el efecto `reply` con la política de `outbox.ts`, con marcador y reconciliación.
6. **Modo `auto` mínimo (S8).**
   - `fab resident --mode auto`; la fase 1 lo rechazaba.
   - El efecto `admit` llama a `applyAdmission`: `scope_max=propose` → solo `addSignal`; `change` → `triageSignal`. Además une el hilo al change.
   - El prompt usa **solo** la copia admitida de `adm_content` (texto no confiable delimitado).
   - Los changes de canal solo se ejecutan con un adaptador confinable; `native` queda fuera.
   - `observe` sigue funcionando igual.
7. **Puntos abiertos que debes cerrar**, los de `open_items` de T12:
   - **A8:** marcar la sesión lanzada **antes** de lanzar y comparar `profile_digest`.
   - **A6:** `fab retry` reinicia el tope de generaciones. Decisión: **sí lo reinicia**, porque un reintento humano es una decisión nueva. Deja un evento.
   - **Tabla de sesiones:** se queda en `adm_sessions`. No migres tablas de la fab.
   - **B1:** delimitar el texto no confiable también en `reconstructPrompt` y activar `untrusted` con `isChannelChange`.
   - **M1:** unir hilo y change cuando un signal `propose` se triaja a mano.
   - **A5:** un report `done`/`blocked` se marca aplicado junto con el cierre de la activity, con comprobación de worker.
   - **A4:** `question-not-published` no debe ser definitiva si el residente murió entre publicar y guardar `published_at`. Reconcilia por marcador.
   - **M2:** define qué puede hacer la persona con una activity `waiting_reply` desde `fab inbox`/`fab show`. Como mínimo, verla con su pregunta y poder cancelarla o reintentarla.
   - **M4:** documenta que el plazo solo vence si el residente corre, o haz que también lo compruebe el pool.
   - **B2:** no puedes hacerla sin `claude` real; descríbela como prueba manual en el informe.

## Condición de salida (fase 2, §7 del 06)
**Costura completa con fallos inyectados en cada frontera**:

evento → admisión → turno → pregunta → caída → respuesta → reanudación → gates

Hay que cubrir las **12 fronteras** de la tabla del 07 §6, con el patrón `CrashPoint` existente (`src/admission/effects.ts`, `resident.ts`) y backends y `gh` falsos (`tests/helpers/admission.ts`, `tests/helpers/live.ts`). Para cada frontera, un test que mata en ese punto, reinicia y comprueba que **no pasa** lo que dice la columna «Qué no debe pasar».

Además, un test de extremo a extremo con `--mode auto`: issue etiquetado → change → turno que pregunta → comentario autorizado → reanudación → `done` → gates.

## Reglas
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos. Antes de editar una función, revisa **todos** sus llamadores.
- **Cambio mínimo y en la capa dueña**:
  - el Store solo cambia mediante comandos;
  - el módulo de admisión no escribe en tablas de la fab salvo con comandos del Store;
  - sin dependencias nuevas;
  - sin migraciones de tablas existentes de la fab.
- No toques `src/store.ts:57-60` (`isBusyError`): lo cambia T15 en paralelo.
- **Commits:** haz **un commit por pieza** (1-7 de arriba y los tests de fronteras) en tu rama, con mensajes en español. **No hagas push ni merge** y no lances subagentes.
- **Comprobaciones:**
  - **antes de editar:** `bun test tests`; guarda la salida;
  - **al terminar:** `bun run typecheck`, tus tests y otra vez `bun test tests`. La suite no debe empeorar.
  - Hay otros dos agentes ejecutando suites: no lances varias suites completas a la vez.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t12/impl-sonnet.md` e incluye:
- qué conectaste y dónde, citando `ruta:línea`;
- el criterio para activar la rama viva;
- la tabla de las 12 fronteras con el test que cubre cada una;
- cómo cerraste cada punto abierto;
- los commits;
- los comandos que ejecutaste, con su salida pegada;
- lo que no hiciste, incluida la prueba manual B2.

Última línea, exactamente: `<!-- FIN -->`.
