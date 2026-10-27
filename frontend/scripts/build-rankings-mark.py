#!/usr/bin/env python3
"""
Build the Rankings mode mark from the Events mark.

The two marks sit side by side in the mode switch, so they have to read as one
family. Three earlier attempts redrew the swirl from Riot's published artwork
and each one came out a *different* swirl - denser blades, a closed ring - next
to logo.png's thin, wispy, open one. Redrawing it is the mistake. This script
lifts the swirl out of `logo.png` by colour and composites a new object over
it, so the two marks cannot drift: there is exactly one swirl, and it is the
one already on the page.

What the looking glass actually is, measured off logo.png:

  swirl   bbox (16,22)-(157,160), 142x142, centre (86.5, 91)
  lens    an UNFILLED ring, ~3px of #CCCCCC, diameter 58, centre (100.5, 95)
  handle  #C87137, running down-right from the lens and out past the swirl

The lens being an outline is the whole character of the mark - the swirl shows
through it, which is what makes it a glass rather than a coin. So the trophy is
an outline too, at the lens's stroke weight, in the lens's grey, with the base
in the handle's brown. Same size as the lens (58 wide, 41% of the swirl, "about
half"), same offset from the swirl's centre (+14, +4), down and to the right.

    python3 build-rankings-mark.py ../public/logo.png ../public/logo-rankings-v4.png
"""
import colorsys
import sys

from PIL import Image, ImageDraw

SS = 8                      # supersample factor; PIL has no antialiased stroking
STROKE = 3.4                # the lens ring measures 3; a touch more holds at 36px
GREY = (204, 204, 204, 255)  # #CCCCCC, the lens
BROWN = (200, 113, 55, 255)  # #C87137, the handle

CX, CY = 100.5, 95.0        # the lens centre: where the new object goes
LENS_D = 58.0               # the lens diameter: how big it may be


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


def bezier(points, steps=64):
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


def trophy_paths():
    """The cup, in final-image coordinates.

    Laid out inside the lens's own 58px box: the rim spans 40, the handles
    reach +-31 (matching the lens's 58 silhouette), and the foot sits at y=119
    against a rim at y=70, centring the cup on the lens centre.

    The foot is a **filled** brown bar rather than an outline. The mark is
    rendered at 36px, where a 3px stroke is less than a third of a pixel: the
    bowl survives that because it is big and round, but an outlined pedestal
    turned to grey mush and the cup read as a balloon on a string. The glass
    solves the same problem the same way - a light outlined lens over a solid
    brown handle - so the trophy borrows the answer as well as the palette.
    """
    cx = CX
    bowl = (
        [(cx - 20, 70)]
        + bezier([(cx - 20, 70), (cx - 19, 86), (cx - 13, 97), (cx - 7, 99)])
        + [(cx + 7, 99)]
        + bezier([(cx + 7, 99), (cx + 13, 97), (cx + 19, 86), (cx + 20, 70)])
        + [(cx - 20, 70)]
    )
    left = bezier([(cx - 20, 73), (cx - 31, 76), (cx - 30, 89), (cx - 12, 92)])
    right = bezier([(cx + 20, 73), (cx + 31, 76), (cx + 30, 89), (cx + 12, 92)])
    stem = [(cx, 99), (cx, 108)]
    return [(bowl, GREY), (left, GREY), (right, GREY), (stem, GREY)]


def trophy_foot():
    """The solid brown pedestal, as a filled polygon."""
    cx = CX
    return [
        (cx - 9, 107), (cx + 9, 107), (cx + 11, 113),
        (cx + 15, 113), (cx + 15, 119), (cx - 15, 119),
        (cx - 15, 113), (cx - 11, 113),
    ]


def draw_trophy(size):
    """Stroke the cup at SS scale, then hand back a canvas at native size."""
    big = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    width = max(1, round(STROKE * SS))
    for path, colour in trophy_paths():
        pts = [(x * SS, y * SS) for x, y in path]
        d.line(pts, fill=colour, width=width, joint="curve")
        # PIL strokes without caps, so the ends of an open path come out square
        # and a touch short; a dot at each end rounds them to match the lens.
        for x, y in (pts[0], pts[-1]):
            r = width / 2
            d.ellipse([x - r, y - r, x + r, y + r], fill=colour)
    d.polygon([(x * SS, y * SS) for x, y in trophy_foot()], fill=BROWN)
    return big.resize((size, size), Image.LANCZOS)


def main(src_path, out_path):
    src = Image.open(src_path).convert("RGBA")
    size = src.size[0]
    assert src.size[0] == src.size[1], "the mark is square"

    mark = extract_swirl(src)
    mark.alpha_composite(draw_trophy(size))
    mark.save(out_path)

    # State the invariants that matter, so a bad build is visible in the log
    # rather than three deploys later.
    box = mark.getbbox()
    print(f"wrote {out_path} {mark.size}, content bbox {box}")
    print(f"trophy: {LENS_D:.0f}px on a {size}px canvas "
          f"({LENS_D / 142 * 100:.0f}% of the swirl), centred ({CX}, {CY}), "
          f"offset (+{CX - 86.5:.0f}, +{CY - 91:.0f}) from the swirl centre")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
