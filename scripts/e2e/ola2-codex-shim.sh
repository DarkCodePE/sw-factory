#!/bin/sh
# Shim `codex` para la prueba F3 (scripts/e2e/ola2-f3-precommit.sh).
#
# El adaptador codex (src/agents.ts) compila `codex exec --sandbox
# <read-only|workspace-write> --skip-git-repo-check <prompt>` y declara
# factoryCommits: la fábrica commitea lo que el agente deja en el worktree.
# Este shim simula ese agente: en modo workspace-write (implementación) escribe
# un archivo en su cwd y termina con STATUS: done; en read-only (investigación)
# no escribe nada. No toca .git: los commits los hace fab.
#
# Forma de la llamada: codex exec --sandbox <modo> --skip-git-repo-check <prompt>
LOG="${FAB2_LOG:-}"
e2e_log() { [ -n "$LOG" ] && printf '%s\t%s\n' "$1" "$*" >> "$LOG"; }
e2e_log START "$*"

mode="${3:-read-only}"
prompt="${5:-}"

if [ "$mode" = "workspace-write" ] && [ -n "$prompt" ]; then
  if printf 'implementación F3 en %s\n' "$PWD" > "$PWD/impl-f3.txt" 2>/dev/null; then
    e2e_log TOUCH_OK "$PWD/impl-f3.txt"
    echo "STATUS: done"
    printf '\nF3: implementación aplicada en %s\n' "$PWD"
    exit 0
  fi
  e2e_log TOUCH_FAIL "$PWD/impl-f3.txt"
fi
echo "STATUS: done"
printf '\nF3: Investigación completada; trabajo como agente codex simulado.\n'
