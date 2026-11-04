# Implementación del ciclo mínimo de ideación (2026-11-03)

Contrato: [plan-ciclo-minimo.md](plan-ciclo-minimo.md). Código: `scripts/ideas/ciclo.ts` (412 líneas). Tests: `tests/ciclo.test.ts` (20). Sin dependencias nuevas; reutiliza `validateProbeBudget`/`ProbeBudget` de `scripts/ideas/graft-lector.ts` y `appendRow`/`verifyLedger` de `third_party/dream-machine/ledger/index.ts` (importado por ruta en variable, como `tests/provenance.test.ts:9-10`).

Reglas comunes: cada archivo de `<runs-dir>/<run_id>/` se escribe con `flag: 'wx'` (`writeOnce`, `ciclo.ts:60`); el ledger se prepara con `appendRow` y se verifica **en memoria** antes de escribir (`nextLedger`, `ciclo.ts:70`); flags `--runs-dir`, `--ledger`, `--ahora` (tests con tmpdir; por defecto `docs/research/runs` y `docs/research/ledger.md`).

## Subcomandos

| Subcomando | Qué hace | `archivo:línea` |
|---|---|---|
| `init <hipotesis.json>` | Valida todos los campos (`faltantes`, `:97`). Completo: escribe `hipotesis.json` (JSON canónico), `canonical.md` (YAML legible con `inicio`), `hyp.sha256` (sha256 del JSON canónico, claves ordenadas) e `init.json`. Incompleto: escribe `incompleto.json` (si el `run_id` es válido), la fila `INCONCLUSIVE(hipótesis incompleta): faltan …` y sale con 3 | `ciclo.ts:145` |
| `gate <id> --operador N` | Recalcula el hash y regenera `canonical.md` desde `hipotesis.json`; si algo no coincide, sale con 4. Escribe `gate.json` `{operador, fecha, hyp_sha, usd_max, horas_max}` | `ciclo.ts:129` (`loadRun`), `:167` |
| `brief probe <id>` | Exige gate. Escribe `brief-probe.md`: pregunta canónica, fuentes dentro de `<untrusted-source>` (con `<`/`>` neutralizados, así una fuente hostil no cierra el bloque), comando `graft-lector session-init` con el tope del `probe_budget`, y entregables `receta.md` + `spec.md` con citas `archivo:línea@sha` | `ciclo.ts:196` |
| `check probe <id>` | Existen y no están vacíos `receta.md` y `spec.md`; toda cita candidata (`archivo.ext:línea[-línea]`) debe ser `…@<sha 7–40 hex>`; al menos una cita. Las URL con puerto no cuentan como cita | `ciclo.ts:182` |
| `brief medir <id>` | Exige gate y probe válido. Escribe `brief-medir.md` con **solo** `spec.md` (sin fuentes, receta ni canonical) | `ciclo.ts:240` |
| `medir <id> --experiment E [--tier T0] [--report-cmd C]` | Ejecuta el informe (por defecto `bun src/cli.ts improve report E`; con `--report-cmd` se ejecuta `C` + el id como último argumento, sin shell), parsea la tabla de `reportExperiment` (`src/improve.ts:205`) y escribe `medicion.json` `{experiment, tier, informe, filas, coste_usd, coste_nota}`. T0: cada fila split/brazo con n ≤ 5; otros tiers o informe sin corridas → error 11. Coste = Σ media × k de las corridas con coste; `NULL` si ninguna lo reporta | `ciclo.ts:256` (`parseReport`), `:270`, `:287` |
| `brief critico <id>` | Crea `goldfish/` con copias de `canonical.md`, `receta.md`, `spec.md` y `medicion.json`. Planta **un** canary determinista: en la copia de `medicion.json`, la celda de éxito de la primera fila del `informe` cambia ±0,25 (`filas` conserva el valor real, así que hay una incoherencia detectable). `canary.json` queda **fuera** de `goldfish/` (`{id, archivo, campo, original, alterado, palabra_clave}`; la palabra clave es el valor alterado). Escribe `brief-critico.md` (sin revelar el canary) pidiendo `dictamen.md` | `ciclo.ts:298`, `:307` |
| `cerrar <id> --dictamen F --veredicto V --razon R [--guardiana G]` | Exige gate, `medicion.json` y `canary.json`; el dictamen debe contener la palabra clave del canary; el veredicto debe caber en el tier (`TIER_PERMITE`: T0 → REJECT/INCONCLUSIVE; T1 → ACCEPT/INCONCLUSIVE; T2 → los tres) y un REJECT en T0 exige `--guardiana` ∈ `guardianas`; `horas_max` y `usd_max` se comprueban. Hace dry-run del ledger, copia el dictamen, escribe `veredicto.json` y la fila: Deep = capa, Effect = `<tier> <razón>`, Witness = `hyp:<sha8> ev:<sha8>` (ev = sha256 de `medicion.json` + `veredicto.json`), Issue/PR = `NONE`, Evaluated? = `yes` | `ciclo.ts:333` |
| `halt <id> <razón…>` | Escribe `halt.json` y la fila `INCONCLUSIVE`, Effect `HALT: <razón>`, Evaluated? `no`, en cualquier punto (también sin `init`: Deep `NA`, `hyp:NONE`). Falla si el run ya está cerrado | `ciclo.ts:361` |

`horas_max` se comprueba contra `inicio` en todos los subcomandos que cargan el run, salvo `halt` (`loadRun`, `ciclo.ts:129`).

## Códigos de salida

| Código | Clase |
|---|---|
| 0 | ok |
| 2 | uso o argumentos inválidos |
| 3 | hipótesis incompleta (la fila INCONCLUSIVE ya está escrita) |
| 4 | hash de hipótesis o `canonical.md` no coinciden con el prerregistro |
| 5 | precondición ausente (sin init/gate/probe válido/medición/goldfish) |
| 6 | entregable inválido en `check probe` |
| 7 | el archivo ya existe, o el run ya está cerrado |
| 8 | presupuesto excedido (`horas_max` o `usd_max`) |
| 9 | cierre rechazado (sin canary, tier excedido, REJECT en T0 sin guardiana) |
| 10 | el ledger no verifica; no se escribe nada |
| 11 | medición inválida (tier no permitido, T0 con n > 5, sin corridas, comando de informe falló) |

## Ejemplo de punta a punta (tmpdir, informe simulado)

Directorio: `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory/dab2274a-4297-4e43-9cee-6ab82dd1f731/scratchpad/e2e`. `C = bun scripts/ideas/ciclo.ts --runs-dir <dir>/runs --ledger <dir>/ledger.md`; `R = 2026-11-03-C4b-busqueda-01`. El informe lo imprime `report.sh` con el formato exacto de `reportExperiment` (valores inventados).

```
$ C init hip.json                      → init ok: …/runs/R   hyp.sha256 3fc7b582…   (rc 0)
$ C gate R --operador orlando          → gate ok                                    (rc 0)
$ C brief probe R                      → brief-probe.md escrito                     (rc 0)
$ C check probe R   (sin receta)       → error(6): falta receta.md (o está vacío)   (rc 6)
  … el lector escribe receta.md y spec.md …
$ C check probe R                      → probe ok: 2 citas válidas                  (rc 0)
$ C brief medir R                      → brief-medir.md escrito                     (rc 0)
$ C medir R --experiment e1 --report-cmd "sh report.sh"
                                       → medicion.json escrito (T0, coste 0.9: coste completo)   (rc 0)
$ C brief critico R                    → brief-critico.md, goldfish/ y canary.json escritos      (rc 0)
  canary.json: original 0.600 → alterado 0.350, palabra_clave "0.350"
$ C cerrar R … --veredicto ACCEPT …    → error(9): el tier T0 no puede emitir ACCEPT (permite REJECT, INCONCLUSIVE)   (rc 9)
$ C cerrar R … --veredicto INCONCLUSIVE --razon "solo humo"
                                       → cerrado: INCONCLUSIVE (T0 solo humo) hyp:3fc7b582 ev:b6c70cd7   (rc 0)
$ C cerrar R … (otra vez)              → error(7): el run ya está cerrado (veredicto.json)               (rc 7)
```

Fila resultante (pasa `verifyLedger`):

```
| 2026-11-03 | C4b | 2026-11-03-C4b-busqueda-01: ¿La búsqueda acotada antes de editar reduce el coste sin perder éxito? | NONE | NONE | yes | INCONCLUSIVE | T0 solo humo | hyp:3fc7b582 ev:b6c70cd7 | NONE |
```

Archivos del run: `canonical.md brief-probe.md brief-medir.md brief-critico.md canary.json dictamen.md gate.json goldfish/ hipotesis.json hyp.sha256 init.json medicion.json receta.md spec.md veredicto.json`.

## Pruebas

`bunx tsc --noEmit` limpio; `bun test tests/ciclo.test.ts` 20/20; `bun test` completo 986 pass, 0 fail (96 archivos). Los tests usan un tmpdir y un `report.sh` en lugar de agentes o de `fab improve`.

## No verificado

- **`fab improve report` real**: el parser se escribió contra el código de `reportExperiment` y un informe simulado con su formato; no se corrió contra un experimento real. El comando por defecto (`bun src/cli.ts improve report <id>`) tampoco se ejecutó.
- **Chequeo T0**: el informe no trae tareas ni repeticiones, solo `n` por split/brazo. Se exige n ≤ 5 por fila, que no distingue 5 tareas × 1 de 1 tarea × 5 repeticiones. Para exactitud haría falta leer `experiment_runs` (`task_id`, `repeat`).
- **Canary**: la detección es por palabra clave (el valor alterado) en el dictamen; un crítico que lo cite sin entender el defecto pasa. No se probó con un agente real.
- **Reglas de presupuesto**: `usd_max` solo se comprueba en `cerrar`, y solo si `coste_usd` no es NULL (solo `claude` reporta coste). `horas_max` se mide por reloj, no por trabajo efectivo.
- **Entregables escritos por agentes** (`receta.md`, `spec.md`, `dictamen.md`) no pasan por `writeOnce`; solo se garantiza no sobrescribir lo que escribe `ciclo.ts`.
- Los briefs no se probaron con agentes en paneles de Herdr. T1/T2 solo existen como tabla en `cerrar`; `medir` los rechaza.

## Arreglos tras el primer ciclo (2026-11-03)

Tras el run `2026-11-03-C4b-busqueda-acotada-01` (cerrado; no se tocó). Cuatro arreglos; los campos nuevos de la hipótesis solo son obligatorios en `init`, y un run con el esquema viejo se sigue leyendo (`gate`, `halt`, `cerrar`).

1. **Desglose por tarea y dispersión del coste.**
   - `fab improve report <id> --json`: `experimentRunsJson` (`src/improve.ts:233`) devuelve `{experiment, suite_digest, baseline, candidate, runs[]}` desde `experiment_runs`; flag en `src/improve-cli.ts:11`. El texto de `report` no cambia. `suiteDigest` (`src/improve.ts:56`) es el digest que ya guardaba `createExperiment`, ahora reutilizable.
   - `medir` (`scripts/ideas/ciclo.ts:371`) corre el comando de informe dos veces (texto y `--json`); `parseReporte` (`:323`) valida el JSON. `medicionDe` (`:348`) escribe `por_brazo` (n, éxito, coste medio, sd muestral, mín, máx, diff medio) y `por_tarea`. T0 (≤5 tareas distintas × `repeat`=1) se valida sobre las corridas. Se eliminó `parseReport`/`filas`.
2. **`tipo_cambio`** (`perfil|prompt|skill|codigo`, `faltantes` `:102`). `codigo` → `init` escribe `sin-runner.json` y la fila `INCONCLUSIVE(sin runner)` y sale con código 12 (`:174`). `briefMedir` (`:298`) pide `perfiles/{baseline,candidato}.json`, `profile import` e `implementacion.md` con `baseline: <sha256>` y `candidato: <sha256>`, y dice en negrita que no se mide ni se lanzan agentes. `medir` compara esos digests con los del experimento (`digestImpl` `:370`).
3. **`tier` y `suite`.** `tier` solo `T0`; `suite` se valida con `parseSuite` en `init` (`leerSuite` `:155`) y su sha256 va a `canonical.md` y `init.json`. `cargarSuite` (`:164`) falla si el archivo cambió. `brief probe` añade la regla del tier y las tareas (`seccionTier` `:240`) y la sección «Fuera de este tier». `medir` toma el tier de `canonical` (`--tier` opcional, debe coincidir) y exige `suite_digest` igual al de la suite registrada.
4. **Crítico.** `goldfish/` incluye `suite.json` y la `medicion.json` con desglose; el canary (`plantCanary` `:393`) altera `por_tarea[0].exito` (incoherente con n=1 y con `por_brazo`/`informe`); el encargo (`briefCritico` `:400`) añade la frase del sandbox sin escritura. `cerrar` sigue exigiendo el canary.

Pruebas: `tests/ciclo.test.ts` (`:85` codigo, `:176` desglose, `:237` canary + suite) y `tests/improve.test.ts` (`--json`). `bunx tsc --noEmit` limpio; `bun test tests/ciclo.test.ts tests/improve.test.ts` 33/33. Real: `medir` contra `c4b-busqueda-acotada-01` (`FABRICA_HOME=$HOME/.fabrica-ideas`) en una copia del run cerrado dentro de un tmpdir (sin `medicion.json`/`veredicto.json`): rc 0, desglose de 5 tareas, coste 0.2329.

No verificado:
- `brief probe`/`medir`/`critico` con el esquema nuevo no se probaron con agentes reales; el run real usó el esquema viejo, así que no ejercitó la comprobación de digests, `suite_digest` ni `implementacion.md`.
- El formato `baseline: <sha256>` de `implementacion.md` no lo ha escrito ningún implementador; el `profile import` que debe imprimir el digest no se ejecutó.
- Un `--tier T0` con `h.tier` ausente (esquema viejo) se acepta sin más.
- El canary sigue detectándose por palabra clave (`0.25`/`0.75`); un dictamen que cite ese número por otra razón pasa.
- `medicion.json` del esquema viejo no sirve para `brief critico` (sin `por_tarea`): falla con error; hay que repetir `medir`.

## Prerrequisitos de T1 y canary estricto (2026-11-03)

Cambios solo en `src/improve.ts`, `src/improve-cli.ts` y `scripts/ideas/ciclo.ts` (más tests); sin dependencias nuevas. El texto de `fab improve report` solo gana filas (`baseline_rep`); los campos nuevos van en `--json`.

1. **`integrity.ts` en `runArm`** (`src/improve.ts`, bloque tras el agente). *Política vigente (decisión del operador, 2026-11-03):* el worker pide «Add or update tests», así que casi toda corrida toca tests y fallar por ello invalidaría el experimento. Tras el agente y antes de verificar, `protectedIntegrity(worktree, base, DEFAULT_PROTECTED_PATHS)` calcula las rutas tocadas; `integrity_ok` (1 si ninguna, 0 si alguna) se guarda en `experiment_runs` y sale en `--json` **solo como dato**. `restoreProtected` devuelve cada ruta tocada a su estado en el commit base (`git checkout <base> -- <ruta>` si existía; la borra si era nueva) antes de `git add -A`, del cálculo de `diff_lines` y de `verify`, de modo que el agente no influye en el verificador vía tests o configuración. `success` = resultado de `verify`; `error` solo se rellena por la restauración o el propio verify (`restauración de rutas protegidas falló: …`). `diff_lines` ya no cuenta los cambios protegidos descartados. Si `protectedIntegrity` lanza, la corrida falla con `integrity_ok` NULL. *Sustituye* a la versión inicial de este mismo día, que marcaba fallo (`integridad: <rutas>`).
2. **`group` en `SuiteTask`** (`src/improve.ts:40`, validación `:53`): opcional, texto no vacío; solo se transporta (`experiment_runs.task_group`, `--json`). No altera el digest de las suites sin `group`.
3. **`--repeated-baseline`** (`src/improve-cli.ts:11,18`). `experiments.repeated_baseline` (migración `ALTER TABLE` en `ensureSchema`, `src/improve.ts:22-37`). `armOrder` (`:187`) intercala los tres brazos con la semilla (Fisher-Yates); con dos brazos conserva el sorteo anterior, así que las semillas viejas dan el mismo orden. `baseline_rep` corre el perfil baseline. `--json` añade `repeated_baseline`, `integrity_ok` y `task_group`.
4. **T1 en `ciclo.ts`.** `tier` admite `T0|T1` (`faltantes`). `suiteT1` (`scripts/ideas/ciclo.ts:155`): ≥10 tareas, todas con `group`, ≥3 grupos; se exige en `init` y otra vez en `medir`. `calcularT1` (`:371`) exige `repeated_baseline`, `integrity_ok` en todas las corridas y ≥10 pares completos (candidato+baseline+baseline_rep del mismo lote/split/tarea/repetición). Calcula, con `cuantil` (`:364`, interpolación lineal), mediana y p25–p75 del coste por corrida pareada de los tres brazos, `iqr_no_solapado`, `ruido` (|mediana baseline − baseline_rep|), `delta_mediana`, `direccion_ok` (signo frente a `prediccion.cambio_pct`), `supera_ruido` y `guardianas_ok` (éxito candidato ≥ baseline; `integrity_ok` no interviene); todo en `medicion.json` bajo `t1`. `medicion.json` lleva además `integridad` por brazo (`n`, `integrity_ok_0`, `proporcion_integrity_ok_0`) como dato. Si falta coste en alguna corrida pareada no hay IQR ni ruido y no cabe ACCEPT.
   `cerrar` (`:502`): T1 permite ACCEPT/REJECT/INCONCLUSIVE (`:500`), pero ACCEPT exige las cuatro banderas y escribe `T1 candidato: …` en Effect. T0 sigue como antes: REJECT solo con una guardiana declarada en la hipótesis; `--guardiana integridad` **ya no** es una guardiana (tocar rutas protegidas no es violación).
5. **Canary estricto.** `plantCanary` (`:454`) elige la fila por la semilla del hash de la hipótesis y altera `exito` a (k±0,5)/n, imposible con n corridas. `canary.json` guarda `archivo`, `ruta` (`por_tarea[i].exito`), `task_id`, `brazo`, `original` y `alterado` (se quitó `palabra_clave`). `canaryEncontrado` (`:464`) exige un mismo párrafo con el valor (con límites numéricos), el `task_id` o la ruta, y una de las palabras de incoherencia. El encargo del crítico pide un párrafo por defecto con archivo, campo y valor.

Pruebas: `tests/improve.test.ts` (integridad como dato + restauración, `restoreProtected` con un test debilitado, group, repeated-baseline, migración), `tests/ciclo.test.ts` (T1, canary: número suelto falla, mismo párrafo pasa, párrafos separados fallan; T1 con `integrity_ok=0` en el candidato, `integridad` por brazo). `bunx tsc --noEmit` limpio; ver resultado del `bun test` completo en el cierre del trabajo.

No verificado:
- T1 no se ejecutó con un agente real ni con ≥10 tareas reales; solo con corridas sintéticas y el agente `fake` (que no reporta coste, así que un T1 real con `fake` nunca llega a ACCEPT).
- La restauración no se probó con un agente real. El test de «test debilitado» ejercita `restoreProtected` directamente (el agente `fake` solo puede crear archivos, no editar uno existente); `runArm` se probó con un archivo nuevo en `tests/`. Si el agente cambia `package.json` o un lockfile de forma legítima (dependencias nuevas), la restauración lo revierte y `verify` puede fallar por ello; no se midió. Una ruta protegida confirmada en HEAD (commit del agente) se restaura en el worktree pero `HEAD` de la rama sigue distinto.
- El umbral «n ≥ 10 pares» y «IQR no solapado» siguen siendo un filtro: no hay inferencia estadística ni bootstrap (T2).
- La elección de la fila del canary depende de la semilla; un crítico que vea otro paquete no la predice, pero no se probó con un agente real. Un dictamen que cumpla el párrafo sin entender el defecto sigue pasando.
- `ARQUITECTURA.md` §6 dice que T1 solo emite `INCONCLUSIVE(filtrado)` o `ACCEPT-candidato`; aquí T1 admite también REJECT (pedido del encargo) y no se tocó esa tabla.
- No se hizo el runner de dos builds ni la fase 2.
