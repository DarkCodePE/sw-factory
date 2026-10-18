#!/usr/bin/env sh
# Build standalone fab binaries for release (no Bun needed to run them).
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
for target in ${FAB_TARGETS:-bun-linux-x64 bun-linux-arm64 bun-darwin-arm64 bun-darwin-x64}; do
  out="dist/fab-${target#bun-}"
  bun build --compile --target="$target" --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/cli.ts --outfile "$out"
  (cd dist && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
done
