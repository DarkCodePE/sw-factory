# Reporte ola 3 — agy: Banco de medición de la ficha 01 y línea base del QA con LLM

Repo de trabajo: `/home/orlando/Desktop/factory/sw-factory-ola3-agy`  
Rama: `fab/research-ola3-agy` (base `main@5aa8cee`).  
Propiedad respetada: exclusivamente `bench/ola3/` y `scripts/e2e/ola3-*`. No se ha tocado ningún archivo bajo `src/`.

---

## 1. Resumen Ejecutivo de la Línea Base (QA con LLM sin Gates)

Se ha ejecutado la medición de la línea base sobre `main` ejecutando el validador `qa` con el CLI real `codex` (`gpt-6.1-sol`, suscripción) en modo `baseline` (sin `--verify` / sin gates) sobre el banco completo de 20 casos controlados.

| Métrica | Resultado Línea Base (`main`) | Objetivo Ficha 01 (con Gates) | Estado / Observación |
| :--- | :---: | :---: | :--- |
| **Sensibilidad total** | **14 / 15 (93.3%)** | Ratio sensibilidad ≥ 1.2 vs baseline | 8/8 tests fallidos + 6/7 semánticos detectados |
| **Bugs atrapables por test** | **8 / 8 (100.0%)** | 100% con gates deterministas | El LLM corre la suite y rechaza ante fallos |
| **Bugs semánticos (sin test)** | **6 / 7 (85.7%)** | Requiere revisión semántica | 1 escape (`tc-bug-06`: promedio redondeado) |
| **Tasa de falsos rechazos** | **2 / 5 (40.0%)** | 0 / 5 con gates (suite verde = pass) | El LLM inventa criterios y rechaza sanos |
| **Duración total** | **832 s (13.8 min)** | Reducción drástica (gates < 1s) | Promedio de 41.6 s por validador |
| **Coste monetario** | **$0.00** | Coste ≤ 1.0 | Suscripción activa CLI (presupuesto $30 intacto) |

### Conclusiones Principales de la Línea Base:
1. **Detección mecánica dependiente del test suite**: En los 8 casos donde existían tests que fallaban ante el bug, el LLM ejecutó los tests (`pytest` o `bun test`), observó el código de salida distinto de cero y rechazó el cambio inmediatamente.
2. **Escapes semánticos**: En `tc-bug-06`, el parche redondeaba el resultado de `average(values)`. Como el único test existente era `average([4]) == 4` (que con `round(4.0)` sigue dando `4`), el LLM asumió que el redondeo era intencional y emitió `VERDICT: pass`, dejando escapar el bug en promedios fraccionarios.
3. **Elevada tasa de falsos rechazos en el LLM (40%)**: En los cambios sanos del módulo real (`real-clean-01` y `real-clean-02`), la suite de tests pasó al 100%, pero el LLM asumió el rol de revisor hipercrítico, imaginó casos borde fuera de especificación (p. ej. bloques de cita pegados a párrafos o reglas horizontales con sangría de espacios) y emitió `VERDICT: fail`. Esto demuestra empíricamente el valor de los **gates deterministas**: un gate ejecuta la suite y da veredicto objetivo e inmediato, evitando que el LLM rechace trabajo perfectamente válido.

---

## 2. Protocolo de Presupuesto y Corrida Piloto Previa

Conforme al contrato de la tarea:
> *"Autorizado por el usuario: CLIs de suscripción; si algo exigiera API de pago, tope 30 USD: detente antes y avisa. Corre primero 2 casos para medir duración y cuota, anótalo, y luego el resto."*

- **Adaptador utilizado**: `codex` (CLI de OpenAI v0.166.0, modelo `gpt-6.1-sol` vía proveedor `caveman`), cubierto por suscripción activa sin coste adicional de API por token ($0.00 gastados de los $30 autorizados).
- **Corrida piloto previa (2 casos)**:
  - `tc-bug-01` (bug con test fallido): Duración **29.5 s**, veredicto `fail`, detectado exitosamente.
  - `tc-clean-01` (change sano): Duración **67.4 s**, veredicto `pass`, aceptado sin falso rechazo.
  - Consumo y cuota: 0 llamadas de pago a API, sin throttling ni bloqueos de cuota.
  - Con estos valores se autorizó el lanzamiento de la batería completa de 20 casos.

---

## 3. Decisiones Mínimas Tomadas y Anotadas

1. **Corrección de la copia base de `toy-calc`**: El código original de `examples/toy-calc/calc.py` contenía un bug histórico deliberado en `average` (`len(values) + 1`), provocando que `test_average_single` fallara en el estado base. Se corrigió en la plantilla base (`bench/ola3/fixtures/toy-calc/`) para que la suite limpia partiera con 7/7 tests pasando (100% verde), requisito indispensable para medir falsos rechazos y bugs semánticos.
2. **Selección del módulo real para la tarea compleja**: Se integró el conversor Atlassian Document Format (ADF) <-> Markdown de Jira (`src/connectors/adf.ts` y `tests/connectors-adf.test.ts`), un componente real de `sw-factory` con 117 líneas de lógica de transformación AST pura, dependencias limpias y ejecución nativa en `bun test` en menos de 20 ms.
3. **Bandera `--protect-none` en el workstream del banco**: Por diseño, la fábrica protege por defecto `tests/**` (Ficha 02). Dado que en un ciclo de desarrollo real los cambios sanos añaden nuevas funcionalidades acompañadas de sus respectivos tests unitarios (como `tc-clean-01` y `real-clean-01`), el runner del banco crea los workstreams con `--protect-none` para aislar la medición del comportamiento de QA del LLM y no bloquear administrativamente por manipulación de tests (`GATE_TAMPERED`).
4. **Directorio efímero bajo `~/.cache/fab-ola3-bench/`**: Atendiendo al aviso del integrador respecto al confinamiento de bwrap (que en `/tmp` oculta los metadatos de `.git`), las copias de los repositorios y bases de datos se crean por defecto bajo `~/.cache/fab-ola3-bench/` (o `$E2E_ROOT`), garantizando que cuando codex integre los gates, el comando `--verify` opere correctamente sin problemas de aislamiento.

---

## 4. Tabla Detallada Caso por Caso (Línea Base QA con LLM)

Resultados completos de la ejecución de `scripts/e2e/ola3-bench.sh <cli_dir> baseline all`:

| ID | Repositorio | Categoría | Tipo | Atrapable por test | Veredicto QA | Clasificación | Duración | Coste | Resumen del Dictamen del LLM |
| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `tc-bug-01` | `toy-calc` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 43.1 s | Suscripción ($0.00) | `calc.py:5` resta en vez de sumar; fallan tests de suma positiva, negativa y conmutatividad. |
| `tc-bug-02` | `toy-calc` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 41.8 s | Suscripción ($0.00) | Devuelve 0 al dividir por cero; fallan tests que exigen excepción `ValueError`. |
| `tc-bug-03` | `toy-calc` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 37.4 s | Suscripción ($0.00) | Sumar 1 al divisor rompe el cálculo de la media: `average([4])` da `2.0` en vez de `4`. |
| `tc-bug-04` | `toy-calc` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 34.7 s | Suscripción ($0.00) | Inversión de operandos `b / a`; `divide(10, 4)` devuelve `0.4` en vez de `2.5`. |
| `tc-bug-05` | `toy-calc` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 38.8 s | Suscripción ($0.00) | Concatena cadenas antes de convertir a entero; `add(2, 3)` devuelve `23`. |
| `tc-bug-06` | `toy-calc` | `semantic` | Bug | No | `pass` | **NO DETECTADO** *(Escape)* | 45.5 s | Suscripción ($0.00) | Tests pasan; el LLM asume que `round()` en promedio es la conducta deseada. |
| `tc-bug-07` | `toy-calc` | `semantic` | Bug | No | `fail` | **DETECTADO** | 38.2 s | Suscripción ($0.00) | `power()` multiplica en vez de exponenciar; detecta discrepancia con la intención. |
| `tc-bug-08` | `toy-calc` | `semantic` | Bug | No | `fail` | **DETECTADO** | 37.1 s | Suscripción ($0.00) | `subtract(a, b)` devuelve `b - a` en vez de `a - b`; detecta inversión de resta. |
| `tc-bug-09` | `toy-calc` | `semantic` | Bug | No | `fail` | **DETECTADO** | 43.8 s | Suscripción ($0.00) | `is_even(n)` evalúa `n % 2 == 1`; detecta que comprueba imparidad. |
| `tc-bug-10` | `toy-calc` | `semantic` | Bug | No | `fail` | **DETECTADO** | 57.3 s | Suscripción ($0.00) | El LLM ejecutó un script auxiliar con `statistics.median` y detectó error en pares. |
| `tc-clean-01` | `toy-calc` | `clean` | Sano | No | `pass` | **ACEPTADO** | 38.4 s | Suscripción ($0.00) | `multiply(a, b)` y su test unitario pasan; verificación adicional correcta. |
| `tc-clean-02` | `toy-calc` | `clean` | Sano | No | `pass` | **ACEPTADO** | 32.8 s | Suscripción ($0.00) | `subtract(a, b)` y su test pasan; chequeos adicionales correctos. |
| `tc-clean-03` | `toy-calc` | `clean` | Sano | No | `pass` | **ACEPTADO** | 38.0 s | Suscripción ($0.00) | Anotaciones PEP 484 verificadas sintácticamente sin cambios de comportamiento. |
| `real-bug-01` | `real` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 36.9 s | Suscripción ($0.00) | `bun test` falló: encabezados vacíos rompen lectura y roundtrip de Markdown. |
| `real-bug-02` | `real` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 49.4 s | Suscripción ($0.00) | Omisión de bloque de código en ADF rompe suite existente. |
| `real-bug-03` | `real` | `test_caught` | Bug | Sí | `fail` | **DETECTADO** | 31.4 s | Suscripción ($0.00) | Sintaxis de enlace invertida `(url)[text]` detectada por fallo en `bun test`. |
| `real-bug-04` | `real` | `semantic` | Bug | No | `fail` | **DETECTADO** | 45.5 s | Suscripción ($0.00) | El LLM probó expresiones con múltiples tachados y detectó el regex codicioso. |
| `real-bug-05` | `real` | `semantic` | Bug | No | `fail` | **DETECTADO** | 34.7 s | Suscripción ($0.00) | Detectó indexación en base 0 para listas ordenadas en el código fuente. |
| `real-clean-01` | `real` | `clean` | Sano | No | `fail` | **FALSO RECHAZO** *(Defecto LLM)* | 40.7 s | Suscripción ($0.00) | Tests verdes; rechaza exigiendo soporte para citas pegadas a párrafos. |
| `real-clean-02` | `real` | `clean` | Sano | No | `fail` | **FALSO RECHAZO** *(Defecto LLM)* | 61.0 s | Suscripción ($0.00) | Tests verdes; rechaza exigiendo soporte para reglas horizontales con sangría. |

---

## 5. Artefactos Entregados

- **`bench/ola3/README.md`**: Documentación técnica del banco de pruebas, estructura y métricas.
- **`bench/ola3/cases.json`**: Manifiesto JSON con los 20 casos, expectativas de test y comandos.
- **`bench/ola3/fixtures/`**: Repositorios base limpios (`toy-calc` y `real/adf`).
- **`bench/ola3/patches/`**: Los 20 parches git individuales (`tc-bug-01.patch` ... `real-clean-02.patch`).
- **`scripts/e2e/ola3-bench.sh`**: Script ejecutable de entrada (`scripts/e2e/ola3-bench.sh <cli_dir> <modo> [filtro]`).
- **`scripts/e2e/ola3-bench.ts`**: Runner CLI con soporte para modos `baseline` y `gates`, agregación estadística y salida formateada.
- **`scripts/e2e/ola3-runner.ts`**: Lógica de instanciación efímera de workstreams, aplicación atómica de parches e inspección de resultados.
- **`bench/ola3/results/results-baseline.tsv`**: Tabla TSV con el resultado detallado de cada caso.
- **`bench/ola3/results/results-baseline.json`**: Resumen estructurado JSON con las métricas consolidadas.

---

## 6. Instrucciones de Reproducción

Para volver a correr la línea base en este o cualquier otro worktree:
```bash
./scripts/e2e/ola3-bench.sh /home/orlando/Desktop/factory/sw-factory-ola3-agy baseline all
```

Para correr la medición sobre la implementación de gates de codex una vez integrada (`--verify`):
```bash
./scripts/e2e/ola3-bench.sh /home/orlando/Desktop/factory/sw-factory-ola3-codex gates all
```
*(o sobre la rama de integración correspondiente).*
