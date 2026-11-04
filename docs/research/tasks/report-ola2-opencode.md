# Reporte tarea ola 2 — opencode (agents-verify → F2 → F3)

Contrato: `docs/research/tasks/task-ola2-opencode.md`. Worktree:
`sw-factory-ola2-opencode`, rama `fab/research-ola2-opencode`, base
`main@0db0893` (biblioteca 805 tests en verde). Sin merge ni push.

## 1. Cambios

Tres commits, uno por tarea, en orden del contrato:

| Commit | Tarea | Archivos |
| --- | --- | --- |
| `a016b63` | agents-verify | `src/agents-verify.ts` (nuevo), `src/cli.ts`, `src/pool.ts`, `tests/agents-verify.test.ts` (nuevo) |
| `6ebaa3d` | F2 base_sha | `src/worktrees.ts`, `tests/worktrees.test.ts` |
| `0c393b9` | F3 pre-commit | `scripts/e2e/ola2-lib.sh`, `scripts/e2e/ola2-codex-shim.sh`, `scripts/e2e/ola2-f3-precommit.sh` (nuevos) |

Propiedad respetada: solo el módulo nuevo, el subcomando en `cli.ts`, una
llamada al principio de `runPool`, `ensureWorktree` en `worktrees.ts` y
`scripts/e2e/`. `store.ts` no se tocó; de `pool.ts`/`cli.ts` solo la parte
indicada por el contrato (opts + gate único en `runPool`; subcomando, flag
`--accept-agent-binaries` y una línea de `HELP`/`COMMANDS` en `cli.ts`).

### 1.1 agents-verify (`a016b63`)

- `src/agents-verify.ts`: sha256 (`node:crypto`, streaming por `readFileSync`
  del binario resuelto en PATH — resolución manual, sin spawn) de `claude`,
  `codex`, `agy`, `droid` contra un pin en settings. Verificados los mecanismos
  de settings del repo antes de inventar formato: el único settings persistente
  de la fábrica es JSON plano en `$FABRICA_HOME` (convención de
  `loadChatConfig`/`saveChatConfig` en `src/chat/config.ts`: archivo plano,
  `atomic rename`, `0600`). Pin en `$FABRICA_HOME/agents.json`
  (`{"agentBinaries": {"claude": "<64 hex>"…}}`), pines no sha256 o claves
  desconocidas se ignoran.
- `fab agents verify` lista cada uno con veredicto `ok`, `distinto`,
  `no_instalado`, `sin_pin` y un resumen; `fab agents verify --pin` guarda los
  sha256 actuales (los binarios ausentes no se punean y se informan).
- Arranque del pool (`runPool`, una única llamada a `verifyAgentStart` antes
  del bucle): si el adaptador del workstream (u `--agent` override) tiene pin y
  el binario difiere, `runPool` lanza error y no arranca salvo
  `fab run --accept-agent-binaries`; sin pin → aviso por log, no bloqueo; los
  adaptadores sin binario externo (`fake`, `native`) no se punean.
- Idea citada en el commit: `cmd/factory/release.go:171,226-265@d901657`.
- Tests nuevos (`tests/agents-verify.test.ts`, 7): PATH aislado con stubs,
  veredictos, validación de formato de pin, `verifyAgentStart` (sin pin avisa,
  distinto viola, fake/native sin verificación) y `runPool` gate (rechaza sin
  `--accept-agent-binaries`; arranca con él).

### 1.2 F2 — base_sha con merge-base (`6ebaa3d`)

- `ensureWorktree` (`src/worktrees.ts`): helper privado `baseSha()`. Si la
  rama `fab/<id>` ya existía (reintento o worker caído que dejó commits del
  agente), el `baseSha` devuelto es `git merge-base <HEAD del repo> fab/<id>`
  (conservando los `GIT_SAFE_FLAGS` de la ola 0), no el HEAD del worktree ni
  del repo. Sin ancestro común cae al HEAD del repo; rama nueva sigue siendo
  `rev-parse HEAD` (equivale al merge-base).
- Cobertura: en `pool.ts` nada más cambió — `setChangeBase` recibe ya el
  resultado corregido.
- Test nuevo en `tests/worktrees.test.ts` ("F2: baseSha es el merge-base…"):
  cover los tres caminos (creación nueva, reuso del worktree existente y
  worktree perdido con rama persistente); `baseSha` queda en el commit previo
  al del agente, nunca en el HEAD del worktree.

### 1.3 F3 — pre-commit de D5 con commit de fábrica real (`0c393b9`)

- `scripts/e2e/` (copiado lo necesario de
  `/home/orlando/Desktop/factory/sw-factory-ola0-e2e/scripts/e2e/`, sin dump de
  store: el ciclo usa `--no-change-approval --no-spec-approval` y no pasa por
  revisiones ni validadores):
  - `ola2-lib.sh`: raíz efímera en `/tmp/opencode-e2e`, armado del checkout de
    contraste `29d4dd3` (`git worktree add`, `node_modules` enlazado), repos
    limpios, shim, wrapper `fab()` con `FABRICA_HOME`+`PATH` aislados.
  - `ola2-codex-shim.sh`: shim `codex` (el adaptador codex declara
    `factoryCommits`; el fake no commitea, por eso el D5 original "nunca
    pre-commit con fake"). En `--sandbox workspace-write` (implementación)
    deja `impl-f3.txt` en el worktree y reporta `STATUS: done`; en `read-only`
    (investigación) no escribe nada. No toca `.git`: el commit lo hace fab.
  - `ola2-f3-precommit.sh [ola2|base|both]`: repositorio del change con
    `core.hooksPath` malicioso con `pre-commit` (marcador fuera del repo),
    ciclo completo (señal → triage → `fab run --once`) y aserciones: commits de
    fábrica en la rama `fab/<id>` (autor `fab`) y marcadores del hook.

## 2. Salida de tests

`bunx tsc --noEmit`: sin errores (verde).

`bun test` (después de los tres commits):

```
 813 pass
 0 fail
 4424 expect() calls
Ran 813 tests across 84 files. [207.51s]
```

Base 805 en verde + 8 nuevos (7 de `tests/agents-verify.test.ts`, 1 F2 en
`tests/worktrees.test.ts`). En la corrida inicial de la base (previa a los
cambios) hubo 1 fallo puntual en 805; en la repetición y en la final, 0.

## 3. Salida de F3 (`bash scripts/e2e/ola2-f3-precommit.sh both`)

```
=== F3/ola2 === repo del change con pre-commit malicioso: /tmp/opencode-e2e/f3-ola2/repo
=== F3/ola2 === ciclo fab con adaptador codex
--- estado: f3-ola2 [active] agent=codex — prueba F3: commit de fábrica sin ejecutar el pre-commit malicioso
--- commits de fábrica en fab/bff5322f: 1
--- marcadores totales: 0
RESULTADO F3/ola2: OK — la fábrica commitea sin ejecutar el pre-commit malicioso
=== F3/base === repo del change con pre-commit malicioso: /tmp/opencode-e2e/f3-base/repo
--- commits de fábrica en fab/95be88c8: 1
--- marcadores totales: 1
RESULTADO F3/base: OK(repro) — el commit de fábrica de 29d4dd3 ejecutó el pre-commit
resumen F3: fallos=0
```

Verificación adicional del commit de fábrica en el target ola2:
`git log -1 fab/bff5322f` → autor `fab <fab@localhost>`, mensaje "señal F3";
`git show fab/bff5322f:impl-f3.txt` contiene el archivo que dejó la
implementación ("implementación F3 en …/worktrees/bff5322f"). En base 29d4dd3
el mismo ciclo deja 1 marcador (repro del defecto D5 previo a la ola 0).
También verificado a mano: `fab agents verify` y `fab agents verify --pin`
(salida con veredictos y resumen; pines escritos en `$FABRICA_HOME/agents.json`).

## 4. Estado

- Tareas 1 (agents-verify), 2 (F2) y 3 (F3) completas y ejecutadas.
- `bun test` 813/813 y `bunx tsc --noEmit` en verde.
- Nada conocido pendiente del contrato; sin push (como pide el contrato).
