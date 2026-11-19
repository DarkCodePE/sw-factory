# T43: arreglos tras la verificación (Codex)

Lee `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t43/verif-fable.md`. Arregla esto en la misma rama `feat/t43-mandate-pr`, con commits nuevos en español, sin `Co-Authored-By` y sin push. Cada arreglo lleva su test, y ese test debe fallar sin el arreglo (compruébalo en una copia temporal, nunca con `git stash`).

1. **H1:** revocar solo si el evento es posterior al trigger que admitió (`origin.trigger_key`). Añade un test con el escenario E1.
2. **H2, decisión A del usuario:** para Mandate, terminal es solo `completed`, `canceled` y `declined`. Un change `blocked`, `failed` o `quarantined` sin etiqueta se revoca y se cancela. Añade un test que cubra esos tres estados y compruebe que `fab retry` (o `retryChange`) ya no lo revive.
3. **H6:** añade un test para cada condición: un PR sin hilo de origen no se une a nada, y sin esquema de admisión tampoco (mutantes M18 y M19).
4. **H4:** sin `trigger_key`, usa la última decisión `would_admit` con `decided_at <= adm_thread_signals.created_at`. Test.
5. **H5:** une el PR al hilo solo si su repo coincide con el del primer hilo. Test.
6. **H7:** saca las aserciones del callback de caída: guarda lo observado y compruébalo fuera (mutantes M17 y M11).
7. **H8:** comprueba `trigger_key` justo después de admitir (mutante M12).
8. **H9:** en `--dry-run`, aplica el mismo filtro `system === 'jira'`.
9. **H3:** no lo cambies. Documéntalo en el informe como limitación: con un merge en curso, la revocación queda `dead`.

Fuera de alcance: H10.

Antes de terminar, ejecuta `bun run typecheck` y `bun test tests` en el worktree. Añade al final de `t43/impl-codex.md` una sección «Correcciones tras verificación» con una tabla: id, commit, test y si falla sin el arreglo. Mueve `<!-- FIN -->` para que vuelva a ser la última línea.
