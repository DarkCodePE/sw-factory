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

## Instalación desde GitHub

El bootstrap instala la última versión completa del canal elegido, sin escribir una versión.
Mientras FAB esté en RC, utiliza el canal de prueba:

```bash
curl -fsSL https://raw.githubusercontent.com/DarkCodePE/sw-factory/main/scripts/install.sh |
  sh -s -- --channel prerelease
```

Para la última estable, omite `--channel prerelease`. Si todavía no hay una estable,
el instalador lo indica y permite elegir el canal de prueba explícitamente.

Detecta Linux con glibc o macOS, x64/ARM64. Verifica SHA-256 y la versión antes de
instalar en `~/.local/bin/fab`. Requiere curl y Python 3.8+, sin Bun ni sudo.
Añade `~/.local/bin` al PATH si aún no está incluido. Windows utiliza WSL;
Windows nativo y Alpine/musl todavía no están soportados.

```bash
fab --version
fab tui                    # abre el agente interactivo
fab update --check         # consulta sin instalar
fab update                 # actualiza la instalación existente
```

También puedes instalar con npm: `npm install -g @okuanb/fab@next` para RC,
o `npm install -g @okuanb/fab@latest` para estables. El tag npm `latest` heredado
contiene una RC; hasta publicar una final, utiliza `next` explícitamente.
`fab update` conserva el método y prefix de instalación e infiere el canal de la
versión instalada. Una versión fija sigue disponible con `--version`.
Los scripts `install.sh` incluidos en cada release quedan fijados a esa release;
`latest.sh` y `prerelease.sh` buscan sus respectivos canales.
Consulta [instalación y actualización](docs/install-update.md) para precedencias,
rollback y límites. El checksum prueba integridad respecto al archivo publicado;
no es una firma independiente.

Para preparar un artefacto se dispone de `scripts/build.sh`: produce `fab-<sistema>-<arquitectura>` y su `.sha256` en el host nativo. El CI reúne Linux x64/ARM64 y macOS Intel/ARM64; no se permite compilar el módulo nativo para otro host. Cada binario debe probarse en su sistema antes de publicarlo. Actualmente el aislamiento del runtime depende de bubblewrap en Linux; no se promete aislamiento equivalente en macOS. El instalador no instala git, bubblewrap ni configura el proveedor del modelo.

También se distribuye el paquete npm `@okuanb/fab` (RC en `next`). El [contrato de CI/CD](docs/release.md) describe cómo se prueban y publican los mismos bytes en ambos canales.

## Requisitos
Para desarrollar desde fuente: [Bun](https://bun.sh) ≥ 1.3. macOS y la compilación de distribuciones requieren además compilador C y Node con sus headers `include/node/node_api.h`; `bun install` prepara el módulo de archivos en macOS. Los binarios distribuidos lo incluyen y no requieren compilador. Para usar la fábrica: git y un modelo configurado.
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
