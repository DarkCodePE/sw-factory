# Brief: verificar T43, Mandate y enlace del PR (Fable 5.2)

Eres el verificador independiente. No tienes contexto previo. Usa la skill `verificar-cambio` si la tienes disponible.

- **Qué revisas:** la rama `feat/t43-mandate-pr` en `/home/orlando/Desktop/factory/sw-factory-t43`. Son 2 commits sobre `origin/release/0.1.0-rc.12`: `8f662a0` y `41a9fcf`.
- **Qué debía hacer:** lo pide `docs/research/superagent-vs-fab/t43/BRIEF-T43-CODEX.md`.
- **Lo que dice el implementador:** `t43/impl-codex.md`. No lo des por bueno.
- **Diseño de referencia:** `t13/analisis-fable.md`, §3.2-3.4.
- Las tres rutas `docs/research/...` están en `/home/orlando/Desktop/factory/sw-factory/`.

## Qué comprobar
1. **Decisiones:**
   - **D:** cerrar el issue no revoca; solo lo hace retirar la etiqueta, y solo si el change no es terminal.
   - **G:** un hilo revocado no se readmite, aunque se vuelva a poner la etiqueta.
   - **E:** sigue haciendo falta la etiqueta para admitir.
   - **F:** ningún comentario crea un turno.
2. **Atomicidad:** busca cualquier camino que deje revocado sin cancelar, o cancelado sin revocar. Revisa también la idempotencia al reejecutar el efecto `admit`.
3. **Change terminal:** asegúrate de que nunca se cancela un change terminal. Prueba con done, merged, rejected y canceled.
4. **El cambio de prioridad de `admit` en la cola de efectos** (frontera 14): ¿cambia el orden de otros efectos? ¿Puede dejar sin atender respuestas, reintentos o el outbox?
5. **Enlace del PR:**
   - ¿Puede unir el hilo del PR a un change equivocado?
   - Un PR de un change sin hilo de origen no debe unirse a nada.
   - Una respuesta en el PR de alguien sin rol triage debe rechazarse.
   - El texto del PR no debe entrar al prompt sin delimitar.
6. **Modo observe:** no debe escribir nada que cancele; `would_revoke` aparece en el informe. Además, el informe de T13 (`stopsLost`) no debe romperse.
7. **Seguridad (invariantes de §3.3):** el `scope` nunca se amplía, el texto se trata como dato y se descartan los comentarios propios.
8. **Tests:** que fallen sin el arreglo. Haz al menos 3 mutaciones en una **copia temporal**, nunca en el worktree y nunca con `git stash`. Busca huecos de test.
9. **Timeout de S4/M5:** `tests/pool-live.test.ts:189` superó los 5000 ms una vez en la suite completa. ¿Lo provoca T43 o es una inestabilidad previa, de la familia de T45? Si puedes, reprodúcelo en la release.

## Reglas
- **Solo lectura**, salvo tu informe. Sin commits, push ni escrituras en GitHub. No lances subagentes.
- La suite completa se ejecuta en el worktree real: `cd /home/orlando/Desktop/factory/sw-factory-t43 && bun test tests`. Las copias temporales sin `.git` dan falsos fallos.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t43/verif-fable.md` con:
- **Veredicto:** listo para PR, listo con cambios, o no listo.
- **Tabla de hallazgos:** id, severidad, `ruta:línea`, evidencia y arreglo propuesto.
- **Mutaciones:** cada una con su resultado.
- **Comandos:** los que ejecutaste y su salida resumida.
- **Lo que no revisaste.**

Última línea, exactamente: `<!-- FIN -->`.
