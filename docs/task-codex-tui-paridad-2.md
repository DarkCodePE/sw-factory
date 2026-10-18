# Tarea para Codex: segunda pasada de paridad de terminal con REA

Worktree: `/home/orlando/Desktop/factory/sw-factory-tui` (rama `feat/droid-tui`, HEAD `e5548de`). Solo tú escribes aquí.
Documento vivo: `docs/cli-droid-parity.md` (reconoce que no hay paridad completa).

## Entrada nueva

Captura del usuario de la pantalla de inicio de Droid 0.244.0 con la paleta `/` abierta:
`docs/evidence/droid-0.244-slash-menu.png` (ábrela y revísala).

Elementos visibles que hay que contrastar con nuestra TUI:
1. Pantalla de bienvenida: logo grande, versión, un "tip" rotativo, línea de atajos.
2. Atajos anunciados: `shift+tab` cicla modos, `ctrl+N` cicla modelos, `ctrl+L` autonomía, `tab` nivel de razonamiento.
3. Barra de estado de recursos: Skills, MCPs (con conteo y ✗ si no hay), Connectors, AGENTS.md (✗ si falta).
4. Indicador de autonomía a la izquierda («Auto (Off) · all actions require approval») y modelo + esfuerzo de razonamiento a la derecha («GPT-6.1 Sol (High)»).
5. Autocompletado de `/` filtrado por lo tecleado, con descripción en una columna y etiqueta de origen a la derecha (p. ej. «factory skill», «configs»); las skills aparecen como comandos (`/install-triage`, `/detect-overlapping-workstreams`) junto a los integrados (`/droids`, `/skills`, `/hooks`, `/plugins`).

## Qué hacer

1. Aplica REA al terminal de Droid (`/home/orlando/.local/bin/droid`, 0.244.0) igual que en la pasada anterior (PTY en bwrap, root RO, workspace temporal, sin credenciales en la evidencia): captura bienvenida, paleta `/` con filtrado, efecto de cada atajo (shift+tab, ctrl+N, ctrl+L, tab), barra de recursos con y sin AGENTS.md/MCP/skills, y cómo se muestran las skills de proyecto en la paleta. Conserva los IDs `ev_…`.
2. Compara contra `bun src/cli.ts tui` y actualiza en `docs/cli-droid-parity.md` una tabla «visto en Droid → estado en fab (hecho/parcial/falta) → evidencia».
3. Implementa lo que falte de interfaz con código propio: bienvenida, atajos, barra de recursos, indicador de autonomía/modelo/razonamiento, autocompletado con descripción y origen, skills de `.agents/skills` y comandos de `.agents/commands` invocables desde la paleta. Si algo requiere backend que no tenemos (connectors, plugins/marketplace, triage de Slack), muéstralo como no disponible, nunca simulado.
4. Tests deterministas para cada pieza; `bun test` y `tsc` en verde; recompila `dist/fab` y deja recibo en `docs/evidence/`.

## Límites (los mismos de antes)

- Observa comportamiento y layout; **no copies** código, bundles, prompts del sistema, descripciones de herramientas ni textos de las skills de Factory. Nuestros textos, nombres de modelo y descripciones son propios.
- Sin push, merge, release ni instalación global. Commit local al terminar está bien.
- Si REA no puede capturar algo (p. ej. requiere login), regístralo como límite, no como ausencia.

Al terminar, escribe un resumen en `docs/report-codex-tui-paridad-2.md` con lo hecho, lo pendiente y los resultados de tests.
