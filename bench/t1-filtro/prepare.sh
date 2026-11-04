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

TOY_SRC="$FACTORY_ROOT/bench/ola3/fixtures/toy-calc"
REAL_SRC="$FACTORY_ROOT/bench/ola3/fixtures/real"

if [ ! -d "$TOY_SRC" ]; then
  echo "Error: no se encontró el fixture en $TOY_SRC" >&2
  exit 1
fi

if [ ! -d "$REAL_SRC" ]; then
  echo "Error: no se encontró el fixture en $REAL_SRC" >&2
  exit 1
fi

TOY_DEST="$DEST_ABS/toy-calc"
REAL_DEST="$DEST_ABS/real"

# 1. Copiar y preparar fixture toy-calc
mkdir -p "$TOY_DEST/tests"
cp "$TOY_SRC/calc.py" "$TOY_DEST/calc.py"
cp "$TOY_SRC/.gitignore" "$TOY_DEST/.gitignore"
cp "$TOY_SRC/pytest.ini" "$TOY_DEST/pytest.ini"
cp "$TOY_SRC/README.md" "$TOY_DEST/README.md"
cp "$TOY_SRC/tests/test_calc.py" "$TOY_DEST/tests/test_calc.py"
chmod 755 "$TOY_DEST" "$TOY_DEST/tests"
chmod 644 "$TOY_DEST/calc.py" "$TOY_DEST/.gitignore" "$TOY_DEST/pytest.ini" "$TOY_DEST/README.md" "$TOY_DEST/tests/test_calc.py"

git -C "$TOY_DEST" -c init.defaultBranch=main init -q
git -C "$TOY_DEST" -c core.hooksPath=/dev/null -c core.autocrlf=false add -A

GIT_AUTHOR_NAME="T1 Filtro" \
GIT_AUTHOR_EMAIL="t1@factory.local" \
GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" \
GIT_COMMITTER_NAME="T1 Filtro" \
GIT_COMMITTER_EMAIL="t1@factory.local" \
GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
git -C "$TOY_DEST" -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm "init: toy-calc base fixture"

TOY_BASE_SHA="$(git -C "$TOY_DEST" rev-parse HEAD)"

# 2. Copiar y preparar fixture real (adf-connector)
mkdir -p "$REAL_DEST/src" "$REAL_DEST/tests"
cp "$REAL_SRC/package.json" "$REAL_DEST/package.json"
cp "$REAL_SRC/tsconfig.json" "$REAL_DEST/tsconfig.json"
cp "$REAL_SRC/.gitignore" "$REAL_DEST/.gitignore"
cp "$REAL_SRC/README.md" "$REAL_DEST/README.md"
cp "$REAL_SRC/src/adf.ts" "$REAL_DEST/src/adf.ts"
cp "$REAL_SRC/tests/adf.test.ts" "$REAL_DEST/tests/adf.test.ts"
chmod 755 "$REAL_DEST" "$REAL_DEST/src" "$REAL_DEST/tests"
chmod 644 "$REAL_DEST/package.json" "$REAL_DEST/tsconfig.json" "$REAL_DEST/.gitignore" "$REAL_DEST/README.md" "$REAL_DEST/src/adf.ts" "$REAL_DEST/tests/adf.test.ts"

git -C "$REAL_DEST" -c init.defaultBranch=main init -q
git -C "$REAL_DEST" -c core.hooksPath=/dev/null -c core.autocrlf=false add -A

GIT_AUTHOR_NAME="T1 Filtro" \
GIT_AUTHOR_EMAIL="t1@factory.local" \
GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" \
GIT_COMMITTER_NAME="T1 Filtro" \
GIT_COMMITTER_EMAIL="t1@factory.local" \
GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
git -C "$REAL_DEST" -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm "init: real adf-connector base fixture"

REAL_BASE_SHA="$(git -C "$REAL_DEST" rev-parse HEAD)"

VERIFY_DIR="$SCRIPT_DIR/verify"

# 3. Generar suite.json dentro de <destino>
python3 -c '
import json, sys

dest_abs, toy_dest, real_dest, toy_base, real_base, verify_dir = sys.argv[1:7]

tasks = [
  # --- Grupo py-feature (toy-calc) ---
  {
    "id": "py-feature-subtract",
    "group": "py-feature",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, implementar la función subtract(a, b) que calcule la resta a - b. Añadir docstring explicativo y asegurar que los tests existentes sigan pasando.",
    "verify": f"bash -c \x27cp {verify_dir}/py-feature-subtract.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "development"
  },
  {
    "id": "py-feature-multiply",
    "group": "py-feature",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, implementar la función multiply(a, b) que calcule el producto a * b. Añadir docstring explicativo y asegurar que los tests existentes sigan pasando.",
    "verify": f"bash -c \x27cp {verify_dir}/py-feature-multiply.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "development"
  },
  {
    "id": "py-feature-power",
    "group": "py-feature",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, implementar la función power(base, exponent) que calcule base ** exponent. Si exponent es negativo, debe lanzar ValueError con mensaje \"negative exponent not supported\". Documentarla con docstring explicativo.",
    "verify": f"bash -c \x27cp {verify_dir}/py-feature-power.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "development"
  },
  {
    "id": "py-feature-median",
    "group": "py-feature",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, implementar la función median(values) que calcule la mediana de una secuencia numérica no vacía. Si values está vacío, debe lanzar ValueError con mensaje \"cannot compute median of empty list\". Para longitud impar retornar el valor central; para longitud par, la media aritmética de los dos centrales. Documentarla con docstring.",
    "verify": f"bash -c \x27cp {verify_dir}/py-feature-median.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "development"
  },

  # --- Grupo py-fix (toy-calc) ---
  {
    "id": "py-fix-divide-negative-zero",
    "group": "py-fix",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, corregir el caso borde en divide(a, b) donde el numerador es cero y el denominador es negativo. En Python, 0 / -5 produce -0.0 (cero negativo IEEE 754). La función debe normalizar el resultado para devolver siempre 0.0 positivo cuando a == 0 (y b != 0). Si b == 0 o b == 0.0, debe seguir lanzando ValueError con mensaje \"cannot divide by zero\".",
    "verify": f"bash -c \x27cp {verify_dir}/py-fix-divide-negative-zero.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "development"
  },
  {
    "id": "py-fix-average-empty",
    "group": "py-fix",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, corregir average(values) para que, si recibe una lista vacía [], lance ValueError con mensaje \"cannot compute average of empty list\", en lugar de fallar con ZeroDivisionError no controlado.",
    "verify": f"bash -c \x27cp {verify_dir}/py-fix-average-empty.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "development"
  },
  {
    "id": "py-fix-average-iterable",
    "group": "py-fix",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, mejorar average(values) para que soporte cualquier iterable (generadores, tuplas, iteradores), convirtiéndolo a lista en memoria. Si la secuencia está vacía, debe lanzar ValueError con mensaje \"cannot compute average of empty list\".",
    "verify": f"bash -c \x27cp {verify_dir}/py-fix-average-iterable.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "development"
  },
  {
    "id": "py-fix-add-type-check",
    "group": "py-fix",
    "repo": toy_dest,
    "base": toy_base,
    "description": "En calc.py, corregir add(a, b) para asegurar validación estricta de tipos numéricos. Si a o b no es int ni float, o si alguno es de tipo bool (ya que en Python bool es subclase de int), debe lanzar TypeError con el mensaje exacto \"operands must be int or float\".",
    "verify": f"bash -c \x27cp {verify_dir}/py-fix-add-type-check.py tests/test_verify.py && pytest -q; s=$?; rm -f tests/test_verify.py; exit $s\x27",
    "split": "validation"
  },

  # --- Grupo ts-locate (real / adf-connector) ---
  {
    "id": "ts-locate-rule",
    "group": "ts-locate",
    "repo": real_dest,
    "base": real_base,
    "description": "En src/adf.ts, localizar el switch de tipos de nodo en adfToText y el bucle de bloques en markdownToAdf. Añadir soporte para el nodo de regla horizontal (rule): en adfToText, añadir case \x27rule\x27: return \x27---\\n\\n\x27; en markdownToAdf, si una línea no vacía coincide con --- o *** (con posibles espacios), emitir un nodo { type: \x27rule\x27 } en content.",
    "verify": f"bash -c \x27cp {verify_dir}/ts-locate-rule.ts tests/verify.test.ts && bun test; s=$?; rm -f tests/verify.test.ts; exit $s\x27",
    "split": "development"
  },
  {
    "id": "ts-locate-strike",
    "group": "ts-locate",
    "repo": real_dest,
    "base": real_base,
    "description": "En src/adf.ts, localizar el formateo de marcas en adfToText y el analizador léxico en inline(text). Añadir soporte para la marca strike (tachado): en adfToText envolver el texto con ~~ cuando m?.type === \x27strike\x27; en inline(text) añadir soporte para capturar ~~texto~~ y generar nodo de texto con marks: [{ type: \x27strike\x27 }].",
    "verify": f"bash -c \x27cp {verify_dir}/ts-locate-strike.ts tests/verify.test.ts && bun test; s=$?; rm -f tests/verify.test.ts; exit $s\x27",
    "split": "development"
  },
  {
    "id": "ts-locate-depth-limit",
    "group": "ts-locate",
    "repo": real_dest,
    "base": real_base,
    "description": "En src/adf.ts, localizar la guarda de profundidad máxima en adfToText. Exportar la constante DEFAULT_MAX_DEPTH = 100. Extender adfToText(node: unknown, maxDepth?: number): string para aceptar maxDepth opcional; si maxDepth es un número mayor o igual a cero, usarlo como límite de recursión en lugar de DEFAULT_MAX_DEPTH, retornando \x27\x27 cuando depth > limit.",
    "verify": f"bash -c \x27cp {verify_dir}/ts-locate-depth-limit.ts tests/verify.test.ts && bun test; s=$?; rm -f tests/verify.test.ts; exit $s\x27",
    "split": "development"
  },
  {
    "id": "ts-locate-mention",
    "group": "ts-locate",
    "repo": real_dest,
    "base": real_base,
    "description": "En src/adf.ts, localizar el bloque switch (n.type) en adfToText. Añadir soporte para el tipo de nodo \x27mention\x27: obtener attrs con record(n.attrs); si attrs?.text es string no vacío, retornar attrs.text; si no, si attrs?.id es string no vacío, retornar \x27@\x27 + attrs.id; de lo contrario, retornar \x27@unknown\x27.",
    "verify": f"bash -c \x27cp {verify_dir}/ts-locate-mention.ts tests/verify.test.ts && bun test; s=$?; rm -f tests/verify.test.ts; exit $s\x27",
    "split": "validation"
  }
]

suite = {"tasks": tasks}
with open(f"{dest_abs}/suite.json", "w", encoding="utf-8") as f:
    json.dump(suite, f, indent=2, ensure_ascii=False)
    f.write("\n")
' "$DEST_ABS" "$TOY_DEST" "$REAL_DEST" "$TOY_BASE_SHA" "$REAL_BASE_SHA" "$VERIFY_DIR"

echo "Preparados repositorios base en $DEST_ABS:"
echo "  - toy-calc: commit $TOY_BASE_SHA"
echo "  - real: commit $REAL_BASE_SHA"
echo "Suite guardada en $DEST_ABS/suite.json"
