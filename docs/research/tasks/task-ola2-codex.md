# Tarea ola 2 — complejidad alta: 04 manifest por change + merge recuperable

Repo: /home/orlando/Desktop/factory/sw-factory-ola2-codex (rama `fab/research-ola2-codex`, base `main@0db0893`, olas 0 y 1 integradas).
Plan: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §2 (reglas), §3 "Ola 2" y §4 ficha **04**. Léelas enteras: son el contrato. Contexto de lo ya hecho: /home/orlando/Desktop/factory/sw-factory/docs/research/runs/2026-10-30-ola1/resultado.md. ESF (MIT) en /home/orlando/Desktop/factory/ext/esf @d901657, sin copiar código.

## Propiedad
Tuyos: un módulo nuevo para el manifest (p. ej. `src/manifest.ts`), el caso `merge` de `src/cli.ts` y `src/validators/publish.ts`, y los puntos de `src/store.ts`/`src/pool.ts` donde un change o activity llega a estado terminal (llama a tu escritor desde ahí, sin reescribir esas funciones).
En paralelo: agy hace F1 (SQLITE_BUSY: transacciones y reintentos del store), 03 (estado `quarantined`) y 08; opencode hace agents-verify, F2 (`base_sha`) y F3. No toques `src/agents.ts`, `src/sandbox/`, `claimActivity`/`heartbeat`/`requeueOrphans` ni `ensureWorktree`. Prevé `quarantined` como transición terminal aunque aún no exista (lo añade agy).

## Puntos clave (la ficha manda)
- `runs/<changeId>/run.json` en **cada** transición terminal (completed, failed, blocked, quarantined, canceled): base sha, rama y HEAD, activities con validador, veredicto, reintentos y razón, `isolation` por adaptador, duración, `cleanup`. Salida **completa** de cada activity en `runs/<changeId>/<activityId>.log` (hoy `result` se corta a 20 000): captúrala antes de `boundedAgentOutput` en el pool.
- Merge en fases recuperables: evento `merge_started` antes de `git merge`; si el proceso cae, el siguiente `fab merge` detecta la rama ya fusionada y completa cleanup y manifest. Exclusión con el mecanismo de 07.
- Redacción de secretos al escribir (8 patrones: claves de API, tokens de bearer, claves privadas PEM, AWS, GitHub, Slack, JWT, URLs con credenciales).
- Escritura atómica (tmp + rename). Directorio bajo el state dir de fab.

## Tests obligatorios
Un manifest por cada transición terminal; crash simulado entre merge y cierre que el siguiente `fab merge` recupera; 0 secretos en manifest y logs con un fixture que contenga los 8 patrones; log completo > 20 000 caracteres conservado.

## Verificación
`bun test` y `bunx tsc --noEmit` en verde (base 805 pass). `fab` real con agente `fake` sobre una copia de `/home/orlando/Desktop/factory/examples/toy-calc` en /tmp: un change completado y otro cancelado, mostrando sus `run.json`; y un merge interrumpido con `kill -9` tras `merge_started` que el siguiente `fab merge` completa. Pega comandos y salida en el reporte.

## Entrega
- Commits pequeños en español. **Sin `Co-Authored-By`.** Sin merge ni push.
- **Escribe el reporte a medida que avanzas** (por si te quedas sin cuota): /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola2-codex.md, con cambios (archivo:línea), tests, sesión real, decisiones y qué falta.
