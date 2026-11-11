# Brief T10: un worktree a medias pide intervención y se puede reparar

Worktree: `/home/orlando/Desktop/factory/sw-factory-fase0`, rama `fix/t10-worktree-reparar`, base `origin/release/0.1.0-rc.12` (`9dbb175`). Trabaja **solo** ahí. `node_modules` ya está enlazado; no lo toques.

## Contexto
En la fase 2, la fab lanzará agentes sin que nadie mire. `ensureWorktree` (`src/worktrees.ts:63-90`) escribe una marca `.preparing` antes de llamar a git. Si una creación queda a medias, la marca sigue ahí y cada intento lanza `Worktree preparation is incomplete…` (`src/worktrees.ts:70`). `verifyWorktree` también lanza cuando la ruta pertenece a otro repo, la rama no coincide o el directorio no es un worktree.

Hoy esos errores caen en el `catch` general de `processActivity` (`src/pool.ts:347-366`), que llama a `failActivity`. **Verifícalo antes de cambiar nada.** El resultado es que la fab gasta los `MAX_ACTIVITY_RETRIES` en errores que no se arreglan reintentando, y el change acaba en `failed` sin que nadie entienda por qué. Son errores deterministas: necesitan una persona.

## Qué construir
1. **Bloquear en lugar de fallar.**
   - Un error de preparación o verificación del worktree debe dejar la activity **bloqueada** con un motivo reconocible, por ejemplo con el prefijo `WORKTREE_NEEDS_REPAIR:`, la ruta y qué falló. No debe consumir reintentos.
   - Usa el mecanismo de bloqueo que ya existe (`store.blockActivity`, como hace `gates`). Busca con `graft callers` cómo se desbloquea hoy una activity y quién lee esos motivos (inbox, review, tui…), para que el motivo aparezca donde la persona ya mira.
   - Distingue estos errores con un tipo de error propio (p. ej. `class WorktreeNeedsRepair extends Error`), **no** comparando textos.
2. **`fab worktree repair <change-id>`**, o el nombre que encaje en `src/cli.ts`:
   - **Marca presente, worktree válido:** si existe la marca y `verifyWorktree` pasa sobre la ruta (repo correcto, rama `branchFor(changeId)`, checkout completo), borra la marca y dilo.
   - **Marca presente, worktree inválido o ausente:** no borres nada. Imprime qué falla y los comandos exactos para limpiarlo a mano (`git worktree remove …`, `rm <marca>`). Solo con `--discard` explícito puede ejecutar esa limpieza, y nunca debe borrar la rama.
   - **Sin marca:** informa del estado y sale con código 0.
   - Después de reparar, la activity bloqueada debe poder continuar con el mecanismo de desbloqueo existente. Si no existe ninguno adecuado, añádelo como mínimo y justifícalo en el informe.
3. **No cambies** el truncado a 8 caracteres de la ruta (T9 queda fuera), ni la semántica de la marca en `ensureWorktree`, salvo para lanzar el tipo de error nuevo.

## Tests (`tests/worktrees*.test.ts`, `tests/pool*.test.ts`)
- Una activity cuya preparación encuentra la marca queda bloqueada con `WORKTREE_NEEDS_REPAIR`, `retry_count` no sube y el change no pasa a `failed`.
- Una ruta de otro repo o con la rama cambiada da el mismo bloqueo.
- `repair`:
  - con la marca y el worktree válido, la borra, y el siguiente `ensureWorktree` reutiliza el worktree;
  - con la marca y el worktree inválido, no borra nada y sale con código distinto de 0;
  - `--discard` limpia el worktree pero conserva la rama;
  - sin marca, sale con código 0.
- Un error de git no determinista (p. ej. un fallo transitorio de `worktree add` que no deja nada) **sigue** reintentando como hoy.

## Reglas
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos. Antes de editar una función, revisa **todos** sus llamadores.
- **Cambio mínimo y en la capa dueña.** Sin columnas, migraciones ni dependencias nuevas.
- **Prohibido:** tocar otros worktrees o el repo principal (salvo tu informe), hacer commit, push o merge, o lanzar subagentes.
- **Comprobaciones:**
  - **antes de editar:** `bun test tests` en la base; guarda la salida;
  - **al terminar:** `bun run typecheck`, tus tests y otra vez `bun test tests`. La suite completa no debe empeorar.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase2-prep/codex.md` e incluye:
- si el defecto existía, con la cita `ruta:línea`;
- qué cambiaste y por qué en esa capa;
- cómo se desbloquea la activity tras reparar;
- los comandos que ejecutaste, con su salida pegada;
- lo que no hiciste y por qué.

Última línea, exactamente: `<!-- FIN -->`.
