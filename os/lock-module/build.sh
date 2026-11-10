#!/bin/sh
# Build the NEXUS lock-screen module (nexus-lockbar.c) for gtklock 4.0.0 on Debian trixie.
# It must be built on the image's Debian release and architecture (the builder VM, arm64). From the Mac:
#   vm/lab/builder.sh ssh 'rm -rf /tmp/lockmod && mkdir /tmp/lockmod'
#   for f in nexus-lockbar.c window.h build.sh; do vm/lab/builder.sh ssh "cat > /tmp/lockmod/$f" < os/lock-module/$f; done
#   vm/lab/builder.sh ssh 'sh /tmp/lockmod/build.sh'
#   vm/lab/builder.sh ssh 'cat /tmp/lockmod/nexus-lockbar.so' > os/mkosi.extra/usr/lib/nexus/nexus-lockbar.so
# The image ships that .so; /usr/bin/nexus-lock loads it with `gtklock -m`.
# Needs gcc, pkg-config and libgtk-3-dev.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/nexus-lockbar.so}
# shellcheck disable=SC2046  # pkg-config prints several flags on purpose
gcc -shared -fPIC -O2 -Wall -Wextra -Wno-unused-parameter -Werror -o "$out" "$here/nexus-lockbar.c" -I"$here" \
  $(pkg-config --cflags --libs gtk+-3.0)
strip --strip-unneeded "$out"
echo "built $out"
