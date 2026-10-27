#!/usr/bin/env python3
"""
Build the Rankings mode mark from the Events mark.

The two marks sit side by side in the mode switch, so they have to read as one
family. Three earlier versions redrew the swirl from Riot's published artwork
and each one came out a *different* swirl - denser blades, a closed ring - next
to logo.png's thin, wispy, open one. Redrawing it is the mistake. This script
lifts the swirl out of `logo.png` by colour and composites a new object over
it, so the two marks cannot drift: there is exactly one swirl, and it is the
one already on the page.

What the looking glass is, measured off logo.png:

  swirl   bbox (16,22)-(157,160), 142x142, centre (86.5, 91)
  lens    an unfilled ~3px ring of #CCCCCC, diameter 58, centre (100.5, 95)
  handle  #C87137, running down-right from the lens and out past the swirl

**The composition is shared; the material is not.** An earlier version drew the
trophy the way the lens is drawn - an unfilled grey outline - and it came out
looking like it was made of glass, which is right for a spyglass and wrong for
a trophy. What the two marks owe each other is placement and weight: an object
over the swirl's open centre, pushed down and to the right, at a size that
leaves the blades legible. The cup is gold and solid.

Gold on orange is the problem that sizing alone does not solve - #F2C230 sits
15 degrees of hue from the swirl's #EF7D01 and both are fully saturated, so a
flat gold cup disappears into the blades behind it at the 36px this actually
renders at. A dark contour fixes it: every shape is filled gold and outlined
#4A2608, which separates the cup from the swirl at any size without making it
a different colour.

    python3 build-rankings-mark.py ../public/logo.png ../public/logo-rankings-v5.png
"""
import colorsys
import sys

from PIL import Image, ImageDraw

SS = 8                       # supersample factor; PIL has no antialiased stroking

GOLD = (242, 194, 48, 255)      # #F2C230, the cup
GOLD_DEEP = (200, 137, 31, 255)  # #C8891F, the base, so the plinth reads as separate
CONTOUR = (74, 38, 8, 255)       # #4A2608, what keeps gold off orange

# The lens's own geometry, which the cup is placed against.
CX, CY = 100.5, 95.0
LENS_D = 58.0
# The cup is drawn at LENS_D and then scaled about its own centre. The glass
# sits at 41% of the swirl; a trophy has more internal detail - handles, stem,
# plinth - so it needs more room to stay legible small.
TROPHY_D = 68.0
SCALE = TROPHY_D / LENS_D


def extract_swirl(src):
    """The orange swirl alone.

    The blades are hue 31 at saturation 1.0; the handle is hue 24 at 0.72 and
    the lens is unsaturated grey, so a saturation cut separates all three
    cleanly. Antialiased blade edges keep the hue and lose only value, so they
    survive the cut and the silhouette stays soft.
    """
    w, h = src.size
    px = src.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 8:
                continue
            hue, sat, val = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if sat >= 0.88 and 26 <= hue * 360 <= 36 and val > 0.2:
                op[x, y] = (r, g, b, a)
    return out


def bezier(points, steps=48):
    """Sample a cubic Bezier as a polyline."""
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ))
    return out


def cup_shapes():
    """The trophy, authored at LENS_D and scaled about (CX, CY) afterwards.

    Filled areas and stroked ones are kept apart because they are outlined
    differently: a polygon takes its contour from `outline`, while an open
    handle gets one by being drawn twice, dark and wide first.
    """
    cx = CX
    bowl = (
        [(cx - 20, 70)]
        + bezier([(cx - 20, 70), (cx - 19, 86), (cx - 13, 97), (cx - 7, 99)])
        + [(cx + 7, 99)]
        + bezier([(cx + 7, 99), (cx + 13, 97), (cx + 19, 86), (cx + 20, 70)])
    )
    stem = [(cx - 3.5, 98), (cx + 3.5, 98), (cx + 5, 108), (cx - 5, 108)]
    base = [
        (cx - 9, 106), (cx + 9, 106), (cx + 11, 113),
        (cx + 15, 113), (cx + 15, 120), (cx - 15, 120),
        (cx - 15, 113), (cx - 11, 113),
    ]
    handles = [
        bezier([(cx - 20, 73), (cx - 31, 76), (cx - 30, 89), (cx - 12, 92)]),
        bezier([(cx + 20, 73), (cx + 31, 76), (cx + 30, 89), (cx + 12, 92)]),
    ]
    filled = [(bowl, GOLD), (stem, GOLD), (base, GOLD_DEEP)]
    return filled, handles


def scaled(points):
    return [(CX + (x - CX) * SCALE, CY + (y - CY) * SCALE) for x, y in points]


def draw_cup(size):
    """Stroke and fill the cup at SS scale, then hand back a native-size canvas."""
    big = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    edge = max(1, round(2.6 * SS))
    filled, handles = cup_shapes()

    # Handles first, so the bowl's fill covers where they meet it. Each is an
    # open path, so its contour is a wider dark pass underneath the gold.
    for path in handles:
        pts = [(x * SS, y * SS) for x, y in scaled(path)]
        for colour, width in ((CONTOUR, round(4.2 * SS) + edge), (GOLD, round(4.2 * SS))):
            d.line(pts, fill=colour, width=width, joint="curve")
            r = width / 2
            for x, y in (pts[0], pts[-1]):
                d.ellipse([x - r, y - r, x + r, y + r], fill=colour)

    for path, colour in filled:
        pts = [(x * SS, y * SS) for x, y in scaled(path)]
        d.polygon(pts, fill=colour, outline=CONTOUR, width=edge)

    return big.resize((size, size), Image.LANCZOS)


def main(src_path, out_path):
    src = Image.open(src_path).convert("RGBA")
    size = src.size[0]
    assert src.size[0] == src.size[1], "the mark is square"

    mark = extract_swirl(src)
    mark.alpha_composite(draw_cup(size))
    mark.save(out_path)

    print(f"wrote {out_path} {mark.size}, content bbox {mark.getbbox()}")
    print(f"cup: {TROPHY_D:.0f}px on a {size}px canvas "
          f"({TROPHY_D / 142 * 100:.0f}% of the swirl), centred ({CX}, {CY}), "
          f"offset (+{CX - 86.5:.0f}, +{CY - 91:.0f}) from the swirl centre")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
