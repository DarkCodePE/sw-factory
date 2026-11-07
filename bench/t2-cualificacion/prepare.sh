#!/usr/bin/env bash
# Genera la suite T2 (100 tareas, 10 grupos) en <destino>. La red solo se usa al clonar.
# Con T2_UPSTREAM=<dir> reutiliza clones ya fijados a su commit (no usa red).
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Uso: $0 <destino>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
python3 -I "$SCRIPT_DIR/corpus.py" preparar "$1"
