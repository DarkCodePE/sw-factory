# Brief: abrir la PR de la ronda 3 (Codex)

Trabajas en `/home/orlando/Desktop/factory/sw-factory-r3`, rama `feat/ronda3-hallazgos`. La implementación (Sonnet 5.5) y su verificación (Fable 5.2) ya están hechas. Tu trabajo es publicar la rama y abrir la PR. **No cambies código.**

## Antes de publicar
1. `git status` limpio y `git log --oneline origin/release/0.1.0-rc.12..HEAD`: un commit por tarea, sin trailer `Co-Authored-By`.
2. Ejecuta `bun run typecheck` y `bun test tests`. Si algo falla, **no abras la PR**: avisa al coordinador con la salida.
3. Lee `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review3/impl-sonnet.md` y `verif-fable.md`. Si el veredicto global del verificador es `rechazado`, no abras la PR y avisa.
4. Comprueba que el diff no lleva secretos, `.env` ni archivos ajenos a la tarea.

## PR
- `git push -u origin feat/ronda3-hallazgos`.
- `gh pr create --base release/0.1.0-rc.12 --head feat/ronda3-hallazgos`, **en borrador** (`--draft`), con el cuerpo en un archivo (`--body-file`).
- Título: `Ronda 3: hallazgos previos a la fase 2 (T16-T34)`.
- Cuerpo, en español:
  - Qué resuelve, en dos o tres frases, y de dónde sale (ronda 3 de revisión del diseño 06).
  - Tabla por tarea: tarea, hallazgo, severidad, commit, estado (`hecho` o `parcial`) y test que lo cubre. Tómala de `impl-sonnet.md`.
  - Qué queda pendiente de T12 (integración del contrato vivo en el pool y modo `auto`) y qué queda fuera (T25 y T35, del documento 06).
  - Veredicto del verificador y sus observaciones abiertas, tal como están en `verif-fable.md`.
  - Resultado real de typecheck y de la suite que acabas de ejecutar.
- No escribas `@nombre` de nadie. No fusiones la PR ni pidas revisores.

## Al terminar
`hc send t3k "PR: <url>"`, o el bloqueo con su salida.
