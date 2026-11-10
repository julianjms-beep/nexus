#!/bin/bash
# Make the «Instalar NEXUS (Windows)» folder: NEXUS OS on a PC with Windows, in a VirtualBox window (nothing is
# installed over Windows; the person installs VirtualBox once).
#   vm/lab/make-windows-folder.sh "/Volumes/Untitled/Instalar NEXUS (Windows)"   launcher + LÉEME + the amd64 image
#   SCRIPTS_ONLY=1 vm/lab/make-windows-folder.sh /tmp/x                         only the launcher, its script, the LÉEME
#   DISK_GB=32 (default) is the size NEXUS grows into on its first boot.
# The folder: Abrir NEXUS.bat, LÉEME.txt, Sistema/nexus-windows.ps1 (all from vm/windows), Sistema/nexus-os.vdi.
# The disk is the builder's amd64 image (NEXUS_ARCH=amd64 os/build.sh) as a dynamic VirtualBox disk (only what is used
# takes space), made on the builder with qemu-img and checked with sha256 against it after the copy.
set -euo pipefail
source "$(dirname "$0")/common.sh"
OUT=${1:?usage: make-windows-folder.sh <folder>}
W="$NEXUS_REPO/vm/windows"
B="$(dirname "$0")/builder.sh"
GB=${DISK_GB:-32}
version=$(sed -n 's/^ImageVersion=//p' "$NEXUS_REPO/os/mkosi.conf")
mkdir -p "$OUT/Sistema"

# wintext SRC DST ENCODING [KEY VALUE]...: a text file for Windows: CRLF line ends, KEYs replaced. The .ps1 and the
# LÉEME go in UTF-8 with a BOM (Windows PowerShell 5.1 reads a file without one as ANSI and breaks the accents).
wintext() {
  python3 -c '
import sys
src, dst, enc, *kv = sys.argv[1:]
t = open(src, encoding="utf-8").read().replace("\r\n", "\n")
for k, v in zip(kv[::2], kv[1::2]):
    t = t.replace(k, v)
t.encode(enc)   # the .bat must be plain ASCII
open(dst, "w", encoding=enc, newline="\r\n").write(t)' "$@"
}

size_gb=?
if [ "${SCRIPTS_ONLY:-0}" != 1 ]; then
  img=nexus-build-amd64/output
  # (a VDI newer than the image is reused: e.g. the one just tested; a test boots it only through an overlay)
  "$B" ssh "set -e; test -f ~/$img/nexus-os.raw; command -v qemu-img >/dev/null
    if [ ~/$img/nexus-os.vdi -nt ~/$img/nexus-os.raw ] && qemu-img info ~/$img/nexus-os.vdi | grep -q '^virtual size: $GB GiB'; then
      echo reusing the VDI; exit 0; fi
    rm -f ~/$img/nexus-os.vdi
    qemu-img create -q -f vdi ~/$img/nexus-os.vdi ${GB}G
    qemu-img convert -n --target-is-zero -f raw -O vdi ~/$img/nexus-os.raw ~/$img/nexus-os.vdi"
  want=$("$B" ssh "sha256sum ~/$img/nexus-os.vdi" | awk '{print $1}')
  part="$OUT/Sistema/nexus-os.vdi.part"
  "$B" ssh "gzip -1 < ~/$img/nexus-os.vdi" | gunzip > "$part"
  got=$(shasum -a 256 "$part" | awk '{print $1}')
  [ "$want" = "$got" ] || { echo "the copy differs from the builder's disk ($got != $want)" >&2; rm -f "$part"; exit 1; }
  mv -f "$part" "$OUT/Sistema/nexus-os.vdi"
  size_gb=$(python3 -c 'import os,sys; print(f"{os.path.getsize(sys.argv[1])/1e9:.1f}".replace(".", ","))' "$OUT/Sistema/nexus-os.vdi")
  echo "system $version (sha256 $want) in $OUT/Sistema/nexus-os.vdi, $size_gb GB now, grows to $GB GB"
elif [ -f "$OUT/Sistema/nexus-os.vdi" ]; then
  size_gb=$(python3 -c 'import os,sys; print(f"{os.path.getsize(sys.argv[1])/1e9:.1f}".replace(".", ","))' "$OUT/Sistema/nexus-os.vdi")
fi

wintext "$W/Abrir NEXUS.bat" "$OUT/Abrir NEXUS.bat" ascii
wintext "$W/nexus-windows.ps1" "$OUT/Sistema/nexus-windows.ps1" utf-8-sig
wintext "$W/LÉEME.txt" "$OUT/LÉEME.txt" utf-8-sig @VERSION@ "$version" @SIZE_GB@ "$size_gb"
echo "Windows folder $version ready in $OUT"
