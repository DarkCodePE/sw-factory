# Brief: verificar `fab web` F0 y F1 (Fable)

Eres un verificador independiente sin contexto previo. Usa la skill `verificar-cambio`.

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-fabweb`, rama `feat/fab-web`. Son seis commits sobre `origin/release/0.1.0-rc.12`.
- **Encargo original:** `docs/research/warp-platform/BRIEF-WEB-FAB-CODEX.md`, en el checkout principal `/home/orlando/Desktop/factory/sw-factory`.
- **Informe del implementador:** `.../warp-platform/impl-codex.md`. Léelo con desconfianza: compruébalo, no lo des por bueno.

## Qué comprobar
1. **Solo lectura del Store.** Es lo de más riesgo. `src/store.ts` gana un modo `readonly` que:
   - copia la base en memoria con `Database.deserialize`;
   - **reescribe bytes de formato de diario** en esa copia;
   - abre transacciones de lectura fijadas.

   Comprueba:
   - que ninguna ruta del modo escritor cambia de comportamiento (diff de `store.ts` línea a línea);
   - que el modo `readonly` no crea, migra ni bloquea nada sobre una base real con WAL **mientras el pool escribe en ella** (prueba concurrente propia en un `stateDir` temporal);
   - que no puede corromper la base original;
   - qué pasa con una base grande (mide memoria y tiempo con, por ejemplo, 50 MB).
2. **Seguridad HTTP.** Haz mutaciones en una copia temporal, nunca en el worktree. Quita cada defensa por separado y comprueba que algún test falla:
   - el filtro de `Host`;
   - el escapado;
   - el path traversal y los symlinks;
   - el 405;
   - la CSP;
   - la redacción.

   Prueba además ataques reales contra `fab web --port 0` sobre datos sintéticos:
   - `Host` falso;
   - `..` codificado (`%2e%2e`, doble codificación);
   - symlink en `runs/`;
   - un log con secretos en formatos variados.
3. **Refactor de evidencia.** `src/evidence.ts`, `src/manifest.ts` e `src/improve.ts` comparten ahora la lectura. Comprueba que `improve` y los manifiestos se comportan igual que antes, sobre todo el coste desconocido frente a cero.
4. **Corrección de la vista.**
   - En la captura `web-capturas/change-1440-dark.png`, `investigation` aparece como **hija** de `change_review`. Comprueba si el árbol respeta `parent_activity_id` o si está invertido.
   - Comprueba que los contadores de la bandeja cuadran con `fab inbox`.
5. **Suite.** Ejecuta `bun test tests` y `tsc --noEmit -p .` en el worktree. Los fallos de `execute-network`, `t2-cualificacion` y `egress-probe` vinieron por carga o red. Confírmalo o desmiéntelo repitiéndolos y mirando si tocan código cambiado.
6. **Recorrido propio con agent-browser** (sesión `fabverif`, con `--args "--no-sandbox"` si hace falta) sobre datos sintéticos. **No uses `~/.fabrica` ni `~/.fabrica-t11`.**

## Reglas
- Solo lectura en el worktree. Las mutaciones van en copias temporales del scratchpad o de `/tmp`, que borras al acabar.
- No hagas commits, ni push, ni escribas en GitHub. No lances subagentes.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/warp-platform/verif-fable.md` con estas partes:
- **Veredicto:** fusionable / fusionable con arreglos / no fusionable.
- **Hallazgos:** tabla con id, severidad, `ruta:línea`, evidencia (comando y salida) y arreglo propuesto.
- **Mutaciones:** cuáles hiciste y qué test las mató o cuál sobrevivió.
- **Suite:** resultados.
- **Lo que no pudiste comprobar.**

Última línea, exactamente: `<!-- FIN -->`.
