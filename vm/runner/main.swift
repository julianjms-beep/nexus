// nexus-vm: Virtualization.framework runner for the NEXUS OS Linux lab and for booting NEXUS OS images.
//
// Usage: nexus-vm <disk.raw> <vmdir> [options]
//   --kernel K --initrd I --cmdline "..."   direct kernel boot (otherwise UEFI boot with <vmdir>/efi-vars)
//   --mem-gb N  --cpus N                    defaults 4 GB / 2 CPUs
//   --mac 52:54:00:xx:xx:xx                 fixed MAC so the host can find the guest's DHCP lease
//   --seed <iso>                            read-only extra disk (cloud-init NoCloud seed)
//   --data <img>                            extra read-write raw disk
//   --share <dir>                           virtiofs share, tag "host"
//   --rosetta                               Apple's Rosetta for Linux as virtiofs tag "rosetta" (run x86-64 programs;
//                                           the builder uses it to build the x86-64 NEXUS image: os/build.sh)
//   --gui [--size 1440x900]                 open a window with a virtio-gpu display, USB keyboard and tablet
//
// Serial console (hvc0): output -> <vmdir>/console.log, input <- FIFO <vmdir>/console.in.
// Network: NAT. The guest can reach the Internet; nothing on the host is exposed (no port forwarding).
import AppKit
import Foundation
import Virtualization

var args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let v = args[i + 1]; args.removeSubrange(i...(i + 1)); return v
}
func flag(_ name: String) -> Bool {
    guard let i = args.firstIndex(of: name) else { return false }
    args.remove(at: i); return true
}
func fail(_ msg: String) -> Never { FileHandle.standardError.write(Data((msg + "\n").utf8)); exit(2) }

let share = opt("--share"), dataPath = opt("--data"), seedPath = opt("--seed")
let kernelPath = opt("--kernel"), initrdPath = opt("--initrd")
let cmdline = opt("--cmdline") ?? "console=hvc0"
let memGB = UInt64(opt("--mem-gb") ?? "4") ?? 4
let cpus = Int(opt("--cpus") ?? "2") ?? 2
let mac = opt("--mac")
let gui = flag("--gui")
let rosetta = flag("--rosetta")
let size = (opt("--size") ?? "1440x900").split(separator: "x").compactMap { Int($0) }
guard args.count == 2 else { fail("usage: nexus-vm <disk.raw> <vmdir> [--gui] [--mac M] [--seed iso] [--kernel K --initrd I --cmdline C] [--mem-gb N] [--cpus N]") }
guard size.count == 2 else { fail("--size must look like 1440x900") }

let diskURL = URL(fileURLWithPath: args[0]), vmDir = URL(fileURLWithPath: args[1])
try? FileManager.default.createDirectory(at: vmDir, withIntermediateDirectories: true)
let logURL = vmDir.appendingPathComponent("console.log"), inPath = vmDir.appendingPathComponent("console.in").path
FileManager.default.createFile(atPath: logURL.path, contents: nil)
unlink(inPath); mkfifo(inPath, 0o600)
let inFD = open(inPath, O_RDWR)
let outHandle = try FileHandle(forWritingTo: logURL)

let cfg = VZVirtualMachineConfiguration()
cfg.cpuCount = cpus
cfg.memorySize = memGB * 1024 * 1024 * 1024
let platform = VZGenericPlatformConfiguration()
let idURL = vmDir.appendingPathComponent("machine-id")
if let d = try? Data(contentsOf: idURL), let id = VZGenericMachineIdentifier(dataRepresentation: d) { platform.machineIdentifier = id }
else { try platform.machineIdentifier.dataRepresentation.write(to: idURL) }
cfg.platform = platform

if let kernelPath {
    let lb = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernelPath))
    if let initrdPath { lb.initialRamdiskURL = URL(fileURLWithPath: initrdPath) }
    lb.commandLine = cmdline
    cfg.bootLoader = lb
} else {
    let boot = VZEFIBootLoader()
    let nvramURL = vmDir.appendingPathComponent("efi-vars")
    boot.variableStore = FileManager.default.fileExists(atPath: nvramURL.path)
        ? VZEFIVariableStore(url: nvramURL) : try VZEFIVariableStore(creatingVariableStoreAt: nvramURL)
    cfg.bootLoader = boot
}

// Caching MUST be .cached: with .automatic the VirtIO block backend can return stale zeros when reading sparse
// image regions right after writing them (read-after-write incoherence), which corrupts ext4 and crashes binaries
// (I/O errors, SIGILL/SIGSEGV). That was the real cause of the October 2026 "disk corruption" in this lab.
// Same fix as UTM (utmapp/UTM#5919) and Apple's containerization project. Sync stays .fsync for durability.
func blockDevice(_ path: String, readOnly: Bool) throws -> VZVirtioBlockDeviceConfiguration {
    let a = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: path), readOnly: readOnly,
                                                   cachingMode: .cached, synchronizationMode: .fsync)
    return VZVirtioBlockDeviceConfiguration(attachment: a)
}
var disks = [try blockDevice(diskURL.path, readOnly: false)]
if let seedPath { disks.append(try blockDevice(seedPath, readOnly: true)) }
if let dataPath { disks.append(try blockDevice(dataPath, readOnly: false)) }
cfg.storageDevices = disks

let net = VZVirtioNetworkDeviceConfiguration()
net.attachment = VZNATNetworkDeviceAttachment()
if let mac { guard let m = VZMACAddress(string: mac) else { fail("bad --mac") }; net.macAddress = m }
cfg.networkDevices = [net]

let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: FileHandle(fileDescriptor: inFD), fileHandleForWriting: outHandle)
cfg.serialPorts = [serial]
cfg.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
cfg.socketDevices = [VZVirtioSocketDeviceConfiguration()]

var shares: [VZDirectorySharingDeviceConfiguration] = []
if let share {
    let fs = VZVirtioFileSystemDeviceConfiguration(tag: "host")
    fs.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: share), readOnly: false))
    shares.append(fs)
}
if rosetta {
    guard VZLinuxRosettaDirectoryShare.availability == .installed else { fail("Rosetta for Linux is not installed (softwareupdate --install-rosetta)") }
    let fs = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
    fs.share = try VZLinuxRosettaDirectoryShare()
    shares.append(fs)
}
cfg.directorySharingDevices = shares
if gui {
    let g = VZVirtioGraphicsDeviceConfiguration()
    g.scanouts = [VZVirtioGraphicsScanoutConfiguration(widthInPixels: size[0], heightInPixels: size[1])]
    cfg.graphicsDevices = [g]
    cfg.keyboards = [VZUSBKeyboardConfiguration()]
    cfg.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    let sound = VZVirtioSoundDeviceConfiguration()
    let out = VZVirtioSoundDeviceOutputStreamConfiguration(); out.sink = VZHostAudioOutputStreamSink()
    sound.streams = [out]
    cfg.audioDevices = [sound]
}
do { try cfg.validate() } catch { fail("invalid VM configuration: \(error)") }

let vm = VZVirtualMachine(configuration: cfg)
final class Delegate: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ vm: VZVirtualMachine) { print("guest stopped"); fflush(stdout); exit(0) }
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError e: Error) { print("vm error: \(e)"); fflush(stdout); exit(1) }
}
let delegate = Delegate(); vm.delegate = delegate

// Clean shutdown on SIGTERM/SIGINT or window close: ask the guest to power off, force-stop after 25 s.
func requestShutdown() {
    print("stopping guest"); fflush(stdout)
    if vm.canRequestStop { try? vm.requestStop() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 25) { vm.stop { _ in exit(0) } }
}
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { requestShutdown() }
    src.resume()
    signalSources.append(src)
}

func startVM() {
    vm.start { r in
        switch r {
        case .success:
            print("vm started; console: \(logURL.path) (in: \(inPath))"); fflush(stdout)
            if gui, let sock = vm.socketDevices.first as? VZVirtioSocketDevice { startClipboard(sock) }
        case .failure(let e): print("start failed: \(e)"); fflush(stdout); exit(1)
        }
    }
}

// Copy and paste with the guest (text only, at most 1 MiB) over vsock, the VM's private channel to this process:
// nothing is exposed on the network. The guest's nexus-clipboard-bridge listens on port 7781 for the Mac's text and
// sends every NEXUS copy to port 7780 here. The Mac's clipboard is only read while the NEXUS OS window is in front.
final class Clipboard: NSObject, VZVirtioSocketListenerDelegate {
    static let limit = 1 << 20
    let device: VZVirtioSocketDevice
    let listener = VZVirtioSocketListener()
    var lastText: String?                      // the text both sides already have: never sent back
    var lastChange = NSPasteboard.general.changeCount
    var retryAt = Date.distantPast
    var open = Set<VZVirtioSocketConnection>() // kept alive while their data is read
    init(_ d: VZVirtioSocketDevice) {
        device = d
        super.init()
        listener.delegate = self
        d.setSocketListener(listener, forPort: 7780)
    }
    func listener(_ l: VZVirtioSocketListener, shouldAcceptNewConnection c: VZVirtioSocketConnection,
                  from d: VZVirtioSocketDevice) -> Bool {
        open.insert(c)
        let fd = c.fileDescriptor
        DispatchQueue.global().async {
            var data = Data(), buf = [UInt8](repeating: 0, count: 65536)
            while data.count <= Clipboard.limit { let n = read(fd, &buf, buf.count); if n <= 0 { break }; data.append(buf, count: n) }
            DispatchQueue.main.async {
                c.close(); self.open.remove(c)
                guard data.count <= Clipboard.limit, let s = String(data: data, encoding: .utf8), !s.isEmpty, s != self.lastText else { return }
                self.lastText = s
                let pb = NSPasteboard.general
                pb.clearContents(); pb.setString(s, forType: .string)
                self.lastChange = pb.changeCount
            }
        }
        return true
    }
    /// Main queue. Sends the Mac's text to NEXUS when it changed since the last time.
    func push() {
        let pb = NSPasteboard.general
        guard pb.changeCount != lastChange, Date() >= retryAt else { return }
        let change = pb.changeCount
        guard let s = pb.string(forType: .string), !s.isEmpty, s != lastText, s.utf8.count <= Clipboard.limit else { lastChange = change; return }
        device.connect(toPort: 7781) { r in
            switch r {
            case .success(let c):
                self.lastText = s; self.lastChange = change
                let d = Data(s.utf8), fd = c.fileDescriptor
                DispatchQueue.global().async {
                    d.withUnsafeBytes { p in
                        var off = 0
                        while off < d.count { let n = write(fd, p.baseAddress! + off, d.count - off); if n <= 0 { break }; off += n }
                    }
                    DispatchQueue.main.async { c.close() }
                }
            case .failure: self.retryAt = Date().addingTimeInterval(2) // NEXUS still starting (or an older image)
            }
        }
    }
}
var clipboard: Clipboard?
var clipboardTimer: Timer?
/// The Mac's text goes to NEXUS when its window comes to the front, and every 0.5 s while it stays there.
/// NEXUS_VM_CLIPBOARD_ALWAYS=1 also does it in the background (lab tests drive the VM without clicking its window).
func startClipboard(_ sock: VZVirtioSocketDevice) {
    let c = Clipboard(sock)
    clipboard = c
    let always = ProcessInfo.processInfo.environment["NEXUS_VM_CLIPBOARD_ALWAYS"] == "1"
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in c.push() }
    clipboardTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in if always || NSApp.isActive { c.push() } }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    func applicationDidFinishLaunching(_ n: Notification) {
        let view = VZVirtualMachineView()
        view.virtualMachine = vm
        view.capturesSystemKeys = true
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let rect = NSRect(x: 0, y: 0, width: CGFloat(size[0]) / scale, height: CGFloat(size[1]) / scale)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "NEXUS OS"
        window.contentView = view
        window.contentAspectRatio = NSSize(width: size[0], height: size[1])
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        NSApp.activate(ignoringOtherApps: true)
        startVM()
    }
    func windowWillClose(_ n: Notification) { requestShutdown() }
}

if gui {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let appDelegate = AppDelegate()
    app.delegate = appDelegate
    app.run()
} else {
    startVM()
    RunLoop.main.run()
}
