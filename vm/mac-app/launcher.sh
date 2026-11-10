#!/bin/bash
# NEXUS OS.app: opens NEXUS OS in a window, next to macOS (nothing is installed over macOS).
# The system is the file «Sistema/nexus-os.raw» in the same folder as this app. Small working files (startup
# settings, log) live in ~/Library/Application Support/NEXUS OS, because the external drive (exFAT) cannot hold them.
APP="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$(dirname "$APP")"
DISK="${NEXUS_DISK:-$HERE/Sistema/nexus-os.raw}"
STATE="${NEXUS_STATE:-$HOME/Library/Application Support/NEXUS OS}"
if [ ! -f "$DISK" ]; then
  /usr/bin/osascript -e 'display alert "No encuentro el sistema de NEXUS OS" message "Tiene que estar la carpeta «Sistema» (con nexus-os.raw) junto a la app. Si NEXUS está en tu disco duro, conéctalo primero." as critical' >/dev/null 2>&1
  exit 1
fi
mkdir -p "$STATE"
exec "$(dirname "$0")/nexus-vm" "$DISK" "$STATE" --gui --size 1920x1200 --mac 52:54:00:4e:58:10 --mem-gb 5 --cpus 6
