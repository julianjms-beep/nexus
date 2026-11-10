#!/bin/bash
# Build a cloud-init NoCloud seed ISO: user "nexus" with the lab SSH key, passwordless sudo, no password logins.
# usage: make-seed.sh <out.iso> <hostname>
source "$(dirname "$0")/common.sh"
out="$1"; host="$2"
[ -f "$NEXUS_KEY" ] || ssh-keygen -q -t ed25519 -N "" -C nexus-lab -f "$NEXUS_KEY"
dir=$(mktemp -d)
cat > "$dir/meta-data" <<META
instance-id: $host-$(date +%s)
local-hostname: $host
META
cat > "$dir/user-data" <<USER
#cloud-config
hostname: $host
users:
  - name: nexus
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$NEXUS_KEY.pub")
disable_root: true
ssh_pwauth: false
growpart: {mode: auto, devices: ["/"]}
resize_rootfs: true
USER
rm -f "$out"
hdiutil makehybrid -quiet -iso -joliet -default-volume-name cidata -o "$out" "$dir"
rm -rf "$dir"
echo "seed: $out"
