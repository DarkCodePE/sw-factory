#!/bin/sh
# Biblioteca compartida para las scripts E2E de la ola 2 (adaptada de
# scripts/e2e/ola0-lib.sh del worktree sw-factory-ola0-e2e). Se hace `source`,
# no se ejecuta. Todo el trabajo ocurre en /tmp (E2E_ROOT): nunca toca otros
# worktrees ni src/. Requiere bun en el PATH.

# Raíz de I/O efímero para las corridas.
E2E_ROOT="${E2E_ROOT:-${TMPDIR:-/tmp}/opencode-e2e}"
mkdir -p "$E2E_ROOT"

# Directorio del worktree que contiene este script (raíz del repo fab bajo prueba).
E2E_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
E2E_SCRIPT_DIR="$E2E_REPO/scripts/e2e"

# Árbol de fab bajo prueba: por defecto este worktree (ola 2). Para la línea
# base (29d4dd3, main previo a la ola 0: sin GIT_SAFE_FLAGS) E2E_CLI_DIR apunta
# a un checkout temporal creado por e2e_armar_base.
E2E_CLI_DIR="${E2E_CLI_DIR:-$E2E_REPO}"

# Checkout temporal del fab 29d4dd3 (el contraste de D5/F3: commit de fábrica
# sin core.hooksPath=/dev/null). Vive en /tmp; no toca otros worktrees.
e2e_armar_base() {
  E2E_BASE_DIR="$E2E_ROOT/fab-base-29d4dd3"
  if [ ! -e "$E2E_BASE_DIR/.git" ] && [ ! -e "$E2E_BASE_DIR/src/cli.ts" ]; then
    git -C "$E2E_REPO" worktree add --detach "$E2E_BASE_DIR" 29d4dd3 >/dev/null 2>&1
  fi
  # Los deps de runtime están instalados en el worktree principal; se enlazan.
  if [ ! -e "$E2E_BASE_DIR/node_modules" ] && [ -d "$E2E_REPO/node_modules" ]; then
    ln -s "$E2E_REPO/node_modules" "$E2E_BASE_DIR/node_modules"
  fi
  echo "$E2E_BASE_DIR"
}

# Repositorio del change, simple y limpio: un archivo inicial committeado.
e2e_repro_repo() { # $1 = destino
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  printf '# repo F3\ncalc.py:\n  def suma(a, b):\n    return a + b\n' > "$dest/README.md"
  git -C "$dest" init -q -b main
  git -C "$dest" -c user.name=e2e -c user.email=e2e@localhost add -A
  git -C "$dest" -c user.name=e2e -c user.email=e2e@localhost commit -qm "estado inicial (repo F3)"
  echo "$dest"
}

# Shim `codex` para las corridas e2e con el adaptador codex (factoryCommits):
# en `--sandbox workspace-write` (implementación) deja un archivo en el worktree
# y reporta STATUS: done; en read-only (investigación) no escribe nada.
e2e_install_codex_shim() { # $1 = dir destino
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp "$E2E_SCRIPT_DIR/ola2-codex-shim.sh" "$dest/codex"
  chmod +x "$dest/codex"
  echo "$dest/codex"
}

# Ejecuta el CLI de fab bajo prueba con el home y el PATH (shim) ya configurados.
# Requiere: E2E_HOME (FABRICA_HOME) y E2E_SHIM_DIR, seteados por el llamador.
fab() {
  FABRICA_HOME="$E2E_HOME" PATH="$E2E_SHIM_DIR:$PATH" \
    bun "$E2E_CLI_DIR/src/cli.ts" "$@"
}

e2e_marca_ok() { printf '%s: OK — %s\n' "$1" "$2"; }
e2e_marca_fallo() { printf '%s: FALLO — %s\n' "$1" "$2"; }
