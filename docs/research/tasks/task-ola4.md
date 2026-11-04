# Tarea ola 4 — 05 perfiles inmutables por digest (fase 1)

Repo: /home/orlando/Desktop/factory/sw-factory-ola4 (rama `fab/research-ola4`, base `main@c553143`, olas 0–3 integradas).
Contexto obligatorio: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md ficha **05** y /home/orlando/Desktop/factory/sw-factory/docs/research/analisis/esf.md sección **C4b-perfil-inmutable-05**. Referencia ESF (MIT) /home/orlando/Desktop/factory/ext/esf @d901657: `internal/harnessprofile/profile.go` (perfil y digest), `store.go`, `qualification.go` (solo como idea; la cualificación estadística, rollout y rollback son fase 2 y quedan **fuera**). Reimplementa en TS, sin copiar código, y cita `ext/esf/<archivo>@d901657` en los commits.

## Problema
`buildWorkerPrompt` (`src/prompts.ts:47`) y `buildValidatorPrompt` (`src/validators/prompts.ts:46`) arman los prompts en runtime sin versión. No hay forma de saber con qué instrucciones corrió un change, ni de comparar dos versiones de instrucciones de forma reproducible.

## Qué construir (mínimo que cumple la ficha)
1. **Perfil**: JSON con las plantillas de instrucciones del worker (investigación, implementación) y de los validadores (code_review, security_audit, qa), más `harness` (adaptador), `model` (opcional) y `repo` (opcional). **Digest** = sha256 del JSON canónico (claves ordenadas, sin espacios). Inmutable: se guarda direccionado por contenido en `<stateDir>/profiles/<digest>.json`; importar un contenido distinto con el mismo digest es imposible por construcción y reimportar el mismo es idempotente.
2. **Perfil por defecto** = las plantillas actuales exportadas tal cual. **Precondición:** con el perfil por defecto, los prompts generados son byte a byte idénticos a los de hoy (test que lo compare para cada tipo de activity y validador).
3. **CLI**: `fab profile export [--out f]` (perfil por defecto), `fab profile import <f>` (valida esquema y plantillas, imprime digest), `fab profile inspect <digest>`, `fab profile list`. `fab ws create … --profile <digest>` fija el perfil del workstream (columna con `addColumn`); sin `--profile`, el por defecto. Un digest desconocido se rechaza.
4. **Trazabilidad**: cada activity registra el digest de perfil usado y el sha de fab; ambos van al `run.json` del manifest (04).
5. **Experimentos, sin cualificación**: `fab improve create --experiment-id <id> --baseline <digest> --candidate <digest> --suite <archivo>` registra un experimento inmutable; los IDs no se reutilizan nunca (aunque se borre). La suite lista tareas (repo, commit base, descripción, comando de verificación) con su **split** (development, validation, qualification). `fab improve run <id> --split <s> --repeats N` corre cada tarea con ambos perfiles, pareado y en orden aleatorio con semilla registrada, en workstreams desechables, y guarda por corrida: éxito (comando de verificación), tamaño del diff, duración. `fab improve report <id>` resume por brazo: tasa de éxito, varianza del éxito y del tamaño del diff, duración media.

## Tests
Digest estable e independiente del orden de claves; import idempotente; plantilla inválida rechazada; precondición byte a byte con el perfil por defecto; `--profile` desconocido rechazado; digest en activity y en `run.json`; ID de experimento no reutilizable; `improve run` con agente `fake` produce corridas pareadas con la semilla registrada.

## Medición con LLM real (después de que todo lo anterior esté verde)
Autorizado: CLI de **suscripción** `claude` (`--agent claude`); si algo exigiera API de pago, tope **30 USD**: detente antes y avisa. Suite pequeña de 3 tareas reales sobre una copia de /home/orlando/Desktop/factory/examples/toy-calc **bajo ~/.cache** (no /tmp). Brazos: perfil por defecto contra un perfil candidato que **solo** cambia una instrucción del worker (p. ej. exigir correr los tests antes de terminar). Primero 1 repetición para medir duración; luego hasta 10 pareadas si la duración lo permite (anótalo). Guardianas: éxito y coste del candidato no inferiores. Reporta la tabla de `improve report`.

## Verificación y entrega
`bun test` y `bunx tsc --noEmit` en verde (base 883). `fab` real con agente `fake`: export → import → ws con `--profile` → change → `run.json` con el digest. Commits pequeños en español **sin `Co-Authored-By`**, sin merge ni push. **Escribe el reporte mientras avanzas** en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola4.md. No hagas grep sobre /home/orlando/Desktop/factory entero.
