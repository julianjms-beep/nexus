#!/bin/bash
# Make the «Instalar NEXUS» folder: NEXUS OS as a Mac app (a window next to macOS; nothing is installed over macOS).
#   vm/lab/make-install-folder.sh "/Volumes/Untitled/Instalar NEXUS"            app + LÉEME + the builder's image
#   APP_ONLY=1 vm/lab/make-install-folder.sh /tmp/x                               only the app and the LÉEME
#   DISK_GB=32 (default) is the size NEXUS grows into on its first boot.
# The folder: NEXUS OS.app (vm/mac-app/launcher.sh + the signed vm/runner), LÉEME.txt, Sistema/nexus-os.raw.
# The image comes from the builder (os/build.sh output) and is checked with sha256 against it before it is used.
set -euo pipefail
source "$(dirname "$0")/common.sh"
OUT=${1:?usage: make-install-folder.sh <folder>}
M="$NEXUS_REPO/vm/mac-app"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
A="$TMP/NEXUS OS.app"
mkdir -p "$A/Contents/MacOS" "$A/Contents/Resources" "$TMP/NEXUS.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$M/icon-1024.png" --out "$TMP/NEXUS.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$M/icon-1024.png" --out "$TMP/NEXUS.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/NEXUS.iconset" -o "$A/Contents/Resources/NEXUS.icns"
swiftc -O "$NEXUS_REPO/vm/runner/main.swift" -o "$A/Contents/MacOS/nexus-vm"
codesign --force --sign - --entitlements "$NEXUS_REPO/vm/runner/nexus-vm.entitlements" "$A/Contents/MacOS/nexus-vm"
version=$(sed -n 's/^ImageVersion=//p' "$NEXUS_REPO/os/mkosi.conf")
sed "s/<string>0\.[0-9]*\.[0-9]*<\/string>/<string>$version<\/string>/g" "$M/Info.plist" > "$A/Contents/Info.plist"
plutil -lint "$A/Contents/Info.plist" >/dev/null
install -m 0755 "$M/launcher.sh" "$A/Contents/MacOS/NEXUS OS"
mkdir -p "$OUT/Sistema"
# exFAT (the factory format of most external disks) is slow at the sparse writes of a first boot: the root partition
# grows to DISK_GB and the disk stalled for ~5 minutes on 2026-11-10 (systemd-sysusers timed out). Say so.
fs=$(diskutil info "$(df "$OUT" | awk 'NR==2{print $1}')" 2>/dev/null | sed -n 's/.*File System Personality: *//p')
case "$fs" in *ExFAT*|*FAT*) echo "aviso: «$OUT» está en un disco $fs; el primer arranque puede tardar 5 minutos (mejor APFS o el disco del Mac)" >&2 ;; esac
rm -rf "$OUT/NEXUS OS.app"
ditto --noextattr --noqtn "$A" "$OUT/NEXUS OS.app"
sed "s/^NEXUS OS 0\.[0-9]*\.[0-9]*/NEXUS OS $version/" "$M/LÉEME.txt" > "$OUT/LÉEME.txt"
codesign -v "$OUT/NEXUS OS.app/Contents/MacOS/nexus-vm"
echo "app $version ready in $OUT"
[ "${APP_ONLY:-0}" = 1 ] && exit 0

if pgrep -f "nexus-vm $OUT/Sistema/nexus-os.raw" >/dev/null; then echo "NEXUS OS is running from that folder: close it first" >&2; exit 1; fi
part="$OUT/Sistema/nexus-os.raw.part"
"$(dirname "$0")/builder.sh" ssh 'sudo cat ~/nexus-build/output/nexus-os.raw | gzip -1' | gunzip > "$part"
want=$("$(dirname "$0")/builder.sh" ssh 'sudo sha256sum ~/nexus-build/output/nexus-os.raw' | awk '{print $1}')
got=$(shasum -a 256 "$part" | awk '{print $1}')
[ "$want" = "$got" ] || { echo "the copy differs from the builder's image ($got != $want)" >&2; rm -f "$part"; exit 1; }
python3 -c 'import sys; f=open(sys.argv[1],"r+b"); f.truncate(int(sys.argv[2])*1024**3)' "$part" "${DISK_GB:-32}"
mv -f "$part" "$OUT/Sistema/nexus-os.raw"
echo "system $version (sha256 $want) in $OUT/Sistema/nexus-os.raw, ${DISK_GB:-32} GB"
