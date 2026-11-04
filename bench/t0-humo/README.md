# Suite T0 de Humo para `fab improve`

Suite de pruebas de humo para validación rápida de perfiles de agente en `sw-factory`.

## 1. ¿Qué es T0?

Según la arquitectura de investigación de la fábrica (`docs/research/arquitectura-ideacion/ARQUITECTURA.md` §6), la evaluación se organiza en tres tiers:

| Tier | Contenido | Regla | Puede emitir |
|---|---|---|---|
| **T0 humo** | 5 tareas × 1, agente `fake` o barato | ¿rompe algo? | `REJECT` solo por guardiana determinista (integridad, escape de sandbox, licencia) o `INCONCLUSIVE` |
| **T1 filtro** | `bench/ola3` + casos nuevos; n_runs ≥ 10 pareadas, IQR | Mejora con IQR no solapado | `INCONCLUSIVE(filtrado)` o `ACCEPT-candidato` |
| **T2 cualificación** | ≥100 tareas intactas, ≥10 clusters, × 3, bootstrap ESF | ganancia ≥ 5 pp y cota inferior IC 95 % > 0 | `ACCEPT-cualificado` / `REJECT` |

T0 es un filtro de humo preliminar (5 tareas × 1 repetición). No califica candidatos para promoción (`ACCEPT-candidato` requiere T1 y `ACCEPT-cualificado` requiere T2); su función es detectar regresiones inmediatas, roturas de integridad o incapacidad de ejecutar tareas básicas antes de invertir presupuesto de evaluación.

## 2. Preparación

Para instanciar la suite en un directorio destino limpio:

```bash
bench/t0-humo/prepare.sh /ruta/al/destino
```

El script:
1. Copia el fixture `bench/ola3/fixtures/toy-calc/` (código Python, `pytest -q`, 7 tests verdes en base).
2. Inicializa un repositorio git en `<destino>` con autor, committer y marcas temporales fijas para garantizar que el SHA base del commit inicial sea 100 % determinista y reproducible (`ef868f55ae6db07938ee1aaeac22756a4f731087`).
3. Genera el manifiesto `<destino>/suite.json` compatible con `Suite` / `SuiteTask` (`src/improve.ts:13-16`), configurando las rutas absolutas al repositorio y a los comandos de verificación. No escribe ningún archivo fuera de `<destino>`.

## 3. Uso con `fab improve`

Una vez preparado `<destino>/suite.json`:

```bash
# 1. Registrar experimento pareado (baseline vs candidato)
fab improve create \
  --experiment-id exp-t0-humo-01 \
  --baseline <digest_baseline> \
  --candidate <digest_candidato> \
  --suite /ruta/al/destino/suite.json

# 2. Ejecutar corridas en split development (1 repetición por tarea)
fab improve run exp-t0-humo-01 \
  --split development \
  --repeats 1 \
  --agent fake

# 3. Consultar reporte de resultados pareados
fab improve report exp-t0-humo-01
```

## 4. Catálogo de Tareas

Todas las tareas pertenecen al split `development`. Cada tarea es pequeña, independiente y cuenta con un test de verificación que **falla en la base** y **pasa únicamente con la solución correcta**.

| ID | Split | Categoría | Descripción | Verificación | Solución Referencia |
|---|---|---|---|---|---|
| `add-subtract` | `development` | Feature nueva | Implementar `subtract(a, b)` en `calc.py` que devuelva `a - b`. Añadir docstring. | `verify/add-subtract.py` | `referencia/add-subtract.patch` |
| `add-power` | `development` | Feature nueva | Implementar `power(base, exponent)` en `calc.py` que devuelva `base ** exponent`. Lanzar `ValueError('negative exponent not supported')` si `exponent < 0`. | `verify/add-power.py` | `referencia/add-power.patch` |
| `add-modulo` | `development` | Feature nueva | Implementar `modulo(a, b)` en `calc.py` que devuelva `a % b`. Lanzar `ValueError('cannot divide by zero')` si `b == 0` o `b == 0.0`. | `verify/add-modulo.py` | `referencia/add-modulo.patch` |
| `fix-divide-edge-case` | `development` | Corrección | Corregir caso borde en `divide(a, b)` cuando el numerador es cero (`a == 0`) y el denominador negativo, evitando el `-0.0` de punto flotante de Python y devolviendo `0.0` positivo. | `verify/fix-divide-edge-case.py` | `referencia/fix-divide-edge-case.patch` |
| `locate-and-safe-divide` | `development` | Lectura / Localización | Localizar el mensaje de error de `divide` (`cannot divide by zero`), exportarlo como constante `ERROR_DIVIDE_BY_ZERO` e implementar helper `safe_divide(a, b, default=None)` que capture el error y retorne `default`. | `verify/locate-and-safe-divide.py` | `referencia/locate-and-safe-divide.patch` |
