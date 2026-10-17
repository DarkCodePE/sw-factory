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
- Los nuevos workstreams usan el agente propio `native`; también admiten adaptadores externos (`claude`, `codex`) y `fake` para tests.
- Reintentos automáticos (3) y recuperación de actividades huérfanas al arrancar.

## Requisitos
[Bun](https://bun.sh) ≥ 1.3, git y un modelo con API compatible con OpenAI.
El agente `native` ejecuta su propio bucle y herramientas; no depende de ningún otro agente.
En Linux, `bubblewrap` permite aislar los comandos; las operaciones que exigen aislamiento fallan si no está disponible.
Los adaptadores externos requieren su CLI correspondiente.

## Uso

```bash
bun install
F="bun src/cli.ts"
export FABRICA_LLM_BASE_URL=http://127.0.0.1:11434/v1
export FABRICA_LLM_MODEL=qwen3.5-32k:latest

$F ws create demo --repo /ruta/al/repo --goal "Mantener el proyecto correcto"
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

Panel interactivo (lista de changes, detalle con specs, eventos y aprobar/comentar/rechazar con el teclado):

```bash
$F tui demo                        # ↑↓ mover · enter detalle · a aprobar · c comentar · d rechazar · r reintentar · q salir
```

El pool (`fab run`) y el panel son procesos separados: deja uno corriendo en otra terminal.

Otros comandos: `fab show <change>`, `fab retry <change>`, `fab reject <change>`, `fab events <ws>`.
Opciones de `ws create`: `--concurrency N`, `--task-limit N`, `--no-change-approval`,
`--no-spec-approval`.

Ejecución directa: `bun src/cli.ts exec --auto medium "Describe la tarea"`.
Consulta [el contrato del agente](src/agent/README.md) para sesiones, JSON-RPC,
MCP, modelos propios, subagentes, misiones y el alcance pendiente.

## Misiones

`fab exec --mission --auto high` planifica una misión en features y milestones, las ejecuta con
workers en serie y valida cada milestone con dos validadores independientes. Una misión solo se
completa con evidencia que el runtime observó y con los `verificationCommands` del contrato,
ejecutados por el propio runner en un sandbox; el texto que entrega el modelo nunca basta.
Ver [el contrato del agente](src/agent/README.md#misiones).

## Tests

```bash
bun test && bunx tsc --noEmit -p .
```
