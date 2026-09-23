"""Luckagent tangram robot logo (chosen concept B2), redrawn with exact tangram geometry.

Seven classic pieces (small-leg a = 64): 2 large triangles (legs 2a) = head, 1 medium
triangle (legs a*sqrt2) = antenna, 2 small triangles (legs a) = ears, 1 square (side a)
+ 1 parallelogram (sides a, a*sqrt2) = mouth. Two dots = eyes.
Outputs: logo.svg / logo-dark.svg (mark), logo-mark-512.png, logo-lockup.png / logo-lockup-dark.png.\nUsage: python3 scripts/make-logo.py docs/images   (needs Pillow; wordmark font: macOS Avenir Next)
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
A = 64
R2 = math.sqrt(2)

NAVY, TEAL, GOLD, SKY = "#163A6B", "#179C95", "#E9AE3A", "#7DB7F0"
NAVY_DARK = "#3D74BF"  # navy pieces on dark backgrounds

hyp_s = A * R2  # small triangle hypotenuse
PIECES = [
    ("antenna", GOLD, [(192, 150), (320, 150), (256, 86)]),                   # medium
    ("head-l", NAVY, [(256, 150), (128, 150), (256, 278)]),                   # large
    ("head-r", TEAL, [(256, 150), (384, 150), (256, 278)]),                   # large
    ("ear-l", SKY, [(150, 222 - hyp_s / 2), (150, 222 + hyp_s / 2), (150 - hyp_s / 2, 222)]),
    ("ear-r", GOLD, [(362, 222 - hyp_s / 2), (362, 222 + hyp_s / 2), (362 + hyp_s / 2, 222)]),
    ("mouth-sq", SKY, [(154, 290), (218, 290), (218, 354), (154, 354)]),       # square
    ("mouth-pg", NAVY, [(230, 354), (294, 354), (358, 290), (294, 290)]),      # parallelogram
]
EYES = [(180, 222), (332, 222)]
EYE_R = 15
GAP = 5  # inset per edge -> ~10px seams between neighbouring pieces

# normalise: centre the drawing in a 512 box, fill ~88% of the width
xs = [x for _, _, pts in PIECES for x, _ in pts]
ys = [y for _, _, pts in PIECES for _, y in pts]
cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
SCALE = min(440 / (max(xs) - min(xs)), 440 / (max(ys) - min(ys)))


def tf(p):
    return ((p[0] - cx) * SCALE + 256, (p[1] - cy) * SCALE + 256)


def inset(poly, d):
    """Offset a convex polygon inwards by d (edge-parallel), returning new vertices."""
    area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
    sign = 1 if area > 0 else -1
    lines = []
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
        ex, ey = x2 - x1, y2 - y1
        L = math.hypot(ex, ey)
        nx, ny = -ey / L * sign, ex / L * sign  # inward normal
        lines.append(((x1 + nx * d, y1 + ny * d), (ex, ey)))
    out = []
    for i in range(len(lines)):
        (p, r), (q, s) = lines[i - 1], lines[i]
        cross = r[0] * s[1] - r[1] * s[0]
        t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / cross
        out.append((p[0] + t * r[0], p[1] + t * r[1]))
    return out


SHAPES = [(name, color, [tf(p) for p in inset(pts, GAP)]) for name, color, pts in PIECES]
EYES_T = [tf(e) for e in EYES]
EYE_RT = EYE_R * SCALE


def svg(navy=NAVY):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Luckagent">']
    for name, color, pts in SHAPES:
        c = navy if color == NAVY else color
        d = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        parts.append(f'  <polygon points="{d}" fill="{c}"><title>{name}</title></polygon>')
    for x, y in EYES_T:
        parts.append(f'  <circle cx="{x:.1f}" cy="{y:.1f}" r="{EYE_RT:.1f}" fill="{navy}"/>')
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def mark_png(size, navy=NAVY, ss=4):
    big = Image.new("RGBA", (512 * ss, 512 * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    for _, color, pts in SHAPES:
        d.polygon([(x * ss, y * ss) for x, y in pts], fill=navy if color == NAVY else color)
    for x, y in EYES_T:
        r = EYE_RT * ss
        d.ellipse([x * ss - r, y * ss - r, x * ss + r, y * ss + r], fill=navy)
    return big.resize((size, size), Image.LANCZOS)


def lockup(text_color, navy):
    H = 240
    mark = mark_png(H, navy)
    font = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc", 150, index=0)  # Avenir Next Bold
    tmp = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    bbox = tmp.textbbox((0, 0), "Luckagent", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    W = H + 24 + tw + 20
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    img.alpha_composite(mark, (0, 0))
    d = ImageDraw.Draw(img)
    d.text((H + 24 - bbox[0], (H - th) / 2 - bbox[1] + 6), "Luckagent", font=font, fill=text_color)
    return img


open(f"{OUT}/logo.svg", "w").write(svg())
open(f"{OUT}/logo-dark.svg", "w").write(svg(NAVY_DARK))
mark_png(512).save(f"{OUT}/logo-mark-512.png")
lockup(NAVY, NAVY).save(f"{OUT}/logo-lockup.png")
lockup("#FFFFFF", NAVY_DARK).save(f"{OUT}/logo-lockup-dark.png")
print("ok")
