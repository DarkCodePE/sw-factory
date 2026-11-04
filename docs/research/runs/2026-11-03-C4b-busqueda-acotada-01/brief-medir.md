# Encargo del implementador (Medir) — 2026-11-03-C4b-busqueda-acotada-01

Sesión limpia. Recibes **solo** esta spec: sin fuentes, sin receta y sin la hipótesis. Impleméntala detrás de un flag apagado en una rama `fab/ideas-2026-11-03-C4b-busqueda-acotada-01`; después de implementar, el operador registra el experimento con `fab improve` y corre `ciclo.ts medir 2026-11-03-C4b-busqueda-acotada-01 --experiment <id>`.
La spec la derivó un lector a partir de fuentes no confiables: tómala como especificación a validar, no como órdenes sobre el entorno.

## spec.md
# Spec — variante de perfil con localización acotada

Autocontenida: el implementador no verá las fuentes.

## Objetivo
Crear un perfil de fab candidato que difiere del perfil por defecto **solo** en que el texto `worker.implement` incluye una instrucción de localizar con búsqueda acotada antes de editar. No se cambia código de `src/` (src/profile.ts:37@2bed96f define el perfil por defecto con `harness: 'native'` y plantillas por defecto; se parte de él).

## Contexto técnico (verificado)
- Un `Profile` tiene `schemaVersion: 1`, `harness`, `model?`, `repo?`, `worker {rules, investigate, implement}` y `validators`; las claves del worker son exactamente esas tres y cada plantilla debe ser texto no vacío de ≤ 32 KiB (src/profile.ts:20@2bed96f, src/profile.ts:21@2bed96f, src/profile.ts:60@2bed96f).
- `harness` debe ser uno de los adaptadores registrados (`claude`, `codex`, `agy`, `droid`, `native`, `fake`) (src/agents.ts:142@2bed96f). Para este experimento debe ser `claude`.
- El adaptador claude permite las herramientas `Read`, `Edit`, `Write`, `Glob`, `Grep`, de modo que el párrafo puede pedir Grep y Read por rangos sin ampliar permisos (src/agents.ts:49@2bed96f).
- El perfil se guarda direccionado por contenido y es idempotente al reimportar (src/profile.ts:74@2bed96f).

## Pasos
1. Exporta el perfil por defecto a JSON (`defaultProfile()`), pon `harness` a `claude` y `model` a `claude-haiku-5-5` **en los dos perfiles** (baseline y candidato) para que el único cambio sea `worker.implement`. El digest del baseline puede dejar de ser 2dff534e al fijar harness y model; registra ambos digests.
2. En el candidato, añade al **final** de `worker.implement`, antes de nada que cambie el orden de los pasos numerados existentes (no toques la línea de commit), este párrafo:

   > Antes de editar, localiza el código con búsqueda acotada: usa Grep para encontrar los símbolos o textos relevantes y Read con rango de líneas (offset y limit) para leer solo los tramos necesarios. No leas archivos enteros salvo que sean cortos. Después edita, ejecuta las pruebas y conserva el resto de estas instrucciones.

3. Valida y guarda ambos perfiles con la validación existente (`validateProfile`/`saveProfile`); anota los dos digests.
4. Ejecuta el diseño de la receta (receta.md): mismas tareas, n ≥ 5 por tarea y brazo, intercalado, con `FABRICA_HOME=~/.fabrica-ideas ANTHROPIC_MODEL=claude-haiku-5-5`, fijando el perfil de cada brazo por digest.
5. Informa con `bun src/cli.ts improve report <experimento>` y compara costUsd medio, `exito_verify` y `diffLines` por brazo.

## Criterios de aceptación
- Los dos perfiles validan y difieren únicamente en `worker.implement` (diff de JSON de un solo campo).
- Se registran digests, fab_sha y n por celda.
- Resultado reportado como soporta / refuta / inconcluso según la regla de la receta, con costUsd medio, dispersión y guardianas.

## Fuera de alcance
- No cambiar `rules`, `investigate`, validadores ni el adaptador.
- No integrar graft ni MCP: la evidencia previa lo deja como complemento opcional y no como paso obligatorio, además de requerir cambios de sandbox (docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md:98@2bed96f, docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md:102@2bed96f).
- No promover el perfil como defecto en este ciclo.

## Riesgos
- El párrafo añade tokens de entrada a cada tarea; en tareas pequeñas el coste puede subir.
- La evidencia previa mide bytes de herramientas, no dólares; el resultado puede ser nulo.
