#!/bin/sh
# Download a standalone release; no Bun, sudo, or shell-profile edits.
# Keep all work inside a function so a truncated curl response cannot install.
fab_install() {
  set -eu
  version=latest
  install_dir=${FAB_INSTALL_DIR:-${HOME:?HOME no está definido}/.local/bin}
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|--install-dir)
        [ "$#" -ge 2 ] || { printf '%s\n' "Falta valor para $1" >&2; return 1; }
        if [ "$1" = --version ]; then version=$2; else install_dir=$2; fi
        shift 2 ;;
      -h|--help)
        printf '%s\n' 'Uso: sh install.sh [--version v0.1.0] [--install-dir /ruta/bin]' \
          'Predeterminado: última release, ~/.local/bin. Windows: ejecutar dentro de WSL.'
        return 0 ;;
      *) printf '%s\n' "Opción desconocida: $1" >&2; return 1 ;;
    esac
  done
  case "$version" in ''|.|..|-*|*[!A-Za-z0-9._-]*) printf '%s\n' 'Versión inválida' >&2; return 1 ;; esac
  case "$install_dir" in /*) ;; *) printf '%s\n' '--install-dir debe ser una ruta absoluta' >&2; return 1 ;; esac
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) printf '%s\n' 'Sistema no soportado por este instalador. En Windows usa WSL (Linux).' >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) printf '%s\n' 'Arquitectura no soportada: se requiere x64 o arm64' >&2; return 1 ;;
  esac
  if [ "$os" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    printf '%s\n' 'Se requiere Linux con glibc; aún no publicamos binarios musl/Alpine.' >&2; return 1
  fi
  for dependency in curl mktemp awk cp chmod mv; do
    command -v "$dependency" >/dev/null 2>&1 || { printf '%s\n' "Falta dependencia: $dependency" >&2; return 1; }
  done
  if command -v sha256sum >/dev/null 2>&1; then hash_command=sha256sum
  elif command -v shasum >/dev/null 2>&1; then hash_command=shasum
  else printf '%s\n' 'Se requiere sha256sum o shasum' >&2; return 1
  fi
  asset="fab-$os-$arch"
  base=https://github.com/DarkCodePE/sw-factory/releases
  if [ "$version" = latest ]; then base="$base/latest/download"; else base="$base/download/$version"; fi
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/fab-install.XXXXXX")
  staged=
  trap 'rm -rf "$temp_dir"; if [ -n "$staged" ]; then rm -f "$staged"; fi' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  for file in "$asset" "$asset.sha256"; do
    if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --tlsv1.2 --connect-timeout 15 --max-time 180 --retry 2 --output "$temp_dir/$file" "$base/$file"; then
      printf '%s\n' "No se pudo descargar $file. Comprueba que exista una release con ese artefacto." >&2; return 1
    fi
  done
  expected=$(awk -v asset="$asset" '
    NR == 1 && NF == 2 && length($1) == 64 && $1 !~ /[^[:xdigit:]]/ && $2 == asset { hash=tolower($1); next }
    { bad=1 }
    END { if (NR != 1 || bad || hash == "") exit 1; print hash }
  ' "$temp_dir/$asset.sha256") || { printf '%s\n' 'Archivo checksum inválido' >&2; return 1; }
  if [ "$hash_command" = sha256sum ]; then actual=$(sha256sum "$temp_dir/$asset")
  else actual=$(shasum -a 256 "$temp_dir/$asset")
  fi
  [ "${actual%% *}" = "$expected" ] || { printf '%s\n' 'Checksum SHA-256 incorrecto; instalación cancelada' >&2; return 1; }
  chmod 755 "$temp_dir/$asset"
  reported=$("$temp_dir/$asset" --version) || { printf '%s\n' 'El binario no puede ejecutarse en este sistema' >&2; return 1; }
  case "$reported" in 'fab '[0-9]*) ;; *) printf '%s\n' 'El binario no identifica una versión de FAB válida' >&2; return 1 ;; esac
  number=${reported#fab }
  case "$number" in *[!A-Za-z0-9.+-]*) printf '%s\n' 'Versión de FAB inválida' >&2; return 1 ;; esac
  if [ "$version" != latest ] && [ "$number" != "${version#v}" ]; then
    printf '%s\n' 'La versión del binario no coincide con la release solicitada' >&2; return 1
  fi
  mkdir -p "$install_dir"
  if [ -L "$install_dir/fab" ] || { [ -e "$install_dir/fab" ] && [ ! -f "$install_dir/fab" ]; }; then
    printf '%s\n' 'El destino fab es un enlace o no es un archivo normal; no se reemplazó' >&2; return 1
  fi
  staged=$(mktemp "$install_dir/.fab-install.XXXXXX")
  cp "$temp_dir/$asset" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$install_dir/fab"
  staged=
  printf '%s\n' "$reported instalado en $install_dir/fab" 'Inicia la TUI con: fab tui'
  case ":${PATH:-}:" in *":$install_dir:"*) ;; *) printf '%s\n' "Añade $install_dir al PATH para usar fab desde cualquier carpeta." ;; esac
}
fab_install "$@"
