#!/bin/bash
# Builder VM (Debian 13 arm64 genericcloud): start | stop | ssh [cmd...] | ip | status
# DATA=<raw> start: also attach that disk (/dev/vdc in the builder): extra room for a big build, e.g. on an external drive
source "$(dirname "$0")/common.sh"
B="$NEXUS_LAB/builder"
case "${1:-status}" in
  start)
    check_free
    [ -f "$B/seed.iso" ] || "$(dirname "$0")/make-seed.sh" "$B/seed.iso" nexus-builder
    if pgrep -f "nexus-vm $B/builder.raw" >/dev/null; then echo "already running"; exit 0; fi
    nohup "$NEXUS_VM" "$B/builder.raw" "$B/run" --seed "$B/seed.iso" --mac "$BUILDER_MAC" \
      --mem-gb "${MEM_GB:-6}" --cpus "${CPUS:-6}" --rosetta ${DATA:+--data "$DATA"} > "$B/runner.log" 2>&1 &
    echo "started pid $!"
    for i in $(seq 1 90); do
      ip=$(lease_ip nexus-builder "$BUILDER_MAC"); if [ -n "$ip" ] && ssh "${SSH_OPTS[@]}" "nexus@$ip" true 2>/dev/null; then echo "ssh ready at $ip"; exit 0; fi
      sleep 2
    done
    echo "guest did not answer on ssh in 180 s; see $B/runner.log and $B/run/console.log" >&2; exit 1 ;;
  stop) pkill -TERM -f "nexus-vm $B/builder.raw" && echo "stop requested" || echo "not running" ;;
  ip) lease_ip nexus-builder "$BUILDER_MAC" ;;
  ssh) shift; ip=$(lease_ip nexus-builder "$BUILDER_MAC"); exec ssh "${SSH_OPTS[@]}" "nexus@$ip" "$@" ;;
  status) pgrep -fl "nexus-vm $B/builder.raw" || echo "not running" ;;
esac
