#!/bin/bash
# T74g, fase 1: camino completo con runner remoto (ssh falso → `fab runner serve` local) y agente fake.
# workstream con runner, pool de un disparo, bundle de ida, agente confinado en el runner, sellado, vuelta, import,
# gates y validador en casa. Uso: run-fake.sh [dir-temporal]
# CUT=1: además corta la conexión a mitad de la implementación (SIGHUP al serve y muerte del ssh) y comprueba el reintento.
. "$(dirname "$0")/lib.sh"
# REAL=1: agente `claude` real. El «runner» es esta misma máquina: su credencial es la propia (D10/P1), que el sandbox monta
# en solo lectura; el script nunca la lee. Sin shim: ni `sh` falso ni canarios (una ANTHROPIC_API_KEY falsa rompería la autenticación).
if [ -n "${REAL:-}" ]; then T74G_RPATH_EXTRA="$HOME/.local/bin"; T74G_RHOME_REAL="$HOME"; AGENT=claude; else AGENT=fake; fi
t74g_setup "${1:-${TMPDIR:-/tmp}/t74g-fake}" "${T74G_RHOME_REAL:-}"
FILE=RUNNER_E2E.txt; [ -n "${REAL:-}" ] && FILE=HOLA.txt
FAIL=0; ok() { echo "OK    $*"; }; bad() { echo "FALLO $*"; FAIL=1; }
t74g_repo "$T74G_DIR/repo"
if [ -n "${CUT:-}" ]; then touch "$T74G_DIR/repo/PAUSE"; git -C "$T74G_DIR/repo" -c user.name=e -c user.email=e@l add -A; git -C "$T74G_DIR/repo" -c user.name=e -c user.email=e@l commit -qm pause; fi
# Canarios en casa (A1): no deben aparecer en la sesión, en ps ni en el entorno del agente del runner.
[ -n "${REAL:-}" ] || export ANTHROPIC_API_KEY=CANARIO-API-91ac GH_TOKEN=CANARIO-GH-77be OPENAI_API_KEY=CANARIO-OAI-33d0
( while :; do ps -eo args >> "$T74G_DIR/log/ps.txt"; sleep 0.05; done ) & SAMPLER=$!
fab ws create demo --repo "$T74G_DIR/repo" --goal "demo runner remoto" --agent $AGENT --verify "grep -q hola $FILE" >/dev/null || exit 3
fab runner add torre --ssh torre | tee "$T74G_DIR/log/add.txt"
fab ws runner demo torre; fab ws state demo active >/dev/null
fab runner check torre && ok "runner check" || bad "runner check"
out=$(fab signal add demo "Crea el fichero $FILE en la raíz del repositorio con la palabra hola. Nada más." --body "Un solo fichero nuevo, sin tocar otros. Sé breve."); sid=$(echo "$out" | awk '{print $2}')
cid=$(fab triage "$sid" | awk -F'change ' '{print $2}' | cut -d' ' -f1); echo "change $cid"
aid=$(t74g_db "select id from activities where kind='change_review' and review_status='awaiting' and change_id like '$cid%'")
fab review "$aid" approve >/dev/null
fab run demo --once >/dev/null 2>"$T74G_DIR/log/run1.err"; echo "tras investigación: $(t74g_db "select status from changes where id like '$cid%'")"
aid=$(t74g_db "select id from activities where kind='investigation' and review_status='awaiting' and change_id like '$cid%'")
fab review "$aid" approve >/dev/null
if [ -n "${CUT:-}" ]; then
  ( # espera a que el agente del runner esté escribiendo en su clon (2.º encargo: el de la implementación) y corta
    until ls "$T74G_DIR"/root/jobs/*/repo/RUNNER_E2E.txt >/dev/null 2>&1 && [ "$(wc -l < "$T74G_DIR/log/ssh-argv")" -ge 3 ]; do sleep 0.05; done
    echo "corte: $(ls "$T74G_DIR/root/jobs")" > "$T74G_DIR/log/cut.txt"
    kill -HUP $(pgrep -f "runner serve --root $T74G_DIR/root"); kill -9 $(pgrep -f "^/bin/sh $T74G_DIR/bin/ssh") 2>/dev/null;
  ) & CUTTER=$!
fi
fab run demo --once >/dev/null 2>"$T74G_DIR/log/run2.err"
[ -n "${CUT:-}" ] && { wait $CUTTER; fab run demo --once >/dev/null 2>>"$T74G_DIR/log/run2.err"; }
echo "--- actividades"; t74g_db -header "select kind,validator,status,review_status,runner,retry_count,substr(error,1,60) e from activities order by created_at"
echo "--- eventos"; fab events demo | tail -20
fab validate "$cid" --only code_review >/dev/null; fab run demo --once >/dev/null 2>"$T74G_DIR/log/run3.err"
fab validate status "$cid"
branch=$(t74g_db "select branch from changes where id like '$cid%'")
git -C "$T74G_DIR/repo" log --oneline "$branch" | head -3
git -C "$T74G_DIR/repo" show "$branch:$FILE" 2>/dev/null | grep -q hola && ok "la rama del change lleva el fichero importado" || bad "sin fichero importado"
[ "$(git -C "$T74G_DIR/repo" rev-list --count main.."$branch")" = 1 ] && ok "un solo commit del runner" || bad "n.º de commits"
for k in implementation investigation; do
  r=$(t74g_db "select runner from activities where kind='$k' and status='completed'"); [ "$r" = torre ] && ok "$k: activities.runner=torre" || bad "$k runner=[$r]"
done
[ -z "$(t74g_db "select runner from activities where kind='gates'")" ] && ok "gates sin runner (corren en casa)" || bad "gates con runner"
n=$(wc -l < "$T74G_DIR/log/ssh-argv"); echo "sesiones ssh: $n"
for o in BatchMode=yes StrictHostKeyChecking=yes ClearAllForwardings=yes ServerAliveInterval=15; do grep -q "$o" "$T74G_DIR/log/ssh-argv" && ok "argv ssh: $o" || bad "argv ssh sin $o"; done
ls "$T74G_DIR/root/jobs" | grep -v '^\.lock' | wc -l | xargs -I{} echo "directorios de encargo en el runner: {}"
pgrep -af "$T74G_DIR/root" | grep -v shell-snapshots | grep -q . && bad "quedan procesos serve" || ok "sin procesos serve ni agentes (bwrap/sleep) en el runner"
kill $SAMPLER 2>/dev/null
echo "muestras de ps: $(grep -c . "$T74G_DIR/log/ps.txt") líneas"
grep -a -v shell-snapshots "$T74G_DIR/log/ps.txt" | grep -a -q CANARIO && bad "canario en ps" || ok "ps (casa y runner, misma máquina) sin canarios"
cat "$T74G_DIR"/log/session-in.* | grep -a -q CANARIO && bad "canario en la sesión" || ok "captura de la sesión ($(cat "$T74G_DIR"/log/session-in.* | wc -c) bytes) sin canarios"
[ -n "${REAL:-}" ] && { PAT='sk-ant-|accessToken|refreshToken|CLAUDE_CODE_OAUTH|ANTHROPIC_API_KEY=|Bearer '
  grep -a -v shell-snapshots "$T74G_DIR/log/ps.txt" | grep -a -q -E "$PAT" && bad "patrón de credencial en ps" || ok "ps sin patrones de credencial"
  cat "$T74G_DIR"/log/session-in.* | grep -a -q -E "$PAT" && bad "patrón de credencial en la sesión" || ok "sesión sin patrones de credencial"
  git -C "$T74G_DIR/repo" log --oneline "$branch" | head -3; exit $FAIL; }
git -C "$T74G_DIR/repo" show "$branch:RUNNER_ENV.txt" > "$T74G_DIR/log/agent-env.txt"
grep -q CANARIO "$T74G_DIR/log/agent-env.txt" && bad "canario en el entorno del agente" || ok "entorno del agente confinado sin canarios ($(wc -l < "$T74G_DIR/log/agent-env.txt") variables)"
exit $FAIL
