#!/usr/bin/env bash
# Script de medición para la ola 3 (Ficha 01: Verificación determinista vs QA LLM)
# Uso: scripts/e2e/ola3-bench.sh <cli_dir> <modo> [filtro]
#
# <cli_dir>: ruta absoluta o relativa al repo bajo prueba (con src/cli.ts)
# <modo>:    'baseline' (sin gates) o 'gates' (con --verify)
# [filtro]:  'all' (por defecto), 'pilot' (2 casos de prueba), o un caso individual (ej. tc-bug-01)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ $# -lt 2 ]; then
  echo "Uso: $0 <cli_dir> <modo> [filtro]"
  echo "  cli_dir: directorio del repo fab (ej: $REPO_ROOT)"
  echo "  modo:    baseline | gates"
  echo "  filtro:  all (defecto) | pilot (2 casos) | <id_caso>"
  exit 1
fi

CLI_DIR="$(cd "$1" && pwd)"
MODO="$2"
FILTRO="${3:-all}"

export E2E_ROOT="${E2E_ROOT:-$HOME/.cache/fab-ola3-bench}"
mkdir -p "$E2E_ROOT"

bun "$SCRIPT_DIR/ola3-bench.ts" "$CLI_DIR" "$MODO" "$FILTRO"

