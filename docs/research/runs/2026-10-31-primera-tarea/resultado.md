# Primera tarea real de la fábrica (2026-10-31)

Repo: `plataforma-starteria` (worktree `plataforma-starteria-fab` sobre `origin/main@fc4baa7`), estado `~/.fabrica-starteria`, workstream `sintesis`, agente `claude`, 1 worker, aprobaciones humanas. Claude como supervisor (meta-loop).

- Tarea: plan para dividir la síntesis de Portfolio Entry (~45 s, tope 120 s) en subagentes paralelos sin romper KAN-114. Entregable `docs/plans/sintesis-subagentes.md`.
- change review → aprobado por el supervisor; investigación (spec) revisada contra el objetivo, referencias archivo:línea verificadas en código (`provider-config.ts:19-26`, `router.ts:328`, `prompt-manifest.ts:10`) → aprobada con 3 condiciones; implementación: commit `cffa037` en `fab/043c79b9`, 232 líneas, solo `docs/plans/`. Cumple los 8 puntos y las 3 condiciones.

## Hallazgo F4 · falso positivo de integridad (02) por índices de herramientas ignorados — S/M
- La implementación terminó `blocked: GATE_TAMPERED` con **430 rutas**, todas `graft/**/*.test.md`: el índice que el hook global de `graft` escribe dentro del worktree mientras corre `claude`. `graft/` está en `.gitignore` y no tiene archivos rastreados.
- Causa: `protectedIntegrity` incluye archivos ignorados del disco (a propósito: un `conftest.py` ignorado sí cambia los tests) y el patrón `**/*.test.*` casa `.test.md`.
- `gate allow` + `retry` no sirve: el retry relanza al agente, el hook regenera el índice y vuelve a bloquear.
- Corrección candidata: excluir de la integridad los archivos ignorados que no pueden alterar la ejecución de tests (p. ej. ignorados bajo directorios sin rastrear de herramientas, o limitar ignorados a nombres ejecutables por runners: `conftest.py`, `*.pth`, `pytest.ini`, `bunfig.toml`, `*.config.*`), o una opción por workstream `--integrity-ignore <glob>` auditada. Va a la rc siguiente.
