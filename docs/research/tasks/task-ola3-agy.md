# Tarea ola 3 — agy: banco de medición de la ficha 01 y línea base del QA con LLM

Repo: /home/orlando/Desktop/factory/sw-factory-ola3-agy (rama `fab/research-ola3-agy`, base `main@5aa8cee`).
Plan: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §2 (reglas de medición) y §4 ficha **01** (medición: 10 bugs plantados en toy-calc + 5 en tarea real; línea base QA LLM; sensibilidad ≥ 1,2; coste ≤ 1,0).

Codex implementa los gates en paralelo. Tú construyes la medición y corres la **línea base** (sin gates) sobre `main`. Cuando codex termine, yo correré el mismo banco con gates.

## Propiedad
Solo `bench/ola3/` (casos) y `scripts/e2e/ola3-*` (scripts). No toques `src/`.

## Qué construir
1. **Casos:** 10 bugs plantados en copias de /home/orlando/Desktop/factory/examples/toy-calc y 5 en una tarea real (elige un repo pequeño real con tests, p. ej. un módulo de `sw-factory` y sus tests). Cada caso = parche que introduce el bug + descripción + si los tests existentes lo atrapan o no. Mezcla deliberada: unos atrapables por tests, otros semánticos que solo vería una revisión. Más 5 changes **sanos** para medir falsos rechazos.
2. **Script** `scripts/e2e/ola3-bench.sh <cli_dir> <modo>` que, por cada caso, crea un workstream sobre la copia, aplica el parche como "implementación" (agente fake o commit directo en la rama del change) y corre el validador **qa** con un CLI real: `--agent codex` o `claude` (suscripción). Modo `baseline` = sin `--verify`; modo `gates` = con `--verify '<comando de tests>'` (lo usaré cuando codex entregue). Registra por caso: detectado o no, falso rechazo, duración y coste si el CLI lo reporta.
3. **Resumen** en TSV/JSON: sensibilidad (bugs detectados/15), falsos rechazos (sanos rechazados/5), duración total, coste.

## Presupuesto
Autorizado por el usuario: CLIs de **suscripción**; si algo exigiera API de pago, tope **30 USD**: detente antes y avisa. Corre primero 2 casos para medir duración y cuota, anótalo, y luego el resto.

## Entrega
Commits en español **sin `Co-Authored-By`**, sin merge ni push. Reporte en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola3-agy.md con la tabla por caso y el resumen de la línea base. **No hagas grep sobre /home/orlando/Desktop/factory entero.**
