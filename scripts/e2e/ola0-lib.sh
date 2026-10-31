#!/bin/sh
# Biblioteca compartida para los scripts E2E de la ola 0 (fuente: task-ola0-e2e-opencode.md).
# Se hace `source`, no se ejecuta. Todo el trabajo ocurre en /tmp (E2E_ROOT):
# nunca toca otros worktrees ni src/. Requiere bun en el PATH.

# Raíz de I/O efímero para las corridas.
E2E_ROOT="${E2E_ROOT:-${TMPDIR:-/tmp}/opencode-e2e}"
mkdir -p "$E2E_ROOT"

# Directorio del worktree que contiene este script (raíz del repo fab bajo prueba).
E2E_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
E2E_SCRIPT_DIR="$E2E_REPO/scripts/e2e"

# Árbol de fab bajo prueba: por defecto este worktree (ola 0, HEAD 7783845).
# Para la línea base (main previo a ola 0, 29d4dd3) E2E_CLI_DIR apunta a un
# checkout temporal creado con e2e_armar_base.
E2E_CLI_DIR="${E2E_CLI_DIR:-$E2E_REPO}"

# Fuente del ejemplo toy-calc: primero en este tree, luego el camino conocido del repo sw-factory.
if [ -d "$E2E_REPO/examples/toy-calc" ]; then
  E2E_TOY_CALC="$E2E_REPO/examples/toy-calc"
elif [ -d "$E2E_REPO/../examples/toy-calc" ]; then
  E2E_TOY_CALC="$E2E_REPO/../examples/toy-calc"
elif [ -d "$HOME/Desktop/factory/examples/toy-calc" ]; then
  E2E_TOY_CALC="$HOME/Desktop/factory/examples/toy-calc"
else
  echo "no se encuentra examples/toy-calc; define E2E_TOY_CALC" >&2
  return 1 2>/dev/null || exit 1
fi

E2E_DUMP="$E2E_SCRIPT_DIR/ola0-dump-store.ts"

e2e_now_ms() { date +%s%3N; }
e2e_now_iso() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Checkout temporal del main previo a ola 0 (29d4dd3) con los git safe flags de la ola 0
# todavía sin aplicar. Vive en /tmp; no toca otros worktrees.
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

# Copia limpia de toy-calc con git propio (el "repo" observable por fab).
e2e_repro_repo() { # $1 = destino
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest"
  for f in calc.py README.md pytest.ini; do
    [ -f "$E2E_TOY_CALC/$f" ] && cp "$E2E_TOY_CALC/$f" "$dest/"
  done
  cp -r "$E2E_TOY_CALC/tests" "$dest/tests" 2>/dev/null
  find "$dest" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null
  git -C "$dest" init -q -b main
  git -C "$dest" -c user.name=e2e -c user.email=e2e@localhost add -A
  git -C "$dest" -c user.name=e2e -c user.email=e2e@localhost commit -qm "estado inicial de toy-calc (copia E2E)"
  echo "$dest"
}

# Shell falsa para el agente fake: se instala primero en el PATH de las corridas
# `fab`. Delega todo a /bin/sh y solo se desvía en las llamadas con prompt de validador.
e2e_install_shim() { # $1 = dir destino
  local dest="$1"
  rm -f "$dest/sh" 2>/dev/null
  mkdir -p "$dest"
  cp "$E2E_SCRIPT_DIR/ola0-fake-shim.sh" "$dest/sh"
  chmod +x "$dest/sh"
  echo "$dest/sh"
}

# Ejecuta el CLI de fab bajo prueba con el home y el PATH (shim) ya configurados.
# Requiere: E2E_HOME (FABRICA_HOME) y E2E_SHIM_DIR, seteados por el llamador.
fab() {
  FABRICA_HOME="$E2E_HOME" PATH="$E2E_SHIM_DIR:$PATH" \
  FAB_SHIM_LOG="${FAB_SHIM_LOG:-$E2E_HOME/shim.log}" \
    bun "$E2E_CLI_DIR/src/cli.ts" "$@"
}

# Volcado TSV del store para aserción/instrumentación (lee la SQLite, no la muta).
e2e_dump() { # $1: activities|events|changes|signals  — requiere E2E_HOME
  bun "$E2E_DUMP" "$E2E_HOME" "$1"
}

# Primer id de actividad que casa change + kind + review_status.
# Los ids de change/vía CLI suelen llegar con prefijo de 8; se exige prefijo exacto.
e2e_activity_primer_id() { # $1 change_id  $2 kind  $3 review_status ej. awaiting
  e2e_dump activities | awk -F'\t' -v c="$1" -v k="$2" -v s="$3" \
    'NR > 1 && index($3, c) == 1 && $4 == k && $7 == s { print $1; exit }'
}

# Estado del change con id $1 (columna de status).
e2e_change_status() {
  e2e_dump changes | awk -F'\t' -v id="$1" 'NR > 1 && index($1, id) == 1 { print $4 }'
}

# Error de la primera actividad del change con kind+status indicados.
e2e_activity_error() {
  e2e_dump activities | awk -F'\t' -v c="$1" -v kind="$2" -v st="$3" \
    'NR > 1 && index($3, c) == 1 && $4 == kind && $6 == st { print $10 }'
}

# Filas de eventos cuyo mensaje contiene el patrón indicado.
e2e_eventos_con() {
  e2e_dump events | awk -F'\t' -v pat="$1" 'NR > 1 && index($6, pat) > 0'
}

# Última actividad del validador $2 en el change $1: "status\treview_status\terror".
e2e_validator_ultimo() {
  e2e_dump activities | awk -F'\t' -v c="$1" -v v="$2" \
    'NR > 1 && index($3, c) == 1 && $5 == v { s=$6; r=$7; e=$10 } END { print s "\t" r "\t" e }'
}

e2e_marca_ok() { printf '%s: OK — %s\n' "$1" "$2"; }
e2e_marca_fallo() { printf '%s: FALLO — %s\n' "$1" "$2"; }

# Crea una señal y triagea; imprime el change id (prefijo de 8) por stdout.
e2e_signal_change() { # $1 slug  $2 título
  local out sid
  out=$(fab signal add "$1" "$2") || return 3
  sid=$(printf '%s' "$out" | awk '{print $2}')
  [ -n "$sid" ] || { echo "no se pudo leer id de señal: $out" >&2; return 3; }
  out=$(fab triage "$sid") || return 3
  printf '%s' "$out" | awk -F'change ' '{print $2}' | cut -d' ' -f1
}

# Ciclo completo señal→investigación→implementación con el agente fake y las
# dos revisiones humanas (gates del README). Crea el workstream, la señal, triagea
# y aprobada ambas puertas; imprime el change id por stdout y progreso por stderr.
# $1 slug, $2 repo, $3 goal, $4 título señal.
e2e_ciclo_implementado() {
  local sid cid aid
  fab ws create "$1" --repo "$2" --goal "$3" --agent fake >/dev/null || return 3
  fab ws state "$1" active >/dev/null || return 3
  out=$(fab signal add "$1" "$4") || return 3
  sid=$(printf '%s' "$out" | awk '{print $2}')
  [ -n "$sid" ] || { echo "no se pudo leer id de señal: $out" >&2; return 3; }
  out=$(fab triage "$sid") || return 3
  cid=$(printf '%s' "$out" | awk -F'change ' '{print $2}' | cut -d' ' -f1)
  [ -n "$cid" ] || { echo "no se pudo leer id de change: $out" >&2; return 3; }
  echo "change $cid triageado" >&2
  # Gate 1: change_review awaiting -> approve -> investigation
  aid=$(e2e_activity_primer_id "$cid" change_review awaiting)
  [ -n "$aid" ] || { echo "change_review no está en awaiting" >&2; return 3; }
  echo "gate 1: revisión de unidad $aid" >&2
  fab review "$aid" approve >/dev/null || return 4
  echo "== investigación" >&2
  fab run "$1" --once >/dev/null 2>&1 || true
  echo "estado tras investigación: change $(e2e_change_status "$cid")" >&2
  # Gate 2: spec de investigación awaiting -> approve -> implementation
  aid=$(e2e_activity_primer_id "$cid" investigation awaiting)
  [ -n "$aid" ] || { echo "investigación no quedó awaiting" >&2; return 3; }
  echo "gate 2: revisión de especificación $aid" >&2
  fab review "$aid" approve >/dev/null || return 4
  echo "== implementación" >&2
  fab run "$1" --once >/dev/null 2>&1 || true
  echo "estado final: change $(e2e_change_status "$cid")" >&2
  echo "$cid"
}
