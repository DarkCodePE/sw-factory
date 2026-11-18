# Brief: T40, que `claude --resume` funcione confinado (Sonnet 5.5)

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-t40`
- **Rama:** `fix/t40-resume-confinado`, sobre `origin/release/0.1.0-rc.12`
- **Contexto:** `docs/research/superagent-vs-fab/task.json` (T39, T40) en `/home/orlando/Desktop/factory/sw-factory`.

## El fallo (visto en la prueba B2 con `claude` 2.1.322 real)
`confineAgent` (`src/sandbox/confine.ts:17`) crea en cada llamada un HOME nuevo con `mkdtempSync`, lo monta en `/home/agent` y lo borra en `cleanup`. Claude guarda el transcript de la sesión en `~/.claude/projects/…`.

Por eso, en el turno 2 de la rama viva, `--resume <id>` falla con «No conversation found with session ID». S3 lo tapa (sesión perdida, generación nueva y prompt reconstruido), pero cada respuesta humana pierde el contexto y gasta una generación del tope de 3.

Los tests no lo ven porque el backend falso no escribe en disco.

## Qué hacer
1. Persiste el `~/.claude/projects` del sandbox **por worktree**, fuera del HOME efímero:
   - Ponlo en el directorio git del worktree, junto a `fab-live`: `.git/worktrees/<n>/fab-live/…`. Ya existe y se monta (mira `src/live/claude.ts:26-29`).
   - Móntalo en lectura y escritura en `/home/agent/.claude/projects`.
   - **Solo en turnos vivos de claude.** El camino de un disparo y los demás adaptadores no cambian.
   - Decide tú la forma más pequeña, por ejemplo una opción de `confineAgent` que pase el backend vivo. Debe encajar con cómo `claude.ts` ya calcula su ruta.
2. **Seguridad:** el directorio es por worktree. No se comparte entre changes ni con el `~/.claude` del host, y no se monta nada más del HOME.
3. **Tests:**
   - Un test que demuestre que dos llamadas confinadas sucesivas para el mismo worktree ven el mismo `/home/agent/.claude/projects`. Si en CI no hay `bwrap`, sáltalo como hacen los tests de `tests/sandbox-confine.test.ts`.
   - Otro test que demuestre que sin modo vivo no se monta.
   - Comprueba que el test nuevo **falla sin el arreglo**.
4. **Si puedes**, repite la prueba real: el script está en `/tmp/claude-1000/-home-orlando-Desktop-ia-master/a82ff1be-88c1-4b9c-944e-03eeba3f3ea6/scratchpad/b2/b2.ts`.
   - Cambia `SRC` a tu worktree y ejecútalo con `bun b2.ts <dir-temporal>`. Gasta pocos turnos de claude.
   - Éxito es que el turno 2 reanude con `--resume` sin sesión perdida y que solo haya una generación en `adm_sessions`.

## Reglas
- Commits en español y **sin `Co-Authored-By`**. Prohibido por `/home/orlando/Desktop/factory/CLAUDE.md` #2078.
- Sin push, sin merge y sin escribir en GitHub. No lances subagentes.
- Ejecuta `bun run typecheck` y `bun test tests`. La suite completa, una vez al final.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t40/impl-sonnet.md` con estas partes:
- qué cambiaste y dónde (`ruta:línea`);
- tests y si fallan sin el arreglo;
- el resultado de la prueba real, si la hiciste;
- comandos y su salida resumida;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
