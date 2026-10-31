#!/bin/bash
# Carreras multiproceso (línea base para la ficha 07 de la ola 1, defectos D6/D7).
# tarea: doc/research/tasks/task-ola0-e2e-opencode.md §3.
#
# Lanza dos `fab run <ws>` en paralelo sobre el MISMO store (mismo FABRICA_HOME)
# con un fake lento (shim con FAB_SHIM_DELAY) y varios changes, y mide n=10 veces:
#   a) activities reclamadas dos veces (claims repetidos con workers distintos)
#      + conflictos de custodia ("is not held by" en los logs de los pools)
#   b) dos escritores en el mismo worktree (solapes de ventanas shim con el mismo cwd)
#   c) escrituras del validador después de `fab reject` con el worktree ya borrado
#   d) `kill -9` de un pool: ¿se reencola?, ¿cuánto tarda (claim tras kill, change listo)?
#
# Uso: bash ola0-races.sh [n]  (n default 10; FAB_SHIM_DELAY/TAIL usan defaults 2s)
# Salida: <E2E_ROOT>/races/resumen.tsv (una fila por corrida) + agregados en pantalla.
# Los fallos esperados (D6/D7) NO abortan el script: se miden.

set -u
. "$(dirname "$0")/ola0-lib.sh"

N="${1:-10}"
DELAY="${FAB_SHIM_DELAY:-2}"
TAIL="${FAB_SHIM_TAIL:-4}"
BASE="$E2E_ROOT/races"
RESUMEN="$BASE/resumen.tsv"
rm -rf "$BASE"
mkdir -p "$BASE"

analizar_run() { # $1 índice  $2 dir de la corrida
  local i="$1" dir="$2"
  local T_REJECT T_KILL AID3 T_DONE requeued rec_ms lat_rec lat_done huert d3 fin3 conflicto
  T_REJECT=$(awk '/^reject=/{ sub(/^reject=/, ""); split($0, v, " "); print v[1] }' "$dir/times.tsv")
  T_KILL=$(awk '/^kill=/{ sub(/^kill=/, ""); split($0, v, " "); print v[1] }' "$dir/times.tsv")
  AID3=$(awk '/^kill=/{ sub(/^kill=/, ""); split($0, v, " "); sub(/^aid=/, "", v[2]); print v[2] }' "$dir/times.tsv")
  T_DONE=$(awk '/^done=/{ sub(/^done=/, ""); split($0, v, " "); print v[1] }' "$dir/times.tsv")

  conflicto=$(cat "$dir"/*.out 2>/dev/null | grep -c 'is not held by' || true)
  [ -n "$conflicto" ] || conflicto=0
  rec_ok=$(awk '/requeued [0-9]+ orphaned activities/ { ok = 1 } END { print ok+0 }' "$dir/c2.out")
  sql_busy=$(cat "$dir"/*.out 2>/dev/null | grep -c 'database is locked' || true)
  [ -n "$sql_busy" ] || sql_busy=0

  {
    printf '%s\t' "$i"

    # (a) activities con claims repetidos de dos workers distintos
    e2e_dump events | awk -F'\t' '
      $6 ~ / claimed by / { split($6, a, " claimed by "); wk = a[2]
        if (visto[$4 SUBSEP wk] != 1) { visto[$4 SUBSEP wk] = 1; nu[$4]++ } }
      END { rep = 0; for (k in nu) if (nu[k] > 1) rep++; printf "%s\t", rep }'
    printf '%s\t' "$conflicto"

    # (b) pares de runs shim con solape temporal en el mismo cwd
    awk -F'\t' '
      $2 == "START"  { if (!($3 in s)) { s[$3] = $1; c[$3] = $4 } ; if (!($3 in kk)) kk[$3] = "worker" }
      $2 == "VREPORT" { kk[$3] = "validator" }
      $2 == "END"    { if ($1 > e[$3]) e[$3] = $1 }
      END {
        for (p in s) { if (!(p in e)) e[p] = s[p] }
        n = 0; pvv = 0; pmx = 0
        for (a in s) for (b in s) {
          if (a >= b || c[a] != c[b]) continue
          if (s[a] <= e[b] && s[b] <= e[a]) {
            n++
            printf "par pid=%s kind=%s pid=%s kind=%s cwd=%s\n", a, kk[a], b, kk[b], c[a] >> FILE2
            if (kk[a] == "validator" && kk[b] == "validator") pvv++; else pmx++
          }
        }
        printf "%s\t%s\t", n, pvv
      }' FILE2="$dir/pares.txt" "$dir/shim.log" 2>/dev/null
    [ -s "$dir/pares.txt" ] || : > "$dir/pares.txt"

    # (c) intentos de escritura del validador después del reject (TOUCH_* post T_REJECT)
    awk -F'\t' -v rej="$T_REJECT" '
      $2 == "TOUCH_OK" || $2 == "TOUCH_FAIL" { if ($1+0 > rej+0) { n++ ; if ($2 == "TOUCH_OK") ok++ } }
      END { printf "%s\t%s\t", ok+0, n+0 }' "$dir/shim.log"

    # (d7) validadores cuya 'completed' llega después del fab reject (actividad sigue viva tras cancelar el change)
    e2e_dump events | awk -F'\t' -v rej="$T_REJECT" '$6 ~ /validator .* completed:/ && $7+0 > rej+0 { n++ } END { printf "%s\t", n+0 }'

    # (d) kill -9: requeue del pool de recuperación y latencias
    requeued=$(awk '/requeued [0-9]+ orphaned activities/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) { print $i; exit } }' "$dir/c2.out")
    requeued="${requeued:-0}"
    rec_ms=$(e2e_dump events | awk -F'\t' -v aid="$AID3" -v kill="$T_KILL" '$4 == aid && $6 ~ /claimed by/ && $7 > kill { print $7; exit }')
    lat_rec=$(( ${rec_ms:-${T_KILL:-0}} - ${T_KILL:-0} ))
    lat_done=$(( ${T_DONE:-0} - ${T_KILL:-0} ))
    me_huerto=$(awk -F= '/^huérfano=/{print $2}' "$dir/times.tsv")
    d3stat=$(e2e_dump activities | awk -F'\t' -v aid="$AID3" 'NR > 1 && $1 == aid { print $6 }')
    rq_deliberado=$(awk '/requeued [0-9]+ orphaned activities/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) { print $i; exit } }' "$dir/b2.out")
    rq_deliberado="${rq_deliberado:-0}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$rq_deliberado" "$requeued" "$lat_rec" "$lat_done" "$rec_ok" "$d3stat" "$me_huerto" "$sql_busy"
  } >> "$RESUMEN"
}

corre_run() { # $1 = índice de corrida (1..N)
  local i="$1"
  local dir repo slug cid1 cid2 cid3 s3 p1 p2 p3 p4 p5 aid3 st
  dir="$BASE/run-$i"
  mkdir -p "$dir/shimdir"
  repo="$(e2e_repro_repo "$dir/repo")" || return 1
  E2E_HOME="$dir/home"
  E2E_SHIM_DIR="$dir/shimdir"
  e2e_install_shim "$E2E_SHIM_DIR" >/dev/null
  FAB_SHIM_LOG="$dir/shim.log"
  FAB_SHIM_DELAY="$DELAY"
  FAB_SHIM_TAIL="$TAIL"
  FAB_SHIM_DIRTY=1      # los validadores escriben (y limpian al salir): ventana para medir post-reject
  FAB_SHIM_KEEP=
  FAB_SHIM_VERDICT=pass
  FAB_SHIM_RAW=
  export E2E_HOME E2E_SHIM_DIR FAB_SHIM_LOG FAB_SHIM_DELAY FAB_SHIM_TAIL FAB_SHIM_DIRTY FAB_SHIM_KEEP FAB_SHIM_VERDICT FAB_SHIM_RAW

  slug="race-$i"
  echo "=== corrida $i === fake lento (${DELAY}s), dos pools paralelos" >&2
  fab ws create "$slug" --repo "$repo" --goal "instrumento de carreras n=$i" --agent fake --concurrency 2 --no-change-approval --no-spec-approval >/dev/null || return 1
  fab ws state "$slug" active >/dev/null || return 1
  cid1=$(e2e_signal_change "$slug" "carreras señal 1") || return 1
  cid2=$(e2e_signal_change "$slug" "carreras señal 2") || return 1
  s3=$(fab signal add "$slug" "carreras señal 3 (kill)" | awk '{print $2}')

  # --- fase A: dos `fab run` simultáneos sobre el mismo store (2 changes pendientes)
  fab run "$slug" --once >"$dir/a1.out" 2>&1 & p1=$!
  fab run "$slug" --once >"$dir/a2.out" 2>&1 & p2=$!
  wait "$p1" || true
  wait "$p2" || true
  # Los carreras pueden dejar la cadena de un change en rematch (crash SQLITE_BUSY,
  # reencolado de huérfanos…) o hacia implemented; esperar ambos antes de fase B.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28; do
    s1=$(e2e_change_status "$cid1"); s2=$(e2e_change_status "$cid2")
    [ "$s1" = "implemented" ] && [ "$s2" = "implemented" ] && break
    fab run "$slug" --once >/dev/null 2>&1 || true
    sleep 0.5
  done
  echo "faseA cid1=$(e2e_change_status "$cid1") cid2=$(e2e_change_status "$cid2")" >> "$dir/times.tsv"

  # --- fase B: dos validadores del change 1 en paralelo + `fab reject` en caliente (D6+D7)
  fab validate "$cid1" --only code_review,security_audit >/dev/null || true
  fab run "$slug" --once >"$dir/b1.out" 2>&1 & p3=$!
  sleep 0.6   # el segundo pool arranca mientras el primero ya tiene el validador 1 en curso
  fab run "$slug" --once >"$dir/b2.out" 2>&1 & p4=$!
  sleep 2.4   # ventana: shim ya escribió su primer archivo (post-touch) y está en el tail
  t_reject=$(e2e_now_ms)
  fab reject "$cid1" >"$dir/reject.out" 2>&1 || true
  wait "$p3" || true
  wait "$p4" || true
  echo "reject=$t_reject" > "$dir/times.tsv"

  # --- fase C: `kill -9` de un pool con la investigación del change 3 en curso
  out=$(fab triage "$s3" 2>&1) || { echo "fallo triage señal 3: $out" >&2; return 1; }
  cid3=$(printf '%s' "$out" | awk -F'change ' '{print $2}' | cut -d' ' -f1)
  [ -n "$cid3" ] || { echo "fallo leyendo cid3: $out" >&2; return 1; }
  fab run "$slug" --once >"$dir/c1.out" 2>&1 & p5=$!
  aid3=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
    aid3=$(e2e_dump activities | awk -F'\t' -v c="$cid3" 'NR > 1 && index($3, c) == 1 && $4 == "investigation" && $6 == "in_progress" { print $1; exit }')
    [ -n "$aid3" ] && break
    sleep 0.25
  done
  t_kill=$(e2e_now_ms)
  kill -9 "$p5" 2>/dev/null || true
  echo "kill=$t_kill aid=$aid3" >> "$dir/times.tsv"
  sleep 0.5
  # ¿la activity quedó in_progress tras el kill? (solo un pool nuevo puede reencolarla)
  huert=$(e2e_dump activities | awk -F'\t' -v a="$aid3" 'NR > 1 && $1 == a { if ($6 == "in_progress") print "si"; else print "no"; exit }')
  echo "huérfano=$huert" >> "$dir/times.tsv"

  # --- fase C2: reencolado con un pool nuevo; medir latencia de claim y de change listo
  fab run "$slug" --once >"$dir/c2.out" 2>&1 || true
  t_done=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28; do
    st=$(e2e_change_status "$cid3")
    if [ "$st" = "implemented" ] || [ "$st" = "completed" ]; then t_done=$(e2e_now_ms); break; fi
    sleep 0.25
  done
  [ -n "$t_done" ] || t_done=$(e2e_now_ms)
  echo "done=$t_done" >> "$dir/times.tsv"

  analizar_run "$i" "$dir"
}

printf 'run\tclaims_repetidas\tconflicto_custodia\tpares_same_wt\tpares_validator_wt\ttouch_reject_ok\ttouch_reject_intentos\tvalidador_completa_post_reject\trequeue_deliberado\trequeue_tras_kill\tlatency_claim_ms\tlatency_change_ms\trecuperado_tras_kill\testado_actividad3\thuérfano_detectado\tsql_busy_crash\n' > "$RESUMEN"
for i in $(seq 1 "$N"); do
  corre_run "$i" || echo "corrida $i: FALLO inicial" >&2
done

echo
echo "=== resumen n=$N ==="
if command -v column >/dev/null 2>&1; then
  column -t -s "$(printf '\t')" "$RESUMEN"
else
  cat "$RESUMEN"
fi
awk -F'\t' 'NR > 1 {
  for (z = 2; z <= NF; z++) {
    if ($z == "" || $z !~ /^[0-9.-]+$/) continue
    n[z]++
    v = $z + 0
    if (!(z in minimo) || (minimo[z] > v)) minimo[z] = v
    if (!(z in maximo) || (maximo[z] < v)) maximo[z] = v
    suma[z] += v
  }
}
END {
  print "=== min/media/máx por columna numérica ==="
  for (z = 2; z <= 24; z++) {
    if (n[z] == 0) continue
    printf "col%d: n=%d min=%s media=%.1f máx=%s\n", z, n[z], minimo[z], suma[z]/n[z], maximo[z]
  }
}' "$RESUMEN"

# detalle adicional para el reporte:
echo "recuento de pares por corrida (detalle): $BASE/run-*/pares.txt"
exit 0
