# Brief: auditoría de las tareas parciales y revisión del PR #75 (agy)

- **Worktree de lectura:** `/home/orlando/Desktop/factory/sw-factory-lectura` (`origin/release/0.1.0-rc.12`, `aa2142b`). **Solo lectura:** no edites, no hagas commit, no cambies de rama. Otro agente lee ahí a la vez.
- **Reglas del repo:** lee primero `/home/orlando/Desktop/factory/sw-factory-docs-t41/AGENTS.md`, sobre todo «Verificar» e «Informes».
- **Cola de tareas:** `/home/orlando/Desktop/factory/sw-factory-docs-t41/docs/research/superagent-vs-fab/task.json`.

Eres un revisor independiente sin contexto previo. No arreglas nada. Son dos encargos, cada uno con su sección en el mismo informe.

## Parte A: ¿siguen siendo parciales T16, T17, T18, T19, T21, T23, T26, T30, T32, T33 y T34?
Las once figuran como `partial` con la nota «Fusionado (#62). Falta integrar en el pool (T12)». T12 figura como hecha (#67). Puede que la cola esté atrasada y ya estén completas, o puede que a alguna le falte algo.

Para cada una:
1. Lee su entrada completa en `task.json` (título, `why`, `where`, `proposal`).
2. Comprueba en el código de la release si lo que pide está hecho **e integrado en el pool** (`src/pool.ts`, `src/live/`, `src/admission/`), no solo como pieza suelta. Mira también si hay un test que lo fije.
3. Da un veredicto: **hecha**, **parcial** (di exactamente qué falta) o **no lo sé** (di qué habría que mirar).

Salida: una tabla con id, veredicto, evidencia (`ruta:línea`) y lo que falta. No cambies `task.json`: propón el cambio.

## Parte B: revisión del PR #75 (T42, test inestable)
- Rama `fix/t42-test-inestable`; mira el cambio con `git fetch origin` y `git diff origin/release/0.1.0-rc.12...origin/fix/t42-test-inestable`. Descripción: `gh pr view 75`.
- El cambio toca solo `tests/agent.test.ts`: sustituye un `timeoutMs: 40` por una señal controlada por el test.
- Responde: ¿el test sigue probando lo mismo que antes, o más?, ¿queda alguna dependencia del tiempo?, ¿puede pasar aunque el código esté roto? Si quieres ejecutarlo o mutarlo, hazlo en una copia temporal fuera del repo, nunca con `git stash`.
- Veredicto: listo para fusionar, listo con cambios o no listo, con tabla de hallazgos (id, severidad, `ruta:línea`, problema, escenario que falla y arreglo).

## Reglas
- Solo lectura. Sin push, sin escribir en GitHub (tampoco comentarios en el PR), sin subagentes.
- Marca cada afirmación **[V]** (verificada ejecutando o leyendo la línea) o **[I]** (inferida).

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/auditoria-parciales/informe-agy.md`, con las partes A y B y, al final, «Lo que no revisé». Última línea, exactamente: `<!-- FIN -->`.
