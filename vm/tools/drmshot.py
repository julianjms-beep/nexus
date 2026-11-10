#!/usr/bin/env python3
"""drmshot: screenshot whatever the display shows right now (boot splash, console, compositor), from inside the guest.

Reads the framebuffer bound to the first active CRTC through the DRM API (needs root: GETFB only hands out the
buffer handle to CAP_SYS_ADMIN). Works before any Wayland compositor runs, so it can film the boot.
Test tool for the dev VM only: it is not part of the NEXUS OS image.

  sudo python3 drmshot.py out.ppm                    one frame (PPM, convert on the Mac)
  sudo python3 drmshot.py --film DIR SECONDS STEP    a frame every STEP s for SECONDS s: DIR/0000.ppm ... (+ times.txt)
"""
import ctypes
import fcntl
import mmap
import os
import struct
import sys
import time


def _iowr(nr, size):
    return (3 << 30) | (size << 16) | (ord("d") << 8) | nr


def _iow(nr, size):
    return (1 << 30) | (size << 16) | (ord("d") << 8) | nr


GETRESOURCES = _iowr(0xA0, 64)
GETCRTC = _iowr(0xA1, 104)
GETFB = _iowr(0xAD, 28)
MAP_DUMB = _iowr(0xB3, 16)
GEM_CLOSE = _iow(0x09, 8)


def crtcs(fd):
    res = bytearray(64)
    fcntl.ioctl(fd, GETRESOURCES, res)
    n = struct.unpack_from("<I", res, 36)[0]                      # count_crtcs
    ids = (ctypes.c_uint32 * max(1, n))()
    res = bytearray(64)
    struct.pack_into("<Q", res, 8, ctypes.addressof(ids))        # crtc_id_ptr
    struct.pack_into("<I", res, 36, n)
    fcntl.ioctl(fd, GETRESOURCES, res)
    return list(ids)[:n]


def grab(fd):
    """-> (width, height, rgb bytes) of the first CRTC showing a framebuffer, or None (nothing on screen yet)."""
    for cid in crtcs(fd):
        c = bytearray(104)
        struct.pack_into("<I", c, 12, cid)                           # crtc_id
        fcntl.ioctl(fd, GETCRTC, c)
        fb_id = struct.unpack_from("<I", c, 16)[0]
        if not fb_id:
            continue
        f = bytearray(28)
        struct.pack_into("<I", f, 0, fb_id)
        fcntl.ioctl(fd, GETFB, f)
        _, w, h, pitch, bpp, depth, handle = struct.unpack("<7I", f)
        if not handle:
            raise SystemExit("drmshot: no buffer handle (run as root)")
        try:
            if bpp != 32:
                raise SystemExit(f"drmshot: {bpp} bpp framebuffer not supported")
            m = bytearray(16)
            struct.pack_into("<I", m, 0, handle)
            fcntl.ioctl(fd, MAP_DUMB, m)
            off = struct.unpack_from("<Q", m, 8)[0]
            with mmap.mmap(fd, pitch * h, mmap.MAP_SHARED, mmap.PROT_READ, offset=off) as mm:
                raw = mm[:]
        finally:
            fcntl.ioctl(fd, GEM_CLOSE, struct.pack("<II", handle, 0))
        rgb = bytearray(w * h * 3)
        for y in range(h):                                           # XRGB8888 little endian = B G R X in memory
            row = raw[y * pitch: y * pitch + w * 4]
            o = y * w * 3
            rgb[o + 0: o + w * 3: 3] = row[2::4]
            rgb[o + 1: o + w * 3: 3] = row[1::4]
            rgb[o + 2: o + w * 3: 3] = row[0::4]
        return w, h, bytes(rgb)
    return None


def save(path, shot):
    w, h, rgb = shot
    with open(path, "wb") as out:
        out.write(b"P6\n%d %d\n255\n" % (w, h) + rgb)


def main():
    card = "/dev/dri/card0"
    while not os.path.exists(card):                                  # early boot: wait for the GPU driver
        time.sleep(0.05)
    fd = os.open(card, os.O_RDWR | os.O_CLOEXEC)
    if sys.argv[1] == "--film":
        d, secs, step = sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
        os.makedirs(d, exist_ok=True)
        t0, i, log = time.monotonic(), 0, open(os.path.join(d, "times.txt"), "w")
        while time.monotonic() - t0 < secs:
            try:
                s = grab(fd)
            except OSError:                                          # e.g. the compositor is swapping buffers
                s = None
            up = float(open("/proc/uptime").read().split()[0])
            if s:
                save(os.path.join(d, "%04d.ppm" % i), s)
                log.write("%04d %.2f\n" % (i, up)); log.flush(); i += 1
            time.sleep(step)
    else:
        s = grab(fd)
        if not s:
            raise SystemExit("drmshot: nothing on screen")
        save(sys.argv[1], s)


if __name__ == "__main__":
    main()
