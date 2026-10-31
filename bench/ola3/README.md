# Banco de Medición — Ola 3 (Ficha 01: Verificación Determinista y Línea Base QA)

Banco de pruebas sistemático para evaluar la efectividad y el coste de la verificación determinista (gates) en contraste con la línea base de revisión de calidad (QA) mediante LLM (Ficha 01 del Plan de Candidatos ESF -> fab).

## 1. Estructura y Casos

El banco contiene 20 casos rigurosamente diseñados y verificados:
- **10 casos en `toy-calc`** (Python / `pytest -q`):
  - 5 bugs atrapables por tests existentes (`tc-bug-01` a `tc-bug-05`).
  - 5 bugs semánticos no cubiertos por la suite base (`tc-bug-06` a `tc-bug-10`).
  - 3 changes sanos (`tc-clean-01` a `tc-clean-03`).
- **10 casos en tarea real** (`real`: módulo de conectores ADF de `sw-factory`, TypeScript / `bun test`):
  - 3 bugs atrapables por tests existentes (`real-bug-01` a `real-bug-03`).
  - 2 bugs semánticos no cubiertos por la suite base (`real-bug-04` a `real-bug-05`).
  - 2 changes sanos (`real-clean-01` a `real-clean-02`).

Total:
- **15 bugs** (8 atrapables por tests, 7 semánticos).
- **5 changes sanos** (medición de falsos rechazos).

## 2. Archivos del Banco

- `cases.json`: Manifiesto estructurado de los 20 casos con metadatos, categoría, expectativas de test y comandos de verificación.
- `fixtures/toy-calc/`: Plantilla limpia de `toy-calc` con la corrección base de `average` para tener 7 tests verdes iniciales.
- `fixtures/real/`: Plantilla limpia del módulo `connectors/adf` (`src/adf.ts` y `tests/adf.test.ts`) con 2 tests verdes iniciales.
- `patches/*.patch`: 20 parches git aplicables de forma atómica y reproducible.

## 3. Modos de Ejecución

El script `scripts/e2e/ola3-bench.sh <cli_dir> <modo> [caso]` soporta:
- `baseline`: Ejecuta el validador `qa` sin gates (comportamiento en `main`).
- `gates`: Ejecuta con `--verify '<comando_test>'` (cuando la implementación de gates de codex esté disponible).

## 4. Métricas de Evaluación

- **Sensibilidad**: `bugs_detectados / 15` (detección = veredicto `fail`, `needs_human` o fallo de ejecución).
- **Tasa de falsos rechazos**: `sanos_rechazados / 5` (falso rechazo = veredicto distinto de `pass`).
- **Duración total**: Tiempo acumulado de ejecución del validador.
- **Coste**: Tokens o coste de suscripción / API reportado por el adaptador.
