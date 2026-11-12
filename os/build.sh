#!/bin/bash
# Build the NEXUS OS disk image. Runs INSIDE the Debian builder VM, from the synced repo: os/build.sh
# Output: ~/nexus-build/output/nexus-os_<version>.raw, and ~/nexus-build/release-tree (what NEXUS Update ships).
#   NEXUS_VERSION=0.2.1 os/build.sh --tree-only   only stages the release tree (for os/update/nexus-release.ts publish)
#   NEXUS_ARCH=amd64 os/build.sh                  the image for PCs with Intel/AMD chips (x86-64; NEXUS on Windows in
#                                                 VirtualBox: vm/windows). Default arm64 (Macs with Apple chips).
#     An amd64 image is built on this arm64 builder: Rosetta for Linux runs its x86-64 programs (the packages' install
#     scripts, node, the compiler that builds labwc and the lock module). vm/lab/builder.sh starts the builder with
#     the Mac's Rosetta shared in (--rosetta); setup_foreign below registers it. Its work folder is ~/nexus-build-amd64.
set -euo pipefail
umask 022   # image files must not be group-writable (sshd StrictModes, and no one but root may change system files)
REPO=$(cd "$(dirname "$0")/.." && pwd)
ARCH=${NEXUS_ARCH:-arm64}                 # Debian's name for it
case "$ARCH" in
  arm64) MKOSI_ARCH=arm64;  NODE_ARCH=arm64; ELF_ARCH="ARM aarch64" ;;
  amd64) MKOSI_ARCH=x86-64; NODE_ARCH=x64;   ELF_ARCH="x86-64" ;;
  *) echo "NEXUS_ARCH must be arm64 or amd64" >&2; exit 2 ;;
esac
HOST_ARCH=$(dpkg --print-architecture)
FOREIGN=$([ "$ARCH" = "$HOST_ARCH" ] && echo 0 || echo 1)
WORK=${NEXUS_BUILD:-$HOME/nexus-build$([ "$FOREIGN" = 1 ] && echo "-$ARCH" || true)}   # (|| true: under set -e a false test here would stop the build without a word)
NODE_VERSION=24.20.0
NODE_TARBALL=${NODE_TARBALL:-/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz}
STAGE=$WORK/stage
is_target_elf() { file -b "$1" | grep -q "ELF 64-bit.*$ELF_ARCH"; }   # a program built for the image's architecture

# A foreign architecture: its programs run through Rosetta for Linux (the virtiofs share "rosetta"), registered with
# the F flag so it also works inside mkosi's sandbox and chroots; and the builder gets that architecture's C library,
# so the image's own node can run here (npm then picks the image's native packages, e.g. Claude Code's binary).
setup_foreign() {
  [ "$HOST_ARCH" = arm64 ] && [ "$ARCH" = amd64 ] || { echo "only amd64 images can be built on a foreign (arm64) builder" >&2; exit 2; }
  if [ ! -e /proc/sys/fs/binfmt_misc/rosetta ]; then
    mountpoint -q /mnt/rosetta || { sudo mkdir -p /mnt/rosetta; sudo mount -t virtiofs -o ro rosetta /mnt/rosetta; } || {
      echo "no Rosetta share: start the builder with vm/lab/builder.sh (it passes --rosetta to nexus-vm)" >&2; exit 1; }
    printf '%s\n' ':rosetta:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/mnt/rosetta/rosetta:CF' \
      | sudo tee /proc/sys/fs/binfmt_misc/register >/dev/null
  fi
  if ! dpkg -s "libc6:$ARCH" "libstdc++6:$ARCH" arch-test >/dev/null 2>&1; then   # arch-test: mmdebstrap's check
    sudo dpkg --add-architecture "$ARCH" && sudo apt-get -qq update
    sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y "libc6:$ARCH" "libstdc++6:$ARCH" arch-test >/dev/null
  fi
}
[ "$FOREIGN" = 1 ] && setup_foreign

# target_build SRC OUT PACKAGES COMMAND: run COMMAND for the image's architecture, in a copy of folder SRC, with $OUT
# the folder for its results. On the image's own architecture that is this builder; otherwise a fresh Debian trixie
# chroot of that architecture with PACKAGES (mmdebstrap; apt checks every package against the signed archive),
# removed afterwards. "build-dep:P" in PACKAGES installs P's build dependencies.
target_build() {
  local src=$1 out=$2 pkgs=$3 cmd=$4 bdeps="" p inc=""
  mkdir -p "$out"
  if [ "$FOREIGN" = 0 ]; then (cd "$src" && OUT="$out" sh -c "$cmd"); return; fi
  for p in ${pkgs//,/ }; do case "$p" in build-dep:*) bdeps="$bdeps ${p#build-dep:}" ;; *) inc="$inc,$p" ;; esac; done
  sudo mmdebstrap --quiet --arch="$ARCH" --variant=apt --include="build-essential,dpkg-dev,fakeroot,file$inc" \
    ${bdeps:+--customize-hook="chroot \"\$1\" apt-get -qq -y build-dep $bdeps >/dev/null"} \
    --customize-hook="mkdir -p \"\$1/work/out\"" --customize-hook="copy-in $src /work" \
    --customize-hook="chroot \"\$1\" sh -c 'cd /work/$(basename "$src") && export OUT=/work/out && $cmd'" \
    --customize-hook="sync-out /work/out $out" \
    trixie /dev/null "deb http://deb.debian.org/debian trixie main" "deb-src http://deb.debian.org/debian trixie main"
  sudo chown -R "$(id -u):$(id -g)" "$out"
}
# the version: NEXUS_VERSION, else mkosi.conf's ImageVersion. Goes to /usr/lib/nexus/VERSION and the image's os-release.
VERSION=${NEXUS_VERSION:-$(sed -n 's/^ImageVersion=//p' "$REPO/os/mkosi.conf")}
case "$VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "bad version $VERSION" >&2; exit 2 ;; esac
mkdir -p "$WORK/cache" "$WORK/output"
rm -rf "$STAGE"; mkdir -p "$STAGE/usr/lib/nexus/node/bin" "$STAGE/usr/lib/nexus/engine" "$STAGE/etc/ssh/authorized_keys"

# 1. Node runtime (node + npm/npx for the person's own projects). The tarball was verified against nodejs.org SHASUMS256 when downloaded.
if [ ! -f "$NODE_TARBALL" ]; then
  curl -fsSLo "$NODE_TARBALL" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz\$" | (cd "$(dirname "$NODE_TARBALL")" && sha256sum -c -)
fi
tar -xJf "$NODE_TARBALL" -C "$STAGE/usr/lib/nexus/node" --strip-components=1 --exclude='*/share/doc' --exclude='*/share/man' --exclude='*/README.md' --exclude='*/CHANGELOG.md'
# node, npm and npx for everyone; `npm i -g` goes to ~/.local (never into the runtime the NEXUS services use)
mkdir -p "$STAGE/usr/local/bin" "$STAGE/usr/lib/nexus/node/etc"
for b in node npm npx corepack; do ln -sf "/usr/lib/nexus/node/bin/$b" "$STAGE/usr/local/bin/$b"; done
# pnpm and yarn: corepack's shims (the first use downloads the manager; `corepack enable` would do the same links)
for b in pnpm pnpx yarn yarnpkg; do ln -sf "/usr/lib/nexus/node/lib/node_modules/corepack/dist/$b.js" "$STAGE/usr/local/bin/$b"; done
printf 'prefix=${HOME}/.local\nfund=false\nupdate-notifier=false\n' > "$STAGE/usr/lib/nexus/node/etc/npmrc"
is_target_elf "$STAGE/usr/lib/nexus/node/bin/node"
# npm runs on the image's own node from here on, so packages with native parts get the image's architecture
export PATH="$STAGE/usr/lib/nexus/node/bin:$PATH"

# 2. Engine code + its single npm dependency, installed exactly from the lockfile (integrity-checked by npm ci)
cp -r "$REPO/core" "$STAGE/usr/lib/nexus/engine/"
rm -rf "$STAGE/usr/lib/nexus/engine/core/test"
cp "$REPO/package.json" "$REPO/package-lock.json" "$STAGE/usr/lib/nexus/engine/"
(cd "$STAGE/usr/lib/nexus/engine" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

# 2b. Claude Code (the person asked for it, 09-11): pinned version from the npm registry (npm checks the package
#     integrity); only its native linux binary (the image's architecture) is kept. /usr/local/bin/claude (mkosi.extra) is a wrapper that turns
#     its self-updater off: new versions arrive with NEXUS updates. /etc/claude-code stays empty: agents get NEXUS's
#     policy bound there inside their sandbox only (usr/share/nexus/agents/claude).
CLAUDE_CODE_VERSION=2.1.311
CC=$(mktemp -d)
(cd "$CC" && printf '{"private":true}\n' > package.json && npm install --no-audit --no-fund --loglevel=error --omit=dev "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION")
"$CC/node_modules/.bin/claude" --version | grep -q "^$CLAUDE_CODE_VERSION "
is_target_elf "$CC/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
install -D -m 0755 "$CC/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$STAGE/usr/lib/nexus/claude-code/claude"
printf '%s\n' "$CLAUDE_CODE_VERSION" > "$STAGE/usr/lib/nexus/claude-code/VERSION"
rm -rf "$CC"
mkdir -p "$STAGE/etc/claude-code"

# 2c. labwc with NEXUS's window animations (os/labwc): a Debian package, rebuilt only when the patch changes. mkosi
#     installs it instead of Debian's (higher version from its local repo); /etc/apt/preferences.d/nexus-labwc keeps it.
PKGS=$WORK/packages
if [ "$(cat "$PKGS/labwc.patch-sha256" 2>/dev/null)" != "$(sha256sum "$REPO/os/labwc/nexus-animations.patch" | cut -d' ' -f1)" ] \
   || ! ls "$PKGS"/labwc_*+nexus*_"$ARCH".deb >/dev/null 2>&1; then
    target_build "$REPO/os/labwc" "$PKGS" "build-dep:labwc" 'sh build.sh "$OUT"'
fi

# 2d. The lock-screen module (os/lock-module) for a foreign architecture, rebuilt when its source changes; the arm64
#     one is the .so in mkosi.extra. The stage's copy replaces mkosi.extra's (mkosi copies --extra-tree after it).
#     Also the architecture's VS Code repository line, and no update channel yet: NEXUS Update releases are built per
#     architecture and this one has no channel of its own, so an arm64 update can never reach it (apt still works).
if [ "$FOREIGN" = 1 ]; then
  src_sum=$(cat "$REPO/os/lock-module/nexus-lockbar.c" "$REPO/os/lock-module/window.h" "$REPO/os/lock-module/build.sh" | sha256sum | cut -d' ' -f1)
  if [ "$(cat "$PKGS/lockbar.src-sha256" 2>/dev/null)" != "$src_sum" ] || [ ! -f "$PKGS/nexus-lockbar.so" ]; then
    target_build "$REPO/os/lock-module" "$WORK/lockbar" "pkg-config,libgtk-3-dev" 'sh build.sh "$OUT/nexus-lockbar.so"'
    install -m 0644 "$WORK/lockbar/nexus-lockbar.so" "$PKGS/nexus-lockbar.so" && rm -rf "$WORK/lockbar"
    printf '%s\n' "$src_sum" > "$PKGS/lockbar.src-sha256"
  fi
  is_target_elf "$PKGS/nexus-lockbar.so"
  install -D -m 0644 "$PKGS/nexus-lockbar.so" "$STAGE/usr/lib/nexus/nexus-lockbar.so"
  install -d "$STAGE/etc/apt/sources.list.d" "$STAGE/etc/nexus"
  sed "s/^Architectures: .*/Architectures: $ARCH/" "$REPO/os/mkosi.extra/etc/apt/sources.list.d/vscode.sources" \
    > "$STAGE/etc/apt/sources.list.d/vscode.sources"
  { sed '/^channel=/d' "$REPO/os/mkosi.extra/etc/nexus/update.conf"
    printf '# %s image: no channel yet (an empty channel means NEXUS Update never looks for releases).\nchannel=\n' "$ARCH"
  } > "$STAGE/etc/nexus/update.conf"
fi

# 3. Dev profile: the lab SSH public key (never stored in git; never part of an update either)
install -m 0644 "$HOME/.ssh/authorized_keys" "$STAGE/etc/ssh/authorized_keys/nexus"

# 3b. NEXUS Update (core/src/update.ts): the release tree = everything this image adds to Debian, which is what an
#     update may change; its manifest goes into the image as the updater's starting point, and NEXUS's own packages
#     are kept by the updater so "Deshacer" can put them back after an update replaced them.
printf '%s\n' "$VERSION" > "$STAGE/usr/lib/nexus/VERSION"
TREE=$WORK/release-tree
rm -rf "$TREE"; mkdir -p "$TREE"
cp -a "$REPO/os/mkosi.extra/." "$TREE/"
cp -a "$STAGE/." "$TREE/"
node --experimental-transform-types --disable-warning=ExperimentalWarning "$REPO/os/update/nexus-release.ts" factory \
  --tree "$TREE" --version "$VERSION" --debs "$PKGS" --out "$STAGE/usr/lib/nexus/update/factory.json"
install -d -m 0700 "$STAGE/var/lib/nexus-update/debs"
cp "$PKGS"/labwc_*+nexus*_"$ARCH".deb "$STAGE/var/lib/nexus-update/debs/"
if [ "${1:-}" = "--tree-only" ]; then echo "release tree $VERSION ready in $TREE"; exit 0; fi

# 3c. VS Code (the person asked for it, 09-11): Microsoft's package from its apt repository. apt checks the
#     repository's signature with the key that also goes into the image (etc/apt/keyrings/microsoft.asc, fingerprint
#     BC52 8686 B50D 79E3 39D3 721C EB3E 94AD BE12 29CF), using its own state folder so the builder's apt is never
#     touched; mkosi then installs it from the local package folder, like labwc. It is not part of NEXUS Update (only
#     +nexus packages are): an installed NEXUS gets new versions with `sudo apt upgrade` (etc/apt/sources.list.d/vscode.sources).
VSA=$WORK/vscode-apt
mkdir -p "$VSA/lists/partial" "$VSA/cache/archives/partial" "$VSA/parts"
printf 'deb [arch=%s signed-by=%s] https://packages.microsoft.com/repos/code stable main\n' \
  "$ARCH" "$REPO/os/mkosi.extra/etc/apt/keyrings/microsoft.asc" > "$VSA/sources.list"
VSAPT=(-o "Dir::Etc::SourceList=$VSA/sources.list" -o "Dir::Etc::SourceParts=$VSA/parts" -o "Dir::State::Lists=$VSA/lists"
       -o "Dir::Cache=$VSA/cache" -o Debug::NoLocking=1 -o APT::Architecture="$ARCH" -o APT::Architectures="$ARCH")
apt-get "${VSAPT[@]}" -qq update
(cd "$PKGS" && apt-get "${VSAPT[@]}" -qq download code)
ls -t "$PKGS"/code_*_"$ARCH".deb | tail -n +2 | xargs -r rm -f   # only the newest stays
echo "VS Code: $(ls "$PKGS"/code_*_"$ARCH".deb)"

# 4. Image
cd "$REPO/os"
sudo mkosi --force --architecture="$MKOSI_ARCH" --package="linux-image-$ARCH" --image-version="$VERSION" --extra-tree="$STAGE" --package-directory="$PKGS" --cache-directory="$WORK/cache" --output-directory="$WORK/output" build
ls -la "$WORK/output"
