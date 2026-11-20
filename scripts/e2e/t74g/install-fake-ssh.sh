#!/bin/sh
# uso: install-fake-ssh.sh <dir-bin> <log> <rhome> <rpath> <root> <cli>
set -eu
mkdir -p "$1"
sed -e "s#@LOG@#$2#g" -e "s#@RHOME@#$3#g" -e "s#@RPATH@#$4#g" -e "s#@ROOT@#$5#g" -e "s#@CLI@#$6#g" -e "s#@BUN@#$(command -v bun)#g" \
  "$(dirname "$0")/fake-ssh" > "$1/ssh"
chmod +x "$1/ssh"
