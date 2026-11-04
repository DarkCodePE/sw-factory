# Receta de medición — búsqueda acotada en el prompt de implementación (C4b)

## Qué dicen las fuentes (y qué no)
- La evidencia previa es de agentes que *exploran repos grandes*: la búsqueda agéntica (`rg` y lectura de tramos con `sed -n`) acertó 5/5 en opencode con ~42 k tokens leídos frente a ~9,5 M del repo (docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md:72@2bed96f, docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md:99@2bed96f) y 5/5 en deer-flow (docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md:115@2bed96f).
- Lo medido son **bytes de salida de herramientas**, no costUsd: la propia medición declara «No incluye los tokens propios del modelo» (docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:29@2bed96f) y lista como no medido los tokens de prompt y razonamiento (docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:77@2bed96f).
- Era una ejecución por celda y la varianza entre sesiones supera al efecto (docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:3@2bed96f, docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:53@2bed96f). El brazo con grafo perdió acierto en 2 de 3 sujetos (docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:68@2bed96f).
- Por tanto el mecanismo es plausible, pero **no está probado para costUsd del worker**. El −20 % es una hipótesis.
- Riesgo propio de la intervención: el texto añadido es input extra en cada tarea; en tareas pequeñas puede costar más de lo que ahorra.

## Variable intervenida
Una sola: el texto de `worker.implement` del perfil (la plantilla de implementación), al que se añade un párrafo fijo (ver spec.md). Todo lo demás (rules, investigate, validators, harness, modelo) idéntico. El perfil es inmutable y se identifica por digest sha256 del JSON canónico, así que el candidato es un perfil nuevo con digest distinto (src/profile.ts:21@2bed96f, src/profile.ts:37@2bed96f, src/profile.ts:60@2bed96f).

## Controles (iguales en ambos brazos)
- Agente `claude`, `ANTHROPIC_MODEL=claude-haiku-5-5`; el adaptador ya permite `Read`, `Grep` y `Glob`, así que no hay que tocar permisos (src/agents.ts:39@2bed96f, src/agents.ts:49@2bed96f).
- Mismo fab_sha 2bed96f, mismas tareas y misma semilla/orden; ejecución intercalada baseline/candidato (ABAB) para repartir deriva de precio o caché.
- Perfil baseline: el por defecto, digest 2dff534e (dato del encargo).
- Fijar `FABRICA_HOME=~/.fabrica-ideas`, como en el receipt de la línea base.

## Diseño
- Tareas: la `add-subtract` de la línea base **más** al menos 4 tareas de mayor tamaño de repo (archivos de varios cientos de líneas), para que haya algo que localizar. Solo `add-subtract` sería insuficiente: con n=2 no se puede estimar varianza.
- n ≥ 5 ejecuciones por tarea y brazo (el mínimo que deja ver varianza; la fuente dice que con una por celda no se puede afirmar nada: docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:74@2bed96f).
- Baseline: costUsd medio por tarea del brazo por defecto, medido de nuevo en esta serie; 0,0224 (n=2: 0,0218 y 0,0229) solo es referencia y no sustituye a la remedición.

## Métricas
- Primaria: costUsd por tarea (campo `usage.costUsd` que informa el CLI de claude; src/agents.ts:12@2bed96f), media del candidato frente a baseline. Predicción: −20 %.
- Guardianas: `exito_verify` (no puede bajar; tolerancia 0 fallos extra) y `diffLines` (no puede subir de forma material; sugerido ±25 %).
- Secundarias, para explicar y no para decidir: inputTokens, outputTokens, nº de llamadas Read/Grep, bytes leídos (src/agents.ts:13@2bed96f).

## Regla de decisión (prerregistrar antes de correr)
- Soporta: media costUsd ≤ −20 % **y** guardianas intactas **y** el efecto supera la dispersión entre repeticiones.
- Refuta: costUsd sin cambio o mayor, o cae `exito_verify`.
- Inconcluso: efecto dentro de la varianza. No promover.

## Limitaciones declaradas
- Las fuentes no miden costUsd ni tokens del modelo; la extrapolación de bytes a dólares es supuesto.
- Evidencia de dos repos grandes y agentes de lectura, no de un worker que edita.
- El árbol de trabajo tiene cambios sin commitear en src/agents.ts; las citas son a 2bed96f.
