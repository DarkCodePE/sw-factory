# Brief T43: Mandate (revocar por etiqueta) y enlace del PR (Codex)

Eres el implementador. No tienes contexto previo.

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-t43`, rama `feat/t43-mandate-pr`, creada desde `origin/release/0.1.0-rc.12`.
- **Lee primero:** `AGENTS.md` del worktree y `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t13/analisis-fable.md`, sobre todo §3.2 (diseño de referencia), §3.3 (invariantes) y §3.4 (fronteras 13-15). Ese diseño es la referencia, pero compruébalo contra el código: las líneas citadas pueden haberse movido.

## Qué construir (solo esto)

### 1. Mandate: retirar la etiqueta para el change
Si un hilo admitido tiene un change **no terminal** y el evento ya no trae la etiqueta de disparo, se revoca.
- **En `auto`:** en una sola transacción, marcar la revocación en `adm_thread_signals` (columnas nuevas añadidas con `ALTER`, como las previas: `trigger_key`, `revoked_at`, `revoked_reason`, o lo que haga falta) y cancelar el change con `store.closeChange(change, 'canceled')`. Así se cancelan las activities, la pregunta abierta y el turno en curso, y el Outbox no publica. Verifica cada uno de esos efectos con tests; no lo des por hecho.
- **En `observe`:** no cancela nada; solo registra `would_revoke`. El informe de `fab resident report` ya tiene `stopsLost`: haz que lo cuente o que muestre ese registro, sin romper el formato actual ni los tests de T13.
- **Decisiones ya tomadas por el usuario:**
  - **D:** solo cuenta retirar la etiqueta, y solo si el change no es terminal. **Cerrar el issue NO revoca**, porque GitHub cierra el issue al fusionar un PR con «Fixes #n».
  - **G:** un hilo revocado no se readmite. Volver a poner la etiqueta no hace nada; se abre un issue nuevo. Regístralo en el informe o en un evento.
  - **E:** se mantiene D1: solo se admite con etiqueta.
- **Revocar no requiere rol** (§3.3): falla hacia cerrado y no consulta la API.
- **Idempotencia:** el efecto `admit` se reejecuta. Revocar dos veces o tras una caída no debe duplicar nada ni cancelar un change terminal.
- **Frontera 13:** nuevo `CrashPoint` `mandate-revoked` dentro de la transacción, con su test en `tests/costura-fronteras.test.ts`. No debe quedar ni revocado sin cancelar ni cancelado sin revocar.
- **Frontera 14:** test en el que la revocación llega con una pregunta pendiente de publicar: el Outbox no la publica.

### 2. Enlace del PR
Cuando la fab crea el PR de un change que viene de un hilo, une el hilo del PR (`github:<owner>/<repo>#<pr>`) al change con `ThreadLinks.link`, solo si hay esquema de admisión (`hasAdmission`). Así `Resident.inbound` acepta respuestas escritas en el PR.
- Busca dónde se crea el PR (`fab pr` o lo que lo haga hoy en `src/cli.ts` u otro sitio) y el patrón de `link` ya existente. `link` es idempotente.
- **Frontera 15:** si el proceso cae entre `gh pr create` y `link`, repetir `fab pr` repara el enlace. Test.
- **Test de punta a punta:** una respuesta válida de alguien con rol triage, escrita en el PR, contesta la pregunta abierta del change igual que si se escribiera en el issue.

## Fuera de alcance (no lo toques)
Router (`route.ts`, `assess`), contexto de seguimientos, que un comentario cree un turno (decisión F: **no**), readmitir, el modo `auto` contra un repo real y cualquier escritura en GitHub.

## Reglas
- Tests que no dependan del tiempo: nada de `timeoutMs` cortos ni `sleep`; usa señales o relojes controlados.
- Commits pequeños en español, **sin `Co-Authored-By`**, sin push, sin tocar `main` ni la release.
- No lances subagentes.
- Antes de terminar, ejecuta `bun run typecheck` y `bun test tests` en el worktree, y escribe la salida real. Si un test falla y crees que no es tuyo, demuéstralo ejecutándolo en `origin/release/0.1.0-rc.12`.
- Si el diseño choca con el código (por ejemplo, el evento no trae las etiquetas), para y explícalo en el informe; no amplíes el alcance.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t43/impl-codex.md` con:
- qué cambiaste y dónde (`ruta:línea`);
- una tabla de test por requisito: D, G, idempotencia, fronteras 13, 14 y 15, observe y respuesta en el PR;
- para 2 o 3 tests clave, si fallan al revertir el arreglo (en una copia temporal, nunca con `git stash`);
- los comandos con su salida resumida;
- riesgos y lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
