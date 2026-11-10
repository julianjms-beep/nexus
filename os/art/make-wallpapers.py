#!/usr/bin/env python3
"""make-wallpapers: NEXUS OS's own wallpaper collection, drawn from code (no photos, nothing downloaded), plus two
pictures kept in the repository: Aurora (os/art/make-lock-art.py) and Pantera (os/art/pantera-fuente.png, a neon
low-poly panther generated for NEXUS on 2026-11-09 from the look the person asked for; padded to 16:10 here).

Writes into usr/share/nexus/wallpapers (or the folder given):
  <id>.jpg            3840×2400 (16:10; 16:9 screens show a centred crop)
  thumbs/<id>.jpg     480×300, for the gallery in Ajustes
  index.json          what the desktop, the lock screen and Ajustes read:
    {"version": 1,
     "images":     {"<id>": {"file", "thumb", "ink": "light"|"dark", "accent": "#rrggbb", "name"}},
     "collection": [{"id", "name", "light": "<image id>", "dark": "<image id>"}            one picture per theme
                    {"id", "name", "dynamic": [[hour, "<image id>"], ...]}]}                 changes with the time of day
  "ink" is the text colour that reads well over the middle of the picture (the desktop clock sits there); it is
  measured from the picture, not guessed.

Run:  python3 os/art/make-wallpapers.py [OUTDIR] [--only id,id] [--preview sheet.png]
Needs Pillow only. Takes about a minute.
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

W, H = 3840, 2400
SS = 2  # supersampling for the shapes' edges

# ------------------------------------------------------------------------------------------------ helpers


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) if isinstance(h, str) else tuple(h)


def mix(a, b, t):
    a, b = rgb(a), rgb(b)
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


def hexs(c):
    return "#%02x%02x%02x" % rgb(c)


def vgrad(stops, w=W, h=H):
    """Vertical gradient; stops = [(0..1, colour), ...]."""
    st = [(p, rgb(c)) for p, c in stops]
    col = Image.new("RGB", (1, h))
    px = col.load()
    for y in range(h):
        t = y / max(1, h - 1)
        if t <= st[0][0]:
            px[0, y] = st[0][1]
            continue
        if t >= st[-1][0]:
            px[0, y] = st[-1][1]
            continue
        for i in range(len(st) - 1):
            if st[i][0] <= t <= st[i + 1][0]:
                u = (t - st[i][0]) / max(1e-9, st[i + 1][0] - st[i][0])
                px[0, y] = mix(st[i][1], st[i + 1][1], u)
                break
    return col.resize((w, h), Image.NEAREST)


def alpha_ramp(h, y0, y1, a0, a1):
    """'L' column (1×h): a0 above y0, a1 below y1, linear between (alpha 0..1)."""
    col = Image.new("L", (1, h))
    px = col.load()
    for y in range(h):
        t = 0 if y <= y0 else 1 if y >= y1 else (y - y0) / max(1, y1 - y0)
        px[0, y] = int(255 * (a0 + (a1 - a0) * t))
    return col


_RADIAL = None


def radial():
    """512×512 'L': distance from the centre, 0 there and 255 on the inscribed circle (and beyond)."""
    global _RADIAL
    if _RADIAL is None:
        n = 512
        _RADIAL = Image.new("L", (n, n))
        _RADIAL.putdata([min(255, int(math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2) * 255)) for y in range(n) for x in range(n)])
    return _RADIAL


def glow(img, cx, cy, r, colour, strength=1.0, falloff=2.0, mode="normal"):
    """Soft round light: alpha = strength·(1 − d/r)^falloff."""
    size = max(2, int(r * 2))
    g = radial().resize((size, size), Image.BILINEAR)
    lut = [int(255 * strength * max(0.0, 1 - v / 255) ** falloff) for v in range(256)]
    mask = g.point(lut)
    x0, y0 = int(cx - r), int(cy - r)
    if mode == "screen":
        layer = Image.new("RGB", img.size, (0, 0, 0))
        tint = Image.new("RGB", (size, size), rgb(colour))
        layer.paste(tint, (x0, y0), mask)
        return ImageChops.screen(img, layer)
    img.paste(Image.new("RGB", (size, size), rgb(colour)), (x0, y0), mask)
    return img


def grain(img, sigma=2.4):
    """A little monochrome grain: no banding in the long, dark gradients."""
    n = Image.effect_noise(img.size, sigma).convert("L")
    return ImageChops.add(img, Image.merge("RGB", (n, n, n)), 1.0, -128)


def shape_mask(draw_fn, box=(0, 0, W, H)):
    """Antialiased 'L' mask of whatever draw_fn(draw, scale) paints in white, for the region box."""
    x0, y0, x1, y1 = box
    m = Image.new("L", ((x1 - x0) * SS, (y1 - y0) * SS), 0)
    draw_fn(ImageDraw.Draw(m), SS, x0, y0)
    return m.resize((x1 - x0, y1 - y0), Image.LANCZOS)


def midpoint(rng, n=1025, rough=0.55):
    """1-D fractal line in about −1..1 (midpoint displacement)."""
    h = [0.0] * n
    h[0], h[-1] = rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6)
    step, scale = n - 1, 1.0
    while step > 1:
        half = step // 2
        for i in range(half, n, step):
            h[i] = (h[i - half] + h[i + half]) / 2 + rng.uniform(-1, 1) * scale
        scale *= rough
        step = half
    m = max(abs(v) for v in h) or 1
    return [v / m for v in h]


def smooth(vals, k):
    if k <= 1:
        return vals
    out, n = [], len(vals)
    for i in range(n):
        a, b = max(0, i - k), min(n, i + k + 1)
        out.append(sum(vals[a:b]) / (b - a))
    return out


def fill_below(img, ys, top_colour, bottom_colour, blur=0.0):
    """Fill the area under the line ys (one y per column sample, spread over the width) with a vertical gradient."""
    y_top = min(H - 2, max(0, int(min(ys)) - 4))
    n = len(ys)

    def paint(d, s, ox, oy):
        pts = [(i / (n - 1) * W * s, (y - oy) * s) for i, y in enumerate(ys)]
        d.polygon(pts + [(W * s, (H - oy) * s), (0, (H - oy) * s)], fill=255)

    mask = shape_mask(paint, (0, y_top, W, H))
    if blur:
        mask = mask.filter(ImageFilter.GaussianBlur(blur))
    band = vgrad([(0, top_colour), (1, bottom_colour)], W, H - y_top)
    img.paste(band, (0, y_top), mask)
    return mask, y_top


def fog(img, colour, y_mid, spread, strength):
    """A band of mist that thickens downwards from y_mid − spread and stays below."""
    a = alpha_ramp(H, int(y_mid - spread), int(y_mid + spread * 0.6), 0, strength).resize((W, H), Image.NEAREST)
    img.paste(Image.new("RGB", (W, H), rgb(colour)), (0, 0), a)


def stars(img, rng, count, y_max, bright=1.0):
    layer = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(layer)
    for _ in range(count):
        x, y = rng.uniform(0, W), rng.uniform(0, y_max) ** 1.0
        v = rng.random() ** 3
        r = 0.6 + v * 2.2
        d.ellipse((x - r, y - r, x + r, y + r), fill=int(70 + 185 * v * bright))
    halo = layer.filter(ImageFilter.GaussianBlur(3))
    layer = ImageChops.add(layer.filter(ImageFilter.GaussianBlur(0.7)), halo)
    fade = alpha_ramp(H, int(y_max * 0.55), int(y_max), 1, 0).resize((W, H), Image.NEAREST)
    layer = ImageChops.multiply(layer, fade)
    return ImageChops.screen(img, Image.merge("RGB", (layer, layer, layer)))


def value_noise(rng, cells, octaves=4, size=(W, H)):
    """Smooth noise ('L', mid-grey ±) from up-scaled random fields: clouds, nebulae, sand."""
    acc = None
    weight = 1.0
    total = 0.0
    for o in range(octaves):
        cw = max(2, int(cells * (2 ** o)))
        ch = max(2, int(cw * size[1] / size[0]))
        small = Image.effect_noise((cw, ch), 60).convert("L")
        big = small.resize(size, Image.BICUBIC)
        if acc is None:
            acc = big
            total = weight
        else:
            acc = Image.blend(acc, big, weight / (total + weight))
            total += weight
        weight *= 0.55
    return acc


# ------------------------------------------------------------------------------------------------ Cumbres


CUMBRES = {
    "amanecer": dict(
        sky=[(0, "#1d2752"), (0.30, "#4d4d84"), (0.52, "#c67e93"), (0.64, "#f4b99a"), (0.70, "#fbd6ad")],
        sun=(0.30, 0.60, 0.42, "#ffe2b8", 0.9), stars=0,
        far="#c18aa0", near="#2a2142", haze="#f2b9a8", fogs=(0.42, 0.30, 0.22, 0.15, 0.08, 0.0), accent="#e07a8f"),
    "dia": dict(
        sky=[(0, "#2c69b3"), (0.40, "#76aee3"), (0.62, "#c6e0f4"), (0.70, "#e8f2fa")],
        sun=(0.76, 0.18, 0.50, "#ffffff", 0.55), stars=0,
        far="#a5bfd9", near="#1c3a4c", haze="#e2edf7", fogs=(0.46, 0.34, 0.24, 0.16, 0.08, 0.0), accent="#2f7fd0"),
    "atardecer": dict(
        sky=[(0, "#151238"), (0.26, "#3c2a6c"), (0.48, "#a64f7c"), (0.62, "#ec8660"), (0.70, "#ffc277")],
        sun=(0.66, 0.64, 0.45, "#ffd28c", 1.0), stars=260,
        far="#9b5577", near="#130d23", haze="#f29b78", fogs=(0.40, 0.30, 0.20, 0.13, 0.07, 0.0), accent="#f0805f"),
    "noche": dict(
        sky=[(0, "#03050d"), (0.45, "#0a1230"), (0.66, "#17224c"), (0.72, "#1f2c5a")],
        sun=(0.78, 0.17, 0.22, "#c9d6ff", 0.55), stars=2600,
        far="#25305a", near="#04060d", haze="#2c3a6c", fogs=(0.30, 0.22, 0.15, 0.10, 0.05, 0.0), accent="#6d83e8"),
}


def cumbres(kind, seed=7):
    p = CUMBRES[kind]
    rng = random.Random(seed)  # the same mountains at every hour of the day
    img = vgrad(p["sky"])
    if p["stars"]:
        img = stars(img, random.Random(seed + 1), p["stars"], H * 0.62, 1.0 if kind == "noche" else 0.5)
    sx, sy, sr, sc, ss = p["sun"]
    img = glow(img, W * sx, H * sy, W * sr, sc, ss * 0.55, 2.2, "screen")
    img = glow(img, W * sx, H * sy, W * sr * 0.18, sc, ss, 1.2, "screen")
    if kind == "noche":  # the moon: a small bright disc
        r = W * 0.012
        img = glow(img, W * sx, H * sy, r * 1.05, "#eef2ff", 1.0, 0.08)
    layers = 6
    for k in range(layers):
        t = k / (layers - 1)
        base = H * (0.585 + 0.068 * k)
        amp = H * (0.055 + 0.03 * k)
        line = smooth(midpoint(rng, 1025, 0.50 + 0.04 * k), 2 if k < 2 else 1)
        ys = [base - amp * (0.5 + 0.5 * v) for v in line]
        top = mix(p["far"], p["near"], t ** 0.8)
        bottom = mix(top, p["near"], 0.35 + 0.4 * t)
        fill_below(img, ys, top, bottom, blur=2.5 if k == 0 else 1.2 if k == 1 else 0)
        if p["fogs"][k]:
            fog(img, p["haze"], base + amp * 0.2, H * 0.06, p["fogs"][k])
    return grain(img), p["accent"]


# ------------------------------------------------------------------------------------------------ Dunas


def dunas(dark, seed=21):
    rng = random.Random(seed)
    if dark:
        sky = [(0, "#070816"), (0.40, "#1a1840"), (0.56, "#3a2d63"), (0.60, "#5a4378")]
        sand = [("#5d4a86", "#2b2148"), ("#4c3c74", "#231a3d"), ("#3d3062", "#1c1532"), ("#30264f", "#140f26"), ("#231b3c", "#0c0918")]
        sun, accent = ("#d9d4ff", 0.70, 0.22, 0.20, 0.55), "#8a76e0"
    else:
        sky = [(0, "#f1d9c4"), (0.35, "#f6dcc0"), (0.55, "#fbe3c6"), (0.60, "#fde9cf")]
        sand = [("#f2cfa6", "#e3b48a"), ("#ecbf91", "#d39a6c"), ("#e3ab78", "#c07c50"), ("#d39461", "#a8603a"), ("#bf7a4a", "#874424")]
        sun, accent = ("#fff4dc", 0.68, 0.36, 0.30, 0.9), "#d0804c"
    img = vgrad(sky)
    if dark:
        img = stars(img, random.Random(seed + 2), 1400, H * 0.5, 0.8)
    sc, sx, sy, sr, ss = sun
    img = glow(img, W * sx, H * sy, W * sr, sc, ss * 0.6, 2.0, "screen")
    img = glow(img, W * sx, H * sy, W * sr * 0.16, sc, ss, 1.1, "screen")
    n = 1200
    for k, (light, shade) in enumerate(sand):
        base = H * (0.585 + 0.08 * k)
        amp = H * (0.035 + 0.022 * k)
        ph = [rng.uniform(0, 2 * math.pi) for _ in range(3)]
        fr = [rng.uniform(0.6, 1.1), rng.uniform(1.6, 2.4), rng.uniform(3.2, 4.4)]
        ys = []
        for i in range(n):
            x = i / (n - 1)
            # sharp-crested dune profile: |sin| folded, plus gentle swells
            v = 0.62 * (1 - abs(math.sin(math.pi * fr[0] * x + ph[0]))) ** 1.6 + 0.28 * math.sin(2 * math.pi * fr[1] * x + ph[1]) * 0.5 + 0.1 * math.sin(2 * math.pi * fr[2] * x + ph[2])
            ys.append(base - amp * v)
        fill_below(img, ys, light, shade, blur=2.0 if k == 0 else 0)
        # wind ripples catch the light just under the crest
        if not dark:
            fog(img, "#fff1de", base - amp * 0.2, H * 0.03, 0.10 - 0.015 * k)
    # sand texture: very fine, very faint
    tex = value_noise(rng, 600, 2)
    img = Image.blend(img, ImageChops.overlay(img, Image.merge("RGB", (tex, tex, tex))), 0.06)
    return grain(img, 2.0), accent


# ------------------------------------------------------------------------------------------------ Marea


def marea(dark, seed=33):
    rng = random.Random(seed)
    if dark:
        bg = [(0, "#050912"), (0.45, "#0a1630"), (0.62, "#10234a")]
        bands = ["#123a68", "#0f3159", "#0c284a", "#0a203d", "#081932", "#061327", "#040d1c"]
        crest, accent = "#5fd3ff", "#38b6e8"
    else:
        bg = [(0, "#dff1fb"), (0.45, "#eaf6fc"), (0.62, "#f4fafd")]
        bands = ["#a9dcec", "#8acde3", "#6bb9d8", "#4fa2c9", "#3a8bb7", "#2a73a1", "#1d5c86"]
        crest, accent = "#ffffff", "#2a8ec1"
    img = vgrad(bg)
    img = glow(img, W * 0.25, H * 0.22, W * 0.45, "#7fdcff" if dark else "#ffffff", 0.25 if dark else 0.5, 2.0, "screen")
    n = 1400
    for k, col in enumerate(bands):
        base = H * (0.50 + 0.07 * k)
        amp = H * (0.018 + 0.006 * k)
        lam = [rng.uniform(0.55, 0.9), rng.uniform(1.6, 2.6)]
        ph = [rng.uniform(0, 2 * math.pi) for _ in range(2)]
        ys = [base - amp * (math.sin(2 * math.pi * x / lam[0] + ph[0]) + 0.35 * math.sin(2 * math.pi * x / lam[1] + ph[1]))
              for x in (i / (n - 1) for i in range(n))]
        mask, y_top = fill_below(img, ys, mix(col, crest, 0.18 if not dark else 0.08), col)
        # a thin bright line along the crest
        line = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(line)
        d.line([(i / (n - 1) * W, y) for i, y in enumerate(ys)], fill=255, width=3)
        line = line.filter(ImageFilter.GaussianBlur(2.2))
        img.paste(Image.new("RGB", (W, H), rgb(crest)), (0, 0), line.point(lambda v: int(v * (0.55 if dark else 0.7))))
    return grain(img, 2.0), accent


# ------------------------------------------------------------------------------------------------ Seda (silk ribbons)


def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return (u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
            u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1])


def ribbon(layer, pts, width, twist, palette, back, strands=170, steps=420, alpha=235):
    """A twisting band of silk: many thin strands across its width, lit by how much the band faces us."""
    d = ImageDraw.Draw(layer)
    centre = [bezier(*pts, i / steps) for i in range(steps + 1)]
    normals = []
    for i in range(steps + 1):
        a, b = centre[max(0, i - 1)], centre[min(steps, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1
        normals.append((-dy / L, dx / L))
    for j in range(strands):
        s = j / (strands - 1) - 0.5
        prev = None
        for i in range(steps + 1):
            t = i / steps
            th = twist[0] + (twist[1] - twist[0]) * t
            c = math.cos(th)
            w = width * (0.55 + 0.45 * math.sin(math.pi * t))
            off = s * w * c
            x = centre[i][0] + normals[i][0] * off
            y = centre[i][1] + normals[i][1] * off
            if prev is not None:
                facing = abs(c)
                sheen = 0.55 + 0.45 * math.cos(math.pi * s * 1.6 - 0.6 * math.sin(th))
                lum = 0.22 + 0.78 * facing * sheen
                k = min(len(palette) - 1.0001, t * (len(palette) - 1))
                col = mix(palette[int(k)], palette[int(k) + 1], k - int(k))
                if c < 0:
                    col = mix(col, back, 0.45)
                col = tuple(min(255, int(v * lum + 255 * max(0.0, lum - 0.92) * 2)) for v in col)
                d.line([prev, (x, y)], fill=col + (alpha,), width=5)
            prev = (x, y)


def seda(dark, seed=5):
    if dark:
        img = vgrad([(0, "#07080f"), (0.6, "#0b0d18"), (1, "#0e0f1d")])
        img = glow(img, W * 0.5, H * 0.55, W * 0.6, "#2a1d55", 0.6, 1.8)
        back, accent = "#1a1036", "#9a7cff"
    else:
        img = vgrad([(0, "#f4f5fb"), (1, "#e9ecf6")])
        img = glow(img, W * 0.55, H * 0.5, W * 0.6, "#ffffff", 0.7, 1.6)
        back, accent = "#c9c2ff", "#7c6cff"
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ribbon(layer, [(-0.10 * W, 0.92 * H), (0.30 * W, 0.40 * H), (0.62 * W, 1.05 * H), (1.10 * W, 0.46 * H)],
           W * 0.13, (0.2, 3.6), ["#5b3df5", "#8f5cff", "#ff5caa", "#ff9a6b"], back)
    ribbon(layer, [(-0.08 * W, 0.18 * H), (0.38 * W, 0.02 * H), (0.55 * W, 0.62 * H), (1.08 * W, 0.08 * H)],
           W * 0.085, (1.2, 4.0), ["#2fc7ff", "#4f7bff", "#7c6cff", "#b46cff"], back, strands=140)
    layer = layer.filter(ImageFilter.GaussianBlur(1.6))
    shadow = layer.split()[3].filter(ImageFilter.GaussianBlur(60)).point(lambda v: int(v * (0.55 if dark else 0.22)))
    img.paste(Image.new("RGB", (W, H), (0, 0, 0) if dark else (90, 80, 140)), (0, 30), shadow)
    img.paste(layer.convert("RGB"), (0, 0), layer.split()[3])
    return grain(img, 1.8), accent


# ------------------------------------------------------------------------------------------------ Cristal (glass)


def cristal(dark, seed=11):
    rng = random.Random(seed)
    if dark:
        img = Image.new("RGB", (W, H), rgb("#0b0e17"))
        blobs = [("#7c6cff", 0.20, 0.30, 0.55, 0.75), ("#38d9ff", 0.85, 0.20, 0.42, 0.55), ("#ff5caa", 0.70, 0.95, 0.55, 0.55), ("#3ddc97", 0.30, 0.95, 0.32, 0.25)]
        tint, edge, accent = (255, 255, 255), 0.30, "#7c6cff"
    else:
        img = Image.new("RGB", (W, H), rgb("#eef1f8"))
        blobs = [("#a99cff", 0.20, 0.30, 0.55, 0.85), ("#8fe6ff", 0.85, 0.20, 0.42, 0.75), ("#ffa3cf", 0.70, 0.95, 0.55, 0.7), ("#9ef0c8", 0.30, 0.95, 0.32, 0.5)]
        tint, edge, accent = (255, 255, 255), 0.55, "#6d5cf0"
    for c, x, y, r, a in blobs:
        img = glow(img, W * x, H * y, W * r, c, a, 1.6)
    img = img.filter(ImageFilter.GaussianBlur(30))
    panes = [  # x, y, w, h (fractions), corner radius (fraction of W), angle
        (0.08, 0.14, 0.26, 0.34, 0.025, -8),
        (0.66, 0.08, 0.24, 0.24, 0.12, 0),
        (0.60, 0.56, 0.30, 0.30, 0.03, 10),
        (0.16, 0.64, 0.18, 0.18, 0.09, 0),
    ]
    for (fx, fy, fw, fh, fr, ang) in panes:
        bw, bh, rr = int(W * fw), int(H * fh), int(W * fr)
        pad = int(max(bw, bh) * 0.3)
        box = (max(0, int(W * fx) - pad), max(0, int(H * fy) - pad), min(W, int(W * fx) + bw + pad), min(H, int(H * fy) + bh + pad))

        def rect(d, s, ox, oy, inset=0):
            d.rounded_rectangle(((W * fx - ox + inset) * s, (H * fy - oy + inset) * s, (W * fx + bw - ox - inset) * s, (H * fy + bh - oy - inset) * s), radius=max(1, (rr - inset)) * s, fill=255)

        outer = shape_mask(lambda d, s, ox, oy: rect(d, s, ox, oy), box)
        inner = shape_mask(lambda d, s, ox, oy: rect(d, s, ox, oy, 4), box)
        if ang:
            outer = outer.rotate(ang, Image.BICUBIC)
            inner = inner.rotate(ang, Image.BICUBIC)
        ring = ImageChops.subtract(outer, inner)
        # drop shadow, then the frosted pane (what is behind it, blurred and lifted), then its bright edge
        sh = outer.filter(ImageFilter.GaussianBlur(40)).point(lambda v: int(v * (0.45 if dark else 0.18)))
        img.paste(Image.new("RGB", outer.size, (0, 0, 0) if dark else (70, 60, 120)), (box[0], box[1] + 24), sh)
        region = img.crop(box).filter(ImageFilter.GaussianBlur(48))
        region = Image.blend(region, Image.new("RGB", region.size, tint), 0.10 if dark else 0.35)
        region = ImageEnhance.Brightness(region).enhance(1.10 if dark else 1.03)
        sheen = vgrad([(0, (255, 255, 255)), (1, (255, 255, 255))], region.size[0], region.size[1])
        top = alpha_ramp(region.size[1], 0, region.size[1], 0.16 if dark else 0.25, 0).resize(region.size, Image.NEAREST)
        region.paste(sheen, (0, 0), top)
        img.paste(region, box[:2], outer)
        img.paste(Image.new("RGB", outer.size, tint), box[:2], ring.point(lambda v: int(v * edge)))
    return grain(img, 1.6), accent


# ------------------------------------------------------------------------------------------------ Nébula


def nebula(seed=3):
    rng = random.Random(seed)
    img = vgrad([(0, "#03040a"), (1, "#070818")])
    img = stars(img, random.Random(seed + 9), 5200, H, 1.0)
    a = value_noise(rng, 5, 5)
    b = value_noise(rng, 7, 5)
    # a diagonal river of gas: denser along a band from the bottom left to the top right
    band = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(band)
    d.line([(-0.1 * W, 1.05 * H), (0.45 * W, 0.55 * H), (1.1 * W, -0.05 * H)], fill=255, width=int(H * 0.55))
    band = band.filter(ImageFilter.GaussianBlur(H * 0.16))

    def density(n, lo, hi):
        return ImageChops.multiply(n.point(lambda v: int(255 * min(1, max(0, (v - lo) / (hi - lo))) ** 1.6)), band)

    da, db = density(a, 112, 175), density(b, 120, 180)
    img.paste(Image.new("RGB", (W, H), rgb("#b04cff")), (0, 0), da.point(lambda v: int(v * 0.85)))
    img.paste(Image.new("RGB", (W, H), rgb("#2fc7ff")), (0, 0), db.point(lambda v: int(v * 0.65)))
    core = ImageChops.multiply(da, db).point(lambda v: min(255, int(v * 2.2)))
    img.paste(Image.new("RGB", (W, H), rgb("#ffd6f4")), (0, 0), core.filter(ImageFilter.GaussianBlur(8)))
    img = glow(img, W * 0.56, H * 0.48, W * 0.10, "#ffe9ff", 0.35, 2.4, "screen")
    # bright foreground stars on top of the gas
    img = stars(img, random.Random(seed + 4), 140, H, 1.0)
    return grain(img, 2.6), "#b04cff"


# ------------------------------------------------------------------------------------------------ output


def ink_of(img):
    """Text colour for the desktop clock: from the brightness of the middle of the picture."""
    c = img.crop((int(W * 0.25), int(H * 0.18), int(W * 0.75), int(H * 0.58))).convert("L").resize((64, 32), Image.BOX)
    mean = sum(c.tobytes()) / (64 * 32) / 255
    return ("dark" if mean > 0.56 else "light"), round(mean, 3)


IMAGES = [  # id, name, maker
    ("cumbres-amanecer", "Cumbres · amanecer", lambda: cumbres("amanecer")),
    ("cumbres-dia", "Cumbres · día", lambda: cumbres("dia")),
    ("cumbres-atardecer", "Cumbres · atardecer", lambda: cumbres("atardecer")),
    ("cumbres-noche", "Cumbres · noche", lambda: cumbres("noche")),
    ("dunas-dia", "Dunas", lambda: dunas(False)),
    ("dunas-noche", "Dunas · noche", lambda: dunas(True)),
    ("marea-clara", "Marea", lambda: marea(False)),
    ("marea-oscura", "Marea · noche", lambda: marea(True)),
    ("seda-clara", "Seda", lambda: seda(False)),
    ("seda-oscura", "Seda · oscuro", lambda: seda(True)),
    ("cristal-claro", "Cristal", lambda: cristal(False)),
    ("cristal-oscuro", "Cristal · oscuro", lambda: cristal(True)),
    ("nebula", "Nébula", lambda: nebula()),
]

COLLECTION = [
    {"id": "pantera", "name": "Pantera", "light": "pantera", "dark": "pantera"},
    {"id": "aurora", "name": "Aurora", "light": "aurora", "dark": "aurora"},
    {"id": "cumbres", "name": "Cumbres", "light": "cumbres-dia", "dark": "cumbres-noche"},
    {"id": "cumbres-hora", "name": "Cumbres según la hora",
     "dynamic": [[6, "cumbres-amanecer"], [9, "cumbres-dia"], [18, "cumbres-atardecer"], [21, "cumbres-noche"]]},
    {"id": "atardecer", "name": "Atardecer", "light": "cumbres-atardecer", "dark": "cumbres-atardecer"},
    {"id": "dunas", "name": "Dunas", "light": "dunas-dia", "dark": "dunas-noche"},
    {"id": "marea", "name": "Marea", "light": "marea-clara", "dark": "marea-oscura"},
    {"id": "seda", "name": "Seda", "light": "seda-clara", "dark": "seda-oscura"},
    {"id": "cristal", "name": "Cristal", "light": "cristal-claro", "dark": "cristal-oscuro"},
    {"id": "nebula", "name": "Nébula", "light": "nebula", "dark": "nebula"},
]


def main():
    args = sys.argv[1:]
    only, preview = None, None
    if "--only" in args:
        i = args.index("--only")
        only = set(args[i + 1].split(","))
        del args[i:i + 2]
    if "--preview" in args:
        i = args.index("--preview")
        preview = args[i + 1]
        del args[i:i + 2]
    here = os.path.dirname(os.path.abspath(__file__))
    out = args[0] if args else os.path.join(here, "..", "mkosi.extra", "usr", "share", "nexus", "wallpapers")
    os.makedirs(os.path.join(out, "thumbs"), exist_ok=True)
    index_path = os.path.join(out, "index.json")
    try:
        with open(index_path, encoding="utf-8") as f:
            images = json.load(f).get("images", {})
    except (OSError, ValueError):
        images = {}
    # Aurora (os/art/make-lock-art.py) is part of the collection too
    aur = Image.open(os.path.join(out, "aurora.png")).convert("RGB")
    aur_full = aur.resize((W, H), Image.LANCZOS) if aur.size != (W, H) else aur
    aur.resize((480, 300), Image.LANCZOS).save(os.path.join(out, "thumbs", "aurora.jpg"), quality=86)
    ink, _ = ink_of(aur_full)
    images["aurora"] = {"file": "aurora.png", "thumb": "thumbs/aurora.jpg", "ink": ink, "accent": "#7c6cff", "name": "Aurora"}
    thumbs = [("aurora", aur)]
    # Pantera: the person's look (09-11): kept at its own size (2688 wide; screens scale it), padded to 16:10 with the
    # picture's own black so there is no seam, the head stays where the picture has it
    src = Image.open(os.path.join(here, "pantera-fuente.png")).convert("RGB")
    ph = round(src.width * 10 / 16)
    pan = Image.new("RGB", (src.width, ph), (0, 0, 0))
    pan.paste(src, (0, (ph - src.height) // 2))
    pan.save(os.path.join(out, "pantera.jpg"), quality=93, optimize=True, progressive=True, subsampling="4:4:4")
    pan.resize((480, 300), Image.LANCZOS).save(os.path.join(out, "thumbs", "pantera.jpg"), quality=88)
    images["pantera"] = {"file": "pantera.jpg", "thumb": "thumbs/pantera.jpg", "ink": "light", "accent": "#22d3ee", "name": "Pantera"}
    thumbs.insert(0, ("pantera", pan))
    # the taskbar's start button: the head, found by where the picture glows, in a round dark badge (256 px)
    lum = src.convert("L").point(lambda v: 255 if v > 48 else 0)
    l, t, r, b = lum.getbbox()
    side = int(max(r - l, b - t) * 1.12)
    cx, cy = (l + r) // 2, (t + b) // 2
    head = src.crop((cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)).resize((512, 512), Image.LANCZOS)
    badge = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    disc = Image.new("L", (512, 512), 0)
    ImageDraw.Draw(disc).ellipse((4, 4, 507, 507), fill=255)
    bg = Image.new("RGBA", (512, 512), (8, 10, 16, 255))
    bg.paste(head, (0, 0))
    badge.paste(bg, (0, 0), disc)
    ImageDraw.Draw(badge).ellipse((4, 4, 507, 507), outline=(63, 240, 255, 90), width=6)
    icons = os.path.join(out, "..", "icons")
    badge.resize((256, 256), Image.LANCZOS).save(os.path.join(icons, "pantera-logo.png"), optimize=True)
    for iid, name, make in IMAGES:
        if only and iid not in only:
            if iid in images and os.path.exists(os.path.join(out, iid + ".jpg")):
                thumbs.append((iid, Image.open(os.path.join(out, "thumbs", iid + ".jpg"))))
            continue
        img, accent = make()
        img.save(os.path.join(out, iid + ".jpg"), quality=90, optimize=True, progressive=True, subsampling="4:4:4")
        img.resize((480, 300), Image.LANCZOS).save(os.path.join(out, "thumbs", iid + ".jpg"), quality=86)
        ink, mean = ink_of(img)
        images[iid] = {"file": iid + ".jpg", "thumb": "thumbs/" + iid + ".jpg", "ink": ink, "accent": accent, "name": name}
        thumbs.append((iid, img))
        print(f"{iid:20s} ink={ink:5s} centre={mean}", flush=True)
    for c in COLLECTION:
        for key in ("light", "dark"):
            assert c.get(key) is None or c[key] in images, c
        for _, iid in c.get("dynamic", []):
            assert iid in images, c
    with open(index_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"version": 1, "images": images, "collection": COLLECTION}, f, ensure_ascii=False, indent=1)
    os.replace(index_path + ".tmp", index_path)
    if preview:
        cols = 4
        rows = (len(thumbs) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * 480, rows * 300), (0, 0, 0))
        for k, (iid, im) in enumerate(thumbs):
            sheet.paste(im.resize((480, 300), Image.LANCZOS), ((k % cols) * 480, (k // cols) * 300))
            ImageDraw.Draw(sheet).text(((k % cols) * 480 + 8, (k // cols) * 300 + 6), iid, fill=(255, 255, 0))
        sheet.save(preview)


if __name__ == "__main__":
    main()
