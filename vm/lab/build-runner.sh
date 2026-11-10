#!/bin/bash
# Compile and ad-hoc sign the Virtualization.framework runner (the virtualization entitlement is mandatory).
# Built next to the old one and moved over it, so a VM that is running from the old binary keeps working.
source "$(dirname "$0")/common.sh"
mkdir -p "$NEXUS_LAB/bin"
swiftc -O "$NEXUS_REPO/vm/runner/main.swift" -o "$NEXUS_VM.new"
codesign --force --sign - --entitlements "$NEXUS_REPO/vm/runner/nexus-vm.entitlements" "$NEXUS_VM.new"
mv -f "$NEXUS_VM.new" "$NEXUS_VM"
echo "built $NEXUS_VM"
