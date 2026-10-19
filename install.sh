#!/usr/bin/env sh
# fab installer: curl -fsSL https://raw.githubusercontent.com/DarkCodePE/sw-factory/main/install.sh | sh
# Downloads the release binary for this OS/arch, verifies its SHA-256 and installs it in ~/.local/bin.
set -eu
REPO="${FAB_REPO:-DarkCodePE/sw-factory}"
VERSION="${FAB_VERSION:-latest}"
BIN_DIR="${FAB_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "fab: sistema no soportado: $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "fab: arquitectura no soportada: $(uname -m)" >&2; exit 1 ;; esac
asset="fab-$os-$arch"
if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/$VERSION"; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "Descargando $asset ($VERSION)..."
curl -fsSL "$base/$asset" -o "$tmp/fab"
curl -fsSL "$base/$asset.sha256" -o "$tmp/fab.sha256"
expected="$(cut -d' ' -f1 < "$tmp/fab.sha256")"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/fab" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$tmp/fab" | cut -d' ' -f1)"; fi
[ "$expected" = "$actual" ] || { echo "fab: la suma SHA-256 no coincide; instalación cancelada" >&2; exit 1; }

mkdir -p "$BIN_DIR"
install -m 0755 "$tmp/fab" "$BIN_DIR/fab"
echo "fab instalado en $BIN_DIR/fab"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Añade $BIN_DIR a tu PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
command -v bwrap >/dev/null 2>&1 || echo "Recomendado en Linux: instala bubblewrap (sudo apt install bubblewrap) para aislar los comandos."
echo "Ejecuta: fab"
