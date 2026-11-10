#!/usr/bin/env python3
"""Boot splash centre pictures for the session's first frame (Pillow only, deterministic).

Why: between plymouth handing over the screen and the shell's first frame (shell/Intro.qml) the compositor would show
its own black background, so the mark blinks off and on. The session's first command (etc/xdg/labwc/autostart) puts
the splash back with swaybg: a flat background colour (the middle of plymouth's #06070d -> #090a16 gradient, at most 4
levels off at the edges) plus this picture of the centre, pasted 1:1 in the middle of swaybg's buffer
(`swaybg -m center -c 080812`). Nothing is resampled and the picture is small, so swaybg is on screen within a few
milliseconds of starting, on any screen size.

Same geometry as usr/share/plymouth/themes/nexus/nexus.script (cx, cy = screen centre, physical pixels): mark.png at
(cx-120, cy-160), word.png at (cx-88.5, cy+26), three dots at (cx-4+(i-1)*20, cy+100) with opacity 0.25. The mark is
drawn at full opacity, as Intro.qml does.

swaybg draws into a buffer of (screen / scale, rounded down) x ceil(scale) pixels, so per interface size one picture
is drawn at ceil(scale) / scale times the physical size:
  centre@1.png     100 % and 200 % (buffer pixels = screen pixels)
  centre@1.25.png  125 % (x 1.6)
  centre@1.5.png   150 % (x 4/3)
into os/mkosi.extra/usr/share/nexus/splash/boot/. Run after make-lock-art.py (it reads mark/word/dot).
Run:  python3 os/art/make-boot-frames.py
"""
import math
import os

from PIL import Image

SPLASH = os.path.join(os.path.dirname(__file__), "..", "mkosi.extra", "usr", "share", "nexus", "splash")
OUT = os.path.join(SPLASH, "boot")
BG = (0x08, 0x08, 0x12)          # swaybg -c 080812 in etc/xdg/labwc/autostart: keep both the same
SCALES = (1, 1.25, 1.5)
HALF_W, HALF_H = 128, 168        # the splash spans x -120..120, y -160..108 around the centre (+ a margin)
CANVAS = 1024                    # square working canvas, centre at (512, 512)


def faded(img, opacity):
    r, g, b, a = img.split()
    return Image.merge("RGBA", (r, g, b, a.point(lambda v: round(v * opacity))))


def centre(mark, word, dot):
    im = Image.new("RGBA", (CANVAS, CANVAS), BG + (255,))
    cx = cy = CANVAS / 2
    im.alpha_composite(mark, (int(cx - mark.width / 2), int(cy - 40 - mark.height / 2)))
    im.alpha_composite(word, (int(cx - word.width / 2), int(cy + 26)))
    soft = faded(dot, 0.25)
    for i in range(3):
        im.alpha_composite(soft, (int(cx - 4 + (i - 1) * 20), int(cy + 100)))
    return im.convert("RGB")


def main():
    mark, word, dot = (Image.open(os.path.join(SPLASH, n)).convert("RGBA") for n in ("mark.png", "word.png", "dot.png"))
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):                  # earlier full-screen pictures
        if old.endswith(".png"):
            os.remove(os.path.join(OUT, old))
    base = centre(mark, word, dot)
    total = 0
    for s in SCALES:
        r = math.ceil(s) / s
        size = round(CANVAS * r)
        big = base if r == 1 else base.resize((size, size), Image.LANCZOS)
        hw, hh = round(HALF_W * r), round(HALF_H * r)          # even width and height: swaybg's offset is whole
        c = size // 2
        pic = big.crop((c - hw, c - hh, c + hw, c + hh))
        path = os.path.join(OUT, f"centre@{s:g}.png")
        pic.save(path, optimize=True)
        total += os.path.getsize(path)
        print(f"{os.path.basename(path)}: {pic.width}x{pic.height}")
    print(f"{total // 1024} KB in {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
