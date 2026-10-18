#!/usr/bin/env sh
# Build standalone fab binaries for release (no Bun needed to run them).
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo 'Unsupported native build host' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Unsupported native build architecture' >&2; exit 1 ;; esac
for target in ${FAB_TARGETS:-bun-$os-$arch}; do
  if [ "$target" != "bun-$os-$arch" ]; then echo 'Build each distribution on its native host (including its Node-API module).' >&2; exit 1; fi
done
sh scripts/build-native.sh
for target in ${FAB_TARGETS:-bun-$os-$arch}; do
  out="dist/fab-${target#bun-}"
  bun build --compile --target="$target" --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/cli.ts --outfile "$out"
  (cd dist
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$(basename "$out")" > "$(basename "$out").sha256"
    else
      shasum -a 256 "$(basename "$out")" > "$(basename "$out").sha256"
    fi
  )
done
