# NEXUS OS Linux lab (Phase L0)

Code lives in this repo (internal disk). Heavy artefacts (VM disks, downloads, kernels, builds) live on the
`NEXUS-DEV` APFS sparsebundle at `/Volumes/Untitled/NEXUS-OS/` so they can be lost without losing code.

- `runner/main.swift` — Virtualization.framework runner. Build:
  `swiftc -O main.swift -o <vmroot>/nexus-vm && codesign --force --sign - --entitlements nexus-vm.entitlements <vmroot>/nexus-vm`.
  4 GB / 2 CPUs by default, NAT (outbound only), virtio-console on `<vmdir>/console.log` + FIFO `<vmdir>/console.in`,
  optional virtiofs share (`--share`, tag `host`).
- `tools/ext4extract.py` — read-only ext4 reader that pulls `/boot/vmlinuz*` and `initrd.img*` out of the official
  Debian image without mounting it (macOS cannot mount ext4).
- `tools/vmsay.sh` — type a line on the VM console and print the new output.
- Boot method: **direct kernel boot** (`VZLinuxBootLoader`) with the uncompressed arm64 `Image` + initrd from the image.
  EFI boot of the same image showed no console under Virtualization.framework, so it is not used.
- Boot cmdline: `root=PARTUUID=2be4fa79-0b11-483e-8483-73a398c9b555 rw console=hvc0 systemd.show_status=1`.

Image: official `debian-13-nocloud-arm64.tar.xz` (cloud.debian.org) verified against the official `SHA512SUMS`.
Netboot installer kernel/initrd (used to validate the runner) verified against the official `SHA256SUMS`.

## Install folders (for the person's own computers)

- **Mac (Apple chips):** `vm/lab/make-install-folder.sh "<folder>"` → `NEXUS OS.app` (vm/mac-app + the runner),
  `LÉEME.txt`, `Sistema/nexus-os.raw` (the builder's arm64 image).
- **Windows PC (Intel/AMD):** `vm/lab/make-windows-folder.sh "<folder>"` → `Abrir NEXUS.bat`, `LÉEME.txt`,
  `Sistema/nexus-windows.ps1` (vm/windows), `Sistema/nexus-os.vdi` (the builder's amd64 image as a dynamic VirtualBox
  disk). The image is built on the arm64 builder with `NEXUS_ARCH=amd64 os/build.sh`: the runner shares the Mac's
  Rosetta for Linux with the builder (`--rosetta`, vm/lab/builder.sh) and the build registers it for x86-64 programs.
  The person installs VirtualBox 7+ once; the script creates the VM (EFI, VMSVGA, USB tablet, NAT) on first use,
  sets the firmware screen to the PC's screen shape (the image's nexus-boot-display passes it on to the desktop) and
  re-attaches the disk when the folder moves (another drive letter, a copy on the PC).
