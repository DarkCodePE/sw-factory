# sw-factory

Fábrica de software local: convierte señales (bugs, peticiones) en cambios que agentes de IA
investigan e implementan en worktrees aislados, con aprobación humana entre etapas.

```
signal ──triage──▶ change ──▶ [revisión del change] ──▶ investigation (spec)
                                                           │
                              [revisión del spec] ◀────────┘
                                      │
                                      ▼
                               implementation ──▶ commit en fab/<id> ──▶ fab merge
```

- Estado en SQLite (`$FABRICA_HOME/fabrica.db`, por defecto `~/.fabrica`).
- Un `git worktree` por change, en la rama `fab/<id>`.
- Los workers son agentes sin interfaz: `claude` (por defecto), `codex`, `droid` o `fake` (para tests).
- Reintentos automáticos (3) y recuperación de actividades huérfanas al arrancar.

## Requisitos
[Bun](https://bun.sh) ≥ 1.3, git y el CLI del agente que vayas a usar (p. ej. `claude`).

## Uso

```bash
bun install
F="bun src/cli.ts"

$F ws create demo --repo /ruta/al/repo --goal "Mantener el proyecto correcto" --agent claude
$F ws state demo active
$F signal add demo "add() resta en vez de sumar" --body "add(2, 3) devuelve -1"
$F triage --all demo
$F inbox demo                      # revisa y aprueba: $F review <id> approve
$F run demo --once                 # los workers investigan y dejan un spec
$F inbox demo                      # aprueba el spec
$F run demo --once                 # los workers implementan y hacen commit
$F status demo
$F merge <changeId>                # fusiona fab/<id> en la rama actual del repo
```

Otros comandos: `fab show <change>`, `fab retry <change>`, `fab reject <change>`, `fab events <ws>`.
Opciones de `ws create`: `--concurrency N`, `--task-limit N`, `--no-change-approval`,
`--no-spec-approval`.

## Tests

```bash
bun test && bunx tsc --noEmit -p .
```
