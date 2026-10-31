#!/bin/sh
# Shim `sh` para las pruebas E2E con el agente fake de fab.
#
# El adaptador fake (src/agents.ts) ejecuta `sh -c 'printf "STATUS: %s..." fake <prompt80>'`.
# Este shim se instala primero en el PATH de la fábrica y:
#   1) se identifica: la llamada fake de fab llega como `$1=-c $2=<script-printf> $3=fake $4=<prompt80>`;
#   2) en corrida de validador (el prompt recortado contiene "validation agent"), en vez del
#      passthrough produce un reporte controlado:
#          STATUS: done
#          VERDICT: <FAB_SHIM_VERDICT, por defecto pass>
#          <resumen>
#      Con FAB_SHIM_DIRTY=1 además escribe (y borra al final) archivos en su cwd —el worktree
#      del change— para reproducir un validador que deja cambios sin commitear (prueba H2),
#      con un retardo FAB_SHIM_TAIL entre la primera y la segunda escritura, para poder medir
#      escrituras que ocurren después de `fab reject` (D7).
#   3) cualquier otra llamada se delega literalmente a /bin/sh "$@" (investigación e
#      implementación del fake quedan idénticas al adaptador real); FAB_SHIM_DELAY añade retardo
#      (fake lento, para las carreras multiproceso).
#   4) siempre anota START/END/touches (ts_ms, evento, pid, cwd) en FAB_SHIM_LOG para las
#      medidas de carreras (dos escritores sobre el mismo worktree).
#
# Entorno:
#   FAB_SHIM_LOG     archivo TSV de eventos
#   FAB_SHIM_DELAY   retardo (s) antes de ejecutar lo que sea
#   FAB_SHIM_RAW     1 => ni siquiera en validadores: passthrough fiel del fake
#                    (reporte sin VERDICT, como el adaptador real)
#   FAB_SHIM_VERDICT pass|fail|needs_human (solo en llamadas de validador)
#   FAB_SHIM_DIRTY   1 => escribe archivos en el cwd (validador sucio)
#   FAB_SHIM_TAIL    retardo (s) entre touch inicial y el segundo (default 1)
#   FAB_SHIM_KEEP    1 => no borra los archivos tocados (H2: worktree sucio al final)

LOG="${FAB_SHIM_LOG:-}"
e2e_log() { # $1 tag  $2 nota extra opcional
  [ -n "$LOG" ] && printf '%s\t%s\t%s\t%s\t%s\n' "$(date +%s%3N)" "$1" "$$" "$(pwd)" "${2:-}" >> "$LOG"
}
e2e_log START "argc=$*"

[ -n "$FAB_SHIM_DELAY" ] && sleep "$FAB_SHIM_DELAY"

FAKE_SCRIPT='printf "STATUS: %s\n\nfake agent handled: %s\n" "${FABRICA_FAKE_STATUS:-done}" "$1"'
if [ "$1" = "-c" ] && [ "$2" = "$FAKE_SCRIPT" ] && [ -n "$4" ]; then
  case "$4" in
    *"validation agent"*)
      # Corrida de validador con el fake de fab: emitimos el reporte controlado
      # (o passthrough fiel con FAB_SHIM_RAW=1).
      if [ "${FAB_SHIM_RAW:-0}" = "1" ]; then
        exec /bin/sh "$@"
      fi
      e2e_log VREPORT "verdict=${FAB_SHIM_VERDICT:-pass} dirty=${FAB_SHIM_DIRTY:-0}"
      echo "STATUS: ${FABRICA_FAKE_STATUS:-done}"
      echo
      echo "VERDICT: ${FAB_SHIM_VERDICT:-pass}"
      echo "Reporte fake del validador (shim e2e): sin hallazgos."

      if [ "$FAB_SHIM_DIRTY" = "1" ]; then
        f1="$(pwd)/.e2e-shim-$$"
        if touch "$f1" 2>/dev/null; then e2e_log TOUCH_OK "$f1"; else e2e_log TOUCH_FAIL "$f1"; fi
        sleep "${FAB_SHIM_TAIL:-1}"
        f2="$(pwd)/.e2e-shim-end-$$"
        if touch "$f2" 2>/dev/null; then e2e_log TOUCH_OK "$f2"; else e2e_log TOUCH_FAIL "$f2"; fi
        [ "$FAB_SHIM_KEEP" = "1" ] || rm -f "$f1" "$f2" 2>/dev/null
      fi
      e2e_log END "validator"
      exit 0
      ;;
    *)
      # Prompt de investigación/implementación del fake: passthrough fiel.
      exec /bin/sh "$@"
      ;;
  esac
fi

exec /bin/sh "$@"
