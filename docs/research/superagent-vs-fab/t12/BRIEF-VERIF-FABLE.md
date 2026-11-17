# Brief: verificar T12, la integración de la fase 2 en el pool (Fable 5.2, goldfish)

Eres un verificador sin contexto previo. Vas a revisar la rama `feat/t12-fase2-integracion` en el worktree `/home/orlando/Desktop/factory/sw-factory-r3`. Son 8 commits sobre `origin/release/0.1.0-rc.12` (`5c4a9ac`). Ve el cambio con `git -C /home/orlando/Desktop/factory/sw-factory-r3 log --stat origin/release/0.1.0-rc.12..HEAD` y su `diff`.

**Solo lectura.**
- No edites nada, no hagas commit, no escribas en GitHub y no lances subagentes.
- Puedes ejecutar tests y typecheck. No lances la suite completa más de una vez.
- Lo único que escribes es tu informe.

## Qué se pidió
- **Encargo:** `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t12/BRIEF-T12.md`.
- **Diseño aprobado:** `techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md` (§5, §5.1 y §5.3 con S1-S8), dentro del worktree.
- **Fronteras de fallo:** `07-ronda3-hallazgos-fase2.md` §6.

**No leas** el informe del implementador (`t12/impl-sonnet.md`) hasta haber escrito tus hallazgos.

## Roles EGM
Usa `codebase_details.md`, `implementation_readiness.md` y `design_critic.md`, que están en `/home/orlando/Desktop/ia-master/elephant-goldfish-model/agents/`.

## Qué verificar
1. **Las 12 fronteras.** Para cada fila del 07 §6, ¿hay un test que de verdad mata en ese punto, reinicia y comprueba que **no** pasa lo prohibido? ¿O solo cubre el camino feliz? Señala las fronteras sin cubrir o mal cubiertas.
2. **Camino de un disparo intacto.** Sin `--live`, ¿el pool se comporta exactamente como antes? Revisa cada línea tocada de `src/pool.ts` y sus llamadores. Ojo con `hasAdmission`, `isChannelChange`, `confine` y `untrusted`, que ahora se evalúan también sin `--live`.
3. **S1-S8** tal como las describe el 06 §5.3. ¿Se cumplen? En especial:
   - **S3:** un error transitorio nunca abre sesión nueva; el tope de generaciones; `fab retry` lo reinicia con evento.
   - **S4:** un turno huérfano no se reejecuta a ciegas.
   - **S6:** el report se aplica al final y en una transacción con el cierre o con el efecto `reply`.
   - **S8:** un change de canal nunca corre sin confinar, y la respuesta solo la da alguien con rol triage o superior.
4. **Modo `auto`.** Comprueba que:
   - `scope_max=propose` no ejecuta nada sin triage humano;
   - el prompt usa solo la copia admitida en `adm_content`;
   - los comentarios de la propia fab se descartan;
   - `observe` sigue igual.
5. **Concurrencia y fencing.** Busca respuestas duplicadas o tardías, dos pools, un residente y un pool a la vez, y `workerId` y `attempt_id` en cada escritura nueva.
6. **Store.** `abandonWait`, `blockWaiting` y `waiting_reply` en los barridos: cierre de change, `requeueOrphans`, `inbox`, `--once` y `TERMINAL_ACTIVITY`.
7. **Tests.** ¿Hay tests frágiles por tiempos? ¿Algún test que pasaría también con el código sin arreglar?
8. **Alcance.** ¿Hay cambios no pedidos o lógica en la capa equivocada?

## Método
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) si el worktree tiene índice; si no, por tramos con `sed -n`. Nada de grep masivos.
- Cita cada hallazgo como `ruta:línea`. Distingue lo **verificado**, leído o ejecutado, de lo **inferido**.
- Si ejecutas algo, pega el comando y su salida.

## Salida
Escribe en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t12/verif-fable.md`:
- **Veredicto:** listo para PR / listo con cambios / no listo.
- **Tabla de las 12 fronteras:** test, si de verdad prueba la caída y nota.
- **Tabla de hallazgos:** id, severidad (alta, media o baja), `ruta:línea`, problema, escenario que falla y arreglo propuesto.
- **Contraste con `impl-sonnet.md`**, escrito después de tus hallazgos.
- **Lo que no revisaste.**

Última línea, exactamente: `<!-- FIN -->`.
