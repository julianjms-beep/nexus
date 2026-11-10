#!/bin/bash
# Copy the working tree (including .git) into the builder VM at ~/nexus-os. Never copies node_modules or build output.
source "$(dirname "$0")/common.sh"
ip=$(lease_ip nexus-builder "$BUILDER_MAC")
rsync -a --delete -e "ssh ${SSH_OPTS[*]}" --exclude node_modules --exclude target --exclude .DS_Store \
  --exclude 'mkosi/mkosi.output' --exclude 'mkosi/mkosi.cache' "$NEXUS_REPO/" "nexus@$ip:nexus-os/"
echo "synced to $ip:nexus-os"
