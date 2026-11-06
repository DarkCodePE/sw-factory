# Spec — perfil candidato «localizar con búsqueda acotada» (2026-11-04-C4b-busqueda-acotada-T1-01)

Autocontenida: quien implemente no verá las fuentes. Repo: `sw-factory` (fab) @ 952afb5.

## Objetivo
Crear **un perfil candidato** de fab cuyo único cambio frente al baseline (perfil `5b2122cd`) sea una instrucción añadida a la plantilla `worker.implement`, y medirlo contra el baseline con el tier T1. No se cambia código de fab, no se añaden herramientas ni adaptadores.

## Hechos del sistema que necesitas
- Un perfil es un JSON con `schemaVersion: 1`, `harness`, `model?`, `repo?`, `worker` y `validators`; es inmutable y se identifica por el sha256 de su JSON canónico (claves ordenadas, sin espacios) (`src/profile.ts:10-18@952afb5`, `src/profile.ts:35@952afb5`).
- `worker` tiene las plantillas `rules`, `investigate`, `implement`; cada plantilla tiene un tope de 32 KiB (`src/profile.ts:20-22@952afb5`). Las claves de primer nivel permitidas son `schemaVersion, harness, model, repo, worker, validators` (`src/profile.ts:23@952afb5`); no añadas otras.
- `saveProfile(stateDir, raw)` valida, guarda por digest y es idempotente; `loadProfile` re-verifica el digest (`src/profile.ts:74-90@952afb5`). Un perfil sin pin usa el por defecto (`src/profile.ts:103-106@952afb5`).
- Los textos por defecto de las plantillas viven en `DEFAULT_WORKER_TEMPLATES` del módulo `src/prompts.ts` (importado en `src/profile.ts:7@952afb5`). Léelo desde allí o desde el JSON del perfil baseline guardado; **no lo reescribas de memoria**.
- El agente `claude` ya permite `Read`, `Edit`, `Write`, `Glob`, `Grep` y varios `Bash(...)` (`src/agents.ts:49-55@952afb5`). Por tanto «Grep y Read por rangos» no requiere permisos nuevos. La salida JSON del CLI aporta `costUsd`, `inputTokens`, `outputTokens` (`src/agents.ts:12-16@952afb5`, `src/agents.ts:60@952afb5`).

## Pasos
1. Obtén el JSON del perfil baseline `5b2122cd` del directorio de estado de la medición (`FABRICA_HOME=~/.fabrica-ideas`, subcarpeta `profiles/`, fichero `<digest completo>.json`). Si solo hay el prefijo, resuelve el digest completo listando los perfiles.
2. Copia el JSON a uno nuevo. Modifica **solo** `worker.implement`: añade al final, tras una línea en blanco, el bloque de abajo. Deja `rules`, `investigate`, `validators`, `harness`, `model` y `repo` intactos.
3. Guarda el perfil candidato (`saveProfile` o el subcomando de importación del CLI de fab) y anota su digest.
4. Comprueba con un diff de JSON que la única diferencia es el sufijo de `worker.implement`, y que la plantilla resultante sigue bajo 32 KiB.
5. Ejecuta la medición T1 (ver «Medición»). No ejecutes nada fuera de ese experimento.

## Bloque a añadir a `worker.implement` (texto literal)
```
Antes de editar, localiza el código con búsqueda acotada:
1. Usa Grep con un patrón concreto (nombre de función, constante o cadena que menciona la tarea) para obtener archivo y número de línea. No listes ni leas directorios enteros.
2. Lee con Read solo el tramo relevante (usa offset y limit alrededor de la línea encontrada, unas 40-80 líneas). Lee el archivo completo solo si tiene menos de ~150 líneas o si el tramo no basta.
3. Edita únicamente ese tramo y los tests que ya existan para él. No releas lo que ya leíste.
```
Notas sobre el bloque: está en español como el resto de la suite; no menciona herramientas que el agente no tenga; no cambia el formato de salida ni la línea de estado que fab exige al final del informe.

## Medición
- Suite: `/home/orlando/.fabrica-ideas/t1/suite.json` (12 tareas, sha256 `45f1ce6a51722e8d88d38fff6e47789c5b1af616f1f806f75f9abab1a81e67e0`; no la edites). Grupos: Python feature (4), Python fix (4), TypeScript `ts-locate-*` (4; `src/adf.ts`).
- Agente `claude`, `ANTHROPIC_MODEL=claude-haiku-5-5`, mismo checkout de fab en todos los brazos.
- Tres brazos: `candidato` (perfil nuevo), `baseline` (`5b2122cd`) y `baseline_rep` (el baseline otra vez, para medir el ruido), con `--repeated-baseline`. ≥10 corridas pareadas por brazo; recomendado 24 (2 pasadas por tarea). Todas con `integrity_ok`.
- Orden intercalado por tarea, no por bloques de brazo.
- Presupuesto: ≤ 4 h y ≤ 10 USD. Si el gasto acumulado supera 8 USD, para y reporta lo medido.
- Informe: `improve report <experimento> --json` con `FABRICA_HOME=~/.fabrica-ideas`.

## Criterios de aceptación (decide el informe, no tú)
Calcula por brazo la **mediana e IQR** de `costUsd` por tarea y emite:
- `ACCEPT` solo si: IQR de candidato y baseline no solapados; coste del candidato menor y la diferencia de medianas mayor que |mediana baseline − mediana baseline_rep|; `exito_verify` del candidato ≥ baseline. Escribe `T1 candidato: …` con las cifras.
- `INCONCLUSIVE(filtrado)` si el IQR solapa o la mejora no supera el ruido.
- `REJECT` si el coste sube o el éxito baja frente al baseline.
Informa además el cambio porcentual de la media (la predicción es −20 %), `diffLines` por brazo (guardiana informativa) y los `integrity_ok` fallidos si los hay. Referencias previas: baseline T0 0,02235 USD/tarea (n=5, sd 0,0015); `ts-locate-rule` 0,0350.

## Prohibido
- Tocar código de `src/`, la suite, el perfil baseline o los validadores.
- Cambiar modelo, permisos de herramientas o el adaptador.
- Declarar éxito por intuición: solo la regla de arriba.

## Límites que debes declarar en el informe
- El respaldo previo (ADR-0008 y la medición A2/A2g) mide bytes de salida de herramientas en repos enormes, con una ejecución por celda, y no mide el coste del modelo (`docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:77@952afb5`). No es evidencia directa de ahorro de `costUsd` en archivos pequeños.
- En un modelo que ya busca con precisión, el ahorro de bytes fue solo −11 % (`docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:44@952afb5`).
- El texto añadido consume tokens de prompt y puede cambiar el número de turnos; un resultado nulo o de coste mayor es plausible y válido.
