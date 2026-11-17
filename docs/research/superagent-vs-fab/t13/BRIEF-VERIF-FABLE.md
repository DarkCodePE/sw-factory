# Brief: verificar T13-a y T13-b, la medición en `fab resident report` (Fable 5.2, goldfish)

Eres un verificador sin contexto previo. Revisa la rama `feat/t13-router` en `/home/orlando/Desktop/factory/sw-factory-t13`. Son dos commits sobre `origin/release/0.1.0-rc.12`: `git log -p origin/release/0.1.0-rc.12..HEAD`.

**Solo lectura.**
- No edites nada, no hagas commit, no escribas en GitHub y no lances subagentes.
- Puedes ejecutar tests concretos. Para mutar código usa una copia temporal, sin `git stash`.
- Lo único que escribes es tu informe.

## Qué se pidió
- **Encargo:** la §4 de `t13/analisis-fable.md` (en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/`). Contiene definiciones exactas, tests y lo que no se debe tocar.
- **Brief del implementador:** `t13/BRIEF-T13-CODEX.md`.
- **No leas** `t13/impl-codex.md` hasta haber escrito tus hallazgos.

## Qué verificar
1. **Definiciones.** ¿`followupsLost`, `stopsLost` y `unlabeledTrusted` cumplen al pie de la letra las definiciones de §4? Fíjate en el orden, la deduplicación por hilo, `admittedAt` y la comparación de etiquetas sin distinguir mayúsculas usando la política guardada en la fila.
2. **Regresión del informe existente.**
   - La consulta de `adm_decisions` pasó a hacer `JOIN adm_triggers`. ¿Puede haber decisiones sin trigger que antes se contaban y ahora desaparecen?
   - ¿Revienta `buildReport` con bases antiguas o filas raras? Por ejemplo:
     - eventos sin `labels`, `state` o `authorAssociation`;
     - una `policy` sin `triggerLabel`;
     - triggers de comentario mezclados.
   - Comprueba qué escribe `resident.ts` en `adm_triggers.event` para issues y para comentarios.
3. **Texto no confiable.** ¿Puede algo controlado por terceros (`author`, `url`, `thread`, `labels`) meter secuencias de escape o saltos de línea en `formatReport`? ¿El cuerpo de los comentarios se queda realmente fuera?
4. **T13-b.**
   - ¿`report` sobre una base sin admisión deja de crear las tablas?
   - ¿Alguna otra ruta de solo lectura crea todavía el esquema? Revisa los llamadores de `new AdmissionDb`.
5. **Tests.**
   - ¿Fallan sin el cambio? Compruébalo mutando en una copia temporal.
   - ¿Hay alguno que pasaría igual con el código roto?
6. **Alcance.** ¿Se tocó algo de la lista «no tocar» de §4?

## Salida
Escríbela en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t13/verif-fable.md`:
- **Veredicto:** listo para PR, listo con cambios o no listo.
- **Tabla de hallazgos:** id, severidad, `ruta:línea`, problema, escenario que falla y arreglo propuesto.
- **Contraste con `impl-codex.md`**, escrito después de tus hallazgos.
- **Lo que no revisaste.**

Cita como `ruta:línea` y distingue lo **verificado** de lo **inferido**. Última línea, exactamente: `<!-- FIN -->`.
