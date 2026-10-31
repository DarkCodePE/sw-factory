#!/bin/bash
# Prueba D5 (doc/research/tasks/task-ola0-e2e-opencode.md): hooks maliciosos y
# fsmonitor en el repo del change, y si git llega a ejecutarlos durante un ciclo
# fab completo.
#
# Contexto: en 29d4dd3 src/worktrees.ts ejecutaba todo git sin
# `-c core.hooksPath=/dev/null -c core.fsmonitor=false`; el fix de la ola 0
# (f9ab813) añade los GIT_SAFE_FLAGS. Un worker sin confinar puede configurar
# hooks/fsmonitor en el repo; fab no debería ejecutarlos.
#
# Uso: bash ola0-d5-hooks.sh [ola0|base|both]      (default both)
#   ola0 = este worktree (HEAD 7783845, ola 0 integrada)
#   base = main previo a la ola 0 (29d4dd3) via `git worktree add` en /tmp
#
# Por objetivo corre el ciclo dos veces con el agente fake:
#   variante a: validadores con VERDICT pass (ejercita diff/status con flags seguros)
#   variante b: validador RAW sin VERDICT (agota reintentos; merge bloqueado; --force),
#               replicando el flujo documentado en runs/2026-10-30-ola0/resultado.md
# Criterio: en ola0 -> 0 marcadores; en base -> >0 (post-checkout en `git worktree add`,
# fsmonitor en `git status --porcelain`; pre-commit nunca con fake porque no commitea).

set -u
. "$(dirname "$0")/ola0-lib.sh"

TARGETS="${1:-both}"
FALLOS=0

instalar_hooks() { # $1 repo $2 dir
  cat > "$2/hooks/post-checkout" <<EOF
#!/bin/sh
echo "post-checkout pid=\$\$ ts=\$(date +%s) \$1 \$2" >> "$2/markers/post-checkout"
EOF
  cat > "$2/hooks/pre-commit" <<EOF
#!/bin/sh
echo "pre-commit pid=\$\$ ts=\$(date +%s)" >> "$2/markers/pre-commit"
EOF
  cat > "$2/hooks/fsmonitor" <<EOF
#!/bin/sh
echo "fsmonitor pid=\$\$ ts=\$(date +%s)" >> "$2/markers/fsmonitor"
EOF
  chmod +x "$2/hooks/post-checkout" "$2/hooks/pre-commit" "$2/hooks/fsmonitor"
  git -C "$1" config core.hooksPath "$2/hooks"
  git -C "$1" config core.fsmonitor "$2/hooks/fsmonitor"
}

corre_d5() { # $1 target (ola0|base)  $2 variante (a|b)
  local target="$1" variante="$2"
  local dir repo home slug cid markers estado mensaje_merge
  dir="$E2E_ROOT/d5-$target-$variante"
  rm -rf "$dir"
  mkdir -p "$dir/markers" "$dir/hooks" "$dir/shimdir"
  repo="$(e2e_repro_repo "$dir/repo")" || return 1
  E2E_HOME="$dir/home"
  E2E_SHIM_DIR="$dir/shimdir"
  e2e_install_shim "$E2E_SHIM_DIR" >/dev/null
  FAB_SHIM_LOG="$dir/shim.log"
  FAB_SHIM_DELAY="${FAB_SHIM_DELAY:-1}"
  FAB_SHIM_DIRTY=
  FAB_SHIM_KEEP=
  case "$variante" in
    a) FAB_SHIM_RAW=;  FAB_SHIM_VERDICT=pass ;;
    b) FAB_SHIM_RAW=1; FAB_SHIM_VERDICT= ;;
  esac
  export E2E_HOME E2E_SHIM_DIR FAB_SHIM_LOG FAB_SHIM_DELAY FAB_SHIM_RAW FAB_SHIM_VERDICT FAB_SHIM_DIRTY FAB_SHIM_KEEP

  echo "=== D5/$target/$variante === repo con hooks y fsmonitor maliciosos en $repo"
  instalar_hooks "$repo" "$dir"

  printf '=== D5/%s/%s === ciclo fab (fake)\n' "$target" "$variante"
  cid="$(e2e_ciclo_implementado "d5-$target-$variante" "$repo" "instrumento D5 variante $variante" "señal e2e D5 ($variante) para toy-calc")" || {
    echo "RESULTADO D5/$target/$variante: FALLO — el ciclo no llegó a implemented"
    FALLOS=$((FALLOS+1)); return 1
  }
  echo "change $cid implementado"

  printf '=== D5/%s/%s === validadores y merge\n' "$target" "$variante"
  fab validate "$cid" --only code_review,security_audit,qa >/dev/null || { FALLOS=$((FALLOS+1)); return 1; }
  fab run "d5-$target-$variante" --once >/dev/null 2>&1 || true
  fab validate status "$cid" || true
  if mensaje_merge=$(fab merge "$cid" 2>&1); then
    echo "merge directo (sin bloqueo): $mensaje_merge"
  else
    echo "merge bloqueado: $mensaje_merge"
    if ! fab merge "$cid" --force >/dev/null 2>&1; then
      echo "RESULTADO D5/$target/$variante: FALLO — merge --force falló"
      FALLOS=$((FALLOS+1)); return 1
    fi
  fi
  estado=$(e2e_change_status "$cid")

  markers=$(cat "$dir/markers"/* 2>/dev/null | wc -l)
  echo "--- marcadores por hook:"
  for f in "$dir/markers"/*; do [ -f "$f" ] && echo "  $(basename "$f"): $(cat "$f" | wc -l)"; done
  echo "--- marcadores totales: $markers; change final: $estado"

  if [ "$target" = "ola0" ]; then
    if [ "$markers" = "0" ] && [ "$estado" = "completed" ]; then
      echo "RESULTADO D5/$target/$variante: OK — ningún marcador creado por git"
    else
      echo "RESULTADO D5/$target/$variante: FALLO — marcadores=$markers estado=$estado"
      FALLOS=$((FALLOS+1))
    fi
  else
    if [ "$markers" -gt 0 ]; then
      echo "RESULTADO D5/$target/$variante: OK(repro) — git de 29d4dd3 ejecutó hooks/fsmonitor"
    else
      echo "RESULTADO D5/$target/$variante: FALLO — no se reprodujo el defecto en 29d4dd3"
      FALLOS=$((FALLOS+1))
    fi
  fi
  printf 'D5\ttarget=%s\tvariante=%s\tmarcadores=%s\testado=%s\n' \
    "$target" "$variante" "$markers" "$estado" >> "$E2E_ROOT/ola0-e2e-resultados.tsv"
}

corre_d5_todos() {
  if [ "$TARGETS" = ola0 ] || [ "$TARGETS" = both ]; then
    corre_d5 ola0 a
    corre_d5 ola0 b
  fi
  if [ "$TARGETS" = base ] || [ "$TARGETS" = both ]; then
    base_dir="$(e2e_armar_base)"
    [ -n "$base_dir" ] || { echo "no se pudo montar la base 29d4dd3"; exit 1; }
    E2E_CLI_DIR="$base_dir"
    corre_d5 base a
    corre_d5 base b
    E2E_CLI_DIR="$E2E_REPO"
  fi
  echo
  echo "resumen D5: fallos-FALLO = $FALLOS"
  exit $(( FALLOS > 0 ? 1 : 0 ))
}

corre_d5_todos
