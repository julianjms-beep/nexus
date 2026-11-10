#!/bin/bash
# Run on the builder: boot the amd64 NEXUS image (its VDI) in qemu (x86-64 emulated), hardware like VirtualBox's:
# EFI, AHCI disk, e1000 network, USB tablet + keyboard, VMware SVGA display. Changes go to a qcow2 overlay.
#   x86test.sh start [vga]   |  shot FILE.ppm  |  stop  |  status
# Copy it to the builder and run it there (the amd64 output must be on a work disk: DATA=<raw> vm/lab/builder.sh start).
# Use "start std": qemu's VMware SVGA has no pitchlock and vmwgfx refuses it (black screen); real VirtualBox is fine.
set -eu
T=/var/tmp/nx86
OUT=$HOME/nexus-build-amd64/output
case "${1:-status}" in
  start)
    mkdir -p "$T"
    pkill -f "qemu-system-x86_64 .*nx86" 2>/dev/null || true
    rm -f "$T/overlay.qcow2" "$T/vars.fd" "$T/mon.sock"
    qemu-img create -q -f qcow2 -b "$OUT/nexus-os.vdi" -F vdi "$T/overlay.qcow2"
    cp /usr/share/OVMF/OVMF_VARS_4M.fd "$T/vars.fd"
    qemu-system-x86_64 -name nx86 -machine q35 -accel tcg,thread=multi -cpu max -smp 4 -m 3072 \
      -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
      -drive if=pflash,format=raw,file="$T/vars.fd" \
      -device ahci,id=ahci -drive id=d0,if=none,file="$T/overlay.qcow2",format=qcow2 -device ide-hd,drive=d0,bus=ahci.0 \
      -netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22 -device e1000,netdev=n0 \
      -device qemu-xhci -device usb-tablet -device usb-kbd \
      -vga "${2:-vmware}" -display none \
      -serial file:"$T/serial.log" -monitor unix:"$T/mon.sock",server,nowait -daemonize
    echo "started (vga ${2:-vmware})" ;;
  shot)
    python3 - "$T/mon.sock" "$2" <<'PY'
import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); time.sleep(0.3); s.recv(65536)
s.sendall(f"screendump {sys.argv[2]}\n".encode()); time.sleep(1.5); s.recv(65536); s.close()
PY
    ls -la "$2" ;;
  stop) pkill -f "qemu-system-x86_64 .*nx86" && echo stopped || echo "not running" ;;
  status) pgrep -fa "qemu-system-x86_64 .*nx86" || echo "not running" ;;
esac
