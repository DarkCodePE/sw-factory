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

Cada GitHub Release incluye su instalador, binarios y checksums. Las versiones de prueba se instalan con su versión explícita; consulta el estado publicado en [Releases](https://github.com/DarkCodePE/sw-factory/releases). Para la RC, una vez publicada:

```bash
curl -fsSL https://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0-rc.1/install.sh |
  sh -s -- --version v0.1.0-rc.1
```

Detecta Linux con glibc o macOS y arquitectura x64/arm64. Descarga `fab-<sistema>-<arquitectura>` y su `.sha256`, verifica SHA-256 y `fab --version`, e instala en `~/.local/bin/fab`. No requiere Bun ni sudo, no cambia perfiles de shell y conserva la instalación anterior si falla la descarga/verificación. Añade `~/.local/bin` a tu PATH si aún no está incluido. Windows: usar este instalador dentro de WSL; Windows nativo y Alpine/musl todavía no están soportados.

```bash
fab --version
fab tui                    # abre el agente interactivo
# También funciona sin modificar PATH:
~/.local/bin/fab tui
```

Repetir el instalador sin fijar versión actualiza a la última release estable sin cambiar sesiones o configuración; una RC siempre usa `--version`. Para una versión publicada concreta o una carpeta diferente:

```bash
curl -fsSL https://github.com/DarkCodePE/sw-factory/releases/download/v0.1.0-rc.1/install.sh |
  sh -s -- --version v0.1.0-rc.1 --install-dir "$HOME/.local/bin"
```

También puedes descargar el script, revisarlo y ejecutarlo con `sh install.sh`. Una versión fijada exige que la release y `fab --version` coincidan. El checksum comprueba integridad frente al archivo publicado en la misma release; no es una firma independiente.

Para preparar un artefacto se dispone de `scripts/build.sh`: produce `fab-<sistema>-<arquitectura>` y su `.sha256` en el host nativo. El CI reúne Linux x64/ARM64 y macOS Intel/ARM64; no se permite compilar el módulo nativo para otro host. Cada binario debe probarse en su sistema antes de publicarlo. Actualmente el aislamiento del runtime depende de bubblewrap en Linux; no se promete aislamiento equivalente en macOS. El instalador no instala git, bubblewrap ni configura el proveedor del modelo.

También se distribuye el paquete npm `@darkcodepe/fab` (RC en `next`). El [contrato de CI/CD](docs/release.md) describe cómo se prueban y publican los mismos bytes en ambos canales.

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
