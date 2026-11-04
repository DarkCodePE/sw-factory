# ADR-0006: Paper2Agent fuera del flujo automático

Estado: propuesto (v0.2) · Fecha: 2026-10-31 · Capa principal: C5 · Afectadas: C4b

## Contexto
v0.1 decía "worktree aislado con el sandbox de fab, sin credenciales". Un worktree es un directorio del host, no aislamiento. Paper2Agent es un skill del host: corre en la sesión del operador (con sus credenciales), instala dependencias y ejecuta código ajeno con red (`skills/paper2agent/paper2mcp/references/runtime.md:16`, `routes/cli.md:49-53`). El sandbox de fab (`bwrap --ro-bind / / --unshare-net`, `src/sandbox/wrap.ts`) y el diseño §6 (red `deny` para código ajeno) no son compatibles con eso.

## Decisión
- Paper2Agent **no forma parte del ciclo automático**. Uso manual, en VM desechable sin credenciales del operador ni acceso a `~/.fabrica`.
- Si se necesita ejecutar código de un paper dentro del ciclo, se usa el mecanismo de fab: `fab exec --sandbox required`, instalación en `--verify-setup` con red solo hacia `$FAB_DEPS`, y ejecución con montaje solo-lectura y sin red.
- Su salida nunca entra en `src/`; si la idea pasa, se reimplementa (ADR-0005).
