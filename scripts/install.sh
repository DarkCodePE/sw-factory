#!/bin/sh
# Source bootstrap: stable by default. Release variants are generated at pack time.
# Keep the complete program inside a function for safe curl | sh use.
fab_install() {
  set -eu
  FAB_INSTALLER_MODE=source
  FAB_INSTALLER_VERSION=
  version=${FAB_VERSION:-}
  channel=${FAB_CHANNEL:-stable}
  install_dir=${FAB_INSTALL_DIR:-${HOME:?HOME no está definido}/.local/bin}
  cli_version= cli_channel= current= check=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|--channel|--install-dir|--current-version)
        [ "$#" -ge 2 ] || { printf 'Falta valor para %s\n' "$1" >&2; return 1; }
        case "$1" in
          --version) version=$2; cli_version=$2 ;;
          --channel) channel=$2; cli_channel=$2 ;;
          --install-dir) install_dir=$2 ;;
          --current-version) current=$2 ;;
        esac
        shift 2 ;;
      --check) check=1; shift ;;
      -h|--help)
        printf '%s\n' 'Uso: sh install.sh [--channel stable|prerelease] [--version VERSION] [--install-dir /ruta/bin] [--check]' \
          'Predeterminado: stable, ~/.local/bin. FAB_CHANNEL y FAB_VERSION configuran el bootstrap fuente.' \
          'Requiere curl, python3 y sha256sum o shasum. En Windows usa WSL.'
        return 0 ;;
      *) printf 'Opción desconocida: %s\n' "$1" >&2; return 1 ;;
    esac
  done
  case "$FAB_INSTALLER_MODE" in
    source) ;;
    pinned)
      if [ -n "$cli_version" ] && [ "${cli_version#v}" != "${FAB_INSTALLER_VERSION#v}" ]; then
        printf '%s\n' 'Este instalador está fijado a su release; utiliza el bootstrap fuente para otra versión.' >&2; return 1
      fi
      version=$FAB_INSTALLER_VERSION; channel=prerelease ;;
    stable|prerelease)
      if [ -n "$cli_version" ] || { [ -n "$cli_channel" ] && [ "$cli_channel" != "$FAB_INSTALLER_MODE" ]; }; then
        printf '%s\n' 'Este instalador tiene un canal fijo; utiliza el bootstrap fuente para elegir otro.' >&2; return 1
      fi
      version=; channel=$FAB_INSTALLER_MODE ;;
    *) printf '%s\n' 'Política de instalador inválida' >&2; return 1 ;;
  esac
  case "$channel" in stable|prerelease) ;; *) printf '%s\n' 'Canal inválido: usa stable o prerelease' >&2; return 1 ;; esac
  case "$install_dir" in /*) ;; *) printf '%s\n' '--install-dir debe ser una ruta absoluta' >&2; return 1 ;; esac
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) printf '%s\n' 'Sistema no soportado; en Windows usa WSL.' >&2; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) printf '%s\n' 'Arquitectura no soportada: se requiere x64 o arm64' >&2; return 1 ;; esac
  if [ "$os" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    printf '%s\n' 'Se requiere Linux con glibc; aún no publicamos binarios musl/Alpine.' >&2; return 1
  fi
  for dependency in curl python3 cat mktemp awk cp chmod mv mkdir rm; do
    command -v "$dependency" >/dev/null 2>&1 || { printf 'Falta dependencia: %s\n' "$dependency" >&2; return 1; }
  done
  if command -v sha256sum >/dev/null 2>&1; then hash_command=sha256sum
  elif command -v shasum >/dev/null 2>&1; then hash_command=shasum
  else printf '%s\n' 'Se requiere sha256sum o shasum' >&2; return 1
  fi
  if [ -L "$install_dir/fab" ] || { [ -e "$install_dir/fab" ] && [ ! -f "$install_dir/fab" ]; }; then
    printf '%s\n' 'El destino fab es un enlace o no es un archivo normal; no se reemplazó' >&2; return 1
  fi
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/fab-install.XXXXXX"); staged=
  trap 'rm -rf "$temp_dir"; if [ -n "$staged" ]; then rm -f "$staged"; fi' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  cat > "$temp_dir/select.py" <<'PYTHON'
import json, re, sys

def version(value):
    match = re.fullmatch(r'v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?', value) if isinstance(value, str) and len(value) <= 120 else None
    if not match:
        raise ValueError('Versión SemVer inválida')
    parts = []
    for part in (match[4] or '').split('.') if match[4] else []:
        if part.isdigit() and len(part) > 1 and part[0] == '0':
            raise ValueError('Identificador numérico inválido')
        parts.append((0, int(part)) if part.isdigit() else (1, part))
    return (*map(int, match.group(1, 2, 3)), match[4] is None, tuple(parts))

try:
    operation, *args = sys.argv[1:]
    if operation == 'pin':
        if args[0]: version(args[0])
    elif operation == 'newer':
        old, new = args
        if version(new) < version(old[4:] if old.startswith('fab ') else old):
            raise ValueError('La versión instalada es más nueva; usa --version para un rollback explícito')
    else:
        file, selection, pin, channel = args
        with open(file) as f: data = json.load(f)
        releases = [data] if pin else data
        if not isinstance(releases, list) or len(releases) > 100:
            raise ValueError('Listado de releases inválido')
        with open(selection) as f: best = json.load(f)
        required = {'install.sh', 'release-manifest.json', 'candidate-receipt.json'}
        for os in ('linux', 'darwin'):
            for arch in ('x64', 'arm64'):
                required.update((f'fab-{os}-{arch}', f'fab-{os}-{arch}.sha256'))
        for release in releases:
            if not isinstance(release, dict): continue
            tag = release.get('tag_name')
            try: parsed = version(tag)
            except ValueError: continue
            if not tag.startswith('v') or release.get('draft') is not False or release.get('prerelease') is not (not parsed[3]): continue
            if (pin and tag != pin) or (not pin and channel == 'stable' and not parsed[3]): continue
            assets = release.get('assets')
            if not isinstance(assets, list): continue
            names, ids, valid = set(), set(), True
            for asset in assets:
                if not isinstance(asset, dict): valid = False; break
                name, id, size = asset.get('name'), asset.get('id'), asset.get('size')
                if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', name) or name in names or type(id) is not int or id <= 0 or id in ids or type(size) is not int or size <= 0:
                    valid = False; break
                names.add(name); ids.add(id)
            if valid and required <= names and (best is None or parsed > version(best)):
                best = tag
        with open(selection, 'w') as f: json.dump(best, f)
        print(len(releases), best or '-')
except (ValueError, OSError, TypeError) as error:
    sys.exit(str(error))
PYTHON
  python3 "$temp_dir/select.py" pin "$version" || return 1
  if [ -n "$version" ]; then version=v${version#v}; fi
  pin=$version; page=1
  printf 'null\n' > "$temp_dir/selection.json"
  while :; do
    if [ -n "$pin" ]; then endpoint="releases/tags/$pin"; else endpoint="releases?per_page=100&page=$page"; fi
    if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 30 --max-filesize 8388608 --retry 2 \
      --output "$temp_dir/releases.json" "https://api.github.com/repos/DarkCodePE/sw-factory/$endpoint"; then
      printf '%s\n' 'No se pudo consultar la release (red, permisos o límite de GitHub); la instalación anterior se conserva.' >&2; return 1
    fi
    selected=$(python3 "$temp_dir/select.py" select "$temp_dir/releases.json" "$temp_dir/selection.json" "$pin" "$channel") || return 1
    read -r count version <<FIELDS
$selected
FIELDS
    [ -z "$pin" ] && [ "$count" -eq 100 ] || break
    [ "$page" -lt 20 ] || { printf '%s\n' 'Listado incompleto: se superaron 20 páginas de releases; usa --version.' >&2; return 1; }
    page=$((page + 1))
  done
  if [ "$version" = - ]; then
    printf 'No hay una release completa para %s. Para versiones de prueba usa --channel prerelease.\n' "${pin:-$channel}" >&2; return 1
  fi
  if [ -z "$pin" ]; then
    if [ -z "$current" ] && [ -x "$install_dir/fab" ]; then current=$("$install_dir/fab" --version); fi
    if [ -n "$current" ]; then python3 "$temp_dir/select.py" newer "$current" "$version" || return 1; fi
  fi
  printf 'FAB %s · canal %s\n' "$version" "$channel"
  if [ "$check" = 1 ]; then printf '%s\n' 'Consulta completada; no se modificó la instalación.'; return 0; fi
  if [ -z "$pin" ] && { [ "${current#fab }" = "${version#v}" ] || [ "$current" = "$version" ]; }; then
    printf '%s\n' 'FAB ya está actualizado.'; return 0
  fi
  asset="fab-$os-$arch"
  base="https://github.com/DarkCodePE/sw-factory/releases/download/$version"
  for file in "$asset" "$asset.sha256"; do
    if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --tlsv1.2 --connect-timeout 15 --max-time 180 --max-filesize 536870912 --retry 2 --output "$temp_dir/$file" "$base/$file"; then
      printf 'No se pudo descargar %s; se conserva la instalación anterior.\n' "$file" >&2; return 1
    fi
  done
  expected=$(awk -v asset="$asset" '
    NR == 1 && NF == 2 && length($1) == 64 && $1 !~ /[^[:xdigit:]]/ && $2 == asset { hash=tolower($1); next }
    { bad=1 }
    END { if (NR != 1 || bad || hash == "") exit 1; print hash }
  ' "$temp_dir/$asset.sha256") || { printf '%s\n' 'Archivo checksum inválido' >&2; return 1; }
  if [ "$hash_command" = sha256sum ]; then actual=$(sha256sum "$temp_dir/$asset")
  else actual=$(shasum -a 256 "$temp_dir/$asset"); fi
  [ "${actual%% *}" = "$expected" ] || { printf '%s\n' 'Checksum SHA-256 incorrecto; instalación cancelada' >&2; return 1; }
  chmod 755 "$temp_dir/$asset"
  reported=$("$temp_dir/$asset" --version) || { printf '%s\n' 'El binario no puede ejecutarse en este sistema' >&2; return 1; }
  [ "$reported" = "fab ${version#v}" ] || { printf '%s\n' 'La versión del binario no coincide con la release solicitada' >&2; return 1; }
  mkdir -p "$install_dir"
  [ ! -L "$install_dir/fab" ] && { [ ! -e "$install_dir/fab" ] || [ -f "$install_dir/fab" ]; } || { printf '%s\n' 'El destino fab cambió o es un enlace; no se reemplazó' >&2; return 1; }
  staged=$(mktemp "$install_dir/.fab-install.XXXXXX")
  cp "$temp_dir/$asset" "$staged"; chmod 755 "$staged"; mv -f "$staged" "$install_dir/fab"; staged=
  printf 'fab %s instalado en %s/fab\nInicia la TUI con: fab tui\n' "${version#v}" "$install_dir"
  case ":${PATH:-}:" in *":$install_dir:"*) ;; *) printf 'Añade %s al PATH para usar fab desde cualquier carpeta.\n' "$install_dir" ;; esac
}
fab_install "$@"
