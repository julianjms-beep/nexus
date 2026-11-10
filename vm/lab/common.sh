# Shared settings for the NEXUS OS lab scripts. Source it; do not run it.
# Heavy artefacts live outside the repo, on the internal SSD (the external USB disk is for backups only:
# it corrupted two VM volumes under load in October 2026).
set -euo pipefail
NEXUS_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NEXUS_LAB="${NEXUS_LAB:-$HOME/nexus-lab}"
NEXUS_VM="$NEXUS_LAB/bin/nexus-vm"
NEXUS_KEY="$NEXUS_LAB/ssh/id_ed25519"
BUILDER_MAC="52:54:00:4e:58:01"
NEXUSOS_MAC="52:54:00:4e:58:02"
MIN_FREE_GB="${MIN_FREE_GB:-8}"

# Abort before heavy work if the internal disk is getting full.
check_free() {
  local free_gb; free_gb=$(df -g "$NEXUS_LAB" | awk 'NR==2{print $4}')
  if (( free_gb < MIN_FREE_GB )); then echo "only ${free_gb} GB free on the host (minimum ${MIN_FREE_GB}); stopping" >&2; exit 3; fi
}

# IP address the macOS NAT DHCP server gave to a guest, by hostname or MAC (newest lease first in the file).
# systemd-networkd sends a DUID client id, so the hostname is the reliable key; bootpd strips leading zeros in MACs.
lease_ip() {
  local name="$1" mac="${2:-}"
  [ -n "$mac" ] && mac=$(echo "$mac" | awk -F: '{for(i=1;i<=NF;i++){sub(/^0/,"",$i)}; OFS=":"; $1=$1; print}')
  awk -v n="$name" -v m="1,$mac" '/^\{/{ip="";hw="";nm=""} /name=/{split($0,a,"=");nm=a[2]} /ip_address=/{split($0,a,"=");ip=a[2]}
    /hw_address=/{split($0,a,"=");hw=a[2]} /^\}/{if(found=="" && (nm==n || hw==m))found=ip} END{if(found!="")print found}' /var/db/dhcpd_leases 2>/dev/null
}

SSH_OPTS=(-i "$NEXUS_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 -o ServerAliveInterval=15)
