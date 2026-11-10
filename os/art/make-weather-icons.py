#!/usr/bin/env python3
"""Weather icons for the desktop's weather card (shell/WeatherCard.qml), as small SVGs (no dependencies).

Why: the card showed the colour-emoji glyph of the weather (🌧️, 🌙...), which looks pasted in next to the glass and
violet of NEXUS. These are drawn in the same style as the concept (docs/concepto/1-inicio-concepto.png: a pale glowing
moon): soft radial glow, gradient bodies, lavender-white clouds, blue drops. Only what Qt SVG (SVG Tiny 1.2) draws:
paths, circles, gradients and opacity; no filters, masks or clip paths. Gradients on clouds are in user space, so the
overlapping circles of a cloud read as one shape.

Names = the `glyph` field of describeWeather() in core/src/sessiond.ts:
  sun moon partly-day partly-night cloud fog showers-day showers-night rain snow storm
into os/mkosi.extra/usr/share/nexus/icons/weather-<name>.svg.
Run:  python3 os/art/make-weather-icons.py
"""
import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "mkosi.extra", "usr", "share", "nexus", "icons")

DEFS = """<defs>
<radialGradient id="sunGlow"><stop offset="0" stop-color="#ffd27a" stop-opacity=".55"/><stop offset=".45" stop-color="#ffb84d" stop-opacity=".18"/><stop offset="1" stop-color="#ffb84d" stop-opacity="0"/></radialGradient>
<radialGradient id="sunBody" cx=".36" cy=".32" r=".75"><stop offset="0" stop-color="#fff7d1"/><stop offset=".55" stop-color="#ffc857"/><stop offset="1" stop-color="#ff9a2e"/></radialGradient>
<radialGradient id="moonGlow"><stop offset="0" stop-color="#ece8ff" stop-opacity=".50"/><stop offset=".45" stop-color="#c9c0ff" stop-opacity=".16"/><stop offset="1" stop-color="#c9c0ff" stop-opacity="0"/></radialGradient>
<radialGradient id="moonBody" cx=".3" cy=".3" r=".85"><stop offset="0" stop-color="#fffdf2"/><stop offset=".6" stop-color="#f1ecff"/><stop offset="1" stop-color="#c8c0f4"/></radialGradient>
<linearGradient id="cloud" gradientUnits="userSpaceOnUse" x1="0" y1="15" x2="0" y2="48"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#ebe8ff"/><stop offset="1" stop-color="#bdb7ee"/></linearGradient>
<linearGradient id="cloudDark" gradientUnits="userSpaceOnUse" x1="0" y1="15" x2="0" y2="48"><stop offset="0" stop-color="#d9d5f6"/><stop offset="1" stop-color="#7f78bf"/></linearGradient>
<linearGradient id="drop" gradientUnits="userSpaceOnUse" x1="0" y1="44" x2="0" y2="60"><stop offset="0" stop-color="#bfe6ff"/><stop offset="1" stop-color="#4f8cff"/></linearGradient>
<linearGradient id="bolt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0a0"/><stop offset="1" stop-color="#ffab1a"/></linearGradient>
<linearGradient id="fog" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d9d4ff" stop-opacity=".35"/><stop offset=".5" stop-color="#f4f2ff"/><stop offset="1" stop-color="#d9d4ff" stop-opacity=".35"/></linearGradient>
</defs>"""


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def sun(cx, cy, r):
    return (f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r * 2.2)}" fill="url(#sunGlow)"/>'
            f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="url(#sunBody)"/>')


def moon(cx, cy, r):
    """Crescent = disc (cx, cy, r) minus a disc up and to the right, as one path of two arcs."""
    bx, by, br = cx + 0.55 * r, cy - 0.42 * r, 0.8 * r
    d = math.hypot(bx - cx, by - cy)
    a = (r * r - br * br + d * d) / (2 * d)          # distance from the moon's centre to the chord
    h = math.sqrt(r * r - a * a)
    mx, my = cx + a * (bx - cx) / d, cy + a * (by - cy) / d
    ux, uy = -(by - cy) / d, (bx - cx) / d
    p1 = (mx + h * ux, my + h * uy)
    p2 = (mx - h * ux, my - h * uy)
    path = (f"M{f(p1[0])} {f(p1[1])}"
            f"A{f(r)} {f(r)} 0 1 1 {f(p2[0])} {f(p2[1])}"      # the outer edge, the long way round
            f"A{f(br)} {f(br)} 0 0 0 {f(p1[0])} {f(p1[1])}Z")  # the inner edge, along the cut-out disc
    return (f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r * 2.1)}" fill="url(#moonGlow)"/>'
            f'<path d="{path}" fill="url(#moonBody)"/>')


def cloud(dx=0.0, dy=0.0, s=1.0, fill="cloud"):
    shape = (f'<circle cx="21" cy="37" r="10"/><circle cx="33" cy="29" r="14"/><circle cx="45" cy="36" r="10"/>'
             f'<rect x="11" y="35" width="44" height="13" rx="6.5"/>')
    return f'<g transform="translate({f(dx)} {f(dy)}) scale({f(s)})" fill="url(#{fill})">{shape}</g>'


def drops(points):
    return "".join(f'<path d="M{f(x)} {f(y)}l-3 7.5" stroke="url(#drop)" stroke-width="3.4" stroke-linecap="round" fill="none"/>'
                   for x, y in points)


def flakes(points):
    return "".join(f'<circle cx="{f(x)}" cy="{f(y)}" r="2.7" fill="#ffffff" fill-opacity=".95"/>' for x, y in points)


ICONS = {
    "sun": sun(32, 32, 15),
    "moon": moon(32, 33, 18),
    "cloud": cloud(0, 2),
    "partly-day": sun(23, 22, 10) + cloud(6, 8, 0.85),
    "partly-night": moon(23, 22, 10.5) + cloud(6, 8, 0.85),
    "showers-day": sun(23, 15, 9) + cloud(6, 1, 0.85) + drops([(29, 46), (39, 46)]),
    "showers-night": moon(23, 15, 9.5) + cloud(6, 1, 0.85) + drops([(29, 46), (39, 46)]),
    "rain": cloud(0, -6) + drops([(23, 47), (33, 47), (43, 47)]),
    "snow": cloud(0, -6) + flakes([(21, 49), (32, 52), (43, 49), (26.5, 58), (37.5, 58)]),
    "storm": cloud(0, -6, 1, "cloudDark") + '<path d="M35 37L26 51h7l-4 11 12-15h-7l4-10z" fill="url(#bolt)"/>',
    "fog": ('<path d="M15 26h34M10 34h44M16 42h32M22 50h20" stroke="url(#fog)" stroke-width="4.2" '
            'stroke-linecap="round" fill="none"/>'),
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, body in ICONS.items():
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{DEFS}{body}</svg>\n'
        with open(os.path.join(OUT, f"weather-{name}.svg"), "w", encoding="utf-8") as fh:
            fh.write(svg)
    print(f"{len(ICONS)} icons in {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
