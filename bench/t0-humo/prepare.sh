#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Uso: $0 <destino>" >&2
  exit 1
fi

DEST="$1"

if [ -d "$DEST" ] && [ "$(ls -A "$DEST" 2>/dev/null)" ]; then
  echo "Error: el destino '$DEST' ya existe y no está vacío." >&2
  exit 1
fi

mkdir -p "$DEST"
DEST_ABS="$(cd "$DEST" && pwd -P)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
FACTORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
FIXTURE_SRC="$FACTORY_ROOT/bench/ola3/fixtures/toy-calc"

if [ ! -d "$FIXTURE_SRC" ]; then
  echo "Error: no se encontró el fixture en $FIXTURE_SRC" >&2
  exit 1
fi

# 1. Copiar fixture limpio a <destino>
mkdir -p "$DEST_ABS/tests"
cp "$FIXTURE_SRC/calc.py" "$DEST_ABS/calc.py"
cp "$FIXTURE_SRC/.gitignore" "$DEST_ABS/.gitignore"
cp "$FIXTURE_SRC/pytest.ini" "$DEST_ABS/pytest.ini"
cp "$FIXTURE_SRC/README.md" "$DEST_ABS/README.md"
cp "$FIXTURE_SRC/tests/test_calc.py" "$DEST_ABS/tests/test_calc.py"
chmod 644 "$DEST_ABS/calc.py" "$DEST_ABS/.gitignore" "$DEST_ABS/pytest.ini" "$DEST_ABS/README.md" "$DEST_ABS/tests/test_calc.py"

# 2. Inicializar repo git con commit reproducible
git -C "$DEST_ABS" -c init.defaultBranch=main init -q
git -C "$DEST_ABS" -c core.hooksPath=/dev/null -c core.autocrlf=false add -A

GIT_AUTHOR_NAME="T0 Humo" \
GIT_AUTHOR_EMAIL="t0@factory.local" \
GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" \
GIT_COMMITTER_NAME="T0 Humo" \
GIT_COMMITTER_EMAIL="t0@factory.local" \
GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
git -C "$DEST_ABS" -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm "init: toy-calc base fixture"

BASE_SHA="$(git -C "$DEST_ABS" rev-parse HEAD)"
VERIFY_DIR="$SCRIPT_DIR/verify"

# 3. Generar suite.json dentro de <destino>
python3 -c '
import json, sys
dest_abs, base_sha, verify_dir = sys.argv[1], sys.argv[2], sys.argv[3]
suite = {
  "tasks": [
    {
      "id": "add-subtract",
      "repo": dest_abs,
      "base": base_sha,
      "description": "En calc.py, implementar la función subtract(a, b) que calcule la resta a - b. Añadir docstring explicativo y asegurar que los tests existentes sigan pasando.",
      "verify": f"bash -c \x27cp {verify_dir}/add-subtract.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
      "split": "development"
    },
    {
      "id": "add-power",
      "repo": dest_abs,
      "base": base_sha,
      "description": "En calc.py, implementar la función power(base, exponent) que calcule base ** exponent. Si exponent es negativo, debe lanzar ValueError con mensaje \"negative exponent not supported\". Documentarla con docstring.",
      "verify": f"bash -c \x27cp {verify_dir}/add-power.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
      "split": "development"
    },
    {
      "id": "add-modulo",
      "repo": dest_abs,
      "base": base_sha,
      "description": "En calc.py, implementar la función modulo(a, b) que calcule el resto de la división entera a % b. Si b == 0 o b == 0.0, debe lanzar ValueError con mensaje \"cannot divide by zero\". Documentarla con docstring.",
      "verify": f"bash -c \x27cp {verify_dir}/add-modulo.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
      "split": "development"
    },
    {
      "id": "fix-divide-edge-case",
      "repo": dest_abs,
      "base": base_sha,
      "description": "En calc.py, corregir el caso borde en divide(a, b) donde el numerador es cero y el denominador es negativo. En Python, 0 / -5 produce -0.0 (cero negativo IEEE 754). La función debe normalizar el resultado para devolver siempre 0.0 positivo cuando a == 0 (y b != 0). Si b == 0 o b == 0.0, debe seguir lanzando ValueError con mensaje \"cannot divide by zero\".",
      "verify": f"bash -c \x27cp {verify_dir}/fix-divide-edge-case.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
      "split": "development"
    },
    {
      "id": "locate-and-safe-divide",
      "repo": dest_abs,
      "base": base_sha,
      "description": "Localizar en calc.py el mensaje exacto de error que lanza divide cuando el divisor es cero (\"cannot divide by zero\"). Exportar este valor como la constante a nivel de módulo ERROR_DIVIDE_BY_ZERO = \"cannot divide by zero\" y actualizar divide para que use dicha constante. Además, implementar la función safe_divide(a, b, default=None) que use divide(a, b) y, en caso de capturar ValueError por división por cero, devuelva el valor de default en vez de fallar.",
      "verify": f"bash -c \x27cp {verify_dir}/locate-and-safe-divide.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
      "split": "development"
    }
  ]
}
with open(f"{dest_abs}/suite.json", "w", encoding="utf-8") as f:
    json.dump(suite, f, indent=2, ensure_ascii=False)
    f.write("\n")
' "$DEST_ABS" "$BASE_SHA" "$VERIFY_DIR"

echo "Preparado repositorio base en $DEST_ABS (commit $BASE_SHA)"
echo "Suite guardada en $DEST_ABS/suite.json"
