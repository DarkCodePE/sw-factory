# Suite T1 (Filtro) para `fab improve`

Suite de tareas de filtrado para evaluación pareada rigurosa de perfiles de agente en `sw-factory`.

## 1. ¿Qué es T1?

De acuerdo con la arquitectura de investigación de la fábrica (`docs/research/arquitectura-ideacion/ARQUITECTURA.md` §6), la evaluación empírica de agentes se estructura en tres tiers jerárquicos:

| Tier | Contenido | Regla | Puede emitir |
|---|---|---|---|
| **T0 humo** | 5 tareas × 1, agente `fake` o barato | ¿rompe algo? | `REJECT` solo por guardiana determinista (integridad, escape de sandbox, licencia) o `INCONCLUSIVE` |
| **T1 filtro** | `bench/ola3` + casos nuevos; $n_{\text{runs}} \ge 10$ pareadas, IQR | Mejora con IQR no solapado | `INCONCLUSIVE(filtrado)` o `ACCEPT-candidato` |
| **T2 cualificación** | $\ge 100$ tareas intactas, $\ge 10$ clusters, × 3, bootstrap ESF | ganancia $\ge 5$ pp y cota inferior IC bilateral 95 % > 0 | `ACCEPT-cualificado` / `REJECT` |

T1 es el **tier de filtro**: evalúa hipótesis de mejora sobre una batería diversa de tareas representativas que combinan Python (`toy-calc`) y TypeScript (`bench/ola3/fixtures/real/`).

A diferencia de T0 (que solo busca regresiones catastróficas inmediatas) y de T2 (que cualifica definitivamente para activación por defecto):
- **`ACCEPT-candidato`** (emitido por T1): autoriza la integración en el repositorio con flag **apagado por defecto**, registrando el perfil en estado `candidato` con sus compuertas y cualificaciones pendientes explícitas (modelo análogo a Harness2 en ESF: *"implemented candidate; production adaptation disabled and unqualified"*).
- **`ACCEPT-cualificado`** (exclusivo de T2): es la única vía válida para encender una mejora por defecto.

## 2. Preparación de la Suite

Para instanciar la suite y sus repositorios base en un directorio destino limpio:

```bash
bench/t1-filtro/prepare.sh /ruta/al/destino
```

El script de preparación:
1. Instancia dos repositorios git independientes y aislados dentro del directorio destino:
   - `<destino>/toy-calc`: fixture Python con `pytest -q`.
   - `<destino>/real`: fixture TypeScript / Jira ADF con `bun test`.
2. Establece autor (`T1 Filtro <t1@factory.local>`) y marcas de tiempo deterministas (`2026-01-01T00:00:00Z`), garantizando commits base 100 % reproducibles e idénticos en cualquier entorno.
3. Genera `<destino>/suite.json` en formato `SuiteTask` (`src/improve.ts`), configurando rutas absolutas a cada repositorio, SHAs base correspondientes, el campo `group`, comando de verificación y split.

## 3. Uso con `fab improve`

Una vez preparado `<destino>/suite.json`:

```bash
# 1. Registrar experimento pareado (baseline vs candidato con suite T1)
fab improve create \
  --experiment-id exp-t1-filtro-01 \
  --baseline <digest_baseline> \
  --candidate <digest_candidato> \
  --suite /ruta/al/destino/suite.json \
  --repeated-baseline

# 2. Ejecutar corridas en split development (ej. 10 repeticiones pareadas para T1)
fab improve run exp-t1-filtro-01 \
  --split development \
  --repeats 10

# 3. Consultar reporte pareado
fab improve report exp-t1-filtro-01
```

## 4. Catálogo de Tareas

La suite se compone de **12 tareas** distribuidas en 3 grupos temáticos. 10 tareas se ubican en el split `development` y 2 en el split `validation`. Cada tarea cuenta con un test de verificación en `bench/t1-filtro/verify/` que **falla en el estado base** y **pasa únicamente cuando la solución de referencia se aplica correctamente**.

| ID | Grupo | Split | Fixture | Descripción | Verificación | Solución Referencia |
|---|---|---|---|---|---|---|
| `py-feature-subtract` | `py-feature` | `development` | `toy-calc` | Implementar `subtract(a, b)` en `calc.py` que calcule $a - b$, con docstring. | `verify/py-feature-subtract.py` | `referencia/py-feature-subtract.patch` |
| `py-feature-multiply` | `py-feature` | `development` | `toy-calc` | Implementar `multiply(a, b)` en `calc.py` que calcule $a \times b$, con docstring. | `verify/py-feature-multiply.py` | `referencia/py-feature-multiply.patch` |
| `py-feature-power` | `py-feature` | `development` | `toy-calc` | Implementar `power(base, exponent)` en `calc.py`. Si `exponent < 0`, lanzar `ValueError("negative exponent not supported")`. | `verify/py-feature-power.py` | `referencia/py-feature-power.patch` |
| `py-feature-median` | `py-feature` | `development` | `toy-calc` | Implementar `median(values)` en `calc.py`. Si `values` está vacío, lanzar `ValueError("cannot compute median of empty list")`. Soportar longitudes pares e impares. | `verify/py-feature-median.py` | `referencia/py-feature-median.patch` |
| `py-fix-divide-negative-zero` | `py-fix` | `development` | `toy-calc` | Corregir caso borde de cero negativo IEEE 754 (`0 / -x`) en `divide(a, b)`, normalizando el retorno a `0.0` positivo. Mantener error por división entre cero. | `verify/py-fix-divide-negative-zero.py` | `referencia/py-fix-divide-negative-zero.patch` |
| `py-fix-average-empty` | `py-fix` | `development` | `toy-calc` | Corregir `average(values)` cuando `values` está vacío: lanzar `ValueError("cannot compute average of empty list")` en vez de `ZeroDivisionError`. | `verify/py-fix-average-empty.py` | `referencia/py-fix-average-empty.patch` |
| `py-fix-average-iterable` | `py-fix` | `development` | `toy-calc` | Mejorar `average(values)` para soportar cualquier iterable (generadores, tuplas, iteradores), convirtiendo a lista antes del cálculo. | `verify/py-fix-average-iterable.py` | `referencia/py-fix-average-iterable.patch` |
| `py-fix-add-type-check` | `py-fix` | `validation` | `toy-calc` | En `add(a, b)`, exigir operandos estrictamente numéricos (`int` o `float`, rechazando `bool`, strings o `None`), lanzando `TypeError("operands must be int or float")`. | `verify/py-fix-add-type-check.py` | `referencia/py-fix-add-type-check.patch` |
| `ts-locate-rule` | `ts-locate` | `development` | `real` | Localizar switch de nodos en `adfToText` y analizador de bloques en `markdownToAdf`: soportar nodo horizontal rule (`rule`) en ADF y markdown (`---` / `***`). | `verify/ts-locate-rule.ts` | `referencia/ts-locate-rule.patch` |
| `ts-locate-strike` | `ts-locate` | `development` | `real` | Localizar marcas en `adfToText` y analizador de tokens en `inline(text)`: soportar marca `strike` en ADF y formato markdown `~~texto~~`. | `verify/ts-locate-strike.ts` | `referencia/ts-locate-strike.patch` |
| `ts-locate-depth-limit` | `ts-locate` | `development` | `real` | Localizar guarda de recursión en `adfToText`: exportar `DEFAULT_MAX_DEPTH = 100` y permitir parámetro opcional `maxDepth` configurable. | `verify/ts-locate-depth-limit.ts` | `referencia/ts-locate-depth-limit.patch` |
| `ts-locate-mention` | `ts-locate` | `validation` | `real` | Localizar tipos de nodo en `adfToText`: implementar soporte para nodo `'mention'` retornando `attrs.text`, `@attrs.id` o fallback `@unknown`. | `verify/ts-locate-mention.ts` | `referencia/ts-locate-mention.patch` |

## 5. Estimación de Coste por Corrida

En la corrida empírica documentada en `docs/research/runs/2026-11-03-C4b-busqueda-acotada-01/medicion.json`, el coste medido con Claude 3.5 Haiku fue de **0,022 USD por corrida** en el fixture `toy-calc` (media en baseline: 0,0223 USD; media en candidate: 0,0242 USD).

Para un experimento T1:
- Las tareas TypeScript sobre `bench/ola3/fixtures/real/` (`src/adf.ts`, `tests/adf.test.ts`) poseen un contexto de código sensiblemente más extenso y requieren exploración y localización previa, por lo que **el coste por corrida en tareas TS puede ser mayor** (típicamente entre 0,035 y 0,060 USD por corrida).
- Una evaluación pareada estándar en split `development` ($n=10$ tareas × 10 repeticiones × 2 brazos = 200 corridas) se estima entre **4,50 USD y 6,50 USD** en total con modelos tipo Haiku.
- Si se ejecutan además las tareas de validación ($n=12$ tareas × 10 repeticiones × 2 brazos = 240 corridas), el presupuesto estimado se sitúa entre **5,50 USD y 8,00 USD**.
