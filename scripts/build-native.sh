#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Linux source execution retains its /proc descriptor backend. Native builds
# still compile this module so Bun can resolve and embed the literal require.
if [ "${1:-}" = --if-needed ] && [ "$(uname -s)" != Darwin ]; then exit 0; fi
header_dir=$(node -p 'require("path").resolve(require("path").dirname(process.execPath), "../include/node")')
if [ ! -f "$header_dir/node_api.h" ]; then
  echo 'Building native file capabilities requires a Node installation with include/node/node_api.h.' >&2
  exit 1
fi
out=src/agent/native/posix.node
temporary="$out.$$.tmp"
trap 'rm -f "$temporary"' 0
case "$(uname -s)" in
  Darwin) cc -O2 -Wall -Wextra -Werror -bundle -undefined dynamic_lookup -fPIC -I "$header_dir" src/agent/native/posix.c -o "$temporary" ;;
  Linux) cc -O2 -Wall -Wextra -Werror -shared -fPIC -I "$header_dir" src/agent/native/posix.c -o "$temporary" ;;
  *) echo 'Native file capabilities support Linux and macOS only.' >&2; exit 1 ;;
esac
mv -f "$temporary" "$out"
