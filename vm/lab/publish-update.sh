#!/bin/bash
# The lab channel of NEXUS Update, on the builder VM (served only on the VMs' private network, port 8090; never on
# the Internet). The signing key stays on the builder: ~/.nexus-keys/update-dev.pem.
#
#   vm/lab/publish-update.sh register            after building an image: its factory manifest becomes a release of
#                                                the channel, so the next update has a small bundle from that image
#   vm/lab/publish-update.sh 0.2.1 notes.txt     publish NEXUS OS 0.2.1 from the current repo: stage the release tree
#                                                (os/build.sh --tree-only), make the bundles + signed latest.json.
#                                                notes.txt: one change per line, in Spanish (Ajustes shows them).
#   FULL=1 vm/lab/publish-update.sh 0.2.1 notes.txt   also a bundle with everything (for machines the channel
#                                                does not know; a few hundred MB)
set -euo pipefail
cd "$(dirname "$0")/../.."
source vm/lab/common.sh
# macOS keeps its VMs apart (the NEXUS OS VM cannot reach the builder), so the Mac passes the channel on: an ssh
# forward that listens only on the Mac's address on the VMs' private network (bridge100), never on the Mac's LAN.
GW=192.168.64.1
forward() {
  nc -z -G 2 "$GW" 8090 2>/dev/null && return 0
  local b; b=$(vm/lab/builder.sh ip)
  ssh "${SSH_OPTS[@]}" -f -N -o ExitOnForwardFailure=yes -L "$GW:8090:$b:8090" "nexus@$b"
  echo "el Mac pasa el canal: http://$GW:8090/nexus/stable/ (solo en la red de las VMs)"
}
CH='~/nexus-channel/nexus/stable'
REL='node --experimental-transform-types --disable-warning=ExperimentalWarning os/update/nexus-release.ts'
serve='ip=$(ip -4 -o addr show scope global | awk "{print \$4}" | cut -d/ -f1 | head -1)
  systemctl --user is-active --quiet nexus-channel || systemd-run --user --unit=nexus-channel --quiet \
    python3 -m http.server 8090 --bind "$ip" --directory "$HOME/nexus-channel"
  echo "canal: http://$ip:8090/nexus/stable/"'

if [ "${1:-}" = register ]; then
  vm/lab/sync-repo.sh >/dev/null
  vm/lab/builder.sh ssh "set -e; cd ~/nexus-os; mkdir -p $CH
    $REL register --manifest ~/nexus-build/stage/usr/lib/nexus/update/factory.json --channel $CH
    $serve"
  forward
  exit 0
fi

V=${1:?versión, p. ej. 0.2.1}; NOTES=${2:?archivo de notas: un cambio por línea}
[ -s "$NOTES" ] || { echo "las notas están vacías" >&2; exit 2; }
vm/lab/sync-repo.sh >/dev/null
vm/lab/builder.sh ssh "cat > /tmp/nexus-notes.txt" < "$NOTES"
vm/lab/builder.sh ssh "set -e; cd ~/nexus-os; mkdir -p $CH
  NEXUS_VERSION=$V ./os/build.sh --tree-only > ~/nexus-build/tree.log 2>&1 || { tail -20 ~/nexus-build/tree.log; exit 1; }
  $REL publish --tree ~/nexus-build/release-tree --version $V --channel $CH \
    --key ~/.nexus-keys/update-dev.pem --notes /tmp/nexus-notes.txt --debs ~/nexus-build/packages --post os/update/post.sh ${FULL:+--full}
  $serve"
forward
