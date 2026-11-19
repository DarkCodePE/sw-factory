#!/usr/bin/env bash
# Prueba local del receptor de avisos de GitHub (T69): arranca un residente desechable y le envía con curl
# una entrega firmada (espera 202) y otra con firma inválida (espera 401). Sin red, sin GitHub, sin secretos reales:
# el secreto se genera al vuelo, el `gh` es un falso que devuelve `[]` y la base vive en un directorio temporal.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v openssl >/dev/null && command -v curl >/dev/null || { echo "faltan openssl o curl" >&2; exit 2; }
PORT="${1:-18787}"
TMP="$(mktemp -d)"
trap 'kill "${PID:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
SECRET="$(openssl rand -hex 24)"
mkdir -p "$TMP/bin" && printf '#!/bin/sh\necho "[]"\n' > "$TMP/bin/gh" && chmod +x "$TMP/bin/gh"

FABRICA_HOME="$TMP/state" PATH="$TMP/bin:$PATH" FAB_GITHUB_WEBHOOK_SECRET="$SECRET" \
  bun run fab resident --repo prueba/local --mode observe --hook-port "$PORT" >"$TMP/log" 2>&1 &
PID=$!
for _ in $(seq 50); do grep -q "receptor de avisos" "$TMP/log" 2>/dev/null && break; sleep 0.2; done
grep -q "receptor de avisos" "$TMP/log" || { echo "el receptor no arrancó:" >&2; cat "$TMP/log" >&2; exit 1; }

BODY='{"action":"labeled","repository":{"full_name":"prueba/local"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
post() { # $1 = firma; imprime el código HTTP
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/github" \
    -H "X-GitHub-Event: issues" -H "X-GitHub-Delivery: $(cat /proc/sys/kernel/random/uuid)" \
    -H "X-Hub-Signature-256: $1" -H 'Content-Type: application/json' --data-raw "$BODY"
}
OK="$(post "$SIG")"
BAD="$(post "sha256=$(printf '%064d' 0)")"
echo "entrega válida:   $OK (esperado 202)"
echo "firma inválida:   $BAD (esperado 401)"
[ "$OK" = 202 ] && [ "$BAD" = 401 ] && echo "OK" || { echo "FALLO" >&2; exit 1; }
