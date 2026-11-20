#!/bin/bash
# Biblioteca de T74g. Se hace `source`. Todo en un temporal (T74G_DIR); nunca ~/.fabrica ni ~/.ssh.
set -u
T74G_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
T74G_SRC="$T74G_REPO/scripts/e2e/t74g"
t74g_setup() { # $1 = dir temporal, $2 = HOME del runner (por defecto uno desechable)
  T74G_DIR="$1"; rm -rf "$T74G_DIR"; mkdir -p "$T74G_DIR"/{bin,rbin,log,root,fabhome,rhome}
  T74G_RHOME="${2:-$T74G_DIR/rhome}"
  T74G_RPATH="$T74G_DIR/rbin:/usr/local/bin:/usr/bin:/bin"
  [ -n "${T74G_RPATH_EXTRA:-}" ] && T74G_RPATH="$T74G_DIR/rbin:$T74G_RPATH_EXTRA:/usr/local/bin:/usr/bin:/bin"
  "$T74G_SRC/install-fake-ssh.sh" "$T74G_DIR/bin" "$T74G_DIR/log" "$T74G_RHOME" "$T74G_RPATH" "$T74G_DIR/root" "$T74G_REPO/src/cli.ts"
  cp "$T74G_SRC/shim-sh" "$T74G_DIR/rbin/sh"; chmod +x "$T74G_DIR/rbin/sh"
}
fab() { FABRICA_HOME="$T74G_DIR/fabhome" PATH="$T74G_DIR/bin:$PATH" bun "$T74G_REPO/src/cli.ts" "$@"; }
t74g_repo() { # $1 = destino
  rm -rf "$1"; mkdir -p "$1"; git -C "$1" init -q -b main
  printf 'def suma(a, b):\n    return a + b\n' > "$1/calc.py"; printf '# demo\n' > "$1/README.md"
  git -C "$1" -c user.name=e2e -c user.email=e2e@l add -A; git -C "$1" -c user.name=e2e -c user.email=e2e@l commit -qm inicial
}
t74g_db() { sqlite3 "$T74G_DIR/fabhome/fabrica.db" "$@"; }
