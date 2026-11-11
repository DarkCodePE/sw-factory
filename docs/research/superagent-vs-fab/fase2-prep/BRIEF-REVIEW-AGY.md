# Brief: verificar T10 y T11 (goldfish)

Eres un revisor sin contexto previo. Vas a revisar dos cambios **sin commit**. Los dos parten de la misma base, `origin/release/0.1.0-rc.12` (`9dbb175`):

| Tarea | Worktree | Rama | Encargo |
|---|---|---|---|
| **T10** | `/home/orlando/Desktop/factory/sw-factory-fase0` | `fix/t10-worktree-reparar` | `BRIEF-T10.md` |
| **T11** | `/home/orlando/Desktop/factory/sw-factory-fase1` | `feat/t11-observe-informe` | `BRIEF-T11.md` |

Los dos encargos están en este directorio, `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase2-prep/`. Mira cada cambio con `git -C <worktree> diff` y `git -C <worktree> status`, que incluye los archivos nuevos.

**Solo lectura.**
- No edites nada de ningún worktree.
- No hagas commit, no escribas en GitHub y no lances subagentes.
- Puedes ejecutar tests, typecheck y comandos `fab` contra un `FABRICA_HOME` temporal, nunca contra `~/.fabrica`.
- Lo único que escribes es tu informe.

**No leas** los informes de los implementadores (`codex.md`, `sonnet.md`) hasta haber escrito tus hallazgos. Después puedes contrastarlos en una sección aparte.

## Roles EGM
Usa `codebase_details.md` e `implementation_readiness.md`, que están en `/home/orlando/Desktop/ia-master/elephant-goldfish-model/agents/`.

## Qué verificar
1. **T10: ¿se bloquea en lugar de fallar?**
   - Comprueba que solo los errores **deterministas** del worktree bloquean la activity sin consumir reintentos: la marca `.preparing`, otro repo, otra rama o un directorio que no es worktree.
   - Comprueba que un fallo transitorio sigue reintentando.
   - Revisa cómo se distinguen esos errores (por tipo, no por texto) y todos los llamadores de `ensureWorktree`, `blockActivity` y lo que se use para desbloquear (`graft callers`).
2. **T10: ¿es segura la reparación?**
   - Sin `--discard`, ¿puede borrar algo que no sea la marca?
   - Con `--discard`, ¿puede borrar la rama o un worktree de otro change? Piensa en el prefijo de 8 caracteres.
   - ¿Hay una carrera si un worker está preparando ese mismo worktree en ese momento?
3. **T10: ¿se puede continuar?** Tras reparar, ¿la activity bloqueada vuelve a ejecutarse con el mecanismo existente? Si se añadió uno nuevo, ¿encaja con el resto?
4. **T11: ¿es de solo lectura?**
   - `report` no debe tomar el lock, escribir en tablas de la fab ni llamar a `gh`.
   - Si se añadió algo al esquema `adm_`, debe ser compatible con una base ya existente: `CREATE TABLE IF NOT EXISTS` o una columna añadida sin romper filas antiguas.
5. **T11: ¿el informe responde a las tres preguntas?**
   - Las preguntas son: (a) si la etiqueta se verifica bien, (b) si aparece el 403 o `unknown`, y (c) si el evento `labeled` llega tarde, lo que se ve en reintentos o efectos `dead`.
   - Comprueba que el informe las responde con los datos reales. Ejecuta tú mismo `FABRICA_HOME=$(mktemp -d) bun src/cli.ts resident --repo DarkCodePE/sw-factory --mode observe --once --since <fecha>` y luego `report` en ese mismo `FABRICA_HOME`. Pega la salida.
   - El `--json` debe ser estable.
6. **Tests en los dos cambios.** ¿Prueban el defecto o solo el camino feliz? ¿Hay tests frágiles por tiempos?
7. **Alcance.** ¿Hay cambios no pedidos, o algo que debería ir en otra capa?

## Método
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos.
- Cita cada hallazgo como `ruta:línea`. Distingue lo **verificado**, leído o ejecutado, de lo **inferido**.
- Si ejecutas comandos, pega el comando y su salida.

## Salida
Escribe en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase2-prep/agy.md`:
- **Veredicto por tarea**: listo para commit / listo con cambios / no listo.
- **Tabla de hallazgos**: id, tarea, severidad (alta, media o baja), `ruta:línea`, problema, escenario concreto que falla y arreglo propuesto.
- **Contraste con `codex.md` y `sonnet.md`**, escrito después de tus hallazgos.
- **Lo que no revisaste.**

Última línea, exactamente: `<!-- FIN -->`.
