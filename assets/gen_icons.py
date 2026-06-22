#!/usr/bin/env python3
"""Generate placeholder PWA icons (a drawn music note) without external deps.
Pure-stdlib PNG encoder + supersampled vector-ish rendering.
Replace these later with custom artwork if desired."""
import zlib, struct, math, os

OUT = os.path.dirname(os.path.abspath(__file__))

BG = (18, 18, 18)        # #121212 app background
PANEL = (30, 30, 30)     # rounded panel #1e1e1e
ACCENT = (108, 140, 255) # note colour

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def sample(x, y):
    """x,y in 0..1 -> (r,g,b)."""
    # rounded panel background (maskable-safe: also fill rest with BG)
    r = 0.16  # corner radius
    inset = 0.0
    # distance to rounded-rect border for panel
    qx = abs(x - 0.5) - (0.5 - inset - r)
    qy = abs(y - 0.5) - (0.5 - inset - r)
    outside = math.hypot(max(qx, 0), max(qy, 0)) - r
    col = PANEL if outside <= 0 else BG

    # music note: two beamed eighth notes
    # noteheads
    heads = [((0.34, 0.72), (0.105, 0.082)), ((0.66, 0.64), (0.105, 0.082))]
    on_note = False
    for (cx, cy), (rx, ry) in heads:
        # slight rotation for style (~ -20deg)
        ang = -0.35
        dx, dy = x - cx, y - cy
        rxx = dx * math.cos(ang) - dy * math.sin(ang)
        ryy = dx * math.sin(ang) + dy * math.cos(ang)
        if (rxx / rx) ** 2 + (ryy / ry) ** 2 <= 1.0:
            on_note = True
    # stems (right edge of each notehead going up)
    stem_w = 0.024
    if seg_dist(x, y, 0.438, 0.70, 0.438, 0.235) <= stem_w:
        on_note = True
    if seg_dist(x, y, 0.758, 0.62, 0.758, 0.175) <= stem_w:
        on_note = True
    # beam connecting stem tops
    if seg_dist(x, y, 0.438, 0.235, 0.758, 0.175) <= 0.045:
        on_note = True

    if on_note:
        col = ACCENT
    return col

def render(size, ss=2):
    n = size * ss
    # accumulate
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            ar = ag = ab = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    c = sample(x, y)
                    ar += c[0]; ag += c[1]; ab += c[2]
            k = ss * ss
            row += bytes((ar // k, ag // k, ab // k, 255))
        rows.append(bytes(row))
    return rows

def write_png(path, size, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw += row
    comp = zlib.compress(bytes(raw), 9)
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))

for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
    rows = render(size, ss=2)
    write_png(os.path.join(OUT, name), size, rows)
    print("wrote", name)
