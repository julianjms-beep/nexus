#!/usr/bin/env python3
"""Draw the NEXUS lock-screen and boot-splash art (Pillow only, no numpy, deterministic).

Writes into os/mkosi.extra/usr/share/nexus/lock/:
  aurora.png  1920x1200 aurora ribbons (violet / cyan / magenta) on deep navy, dark centre for the clock
  logo.png    64 px NEXUS diamond mark (same geometry as icons/nexus.svg)
  ai.png      40 px NEXUS AI tile (violet tile with a four-point sparkle) for the greeting card
  monitor.png 40 px Monitor tile (same violet, a screen outline) for the system-status card
and the Spanish catalogue for gtklock's own four strings (Debian ships none): usr/share/locale/es/LC_MESSAGES/gtklock.mo

Desktop wallpaper "Aurora" (dark theme default) into usr/share/nexus/wallpapers/aurora.png: diagonal light beams,
violet top left, teal top right, magenta bottom right, indigo bottom left, deep navy middle for the clock.

Boot splash (plymouth theme "nexus" and the shell's start-up fade use the same files) into usr/share/nexus/splash/:
  mark.png    the mark at 96 px inside a soft violet glow (240 px canvas)
  word.png    "NEXUS OS" in Inter Medium, letter-spaced
  dot.png     one 8 px loading dot
The wordmark needs the Inter font files: INTER_DIR=<folder with Inter-Medium.otf> (on NEXUS OS:
/usr/share/fonts/opentype/inter); without it the splash files are left as they are.
Run:  [INTER_DIR=...] python3 os/art/make-lock-art.py
"""
import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "mkosi.extra", "usr", "share", "nexus", "lock")
W, H = 1920, 1200
random.seed(7)


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def scale(c, k):
    return tuple(max(0, min(255, round(v * k))) for v in c)


def colour_at(stops, t):
    """stops: [(pos, rgb)], pos ascending in 0..1"""
    t = max(0.0, min(1.0, t))
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if t <= p1:
            return mix(c0, c1, (t - p0) / max(1e-6, p1 - p0))
    return stops[-1][1]


def calm_mask(size, box, low, blur):
    """255 everywhere, `low` inside the ellipse `box`, blurred: multiply by it to darken a soft area."""
    m = Image.new("L", size, 255)
    ImageDraw.Draw(m).ellipse(box, fill=low)
    m = m.filter(ImageFilter.GaussianBlur(blur))
    return Image.merge("RGB", (m, m, m))


def ribbon(curve, stops, height, glow, core, steps=220):
    """A curtain of light hanging above curve(u) -> (x, y), u in [0, 1].
    The bright edge is the curve itself; the curtain fades upwards over `height` px."""
    layer = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(layer)
    pts = [curve(i / steps) for i in range(steps + 1)]
    for k in range(-36, height, 3):                     # mostly above the edge, a little below it
        f = ((1 - k / height) ** 1.5 if k >= 0 else (1 + k / 36) ** 2) * 0.95
        for i in range(steps):
            u = i / steps
            env = math.sin(math.pi * u) ** 0.6          # fade in/out along the ribbon: no hard ends
            c = scale(colour_at(stops, u), f * env)
            (xa, ya), (xb, yb) = pts[i], pts[i + 1]
            d.line([(xa, ya - k), (xb, yb - k)], fill=c, width=4)
    layer = layer.filter(ImageFilter.GaussianBlur(glow))
    rim = Image.new("RGB", (W, H))                       # bright rim along the edge
    d = ImageDraw.Draw(rim)
    for i in range(steps):
        u = i / steps
        env = math.sin(math.pi * u) ** 1.2
        c = scale(mix(colour_at(stops, u), (255, 255, 255), 0.45), core * env)
        d.line([pts[i], pts[i + 1]], fill=c, width=4)
    halo = rim.filter(ImageFilter.GaussianBlur(14))
    rim = rim.filter(ImageFilter.GaussianBlur(2.5))
    return ImageChops.add(ImageChops.add(layer, halo), rim)


def aurora():
    base = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(base)
    top, bottom = hexrgb("#06070d"), hexrgb("#0b0c1c")
    for y in range(H):
        d.line([(0, y), (W, y)], fill=mix(top, bottom, y / H))

    violet = [(0, hexrgb("#6d4dff")), (0.45, hexrgb("#8b5cff")), (0.75, hexrgb("#5a6cff")), (1, hexrgb("#3a7bff"))]
    cyan = [(0, hexrgb("#4b5bff")), (0.4, hexrgb("#22c8f0")), (0.7, hexrgb("#2ee6d6")), (1, hexrgb("#7c6cff"))]
    magenta = [(0, hexrgb("#7c4dff")), (0.5, hexrgb("#d94cf0")), (1, hexrgb("#ff5cc8"))]
    faint = [(0, hexrgb("#5b3fd9")), (1, hexrgb("#7c6cff"))]

    layers = [
        # violet: from the top-left corner sweeping down to the middle, then flattening out to the right
        ribbon(lambda u: (-80 + u * 1500, 120 + 560 * (1 - math.cos(min(1, u * 1.25) * math.pi)) / 2 + 40 * math.sin(u * 5)),
               violet, 260, 26, 0.9),
        # cyan: rises from the centre to the right edge
        ribbon(lambda u: (700 + u * 1300, 760 - 420 * (1 - math.cos(u * math.pi)) / 2 + 30 * math.sin(u * 7)),
               cyan, 220, 22, 1.0),
        # magenta: lower right, below the cyan one
        ribbon(lambda u: (760 + u * 1250, 1080 - 380 * (1 - math.cos(u * math.pi)) / 2 + 25 * math.sin(u * 4 + 1)),
               magenta, 240, 28, 0.85),
        # faint violet veil at the top right
        ribbon(lambda u: (1150 + u * 900, 120 + 160 * math.sin(u * 3.0)), faint, 160, 40, 0.25),
    ]
    light = layers[0]
    for layer in layers[1:]:
        light = ImageChops.screen(light, layer)
    bloom = light.filter(ImageFilter.GaussianBlur(70))           # wide soft glow around everything
    img = ImageChops.screen(ImageChops.screen(base, light), bloom)

    # keep the centre-top darker so the clock and the date stay readable
    img = ImageChops.multiply(img, calm_mask((W, H), (W / 2 - 520, 150, W / 2 + 520, 760), 180, 150))

    # bokeh: a few soft dots, never behind the clock or the password field
    dots = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(dots)
    palette = [hexrgb("#7c6cff"), hexrgb("#38d9ff"), hexrgb("#b46bff"), hexrgb("#2ee6d6")]
    for _ in range(26):
        x, y = random.randint(0, W), random.randint(0, H)
        if abs(x - W / 2) < 420 and y < 760:
            continue
        r = random.choice([3, 4, 5, 6, 10, 18, 26])
        c = scale(random.choice(palette), random.uniform(0.3, 0.75) * (0.45 if r > 9 else 1))
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)
    dots = dots.filter(ImageFilter.GaussianBlur(3))
    img = ImageChops.screen(img, dots)

    # vignette
    vig = Image.radial_gradient("L").resize((W, H), Image.BICUBIC).point(lambda v: round(255 - 0.55 * max(0, v - 90)))
    img = ImageChops.multiply(img, Image.merge("RGB", (vig, vig, vig)))

    # a touch of noise against banding in the soft gradients
    noise = Image.effect_noise((W, H), 2.0)
    img = ImageChops.add(img, Image.merge("RGB", (noise, noise, noise)), 1.0, -128)
    return img


def diagonal(size, stops):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = colour_at(stops, (x + y) / (2 * size - 2))
    return g


def rounded_square(size, side, radius, fill_img):
    """fill_img clipped to a centred rounded square rotated 45 degrees."""
    m = Image.new("L", (size, size))
    o = (size - side) / 2
    ImageDraw.Draw(m).rounded_rectangle([o, o, o + side, o + side], radius=radius, fill=255)
    m = m.rotate(45, resample=Image.BICUBIC)
    out = Image.new("RGBA", (size, size))
    out.paste(fill_img, (0, 0), m)
    return out


def logo(px=64):
    S = px * 8
    grad = diagonal(S, [(0, hexrgb("#9b8cff")), (0.55, hexrgb("#7c6cff")), (1, hexrgb("#38d9ff"))])
    outer = rounded_square(S, S * 38 / 64, S * 11 / 64, grad)
    inner = rounded_square(S, S * 14 / 64, S * 4 / 64, Image.new("RGB", (S, S), (255, 255, 255)))
    inner.putalpha(inner.getchannel("A").point(lambda v: round(v * 0.92)))
    return Image.alpha_composite(outer, inner).resize((px, px), Image.LANCZOS)


def ai_tile(px=40):
    S = px * 8
    tile = Image.new("RGBA", (S, S))
    m = Image.new("L", (S, S))
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.28, fill=255)
    tile.paste(diagonal(S, [(0, hexrgb("#8b7bff")), (1, hexrgb("#5b3fd9"))]), (0, 0), m)
    cx = cy = S / 2                                    # four-point sparkle (astroid), white
    r = S * 0.30
    pts = [(cx + r * math.cos(t) ** 3, cy + r * math.sin(t) ** 3) for t in (2 * math.pi * i / 240 for i in range(240))]
    star = Image.new("L", (S, S))
    ImageDraw.Draw(star).polygon(pts, fill=255)
    tile.paste((255, 255, 255, 255), (0, 0), star)
    return tile.resize((px, px), Image.LANCZOS)


def monitor_tile(px=40):
    """40 px Monitor tile for the lock screen's second card: the AI tile's violet with a white screen outline."""
    S = px * 8
    tile = Image.new("RGBA", (S, S))
    m = Image.new("L", (S, S))
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.28, fill=255)
    tile.paste(diagonal(S, [(0, hexrgb("#8b7bff")), (1, hexrgb("#5b3fd9"))]), (0, 0), m)
    glyph = Image.new("L", (S, S))
    d = ImageDraw.Draw(glyph)
    w = round(S * 0.058)
    d.rounded_rectangle([S * 0.22, S * 0.25, S * 0.78, S * 0.63], radius=S * 0.06, outline=255, width=w)
    for a, b in (((S * 0.5, S * 0.63), (S * 0.5, S * 0.73)), ((S * 0.37, S * 0.75), (S * 0.63, S * 0.75))):
        d.line([a, b], fill=255, width=w)
        for x, y in (a, b):                            # round caps
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=255)
    tile.paste((255, 255, 255, 255), (0, 0), glyph)
    return tile.resize((px, px), Image.LANCZOS)


GTKLOCK_ES = {
    "Caps Lock is on": "Bloq Mayús está activado",
    "Login failed": "Contraseña incorrecta",
    "Password:": "Contraseña:",
    "Unlock": "Desbloquear",
}


def write_mo(path, catalog):
    """GNU gettext .mo (little endian, no hash table)."""
    import struct
    entries = sorted({"": "Content-Type: text/plain; charset=UTF-8\n", **catalog}.items())
    ids = [k.encode() for k, _ in entries]
    strs = [v.encode() for _, v in entries]
    n = len(entries)
    o_ids, o_strs = 28, 28 + 8 * n
    pos = 28 + 16 * n
    id_tab, str_tab, blob = [], [], b""
    for b in ids:
        id_tab.append((len(b), pos + len(blob))); blob += b + b"\0"
    for b in strs:
        str_tab.append((len(b), pos + len(blob))); blob += b + b"\0"
    out = struct.pack("<7I", 0x950412DE, 0, n, o_ids, o_strs, 0, pos)
    out += b"".join(struct.pack("<II", *t) for t in id_tab) + b"".join(struct.pack("<II", *t) for t in str_tab) + blob
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(out)


def beam(layer_size, centre, length, width, colour, strength, blur, angle=33):
    """A soft diagonal shaft of light through `centre` (degrees below the horizontal, top left -> bottom right)."""
    layer = Image.new("RGB", layer_size)
    a = math.radians(angle)
    dx, dy = math.cos(a) * length / 2, math.sin(a) * length / 2
    cx, cy = centre
    ImageDraw.Draw(layer).line([(cx - dx, cy - dy), (cx + dx, cy + dy)], fill=scale(colour, strength), width=int(width))
    return layer.filter(ImageFilter.GaussianBlur(blur))


def glow(layer_size, centre, radius, colour, strength):
    layer = Image.new("RGB", layer_size)
    x, y = centre
    ImageDraw.Draw(layer).ellipse([x - radius, y - radius, x + radius, y + radius], fill=scale(colour, strength))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.8))


def desktop_aurora():
    size = (W, H)
    base = Image.new("RGB", size)
    d = ImageDraw.Draw(base)
    top, bottom = hexrgb("#0b0b22"), hexrgb("#08081a")
    for y in range(H):
        d.line([(0, y), (W, y)], fill=mix(top, bottom, y / H))
    violet, teal, magenta, indigo = hexrgb("#8f52ff"), hexrgb("#19d6c4"), hexrgb("#f03cd2"), hexrgb("#3a40ff")
    light = [
        glow(size, (200, 110), 380, violet, 0.70),
        beam(size, (250, 200), 1000, 210, violet, 0.80, 75),
        beam(size, (60, 330), 900, 100, violet, 0.45, 45),
        beam(size, (470, 110), 760, 60, hexrgb("#b07cff"), 0.38, 30),
        glow(size, (1760, 130), 330, teal, 0.60),
        beam(size, (1740, 170), 860, 190, teal, 0.70, 75),
        beam(size, (1900, 300), 640, 80, teal, 0.45, 40),
        beam(size, (1560, 20), 560, 50, hexrgb("#5fe8ff"), 0.30, 28),
        glow(size, (1820, 1100), 380, magenta, 0.65),
        beam(size, (1760, 1040), 1000, 220, magenta, 0.80, 80),
        beam(size, (1960, 920), 640, 90, hexrgb("#ff5cc8"), 0.45, 45),
        beam(size, (1560, 1170), 640, 60, hexrgb("#c040ff"), 0.38, 32),
        glow(size, (90, 1140), 340, indigo, 0.45),
        beam(size, (200, 1100), 800, 150, indigo, 0.42, 70),
    ]
    acc = light[0]
    for layer in light[1:]:
        acc = ImageChops.screen(acc, layer)
    img = ImageChops.screen(base, acc)
    # deep navy in the middle, where the clock and "Pregunta a NEXUS" sit
    img = ImageChops.multiply(img, calm_mask(size, (W / 2 - 700, H / 2 - 460, W / 2 + 700, H / 2 + 400), 110, 220))
    noise = Image.effect_noise(size, 2.2)
    return ImageChops.add(img, Image.merge("RGB", (noise, noise, noise)), 1.0, -128)


def glow_mark(canvas=240, mark=96):
    img = Image.new("RGBA", (canvas, canvas))
    halo = Image.new("L", (canvas, canvas))
    r = canvas * 0.30
    ImageDraw.Draw(halo).ellipse([canvas / 2 - r, canvas / 2 - r, canvas / 2 + r, canvas / 2 + r], fill=120)
    halo = halo.filter(ImageFilter.GaussianBlur(canvas * 0.12))
    img.paste((124, 108, 255, 255), (0, 0), halo)
    m = logo(mark)
    img.alpha_composite(m, ((canvas - mark) // 2, (canvas - mark) // 2))
    return img


def wordmark(font_dir, text="NEXUS OS", size=21, spacing=9):
    from PIL import ImageFont
    f = ImageFont.truetype(os.path.join(font_dir, "Inter-Medium.otf"), size)
    widths = [f.getlength(ch) for ch in text]
    w = int(sum(widths) + spacing * (len(text) - 1)) + 4
    asc, desc = f.getmetrics()
    img = Image.new("RGBA", (w, asc + desc + 4))
    d = ImageDraw.Draw(img)
    x = 2
    for ch, cw in zip(text, widths):
        d.text((x, 2), ch, font=f, fill=(226, 222, 255, 235))
        x += cw + spacing
    return img


def dot(px=8):
    S = px * 8
    img = Image.new("RGBA", (S, S))
    ImageDraw.Draw(img).ellipse([0, 0, S - 1, S - 1], fill=(186, 178, 255, 255))
    return img.resize((px, px), Image.LANCZOS)


def stroke_icon(kind, px=22, width=2.0, colour=(238, 240, 255, 255)):
    """Line icons for the login screen's buttons (GTK 3 there has no SVG loader): 'power' and 'restart'."""
    k = 8
    S = px * k
    img = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(img)
    w = round(width * k)
    c = S / 2
    r = S * 0.34

    def seg(a, b):                       # a line with round caps
        d.line([a, b], fill=colour, width=w)
        for x, y in (a, b):
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=colour)

    def arc(start, end):                 # clockwise from start to end (degrees from 3 o'clock), round caps
        box = [c - r, c - r, c + r, c + r]
        d.arc(box, start, end, fill=colour, width=w)
        for t in (start, end):
            x, y = c + (r - w / 2) * math.cos(math.radians(t)), c + (r - w / 2) * math.sin(math.radians(t))
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=colour)
        return box

    if kind == "power":
        arc(-50, 230)
        seg((c, c - r * 1.12), (c, c - r * 0.12))
    else:                                # restart: an open circle turning clockwise, arrow at the top right
        end = -62
        arc(18, 360 + end)
        rr = r - w / 2
        tip = (c + rr * math.cos(math.radians(end)), c + rr * math.sin(math.radians(end)))
        tx, ty = -math.sin(math.radians(end)), math.cos(math.radians(end))   # clockwise tangent at the tip
        L = r * 0.62
        for turn in (150, -150):
            a = math.atan2(ty, tx) + math.radians(turn)
            seg(tip, (tip[0] + L * math.cos(a), tip[1] + L * math.sin(a)))
    return img.resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    GREETER = os.path.join(OUT, "..", "greeter")
    os.makedirs(GREETER, exist_ok=True)
    for kind in ("power", "restart"):
        stroke_icon(kind).save(os.path.join(GREETER, kind + ".png"), optimize=True)
    aurora().save(os.path.join(OUT, "aurora.png"), optimize=True)
    logo().save(os.path.join(OUT, "logo.png"), optimize=True)
    ai_tile().save(os.path.join(OUT, "ai.png"), optimize=True)
    monitor_tile().save(os.path.join(OUT, "monitor.png"), optimize=True)
    write_mo(os.path.join(OUT, "..", "..", "..", "share", "locale", "es", "LC_MESSAGES", "gtklock.mo"), GTKLOCK_ES)
    for f in ("aurora.png", "logo.png", "ai.png"):
        print(f, os.path.getsize(os.path.join(OUT, f)), "bytes")
    WALL = os.path.join(OUT, "..", "wallpapers")
    os.makedirs(WALL, exist_ok=True)
    desktop_aurora().save(os.path.join(WALL, "aurora.png"), optimize=True)
    print("wallpapers/aurora.png", os.path.getsize(os.path.join(WALL, "aurora.png")), "bytes")
    SPLASH = os.path.join(OUT, "..", "splash")
    os.makedirs(SPLASH, exist_ok=True)
    glow_mark().save(os.path.join(SPLASH, "mark.png"), optimize=True)
    dot().save(os.path.join(SPLASH, "dot.png"), optimize=True)
    if os.environ.get("INTER_DIR"):
        wordmark(os.environ["INTER_DIR"]).save(os.path.join(SPLASH, "word.png"), optimize=True)
    else:
        print("INTER_DIR not set: splash/word.png left as it is")
    for f in sorted(os.listdir(SPLASH)):
        print("splash/" + f, Image.open(os.path.join(SPLASH, f)).size)
