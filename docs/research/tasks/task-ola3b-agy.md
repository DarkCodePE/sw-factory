# Tarea — agy: banco difícil para la ficha 01

Repo: /home/orlando/Desktop/factory/sw-factory-ola3b-agy (rama `fab/research-ola3b-agy`, base `integ/ola3@1943fac`: tu banco `bench/ola3/`, los gates de codex y `scripts/e2e/ola3-gates.ts`).
Contexto: /home/orlando/Desktop/factory/sw-factory/docs/research/runs/2026-10-31-ola3/resultado.md. Tu banco actual era fácil: el QA de línea base detectó 14/15 (93 %), así que el criterio "sensibilidad ≥ 1,2" era inalcanzable (techo 1,07).

## Objetivo
Un banco donde el QA con LLM solo detecte **≤ 70 %**, para medir si los gates aportan sensibilidad de verdad.

## Qué construir (`bench/ola3/hard/`, mismo esquema que `cases.json`)
- **15 bugs** en código real de `sw-factory` (no toy-calc), con sus tests existentes, de tipos que una revisión suele dejar pasar: off-by-one en límites, condición invertida en una rama poco transitada, error silenciado en un `catch`, comparación de tiempos o zonas horarias, mutación de un objeto compartido, orden de evaluación, inyección o path traversal sutil, y un bug escondido dentro de un refactor grande que además es correcto. Mensajes de commit plausibles y nada engañosos a propósito, pero sin pistas.
- Mezcla: unos **8 atrapables por los tests existentes** (cuenta cuáles fallan de verdad) y **7 que no**.
- **5 changes sanos** de tamaño similar (refactors correctos, features con su test).
- Cada caso con `test_cmd` que corra solo los tests relevantes y en < 60 s.

## Medición
1. Línea base: QA con LLM **usando `claude`** (`--agent claude`, suscripción; reserva la cuota de codex). Tope de 30 USD si algo exigiera API de pago: detente antes y avisa. Corre primero 2 casos y anota duración.
2. Pipeline con gates: generaliza `scripts/e2e/ola3-gates.ts` para aceptar la ruta del banco (`bench/ola3/hard`) sin romper el uso actual, y córrelo.
3. Reporta las mismas métricas que `results-gates.json`: sensibilidad base y del pipeline con su ratio, falsos rechazos, ejecuciones LLM, segundos y ratio de coste.

## Propiedad
Solo `bench/ola3/hard/` y `scripts/e2e/ola3-*`. No toques `src/`. Otra sesión cambia `src/` en paralelo (fase de dependencias).

## Entrega
Commits en español **sin `Co-Authored-By`**, sin merge ni push. Reporte en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola3b-agy.md con la tabla por caso y el resumen. No hagas grep sobre /home/orlando/Desktop/factory entero.
