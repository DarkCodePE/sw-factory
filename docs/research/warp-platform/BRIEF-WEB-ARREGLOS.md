# Arreglos de `fab web` tras la verificación (Codex)

La verificación de Fable está en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/verif-fable.md`. Léela entera. Su veredicto es «fusionable con arreglos».

Haz los arreglos en el mismo worktree y la misma rama. Las reglas son las de tu brief original: commits en español, sin `Co-Authored-By`, sin push.

## Qué hacer
1. **H1 y H8, bloqueos.**
   - En el constructor escritor de `src/store.ts`, pon `PRAGMA busy_timeout = 5000` **antes** de `PRAGMA journal_mode = WAL`. Esa es la opción 1 de la verificación, ya decidida.
   - En la conexión de lectura, añade un `busy_timeout`, o un reintento acotado si `readonly` no admite el PRAGMA.
   - Un test que reproduzca la carrera (en la línea de `store-carrera.ts` de la verificación) con 0 fallos del escritor.
2. **H2 y H6: `improve` debe comportarse igual que en la base.**
   - Lee la metadata sin el tope de 256 KiB; el tope es solo de presentación web.
   - Mantén los mismos casos que antes en: symlink, `stateDir` inexistente, JSON roto y redacción del `workerReport`.
   - Si mantenerlos obliga a separar «leer para `improve`» de «leer para la web», sepáralo.
   - Tests con metadata de 300 KiB y con cada caso de H6, comparando contra el comportamiento de la base.
3. **H3, tests de las defensas que sobrevivieron a las mutaciones.**
   - dirección de escucha `127.0.0.1`;
   - un `INSERT` **válido** rechazado con WAL vivo, en lugar de la aserción vacía de `tests/web.test.ts:84`;
   - `deserialize` en solo lectura;
   - CSP completa, exacta;
   - escapado de comillas en atributo;
   - árbol con padre e hija;
   - redacción por capa;
   - evidencia que no es fichero regular;
   - bandeja filtrada por workstream y contadores;
   - eventos de otros changes que no aparecen.
4. **H5, redacción propia de la web.**
   - Aplica la regla de PEM incompleto también a los valores JSON.
   - Al truncar, redacta antes de cortar o descarta el último token cortado, para que ningún secreto salga a medias.
5. **H7:** pon un tope a los eventos de la timeline, con un aviso de cuántos se omiten.

**No hagas** H4 (ampliar `redact`): será una tarea aparte.

## Verificación
- `tsc --noEmit -p .` y `bun test tests`. Explica los fallos de red o de carga como antes.
- Vuelve a pasar las mutaciones W14, S03, S09, W10, W11, W05, W17, E18, E08 y W21 a W25 en una copia temporal. Di cuáles mueren ahora.

## Informe
Añade al final de `impl-codex.md` una sección «## Arreglos tras verificación» con:
- los commits;
- qué arregla cada uno, por id;
- los tests;
- el resultado de las mutaciones;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`. Mueve la marca `<!-- FIN -->` anterior para que solo quede la del final.
