# Brief: implementar los hallazgos de la ronda 3 (Sonnet 5.5)

Eres el implementador. Trabajas solo en el worktree `/home/orlando/Desktop/factory/sw-factory-r3`, rama `feat/ronda3-hallazgos`, creada desde `origin/release/0.1.0-rc.12` (`9dbb175`).

## Qué leer primero
- Hallazgos, con citas `ruta:línea` y propuesta: `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review3/fable.md`.
- Cola de tareas: `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/task.json`, tareas T16 a T35 (`why`, `where`, `proposal`).
- Contrato vivo de las espigas, que no está en esta rama: `/home/orlando/Desktop/factory/sw-factory-live-claude/src/live/` y `/home/orlando/Desktop/factory/sw-factory-live-native/src/live/`.

## Orden
1. Alta: T16 a T23.
2. Media: T24 a T32.
3. Baja: T33 y T34.

Fuera de esta rama: **T25 y T35**. Son cambios del documento 06, que no está en release.

## Reglas
- **Un commit por tarea**, con mensaje `Txx (H-yy): <qué cambia>`. Sin trailer `Co-Authored-By`.
- Cada tarea lleva su test. Los fallos inyectados siguen el patrón `CrashPoint` de `src/admission/effects.ts` y `src/admission/resident.ts`.
- Tras cada tarea: `bun run typecheck` y los tests que toca. Al acabar cada bloque de severidad: `bun test tests` completo. Informa de los fallos con su salida; no los escondas.
- **La fase 2 no existe en esta rama.** El pool no usa el contrato vivo y el modo `auto` sigue rechazado. No integres el contrato vivo en el pool ni actives `auto`: eso es T12. Implementa de cada tarea lo que es válido sobre rc.12:
  - La parte de Store y de admisión (tablas con prefijo `adm_`, comandos del Store, lectura de comentarios, vínculo hilo → change, registro en modo observe) con sus tests.
  - Si una tarea necesita `src/live/`, tráelo de las espigas tal cual y dilo en el commit.
  - Lo que solo se puede hacer con el pool integrado, no lo fuerces: anótalo como pendiente de T12.
- La admisión no escribe en tablas de la fab: solo comandos del Store (ADR-0001, patrón `ChangeLinkStore`).
- No cambies el comportamiento por defecto de lo que ya funciona. Archivos de menos de 500 líneas donde sea posible sin partir `store.ts`.
- No hagas push, no abras PR, no lances subagentes, no edites `task.json` ni nada fuera de tu worktree, salvo tu informe.
- Si una propuesta del informe te parece equivocada al ver el código, no la apliques a ciegas: implementa lo correcto y explica la diferencia.

## Informe
Mantén al día `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review3/impl-sonnet.md`: una fila por tarea con estado (`hecho`, `parcial`, `no hecho`), commit, tests añadidos y lo que queda pendiente de T12.

## Comunicación
- El verificador es la terminal `t3n` (Fable 5.2, solo lectura). El coordinador es `t3k`.
- Al terminar **cada bloque de severidad**, avisa al verificador: `hc send t3n "Bloque <alta|media|baja> listo: commits <primero>..<último>. Informe en review3/impl-sonnet.md"`.
- El verificador te enviará sus hallazgos. Corrige con commits nuevos (`fix Txx: …`) y vuelve a avisar. Como mucho dos rondas de corrección por bloque; lo que quede sin acuerdo, anótalo en tu informe.
- Si te bloqueas, o cuando el verificador haya aprobado los tres bloques: `hc send t3k "<resultado o bloqueo>"`.
