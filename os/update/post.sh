#!/bin/sh
# NEXUS Update's installation script (vm/lab/publish-update.sh passes it with --post; nexus-updated runs it as root
# after the new files are in place, with a 5-minute limit). NEXUS Update only replaces NEXUS's own files, so what a
# new image gets from os/mkosi.conf and os/mkosi.postinst.chroot has to be done here for computers already installed:
# Debian packages that are new, groups, and services to enable. Everything is safe to run again (each step first
# looks at what is already there), so the same script travels with every release.
#
# It never fails the update for something optional: a computer without Internet keeps working as before, and
# Ajustes → Privacidad y seguridad says what is still missing ("Falta el cortafuegos"…).
set -u
export DEBIAN_FRONTEND=noninteractive
log() { echo "nexus post: $*"; }

# ---- Debian packages the image has and an installed computer may not
want="nftables swayidle network-manager wpasupplicant iw rfkill bluez pipewire pipewire-pulse pipewire-alsa wireplumber rtkit power-profiles-daemon brightnessctl playerctl"
# the firmware for real Wi-Fi and Bluetooth chips is big and useless inside a virtual machine
if ! systemd-detect-virt -q; then
  want="$want firmware-iwlwifi firmware-realtek firmware-mediatek firmware-atheros firmware-brcm80211"
fi
missing=
for p in $want; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || missing="$missing $p"
done
if [ -n "$missing" ]; then
  log "installing:$missing"
  # the security packages first and on their own: they are small, and a slow network must not leave them out
  first= rest=
  for p in $missing; do case "$p" in nftables | swayidle) first="$first $p" ;; *) rest="$rest $p" ;; esac; done
  timeout 60 apt-get update -q >/dev/null 2>&1 || log "could not refresh the package lists (no Internet?)"
  [ -n "$first" ] && { timeout 90 apt-get install -y -q --no-install-recommends $first >/dev/null 2>&1 || log "could not install:$first"; }
  [ -n "$rest" ] && { timeout 130 apt-get install -y -q --no-install-recommends $rest >/dev/null 2>&1 || log "could not install:$rest (Ajustes → Actualizaciones → Debian will offer them again)"; }
fi

# ---- groups of the people of this computer (Wi-Fi, Bluetooth and the power mode from the menu bar)
for g in netdev bluetooth; do
  getent group "$g" >/dev/null || groupadd -r "$g"
  for u in $(awk -F: '$3 >= 1000 && $3 < 60000 && $7 !~ /(nologin|false)$/ { print $1 }' /etc/passwd); do
    id -nG "$u" | tr ' ' '\n' | grep -qx "$g" || usermod -aG "$g" "$u"
  done
done

# ---- services
systemctl daemon-reload
# the firewall and the guard (Ajustes → Privacidad y seguridad). The firewall keeps SSH's port open exactly when SSH
# is enabled, so a computer administered over the network is not cut off by this update.
if [ -x /usr/sbin/nft ]; then
  systemctl enable nexus-firewall.service >/dev/null 2>&1
  systemctl restart nexus-firewall.service || log "the firewall did not start"
fi
systemctl enable nexus-guardd.service >/dev/null 2>&1
systemctl restart nexus-guardd.service || log "the guard did not start"
for s in NetworkManager.service bluetooth.service power-profiles-daemon.service; do
  systemctl cat "$s" >/dev/null 2>&1 && systemctl enable --now "$s" >/dev/null 2>&1
done
# the kernel protections of /usr/lib/sysctl.d/70-nexus-hardening.conf and the new name-resolution settings, now
sysctl --system >/dev/null 2>&1 || true
systemctl try-restart systemd-resolved.service >/dev/null 2>&1 || true
# the new sshd options (keys only, few tries): only if the file is right, and never dropping who is connected
if systemctl is-active --quiet ssh.service && sshd -t 2>/dev/null; then systemctl reload ssh.service >/dev/null 2>&1 || true; fi

# ---- each open desktop: the automatic lock starts now instead of at the next login
for d in /run/user/*; do
  uid=${d##*/}
  case "$uid" in '' | *[!0-9]*) continue ;; esac
  [ "$uid" -ge 1000 ] || continue
  user=$(id -nu "$uid" 2>/dev/null) || continue
  systemctl --user -M "$user@" daemon-reload >/dev/null 2>&1
  systemctl --user -M "$user@" is-active --quiet nexus-session.target 2>/dev/null && systemctl --user -M "$user@" start nexus-idle.service >/dev/null 2>&1
done
log "done"
exit 0
