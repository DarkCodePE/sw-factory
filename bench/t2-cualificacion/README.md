# Corpus T2 de cualificación (10 repos × 10 tareas por mutación)

Prerrequisito P1 de `docs/research/arquitectura-ideacion/plan-t2-tests-protegidos.md`: 100 tareas intactas en 10 grupos (un grupo = un repo) para `fab improve`, con tests **ocultos** al agente.

## Repos

Todos en Python puro, licencia permisiva y suite de pytest que corre en segundos con el `python3` del sistema (sin instalar nada). El pin es un commit de 40 hex; `repos/<nombre>.json` guarda `url`, `commit`, `license_spdx`, `license_sha256` (del archivo LICENSE) y el comando de tests. `corpus.py` aborta si el LICENSE clonado no coincide con ese sha256.

| Grupo | Upstream | Licencia | Commit | Código / tests (líneas Python) |
|---|---|---|---|---|
| boltons | mahmoud/boltons | BSD-3-Clause | `d31d821d56c8` | 17 716 / 7 520 |
| cachetools | tkem/cachetools | MIT | `7f6228eb3769` | 1 798 / 4 063 |
| idna | kjd/idna | BSD-3-Clause | `d35772508224` | 1 377 / 27 423 (incluye tablas de datos) |
| jmespath | jmespath/jmespath.py | MIT | `2812594e69d4` | 1 837 / 984 |
| pyflakes | PyCQA/pyflakes | MIT | `5324946c5d86` | 2 956 / 7 233 |
| semver | python-semver/python-semver | BSD-3-Clause | `f3c7138120d7` | 1 610 / 2 289 |
| sortedcontainers | grantjenks/python-sortedcontainers | Apache-2.0 | `3ac358631f58` | 4 043 / 7 090 |
| tabulate | astanin/python-tabulate | MIT | `268615a5c27d` | 3 222 / 6 078 |
| toolz | pytoolz/toolz | BSD-3-Clause | `451af60dec59` | 3 907 / 3 141 |
| xmltodict | martinblech/xmltodict | MIT | `6e29fba28258` | 657 / 1 502 |

**Decisión: no hay copias en `third_party/`.** Allí van las copias de código con su lint de procedencia (ADR-0005). Aquí no se copia código del upstream al repo de fab: solo se versionan el pin, la licencia (por sha256) y las mutaciones. El código se clona en `prepare.sh` y vive en el destino temporal.

## Cómo se construye una tarea

- `mutaciones/<repo>.json`: 10 entradas `{id, archivo, buscar, reemplazar, descripcion, ocultos}`. `buscar` aparece una sola vez en el archivo; la mutación nunca toca tests. `descripcion` es el síntoma en lenguaje de usuario (sin nombrar archivo, línea ni tests; `corpus.py` y `tests/t2-cualificacion.test.ts` lo comprueban). `ocultos` son los archivos de test que fallan con la mutación.
- `prepare.sh` crea, por tarea, un repo git **propio de un solo commit** (`<destino>/tareas/<id>`): el árbol del upstream con la mutación y **sin** los archivos de test de `ocultos`. Un repo por tarea evita que la historia o los objetos de otra tarea contengan los tests retirados. Los ocultos van a `<destino>/ocultos/<id>/`, fuera del repo. El resto de tests se queda en el árbol (y la suite visible pasa en verde).
- `verify` = `bash -c 'cp -R <destino>/ocultos/<id>/. . && env … python3 -m pytest …'`: restaura los ocultos y corre la suite. Con `--confine` el agente no ve `<destino>/ocultos/`.
- Referencia = mutación inversa (el archivo vuelve a su contenido en el commit pin). Autor, fecha (`2026-01-01T00:00:00Z`) y árbol fijos: el mismo sha por tarea.
- `descartadas.json`: candidatas rechazadas con motivo (indetectable, la detectan demasiados archivos, la suite visible falla sin los ocultos porque otros tests los importan, sobrante). Se generaron 16 o más candidatas por repo y se conservan las 10 primeras válidas.
- Split: las dos últimas tareas de cada repo son `validation` (20); el resto `development` (80).

## Preparar la suite

```bash
bench/t2-cualificacion/prepare.sh /ruta/al/destino          # clona los 10 repos (red) y genera suite.json
T2_UPSTREAM=/ruta/clones bench/t2-cualificacion/prepare.sh /ruta/al/destino   # reutiliza clones ya fijados al commit, sin red
python3 bench/t2-cualificacion/corpus.py validar /ruta/al/destino             # verify en la base y la referencia → validacion.json
```

La red solo se usa al clonar; si un repo no está disponible el script falla con un mensaje claro. Uso posterior con `fab improve`. `suite.json` lleva rutas absolutas: el sha256 de `suite.json` solo coincide entre ejecuciones con el **mismo destino**; los shas base de las tareas no dependen de la ruta.

```bash
fab improve create --experiment-id exp-t2-01 --baseline <digest> --candidate <digest> --control <digest> --repeated-baseline --suite /ruta/al/destino/suite.json
fab improve run exp-t2-01 --split development --repeats 3 --agent claude --confine --concurrency 6
fab improve run exp-t2-01 --split validation  --repeats 3 --agent claude --confine --concurrency 6
```

Otras herramientas: `corpus.py calificar <clones>` regenera `mutaciones/` y `descartadas.json` desde `candidatas/` (con `T2_PROBAR=1` solo ensaya); `probe-ocultos.ts <destino> [tarea]` comprueba, sin modelo, que los ocultos no están en la base ni en su historia y que con `--confine` no son legibles (evidencia en `evidence/probe-ocultos.json`).

## Validación hecha (sin modelos)

- `prepare.sh` dos veces en el mismo destino: mismo `suite.json` (sha256 `7ca7d970…e3ce7`) y mismos 100 shas base.
- `validacion.json`: 100/100 tareas con `verify` fallando en la base y pasando con la referencia; la suite visible (sin ocultos) pasa en 100/100. Mediana de `verify` 1,2 s.
- `parseSuite` acepta la suite y `suiteT2` no devuelve faltas.
- Agente `fake`, `--confine --concurrency 8 --control --repeated-baseline`, 1 repetición: 400 corridas (4 brazos × 100) sin errores del lanzador, `confined: true`.
- Sonda: en la base no hay ocultos (ni en la historia); sin `--confine` son legibles, con `--confine` 0 de 4.

## Coste estimado

1 200 corridas (100 tareas × 3 repeticiones × 4 brazos). Con Haiku a 0,024–0,033 USD por corrida (medido en T1 sobre otros fixtures): unos **30–40 USD**, 3,5–5 h con concurrencia 6. Disco: ~340 MB en el destino (`sortedcontainers` pesa ~20 MB por tarea).

## Limitaciones

- **Ningún modelo real ha corrido sobre este corpus.** No se sabe cuántas tareas resuelve un agente ni si todas las descripciones bastan para localizar el fallo; el coste por corrida en repos de este tamaño es una extrapolación.
- Las mutaciones son de un solo token: tareas más fáciles que bugs reales. Descripciones y candidatas las escribieron agentes LLM sin revisión humana; algunos síntomas se dedujeron leyendo el código y no ejecutándolo.
- El pytest usado vive en `~/.local`, no en `/usr`: `verify` corre en el padre y funciona, pero un agente confinado (solo `/usr`) no puede ejecutar pytest sobre los tests visibles (sí `unittest` o `python3 -c`).
- Sin `--confine` el ocultamiento no existe: el agente puede leer `<destino>/ocultos/` (la sonda lo muestra).
- Quitar archivos de test completos deja al agente con menos cobertura visible; 15 candidatas se descartaron porque otros tests importaban los retirados.
- Pines a HEAD de la rama por defecto en 2026-11 (no a etiquetas); `sortedcontainers` no se actualiza desde 2024.
- Solo Linux con `bash`, `tar`, `git` y `python3` ≥ 3.10 con pytest.
