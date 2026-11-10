#!/bin/sh
# Build labwc with NEXUS's window animations (nexus-animations.patch) as a Debian package, on the builder VM
# (Debian trixie, arm64; the image's release and architecture). os/build.sh runs it when the patch changes:
#   os/labwc/build.sh OUTDIR   →   OUTDIR/labwc_0.8.3-1+nexus1_arm64.deb   (+ OUTDIR/labwc.patch-sha256)
# The image installs that package instead of Debian's (mkosi --package-directory), and an apt pin
# (/etc/apt/preferences.d/nexus-labwc) keeps Debian's labwc from replacing it later: new labwc versions come with
# NEXUS updates. Needs deb-src entries, dpkg-dev and labwc's build dependencies (sudo apt-get build-dep labwc).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: os/labwc/build.sh OUTDIR}
mkdir -p "$out"
out=$(cd "$out" && pwd)
DEBIAN_VERSION=0.8.3-1
VERSION=$DEBIAN_VERSION+nexus1   # "+nexus" sorts above Debian's own "+deb13uN" fixes of the same release
patch="$here/nexus-animations.patch"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
# apt checks the source files against the signed Debian archive index before unpacking them
apt-get source -q --download-only "labwc=$DEBIAN_VERSION" >/dev/null
dpkg-source -x -q "labwc_$DEBIAN_VERSION.dsc" src >/dev/null
cd src
patch -p1 -s --no-backup-if-mismatch < "$patch"
dpkg-checkbuilddeps
{
    printf 'labwc (%s) trixie; urgency=medium\n\n' "$VERSION"
    printf '  * NEXUS OS: window animations (open, close, minimize to the dock, restore),\n'
    printf '    from os/labwc/nexus-animations.patch in the NEXUS OS repository.\n\n'
    printf ' -- NEXUS OS <nexus@nexus.invalid>  %s\n\n' "$(date -R)"
    cat debian/changelog
} > debian/changelog.new
mv debian/changelog.new debian/changelog
DEB_BUILD_OPTIONS="nocheck parallel=$(nproc)" dpkg-buildpackage -b -uc -us >"$work/build.log" 2>&1 || {
    tail -40 "$work/build.log" >&2
    exit 1
}
deb="labwc_${VERSION}_$(dpkg --print-architecture).deb"
dpkg-deb -c "../$deb" > "$work/contents"
grep -q ' ./usr/bin/labwc$' "$work/contents"
find "$out" -maxdepth 1 -name 'labwc_*+nexus*.deb' ! -name "$deb" -exec rm -f {} +   # one version in mkosi's repo
install -m 0644 "../$deb" "$out/$deb"
sha256sum "$patch" | cut -d' ' -f1 > "$out/labwc.patch-sha256"
echo "built $out/$deb"
