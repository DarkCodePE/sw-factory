# Banco Difícil de Medición — Ola 3b (Ficha 01)

Banco de pruebas difícil para evaluar la efectividad y sensibilidad de la verificación determinista (gates) vs revisión de calidad (QA) con LLM.
Construido íntegramente sobre código real de `sw-factory`.

## 1. Casos y Estructura

Total de 20 casos (`cases.json`):
- **15 bugs** en módulos reales (`src/connectors/adf.ts`, `src/manifest.ts`, `src/store.ts`, `src/threatmon/`, `src/validators/`, `src/worktrees.ts`):
  - **8 bugs atrapables por tests existentes** (`hard-bug-01` a `hard-bug-08`):
    - `hard-bug-01`: off-by-one en límite de bytes de `makeExcerpt` (`tests/threatmon.test.ts`).
    - `hard-bug-02`: condición invertida en comprobación de rama en `removeWorktree` (`tests/worktrees.test.ts`).
    - `hard-bug-03`: error silenciado en bloque catch de `mergeAndCleanup` (`tests/worktrees.test.ts`).
    - `hard-bug-04`: error de unidad temporal (ms vs s) en cálculo de expiración de lease (`tests/store.test.ts`).
    - `hard-bug-05`: mutación de objeto compartido de formato de viñetas en `adfToText` (`tests/connectors-adf.test.ts`).
    - `hard-bug-06`: orden de evaluación previo a limpieza markdown en `parseVerdict` (`tests/validators-core.test.ts`).
    - `hard-bug-07`: bypass de saneamiento y path traversal en `evidenceId` (`tests/manifest.test.ts`).
    - `hard-bug-08`: umbral de severidad omitido dentro de refactor de `ThreatMonitor.report` (`tests/threatmon.test.ts`).
  - **7 bugs semánticos no cubiertos por suite base** (`hard-bug-09` a `hard-bug-15`):
    - `hard-bug-09`: off-by-one omitiendo soporte de heading h6 en regex de `markdownToAdf`.
    - `hard-bug-10`: condición invertida en extracción de URL para `inlineCard` en `adfToText`.
    - `hard-bug-11`: error de I/O silenciado en catch de `atomicEvidence`.
    - `hard-bug-12`: cálculo de `durationMs` expresado erróneamente en segundos en `writeManifest`.
    - `hard-bug-13`: retorno de referencia mutable a array memoizado en `defaultRules`.
    - `hard-bug-14`: precedencia invertida de error stale sobre resultado exitoso en log de `writeManifest`.
    - `hard-bug-15`: omisión de atributo start en renderizado de orderedList dentro de refactor de bloques en `adfToText`.
- **5 changes sanos** (`hard-clean-01` a `hard-clean-05`):
  - `hard-clean-01`: soporte de bloque `blockquote` en ADF con unit test.
  - `hard-clean-02`: soporte de línea divisoria `rule` (`---`) en ADF con unit test.
  - `hard-clean-03`: regla `PS-007` para timers de systemd en monitor de amenazas con unit test.
  - `hard-clean-04`: soporte de prefijo `verdict:` insensible a mayúsculas con unit test.
  - `hard-clean-05`: helper `hasPath` para resolución limpia de worktree en manifest con unit test.
