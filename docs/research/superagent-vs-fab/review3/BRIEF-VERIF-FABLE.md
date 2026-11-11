# Brief: verificar la implementación de la ronda 3 (Fable 5.2)

Eres el verificador. **Solo lectura sobre el código**: no edites archivos del worktree, no hagas commit ni push, no lances subagentes. Lo único que escribes es tu informe.

## Qué se verifica
El implementador (Sonnet 5.5, terminal `t3m`) trabaja en `/home/orlando/Desktop/factory/sw-factory-r3`, rama `feat/ronda3-hallazgos`, sobre `origin/release/0.1.0-rc.12` (`9dbb175`). Implementa las tareas T16 a T34 (menos T25), un commit por tarea, en tres bloques: alta (T16-T23), media (T24-T32) y baja (T33-T34).

- Su encargo: `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review3/BRIEF-IMPL-SONNET.md`.
- Los hallazgos de origen: `review3/fable.md` en esa misma carpeta, y `../task.json`.
- Su informe: `review3/impl-sonnet.md`.

## Cuándo actúas
Espera a que `t3m` te avise de que un bloque está listo. No revises a medias. Mientras tanto puedes leer el informe de hallazgos y el código de rc.12.

## Qué compruebas en cada bloque
1. **Cada commit resuelve su hallazgo.** Lee el diff (`git show <commit>`) y contrástalo con el escenario que falla descrito en `fable.md`. ¿El escenario deja de fallar? ¿Hay un test que lo demuestre, y ese test fallaría sin el cambio?
2. **Ejecuta tú las pruebas**: `bun run typecheck` y `bun test tests` en el worktree. No aceptes el resultado que te cuenten. Los tests pueden escribir en temporales; el código no lo tocas.
3. **Regresiones**: comportamiento por defecto intacto, la admisión no escribe en tablas de la fab, nada integra el contrato vivo en el pool ni activa el modo `auto` (eso es T12).
4. **Lo marcado como parcial o pendiente de T12** es razonable y está dicho con claridad.
5. Seguridad de lo nuevo: validación en los bordes, texto no confiable tratado como dato.

Distingue lo verificado (lo ejecutaste o lo leíste en el diff) de lo inferido.

## Informe
Escribe en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review3/verif-fable.md`, una sección por bloque: veredicto (`aprobado`, `aprobado con observaciones` o `rechazado`), tabla por tarea (commit, veredicto, evidencia), y hallazgos con severidad, `ruta:línea`, escenario que falla y corrección pedida. Incluye la salida final de typecheck y de la suite.

## Comunicación
- Tras cada bloque, envía al implementador solo lo que debe corregir: `hc send t3m "Bloque <x>: <n> hallazgos. Detalle en review3/verif-fable.md"`. Si no hay nada, díselo también para que siga.
- Como mucho dos rondas de corrección por bloque. Lo que quede abierto, déjalo escrito.
- Al cerrar los tres bloques, o si algo te bloquea, avisa al coordinador: `hc send t3k "Verificación: <veredicto global>. Informe en review3/verif-fable.md"`.
