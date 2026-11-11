# Brief de revisión (goldfish EGM)

Eres un revisor **sin contexto previo** (goldfish del Elephant-Goldfish Model). No sabes nada de la conversación que produjo el borrador; juzga solo el documento y el material que cita.

## Qué revisas
- Borrador: `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/design_draft.md`
- Tu rol y criterios: lee el prompt de revisor EGM indicado en tu mensaje de arranque, en `/home/orlando/Desktop/ia-master/elephant-goldfish-model/agents/<rol>.md`, y aplícalo.

## Repos (todos indexados con graft)
- fab: `/home/orlando/Desktop/factory/sw-factory` @ `ce84fc4`
- superagent: `/home/orlando/Desktop/ia-master/dsh-superagent-prototype` @ `8c32a9d`
- harness DSH: `/home/orlando/Desktop/ia-master/deepseek-harness` @ `fcc0ad4`

## Método obligatorio para leer código (fab-research, ADR-0008)
No hagas grep masivos ni leas archivos enteros a ciegas. Desde `/home/orlando/Desktop/factory/sw-factory`:
1. Orientación: `graft map <repo>` o `graft ask "<consulta>" <repo>`.
2. Localización: `bun scripts/ideas/graft-lector.ts rg "<patrón>" --repo <repo>` y lectura de tramos con `sed -n 'A,Bp' <archivo>`.
3. Estructura: `bun scripts/ideas/graft-lector.ts skeleton <archivo> --repo <repo> --no-refresh` y `... callers <símbolo> --repo <repo> --no-refresh` (si dice "sin sidecar", ejecuta antes `... init --repo <repo>`).
4. Cada hallazgo cita `archivo:línea@sha` comprobado leyendo el código, no el borrador.

## Reglas
- SOLO LECTURA: no edites nada salvo tu archivo de revisión. No hagas commit. No lances subagentes.
- Distingue: verificado leyendo código / afirmación de docs / inferencia.
- Formato de cada hallazgo: **id**, severidad (alta/media/baja), sección del borrador, problema, evidencia `archivo:línea@sha`, propuesta concreta.
- Termina con un veredicto de una línea (listo para ADR / listo con cambios / no listo) y la última línea exactamente `<!-- FIN -->`.

Escribe en español en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review/<tu-nombre>.md`.
