#!/bin/bash
# Prueba F3 (docs/research/tasks/task-ola2-opencode.md, D5/C8): la implementación
# deja un archivo y el pool hace el commit de fábrica, en un repo del change con
# core.hooksPath malicioso con pre-commit.
#
# Contexto: en 29d4dd3 los `git` de src/worktrees.ts no llevaban
# `-c core.hooksPath=/dev/null`; el commit de fábrica (commitWorktree) ejecutaba
# el pre-commit del repo del change. La ola 0 (f9ab813) añade los GIT_SAFE_FLAGS
# y D5 lo reparó; F3 lo prueba con un commit real (el fake no commitea, pero el
# adaptador codex declara factoryCommits).
#
# Uso: bash ola2-f3-precommit.sh [ola2|base|both]      (default both)
#   ola2 = este worktree (HEAD de la rama fab/research-ola2-opencode)
#   base = fab 29d4dd3 (main previo) via `git worktree add` en /tmp
#
# Criterio: en ola2 -> 0 marcadores del pre-commit y commit de fábrica en la
# rama; en base 29d4dd3 -> el marcador del pre-commit aparece.

set -u
. "$(dirname "$0")/ola2-lib.sh"

TARGETS="${1:-both}"
FALLOS=0

instalar_precommit() { # $1 repo del change  $2 dir de la corrida
  mkdir -p "$2/hooks" "$2/markers"
  cat > "$2/hooks/pre-commit" <<EOF
#!/bin/sh
echo "pre-commit pid=\$\$ ts=\$(date +%s)" >> "$2/markers/pre-commit"
EOF
  chmod +x "$2/hooks/pre-commit"
  git -C "$1" config core.hooksPath "$2/hooks"
}

corre_f3() { # $1 target (ola2|base)
  local target="$1"
  local dir repo slug cid branch archivos_fab markers estado
  dir="$E2E_ROOT/f3-$target"
  rm -rf "$dir"
  mkdir -p "$dir/shimdir"
  repo="$(e2e_repro_repo "$dir/repo")" || return 1
  E2E_HOME="$dir/home"
  E2E_SHIM_DIR="$dir/shimdir"
  e2e_install_codex_shim "$E2E_SHIM_DIR" >/dev/null
  FAB2_LOG="$dir/shim.log"
  export E2E_HOME E2E_SHIM_DIR FAB2_LOG

  echo "=== F3/$target === repo del change con pre-commit malicioso: $repo"
  instalar_precommit "$repo" "$dir"
  slug="f3-$target"

  printf '=== F3/%s === ciclo fab con adaptador codex\n' "$target"
  fab ws create "$slug" --repo "$repo" --goal "prueba F3: commit de fábrica sin ejecutar el pre-commit malicioso" \
      --agent codex --no-change-approval --no-spec-approval >/dev/null || { e2e_marca_fallo "F3/$target" 'ws create falló'; FALLOS=$((FALLOS+1)); return 1; }
  fab ws state "$slug" active >/dev/null || return 1
  out=$(fab signal add "$slug" "señal F3") || { e2e_marca_fallo "F3/$target" 'signal add falló'; FALLOS=$((FALLOS+1)); return 1; }
  sid=$(printf '%s' "$out" | awk '{print $2}')
  out=$(fab triage "$sid") || { e2e_marca_fallo "F3/$target" 'triage falló'; FALLOS=$((FALLOS+1)); return 1; }
  cid=$(printf '%s' "$out" | awk -F'change ' '{print $2}' | cut -d' ' -f1)
  [ -n "$cid" ] || { e2e_marca_fallo "F3/$target" 'no se pudo leer el change id'; FALLOS=$((FALLOS+1)); return 1; }

  # Investigación (read-only) + implementación (workspace-write) en un solo ciclo.
  if ! fab run "$slug" --once >/dev/null 2>&1; then
    e2e_marca_fallo "F3/$target" 'fab run falló'
    FALLOS=$((FALLOS+1)); return 1
  fi
  estado=$(fab status "$slug" 2>/dev/null | head -1)
  echo "--- estado: $estado"

  branch="fab/${cid:0:8}"
  archivos_fab=$(git -C "$repo" log --format='%an %s' "$branch" 2>/dev/null | grep -c '^fab ' || true)
  echo "--- commits de fábrica en $branch: $archivos_fab"

  markers=$(cat "$dir/markers"/* 2>/dev/null | wc -l)
  echo "--- marcadores por hook: pre-commit=$( [ -f "$dir/markers/pre-commit" ] && cat "$dir/markers/pre-commit" | wc -l || echo 0)" || true
  if ! [ -n "$markers" ]; then markers=0; fi
  echo "--- marcadores totales: $markers"

  if [ "$target" = "ola2" ]; then
    if [ "$markers" -eq 0 ] && [ "$archivos_fab" -ge 1 ]; then
      echo "RESULTADO F3/$target: OK — la fábrica commitea sin ejecutar el pre-commit malicioso"
    else
      echo "RESULTADO F3/$target: FALLO — marcadores=$markers commits_de_fabrica=$archivos_fab"
      FALLOS=$((FALLOS+1))
    fi
  else
    if [ "$markers" -gt 0 ]; then
      echo "RESULTADO F3/$target: OK(repro) — el commit de fábrica de 29d4dd3 ejecutó el pre-commit"
    else
      echo "RESULTADO F3/$target: FALLO — no se reprodujo el defecto en 29d4dd3 (marcadores=0)"
      FALLOS=$((FALLOS+1))
    fi
  fi
  printf 'F3\ttarget=%s\tmarcadores=%s\tcommits_fabrica=%s\n' "$target" "$markers" "$archivos_fab" >> "$E2E_ROOT/ola2-e2e-resultados.tsv"
}

corre_f3_todos() {
  if [ "$TARGETS" = ola2 ] || [ "$TARGETS" = both ]; then
    corre_f3 ola2
  fi
  if [ "$TARGETS" = base ] || [ "$TARGETS" = both ]; then
    base_dir="$(e2e_armar_base)"
    [ -n "$base_dir" ] || { echo "no se pudo montar la base 29d4dd3"; exit 1; }
    E2E_CLI_DIR="$base_dir"
    corre_f3 base
    E2E_CLI_DIR="$E2E_REPO"
  fi
  echo
  echo "resumen F3: fallos=$FALLOS"
  exit $(( FALLOS > 0 ? 1 : 0 ))
}

corre_f3_todos
