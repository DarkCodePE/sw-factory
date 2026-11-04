# Tarea — agy: ajustar threatmon (03) con medición de falsos positivos

Repo: /home/orlando/Desktop/factory/sw-factory-ola2b-agy (rama `fab/research-ola2b-agy`, base `main@e7a38c8`, ola 2 integrada).

## Medición (fija: no la modifiques)
`bun /tmp/claude-1000/-home-orlando-Desktop-factory/7a52064a-cc46-49a9-a089-f166a547d8ee/scratchpad/threatmon-fp/measure-frozen.ts <tu worktree> 40 0`  → conjunto de ajuste (40 sesiones reales de codex más recientes)
`bun /tmp/claude-1000/-home-orlando-Desktop-factory/7a52064a-cc46-49a9-a089-f166a547d8ee/scratchpad/threatmon-fp/measure-frozen.ts <tu worktree> 30 40` → conjunto de reserva (30 siguientes)
El JSON da `corpus.tripped` (sesiones limpias que dispararían cuarentena), `hits` (regla y extracto) y `adversarial.detected` sobre 10 transcripciones maliciosas.

Línea base en `main`: ajuste **8/40**, reserva **0/30**, adversarias **8/10** (fallan `curl … | sh` y persistencia por `crontab`).
Todos los hits actuales son falsos positivos: CA-005 (`169.254.169.254` en listas SSRF y docs), RC-001 (`for i in $(seq …)` sin red; la palabra "nMap"), CA-001 (`/proc/<pid>/environ` en un mensaje de error), CA-003 (`AWS_SECRET_ACCESS_KEY` en docs), RC-002 (blob base64), PE-003 (`mount | rg`), RS-001, RS-002.

## Objetivo
- Ajuste ≤ **2/40**, reserva **0/30**, adversarias **10/10**.
- Arregla cada regla por su causa (exigir el verbo que hace daño: un cliente de red contra la IP de metadata, un destino de red en el bucle, un lector sobre `environ`, el valor y no el nombre, límites de palabra), no borrando reglas ni bajando severidades en bloque. Añade reglas para descarga-y-ejecución (`curl|wget … | sh|bash`) y persistencia (`crontab`, `systemd` de usuario, `~/.bashrc` con red).
- Tus tests existentes de `tests/threatmon.test.ts` siguen en verde; añade un test por cada falso positivo corregido y por cada regla nueva.
- Hay un conjunto adversario oculto que usaré para verificar que no ajustaste solo a estos 10.

## Propiedad
Solo `src/threatmon/` y `tests/threatmon.test.ts`. Opencode toca en paralelo `src/manifest.ts` y la sonda 08.

## Entrega
`bun test` y `bunx tsc --noEmit` en verde (base 841). Commits en español **sin `Co-Authored-By`**, sin merge ni push. Reporte en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola2b-agy.md con tabla regla → causa del falso positivo → corrección, y las tres cifras antes/después. **No uses grep sobre /home/orlando/Desktop/factory entero**: busca dentro de tu worktree.
