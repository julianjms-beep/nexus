#!/bin/bash
# NEXUS OS test VM on the Mac: fetch | start | stop | ip | ssh [cmd...] | shot [out.png] | push | status
#   fetch  copy the image built in the builder VM (os/build.sh) to ~/nexus-lab/nexusos/disk.raw and grow it (sparse)
#   start  boot it in a window (virtio-gpu, keyboard, tablet), wait for SSH
#   shot   screenshot of the running desktop (grim inside the guest)
#   push   copy the current shell/apps QML and Engine code into the running VM and restart them (fast iteration)
source "$(dirname "$0")/common.sh"
D="$NEXUS_LAB/nexusos"
mkdir -p "$D"
ip() { lease_ip nexus "$NEXUSOS_MAC"; }
guest() { local a; a=$(ip); [ -n "$a" ] || { echo "no lease for the NEXUS OS VM yet" >&2; exit 1; }; ssh "${SSH_OPTS[@]}" "nexus@$a" "$@"; }
case "${1:-status}" in
  fetch)
    check_free
    if pgrep -f "nexus-vm $D/disk.raw" >/dev/null; then echo "stop the VM first" >&2; exit 1; fi
    "$(dirname "$0")/builder.sh" ssh 'sudo cat ~/nexus-build/output/nexus-os.raw | gzip -1' | gunzip > "$D/disk.raw.new"
    python3 -c 'import sys; f=open(sys.argv[1],"r+b"); f.truncate(int(sys.argv[2])*1024**3)' "$D/disk.raw.new" "${DISK_GB:-24}"
    mv -f "$D/disk.raw.new" "$D/disk.raw"
    rm -f "$D/run/efi-vars"   # boot entries of the previous image are meaningless for the new one
    ls -lhs "$D/disk.raw" ;;
  start)
    check_free
    if pgrep -f "nexus-vm $D/disk.raw" >/dev/null; then echo "already running"; exit 0; fi
    # 1920x1200: a sharp 960x600-point window on a Retina Mac; NEXUS picks 150 % (1280x800 points, like the concept).
    # Measured frame times (software rendering): 13 ms median at 1920x1200, 21 ms at 2400x1500. SIZE=... overrides.
    nohup "$NEXUS_VM" "$D/disk.raw" "$D/run" --gui --size "${SIZE:-1920x1200}" --mac "$NEXUSOS_MAC" \
      --mem-gb "${MEM_GB:-5}" --cpus "${CPUS:-6}" > "$D/runner.log" 2>&1 &
    echo "started pid $!"
    for i in $(seq 1 90); do
      a=$(ip); if [ -n "$a" ] && ssh "${SSH_OPTS[@]}" "nexus@$a" true 2>/dev/null; then echo "ssh ready at $a"; exit 0; fi
      sleep 2
    done
    echo "no SSH after 180 s; see $D/runner.log and $D/run/console.log" >&2; exit 1 ;;
  stop) pkill -TERM -f "nexus-vm $D/disk.raw" && echo "stop requested" || echo "not running" ;;
  ip) ip ;;
  ssh) shift; guest "$@" ;;
  shot)
    out="${2:-$D/shot.png}"
    guest 'XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim -t png -' > "$out" && echo "$out" ;;
  push)
    export COPYFILE_DISABLE=1   # no macOS ._ files or xattrs in the tarballs
    t() { tar --no-xattrs -C "$1" -cf - "${@:3}" | guest "sudo tar -C $2 -xf - --no-same-owner"; }
    t "$NEXUS_REPO/os/mkosi.extra/usr/share/nexus" /usr/share/nexus .
    t "$NEXUS_REPO/os/mkosi.extra/usr/share/themes" /usr/share/themes .
    t "$NEXUS_REPO/os/mkosi.extra/usr/share/locale" /usr/share/locale .
    t "$NEXUS_REPO/os/mkosi.extra/usr/bin" /usr/bin .
    t "$NEXUS_REPO/os/mkosi.extra/etc/xdg" /etc/xdg .
    t "$NEXUS_REPO/core" /usr/lib/nexus/engine/core src
    # labwc re-reads its config/theme on SIGHUP
    guest 'sudo systemctl restart nexus-engined && XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart nexus-sessiond nexus-shell && { pkill -HUP -x labwc || true; }' && echo pushed ;;
  status) pgrep -fl "nexus-vm $D/disk.raw" || echo "not running" ;;
esac
