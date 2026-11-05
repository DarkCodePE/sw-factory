# Resultados de los ciclos de ideación

Una entrada por hipótesis, con su decisión. La fila de cada ciclo está en `docs/research/ledger.md` y su evidencia en `docs/research/runs/<run_id>/`.

## C4b: búsqueda acotada en el prompt del worker (descartada en tareas pequeñas, 2026-11-04)

**Hipótesis.** Añadir a `worker.implement` la instrucción de localizar con `Grep` y leer con `Read` por rangos antes de editar reduce `costUsd` por tarea un 20 %, sin perder éxito.

| Ciclo | Tier | Diseño | Candidato frente a baseline | Veredicto |
|---|---|---|---|---|
| `2026-11-03-C4b-busqueda-acotada-01` | T0 | 5 tareas × 1, Haiku | media +8,5 % (0,0242 frente a 0,0223 USD), dentro de 1 desviación típica | INCONCLUSIVE (T0 solo humo) |
| `2026-11-04-C4b-busqueda-acotada-T1-01` | T1 | 12 tareas × 2, 3 brazos, Haiku | mediana +3,3 % (0,02321 frente a 0,02246 USD), IQR solapados; el ruido entre baseline y baseline_rep (0,0011 USD en medias) es del orden del efecto | INCONCLUSIVE (filtrado) |

**Decisión.** Se abandona en tareas pequeñas.
- Dos ciclos independientes dan el mismo signo, el contrario a la predicción, y ninguna señal de ahorro.
- El lector ya avisó del motivo probable: las tareas nombran el archivo, así que leerlo entero cuesta poco, y el párrafo añadido son tokens de entrada extra en cada corrida.

**Cuándo retomarla.** Solo con el diseño de «Fuera de este tier» de la receta T1:
- archivos grandes o símbolos homónimos, donde localizar sí cuesta;
- tokens de entrada, de salida y turnos medidos por separado;
- un brazo de control con un texto de la misma longitud y sin instrucción de búsqueda.

**Hallazgo lateral.** En el T1, el 100 % de las corridas de los tres brazos tocó rutas protegidas (`tests/**`). El prompt por defecto pide «Add or update tests», y la protección por defecto de los workstreams bloquea esos cambios con `GATE_TAMPERED`. Pasa a ser la limitación del siguiente ciclo.

## C4b: el worker no toca tests protegidos (ACCEPT-candidato en T1, 2026-11-05)

**Hipótesis.** Cambiar los pasos 2 y 3 de `worker.implement`: de «Add or update tests» a no crear, modificar ni borrar archivos protegidos y describir en el informe los tests que harían falta; y de ejecutar los tests a ejecutar los existentes sin editarlos. Con eso, el worker deja de tocar rutas protegidas sin perder éxito.

| Ciclo | Resultado | Veredicto |
|---|---|---|
| `…-T1-01` | Cortado: el equipo se suspendió 8 h a mitad de una corrida. Piloto: 15/24 frente a 24/24 | HALT (presupuesto) |
| `…-T1-02` | Métrica contaminada: `protectedIntegrity` contaba `tests/__pycache__`. Exploratorio por commits: 0/24 frente a 24/24 | INCONCLUSIVE |
| `…-T1-03` | 0/24 corridas tocan rutas protegidas (Wilson 0–0,138) frente a 23/24 del baseline (0,798–0,993) y 24/24 de baseline_rep. −95,8 % (predicho −30 %), ruido 0,042. Éxito 24/24 frente a 23/24 | **ACCEPT-candidato** |

**Qué cambió en fab por el camino.**
- `purgeRegenerableCaches` borra `__pycache__`, `*.pyc` y `.pytest_cache` antes de cada chequeo de integridad, en `pool`, `cli` e `improve`. Sin ese arreglo, todo cambio de Python cuyo worker ejecutaba los tests acababa en `GATE_TAMPERED`.
- `improve` corre bajo `systemd-inhibit`.
- El chequeo del canary acepta raíces de palabras.

**Estado.**
- **Candidato:** el perfil es `64f463d9…` (en `~/.fabrica-ideas`), con flag apagado; el perfil por defecto **no** cambia.
- **Para activarlo por defecto hace falta T2** (ARQUITECTURA.md §6). La receta y el crítico proponen:
  - un brazo de control con un texto de la misma longitud que no hable de tests;
  - éxito medido con tests ocultos;
  - más tareas y clusters.
- **Coste que el ACCEPT no mide:** fab deja de escribir tests propios. El worker los describe en su informe, y alguien tendrá que escribirlos.
