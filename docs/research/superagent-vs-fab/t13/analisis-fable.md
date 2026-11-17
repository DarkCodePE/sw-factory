# T13, fase 3 (router): análisis previo a implementar

| | |
|---|---|
| Analista | Claude Fable 5.2, solo lectura (criterios EGM `design_critic`, `zoom_out`, `implementation_readiness`) |
| Fecha | 2026-11-13 |
| Código | worktree `sw-factory-t13`, rama `feat/t13-router`, HEAD `b4d9945`, árbol limpio |
| Referencia | `dsh-superagent-prototype` `8c32a9d` |

Marcas: **[V]** verificado (leído en código o ejecutado), **[I]** inferido. Las rutas `src/…` y `tests/…` son del worktree.

## Veredicto: esperar evidencia

No se cumple ninguna de las dos condiciones que el diseño pone a la fase 3 (`06-integracion-superagent-fab.md:241`): no hay un canal real funcionando y no hay un problema medido que el gate y el triage no resuelvan.

Lo único que conviene implementar ahora es **medición**: dos tareas pequeñas sobre `fab resident report` (§4), sin router, sin tablas nuevas y sin modelo. Con ellas, la prueba real de T11 dirá qué pieza de la fase 3 hace falta, si alguna.

El resto de este informe deja el diseño de referencia de cada pieza (§3) para cortar el brief siguiente cuando haya datos.

---

## 1. ¿Toca ahora?

### 1.1 No hay canal real

| Hecho | Evidencia |
|---|---|
| El código del canal existe: poll de issues y comentarios, modo `auto`, Outbox | **[V]** `src/admission/resident.ts:199-220`, `src/admission/cli.ts:23-31`, `src/admission/outbox.ts:80-91` |
| El repo `DarkCodePE/sw-factory` no tiene ningún issue, abierto o cerrado, y no tiene la etiqueta `fab` | **[V]** ejecutado: `gh issue list --state all` devuelve `[]`; `gh label list` solo trae las diez etiquetas por defecto |
| El residente no se ha ejecutado nunca en esta máquina | **[V]** ejecutado: 2481 `fabrica.db` bajo `Desktop/factory` y `~/.fabrica*`, ninguna con tablas `adm_*` |
| T11 sigue sin observe real | **[V]** `task.json` del worktree: T11 `in_progress`, «Falta observe real: repo con issues y etiqueta fab» |
| La rama viva no se ha probado con `claude` real | **[V]** `task.json` del worktree: T39 `pending` |
| Con `claude` real confinado, `--resume` falla y cada respuesta humana gasta una generación | Lo afirma `t40/BRIEF-T40.md`; **no lo reproduje**. **[V]** el arreglo no está en este worktree: `src/sandbox/confine.ts:17` sigue creando un HOME efímero y no monta `~/.claude/projects` |

Conclusión: la costura de la fase 2 pasa sus tests con backends falsos, pero no ha corrido ni una vez de extremo a extremo contra GitHub y `claude` reales. Construir encima es construir sobre algo sin probar.

### 1.2 No hay un problema medido

Leyendo el código salen tres huecos. Los tres son reales en el código y **ninguno ha ocurrido**, porque no ha habido tráfico.

| # | Hueco | Evidencia | Qué pieza lo cubriría |
|---|---|---|---|
| G1 | Retirar la etiqueta `fab` o cerrar el issue después de admitir no para nada. El trigger se registra como `thread-already-admitted` y se descarta | **[V]** `resident.ts:88-91` | Mandate (revocación) |
| G2 | Un comentario de alguien con rol en un hilo admitido, sin pregunta abierta, se registra como `no-open-question` y se ignora. No hay forma de corregir el rumbo por el canal | **[V]** `gate.ts:68`, `resident.ts:189-190` | Router de seguimientos + Subscriptions |
| G3 | El PR que abre la fab nunca se une al change. `ThreadLinks.link` solo se llama al admitir y al triar a mano | **[V]** llamadores: `apply.ts:31`, `apply.ts:43` (búsqueda con graft en `src/`); el PR se crea en `src/connectors/github.ts:93` sin tocar la admisión | Subscriptions |

Y un cuarto punto, que es el que más pesa contra el router con modelo:

- **`assess` no tiene entrada.** El gate solo admite con `strength: 'explicit'` (`gate.ts:51-52` **[V]**); `inferred` aparece únicamente en los rechazos (`gate.ts:37`). En superagent, el assessor existe para juzgar candidatos inferidos, es decir, mensajes que nadie dirigió al agente (`dsh-superagent-prototype/docs/002-authorization.md:106-110` **[V]**). En la fab, D1 decidió «solo con la etiqueta `fab`» (`06:251`). Mientras D1 siga vigente, cada admisión es explícita y determinista, y un router con modelo no tendría nada que decidir.

### 1.3 Qué aporta valor ya y qué evidencia reunir

**Ya:** que el informe de observe cuente los casos G1, G2 y los issues de confianza sin etiqueta. Hoy `buildReport` no lee `adm_comment_decisions` (`src/admission/report.ts:12-34` **[V]**), así que la prueba de T11 terminaría sin poder responder si la fase 3 hace falta. Detalle en §4.

**Antes de abrir cualquier pieza, en este orden:**

1. T40 (reanudar `claude` confinado) y luego T39 (prueba manual de la rama viva).
2. T11 en un repo con issues reales y alguien que etiquete: primero `observe --comments`, después `auto`.
3. Leer el informe ampliado. Umbrales propuestos, a confirmar (**[DECIDIR] C**):

| Pieza | Se abre si… |
|---|---|
| Mandate (revocación por etiqueta) | Hay al menos un caso de etiqueta retirada sobre un change vivo, **o** `auto` lo usa alguien que no es el operador del terminal |
| Enlace del PR | Hay al menos una respuesta válida a una pregunta escrita en el PR en vez de en el issue |
| Seguimientos como contexto | Al menos tres seguimientos perdidos que, leídos por una persona, pedían algo que el agente debió saber |
| Router con modelo (`assess`) | Se relaja D1 **y** hay issues de autores de confianza que nadie etiquetó y que debieron entrar |

---

## 2. Alcance mínimo de la fase 3

| Pieza | Problema concreto en fab | Por qué gate y triage no bastan | Decisión |
|---|---|---|---|
| **Medición en el informe** | No se puede saber si la fase 3 hace falta | El informe actual solo agrupa decisiones del gate de issues | **Entra ahora** (§4) |
| **Mandate: revocación** | G1: la autorización no se puede retirar por el canal; hay que ir al terminal y cancelar el change | El gate decide una vez por hilo; después `admit` corta en `thread-already-admitted` antes de mirar etiquetas | Aplazada. Primera pieza cuando haya evidencia. Determinista |
| **Mandate: registro** | Ninguno. Los datos ya existen repartidos: decisión, fuerza, `scope_max` y política (`db.ts:25-27`), contenido atado (`db.ts:39-41`), alcance aplicado (`db.ts:37`) | — | **No se construye.** Una tabla `adm_mandates` duplicaría lo que hay |
| **Mandate: `policyVersion` y revalidación por cambio de política** | Ninguno. La política son flags de la CLI por ejecución (`cli.ts:29-31`) y ya se guarda una copia por decisión | — | No entra |
| **Subscriptions: enlace del PR** | G3 | No es cosa del gate: falta una llamada al crear el PR | Aplazada. Pequeña y determinista |
| **Subscriptions: contexto** | G2: lo que se dice en el hilo entre turnos no llega al agente | `commentGate` solo conoce «respuesta a la pregunta abierta» | Aplazada. Sin steer, solo puede viajar en el siguiente turno que la fab ya fuese a lanzar |
| **Subscriptions: fan-out N hilos a M tickets** | Ninguno. En la fab la relación es N hilos a 1 change y ya existe (`db.ts:34`, `links.ts:1-3`) | — | No entra |
| **Router determinista (`route`)** | Hoy el enrutado está repartido en dos sitios: `resident.ts:88-91` y `resident.ts:176-188` | Funciona mientras solo haya dos destinos (admitir, responder). Con revocación y contexto serían cuatro | Aplazado. Se extrae cuando entre la segunda pieza, no antes |
| **Router con modelo (`assess`)** | Ninguno mientras D1 siga vigente (§1.2) | — | Aplazado sin fecha. Exige relajar D1 |
| **Seguimiento con autoridad** (un comentario crea un turno) | Pedir cambios en el PR sin ir al terminal | Hoy lo hace una persona con `resolveReview` (`src/store.ts:1025-1059`) | Aplazado. Amplía quién origina trabajo: **[DECIDIR] F** |

---

## 3. Diseño

### 3.1 Lo que se implementa ahora: medición

- **Capa y archivo:** `src/admission/report.ts`. Solo lectura. No conecta con el gate, el residente, `ThreadLinks` ni el pool.
- **Datos:** ninguna tabla ni columna nueva. Todo sale de lo que ya se guarda:
  - `adm_comment_decisions.reason` (`db.ts:31-32`);
  - el evento del trigger, que ya trae `author`, `authorAssociation`, `url`, `labels` y `state` (`resident.ts:74`, `resident.ts:159`);
  - `adm_decisions.reasons` y `adm_decisions.policy`;
  - `adm_thread_changes` y `adm_thread_signals`.
- **Invariantes:**
  - El informe muestra la URL del comentario, nunca su texto. El cuerpo es texto no confiable y puede traer secuencias de escape de terminal.
  - `authorAssociation` se usa solo para contar. No es una comprobación de rol y no autoriza nada.
- **Fronteras de fallo:** ninguna nueva. No toma el lock ni escribe.
- **Coste:** cero llamadas a modelo y cero llamadas a `gh`.

### 3.2 Diseño de referencia de lo aplazado (no implementar)

**Router: determinista primero.** `assess` no entra en `LiveBackend`, que se queda en `run` y `steer?` (`src/live/contract.ts:45-51`). El router de la fab sería una función pura como `gate()`:

- **Archivo:** `src/admission/route.ts`.
- **Interfaz:** `route(input: RouteInput): { action: 'admit' | 'answer' | 'context' | 'stop' | 'ignore'; reason: string }`.
- **Entrada:** solo metadatos, igual que `GateInput` (`gate.ts:1-2`): tipo de trigger, si el hilo tiene change y su estado, etiquetas y estado del issue, si hay pregunta abierta y cuándo se publicó, autor, tipo de autor, identidad propia, rol y fecha. El título, el cuerpo y el texto del comentario **no forman parte del tipo**.
- **Conexión:** `Resident.admit` y `Resident.inbound` la llaman y ejecutan la acción. `gate()` y `commentGate()` siguen siendo las que deciden `admit` y `answer`; `route` no las sustituye, las ordena.

**Router con modelo, si algún día se relaja D1.**

- Un disparo con `runAgent`, en un adaptador confinable y en solo lectura. Nivel Haiku: es una clasificación corta.
- Se llama solo para candidatos que el gate determinista dejó pasar como `inferred`. Nunca para lo que ya es explícito ni para lo rechazado.
- La salida es un valor de una lista cerrada, `ignore` o `propose`. Se aplica como `min(scope_max del gate, salida del modelo)`: puede bajar el alcance, nunca subirlo, y nunca devuelve `change`.
- Se registra antes en `observe` (`would_route`) y solo después pasa a `auto`.

**Mandate: solo la revocación.**

- **Datos:** tres columnas en `adm_thread_signals`, añadidas con `ALTER` como en `db.ts:68`: `trigger_key` (la decisión que admitió), `revoked_at` y `revoked_reason`.
- **Regla:** en `Resident.admit`, antes del corte de `resident.ts:89`: si el hilo tiene change, el change no es terminal y el evento ya no trae la etiqueta de disparo, se revoca.
- **Efecto:** en una sola transacción, marcar `revoked_at` y llamar a `store.closeChange(change, 'canceled')`. Lo demás ya ocurre solo:
  - el latido aborta el turno en curso ante un change terminal (`06:199`);
  - las activities pendientes o en espera se cancelan (`src/store.ts:571-572`);
  - la pregunta abierta se cancela (`answers.ts:29-32`) y el Outbox no publica una pregunta que ya no está abierta (`outbox.ts:83`).
- **El cierre del issue no revoca.** GitHub cierra el issue al fusionar un PR con «Fixes #n», y `closeChange('canceled')` no valida el estado de origen (`src/store.ts:1062-1076`, `566-578` **[V]**): se cancelaría un change terminado. **[DECIDIR] D**.

**Subscriptions.**

- **Enlace del PR:** tras crear el PR, `ThreadLinks.link('github:<repo>#<pr>', changeId)` si `hasAdmission(store)`. Es el patrón de `src/cli.ts:258`. `link` ya es idempotente (`links.ts:33`). Con eso `inbound` acepta respuestas escritas en el PR sin más cambios, porque busca el change por hilo (`resident.ts:176`).
- **Contexto:** los comentarios de autores con rol triage o superior en un hilo unido, sin pregunta abierta, se añaden como bloque delimitado al prompt del siguiente turno. Nunca crean un turno. Necesita `delivered_at` en `adm_comments` y una consulta de rol por comentario.

### 3.3 Invariantes de seguridad para cualquier pieza futura

| Invariante | Cómo se cumple |
|---|---|
| Texto como dato | El tipo de entrada de `route` no tiene campos de texto, como `GateInput`. El texto solo llega al agente, delimitado con nonce (`src/prompts.ts:22-23,74`) |
| El `scope` no se amplía nunca | `scope_max` lo fija el gate (`gate.ts:51-52`) y se aplica una vez por hilo (`apply.ts:19-23`). Ninguna pieza posterior escribe `adm_thread_signals.scope`. Un modelo solo puede reducir |
| No confiable aunque lo produzca un LLM | La salida de `assess` se valida contra una lista cerrada y pasa por `min()`. El `report` del agente ya se trata así: plantilla fija y saneado (`outbox.ts:21-41`) |
| Rol triage o superior para autorizar | Todo lo que crea o reanuda trabajo exige `TRIAGE_ROLES` (`gate.ts:32`), consultado en la API, no `author_association`. Revocar no autoriza: falla hacia cerrado y no necesita consulta |
| Comentarios propios descartados | Ya está: `gate.ts:66` y `resident.ts:90`. `route` hereda el filtro como primera regla |
| Trabajo de canal siempre confinado | Ya está: `src/pool.ts:263-271`, `src/admission/channel.ts:19-23` |

### 3.4 Fronteras de fallo de lo aplazado

Continúan la numeración de `07-ronda3-hallazgos-fase2.md` §6. Cada una pide un `CrashPoint` nuevo (`src/admission/effects.ts:19-21`) y un test en `tests/costura-fronteras.test.ts`.

| # | Frontera | Qué no debe pasar | Dónde caer |
|---|---|---|---|
| 13 | Etiqueta retirada → revocación → change cancelado | Revocado sin cancelar, o cancelado sin revocar | `mandate-revoked`, dentro de la transacción, como `signal-created` (`apply.ts:32`). El efecto `admit` es reejecutable (`resident.ts:58`) |
| 14 | Revocación con un turno en curso | Publicar una pregunta de un change cancelado | Entre la revocación y el siguiente despacho de efectos |
| 15 | PR creado → hilo unido | PR sin enlace para siempre | Entre `gh pr create` y `link`; se repara al repetir `fab pr` |
| 16 | Comentario de contexto registrado → entregado | Entregarlo dos veces en silencio, o perderlo | `context-delivered`; al menos una vez, como las respuestas (seguimiento H2 de T12) |

### 3.5 Coste

- **Ahora:** nada.
- **Revocación y enlace del PR:** cero llamadas a modelo y cero llamadas nuevas a `gh`; las etiquetas ya vienen en el evento.
- **Contexto:** una llamada `collaboratorRole` por comentario de un autor que no sea la fab ni un bot.
- **Router con modelo:** un disparo de nivel Haiku por candidato inferido. Hoy serían cero llamadas, porque no hay candidatos inferidos.

---

## 4. Plan de implementación para Codex

Dos tareas. Rama `feat/t13-router`. Al final: `bun run typecheck` y `bun test tests`, la suite completa una vez.

### T13-a · El informe cuenta lo que la fase 3 resolvería

**Archivos:** `src/admission/report.ts`, `tests/admission-report.test.ts`.

**Cambio.** Añadir tres campos a `Report` y sus tres secciones en `formatReport`, después de las actuales y con «(ninguno)» cuando estén vacías:

```ts
followupsLost: { trigger: string; url: string; author: string; association: string; decidedAt: string }[];
stopsLost: { thread: string; url: string; state: 'open' | 'closed'; labelPresent: boolean; decidedAt: string }[];
unlabeledTrusted: { thread: string; url: string; firstSeen: string; admittedAt: string | null }[];
```

Definiciones exactas:

- **Hilo admitido:** su `thread_id` está en `adm_thread_changes` o en `adm_thread_signals`, o tiene alguna fila de `adm_decisions` con `would_admit = 1`. La tercera condición cubre `observe`, donde no se crean vínculos.
- **De confianza:** el `authorAssociation` del evento está en `DEFAULT_POLICY.trustedAssociations` (`gate.ts:28`).
- **`followupsLost`:** filas de `adm_comment_decisions` con `reason = 'no-open-question'`, en un hilo admitido y de un autor de confianza. `url` y `author` salen del JSON de `adm_triggers.event`. Orden: `decided_at`, `trigger_key`.
- **`stopsLost`:** filas de `adm_decisions` cuya primera razón es `thread-already-admitted` y cuyo evento tiene `state = 'closed'` o no trae la etiqueta `triggerLabel` de la política guardada en esa misma fila, sin distinguir mayúsculas. Una fila por hilo: la más antigua.
- **`unlabeledTrusted`:** hilos con alguna decisión cuya primera razón es `no-trigger-label`, con evento `state = 'open'` y autor de confianza. `firstSeen` es el menor `decided_at` de esas decisiones; `admittedAt`, el menor `decided_at` con `would_admit = 1` del mismo hilo, o `null`.

**Tests que deben fallar antes.** Sembrar las filas con `INSERT` sobre `new AdmissionDb(store).db`, sin `gh` falso: `buildReport` es una función de las tablas.

1. «un seguimiento de confianza sin pregunta abierta en un hilo admitido sale en followupsLost, con su URL»: un comentario `MEMBER` en un hilo con fila en `adm_thread_changes` sale; otro `NONE` en el mismo hilo no sale; otro `MEMBER` en un hilo sin admitir no sale.
2. «en observe cuenta como admitido el hilo con una decisión would_admit»: sin vínculos y con una decisión `would_admit = 1`, sale.
3. «la etiqueta retirada o el cierre sobre un hilo ya admitido sale en stopsLost, una vez por hilo»: dos triggers `thread-already-admitted` sin etiqueta dan una fila; uno que conserva la etiqueta y sigue abierto no da ninguna.
4. «un issue de confianza sin etiqueta sale en unlabeledTrusted, con admittedAt si se etiquetó después».
5. «formatReport no imprime el cuerpo del comentario»: sembrar un cuerpo con `\x1b[2J` en `adm_comments` y comprobar que la salida no lo contiene.

**Hecho cuando:** los cinco tests pasan, los tests actuales del archivo siguen pasando y `fab resident report --json` incluye los tres campos.

### T13-b · El informe no crea el esquema

**Problema [V, leído; no ejecutado].** `fab resident report` construye `new AdmissionDb(store)` (`src/admission/cli.ts:18`), que ejecuta el `CREATE TABLE` (`db.ts:66`). En una base que nunca usó la admisión, pedir el informe crea las tablas, y desde entonces `hasAdmission` (`db.ts:79`) da verdadero y el pool abre la admisión en cada activity (`src/pool.ts:261`). Contradice la cabecera de `report.ts:1`, «no escribe nada».

**Archivos:** `src/admission/cli.ts`, `tests/admission-report.test.ts`.

**Cambio.** En la rama `report` de `residentMain`: si `!hasAdmission(store)`, imprimir `(el residente nunca se ha ejecutado en esta base)` y devolver 0 sin construir `AdmissionDb`. Con `--json`, imprimir `{}`.

**Test que debe fallar antes:** «report sobre una base sin admisión no crea tablas adm_*»: tras `residentMain(['report'], store)` sobre un `Store` nuevo, `hasAdmission(store)` es `false` y el código de salida es 0.

**Hecho cuando:** el test pasa y los demás tests del archivo siguen pasando.

### Lo que Codex no debe tocar

- `gate()`, `commentGate()`, `Resident.admit`, `Resident.inbound` y `applyAdmission`.
- El `SCHEMA` de `db.ts`: ni tablas ni columnas nuevas.
- `src/live/*`, `src/pool.ts`, `src/store.ts`, `src/prompts.ts` y `src/admission/outbox.ts`.
- No añadir `assess` a `LiveBackend`, ni `route.ts`, ni llamadas a un modelo, ni flags de CLI.
- Las tablas de la fab.

---

## 5. Riesgos y preguntas abiertas

**[DECIDIR] A · ¿Se acepta «esperar evidencia»?** Si sí, T13 queda como «medición para decidir la fase 3» (T13-a y T13-b) y el router pasa a una tarea nueva, bloqueada por T11. Si se quiere construir ya, la única pieza defendible sin datos es la revocación por etiqueta (§3.2).

**[DECIDIR] B · ¿En qué repo corre T11?** `DarkCodePE/sw-factory` no tiene issues ni la etiqueta `fab`. Sin un repo con tráfico y al menos una persona con rol triage que etiquete, la medición no produce nada.

**[DECIDIR] C · Umbrales de §1.3.** Son una propuesta. Falta fijar también la duración de la prueba; sugiero dos semanas o veinte hilos admitidos, lo que llegue antes.

**[DECIDIR] D · ¿Qué cuenta como «parar» por el canal?** Recomiendo solo retirar la etiqueta, y solo si el change no es terminal. Cerrar el issue no debe contar, por el cierre automático al fusionar.

**[DECIDIR] E · ¿Se mantiene D1 (solo con etiqueta)?** Mientras se mantenga, el router con modelo no tiene entrada. Relajarla cambia el modelo de amenaza: un modelo leería texto de terceros para decidir admisiones.

**[DECIDIR] F · ¿Puede un comentario crear un turno?** Por ejemplo, «cambia X» en el PR de alguien con rol triage, equivalente a `fab review --comment`. Hoy solo una persona en el terminal origina trabajo después de la admisión.

**[DECIDIR] G · ¿Se puede readmitir un hilo revocado?** Hoy un hilo se admite una sola vez (`db.ts:37`). Recomiendo que la primera versión no readmita: issue nuevo.

**Riesgos.**

- **Construir sin evidencia.** Un router con modelo añade superficie de ataque justo en el punto que ADR-0007 protege (`06:220`) y hoy no resolvería ningún caso real.
- **La medición es un indicio, no una prueba.** `author_association` no equivale a rol triage: `COLLABORATOR` puede ser de solo lectura **[I]**. Y que alguien comente no significa que quisiera dirigir al agente; por eso el informe da la URL para que lo lea una persona.
- **En `observe` no hay vínculos**, así que G1 solo se mide en `auto` y G2 se aproxima con «hilo que se habría admitido».
- **`adm_comments` guarda el cuerpo de todos los comentarios del repo**, también los de hilos sin admitir (`resident.ts:162` **[V]**). Es texto de terceros retenido sin límite. No es de T13, pero conviene decidir una retención antes de un repo con tráfico.
- **Siguen abiertos de T12** y afectarían a cualquier pieza conversacional: la respuesta se entrega al menos una vez (H2), el cambio de modelo no se detecta como pérdida de sesión (B5) y un arranque fallido gasta una generación (B6).

---

## Lo que no revisé

- **No ejecuté tests ni `bun`.** Lo ejecutado fue lectura, dos consultas de solo lectura a GitHub (`gh issue list`, `gh label list`) y `sqlite3 -readonly` sobre las bases locales.
- **`task.json`:** hay dos copias. La de `sw-factory` que cita el brief está atrasada (2026-11-11, T12 `pending`, sin T36 en adelante). Usé la del worktree (2026-11-12, con T39). **T40 no aparece en ninguna de las dos**; solo leí `t40/BRIEF-T40.md`.
- **El fallo de `--resume` confinado** no lo reproduje.
- **Bases locales:** busqué `fabrica.db` hasta cinco niveles bajo `Desktop/factory` y `~/.fabrica*`. Un residente ejecutado con otra ruta de estado no habría aparecido.
- **GitHub:** no miré los PRs del repo ni otros repos de la organización.
- **Código de la fab leído solo en parte:** `src/pool.ts` (255-345), `src/store.ts` (firmas y 566-578, 1025-1112), `src/admission/sessions.ts` (85-128). Sin abrir: `reports.ts`, `lock.ts`, `src/live/claude.ts`, `src/threatmon/`, `src/connectors/` salvo las líneas citadas, y los tests salvo la cabecera de `admission-report.test.ts`.
- **superagent:** leí `docs/002-authorization.md`, `src/admission.ts`, `prompts/admission.md` y tramos de `src/core/{model,ports,evals,tickets}.ts`. No abrí `sources/`, `replies.ts`, `prompts/dispatch.md` ni `prompts/subscriptions.md`.
- **Sin leer:** `01-dsh-panorama.md`, `03-dsh-herdr.md`, `review3/fable.md`, `t12/verif-fable.md`, ADR-0007, copilot-superagent y ESF.
- **Inferido, sin comprobar en la API:** que solo quien tiene rol triage o superior puede quitar una etiqueta, y que «Fixes #n» cierra el issue al fusionar.

<!-- FIN -->
