#!/bin/bash
# Prueba H2 (doc/research/tasks/task-ola0-e2e-opencode.md): un validador que no sea
# qa que deja cambios sin commitear en el worktree debe fallar la activity con
# "«<validador>» dejó cambios en el worktree".
#
# Contexto: el chequeo `git status --porcelain` del pool solo miraba `a.validator === 'qa'`
# (src/pool.ts en 29d4dd3); el fix de la ola 0 (d43b031) lo ejecuta después de **todo**
# validador. El shim E2E escribe archivos en el worktree y devuelve un VERDICT válido,
# llegando justo al chequeo porcelain.
#
# Uso: bash ola0-h2-dirty-validator.sh [ola0|base|both]   (default both)
#   VALIDATOR=code_review|security_audit|qa (default code_review, ≠ qa)
# Criterio: en ola0 -> la activity del validador queda failed con el mensaje esperado
#           (3 reintentos); en base -> la misma corrida termina completed approved con
#           el worktree sucio (defecto reproducible).

set -u
. "$(dirname "$0")/ola0-lib.sh"

TARGETS="${1:-both}"
VALIDATOR="${VALIDATOR:-code_review}"
FALLOS=0

corre_h2() { # $1 target
  local target="$1"
  local dir repo home slug cid msg_esp estado_wt Events dirty_file errfila
  dir="$E2E_ROOT/h2-$target"
  rm -rf "$dir"
  mkdir -p "$dir/shimdir"
  repo="$(e2e_repro_repo "$dir/repo")" || return 1
  E2E_HOME="$dir/home"
  E2E_SHIM_DIR="$dir/shimdir"
  e2e_install_shim "$E2E_SHIM_DIR" >/dev/null
  FAB_SHIM_LOG="$dir/shim.log"
  FAB_SHIM_DELAY="${FAB_SHIM_DELAY:-1}"
  FAB_SHIM_VERDICT=pass
  FAB_SHIM_DIRTY=1        # el validador escribe en el worktree
  FAB_SHIM_KEEP=1         # y lo deja sin commitear (clave del H2)
  FAB_SHIM_TAIL="${FAB_SHIM_TAIL:-1}"
  FAB_SHIM_RAW=
  export E2E_HOME E2E_SHIM_DIR FAB_SHIM_LOG FAB_SHIM_DELAY FAB_SHIM_VERDICT FAB_SHIM_DIRTY FAB_SHIM_KEEP FAB_SHIM_TAIL FAB_SHIM_RAW

  echo "=== H2/$target === ciclo fab (fake) hasta implemented, validador=$VALIDATOR"
  cid="$(e2e_ciclo_implementado "h2-$target" "$repo" "instrumento H2 con validador sucio" "señal e2e H2 para toy-calc")" || {
    echo "RESULTADO H2/$target: FALLO — el ciclo no llegó a implemented"
    FALLOS=$((FALLOS+1)); return 1
  }
  slug="h2-$target"
  fab validate "$cid" --only "$VALIDATOR" || { FALLOS=$((FALLOS+1)); return 1; }
  fab run "$slug" --once >/dev/null 2>&1 || true
  # Si la activity falló con reintento permanece pendiente un rato; un segundo pase la
  # agota hasta failed (hasta MAX_ACTIVITY_RETRIES=3).
  for _ in 1 2; do fab run "$slug" --once >/dev/null 2>&1 || true; sleep 0.5; done
  echo "--- resumen de validación:"
  fab validate status "$cid" || true

  msg_esp="$VALIDATOR dejó cambios en el worktree"
  errfila=$(e2e_validator_ultimo "$cid" "$VALIDATOR")
  echo "--- última activity de $VALIDATOR: $errfila"
  eventos=$(e2e_eventos_con "$msg_esp" | wc -l)
  estado_wt=$(find "$dir/home/worktrees" -name '.e2e-shim-*' 2>/dev/null | wc -l)

  if [ "$target" = "ola0" ]; then
    if echo "$errfila" | awk -F'\t' -v m="$msg_esp" '$1 == "failed" && index($3, m) > 0' | grep -q . ; then
      echo "RESULTADO H2/$target: OK — activity failed con «$msg_esp» (intentos con reintento: $eventos, archivos sucios en worktree: $estado_wt)"
    else
      echo "RESULTADO H2/$target: FALLO — esperaba failed + «$msg_esp»; fila: $errfila; eventos: $eventos"
      FALLOS=$((FALLOS+1))
    fi
  else
    if echo "$errfila" | awk -F'\t' '$1 == "completed" && $2 == "approved"' | grep -q . && [ "$eventos" = "0" ]; then
      echo "RESULTADO H2/$target: OK(repro) — defecto de 29d4dd3: validador completado con worktree sucio ($estado_wt archivos)"
    else
      echo "RESULTADO H2/$target: FALLO — no se reprodujo el defecto (fila: $errfila, eventos dejaCambios=$eventos)"
      FALLOS=$((FALLOS+1))
    fi
  fi
  printf 'H2\ttarget=%s\tvalidador=%s\tultima=%s\teventos_dejoCambios=%s\tarchivos_sucios=%s\n' \
    "$target" "$VALIDATOR" "$errfila" "$eventos" "$estado_wt" >> "$E2E_ROOT/ola0-e2e-resultados.tsv"
}

corre_h2_todos() {
  if [ "$TARGETS" = ola0 ] || [ "$TARGETS" = both ]; then
    corre_h2 ola0
  fi
  if [ "$TARGETS" = base ] || [ "$TARGETS" = both ]; then
    base_dir="$(e2e_armar_base)"
    [ -n "$base_dir" ] || { echo "no se pudo montar la base 29d4dd3"; exit 1; }
    E2E_CLI_DIR="$base_dir"
    corre_h2 base
    E2E_CLI_DIR="$E2E_REPO"
  fi
  echo
  echo "resumen H2: fallos-FALLO = $FALLOS"
  exit $(( FALLOS > 0 ? 1 : 0 ))
}

corre_h2_todos
