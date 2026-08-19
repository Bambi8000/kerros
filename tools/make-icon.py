"""
Kerros application icon.

The program's own visual language, at icon size: a stack of cut layers, wide in
the middle and narrowing at both ends, with one layer in the CUT red the DXF
export uses. Three colours and nothing else — an icon that has to read at 16
pixels can carry one idea, and the idea here is the stack.


Run from the repository root:

    pip install pillow
    python3 tools/make-icon.py
    npx tauri icon assets/kerros-icon.png

The second command is the one that matters: it writes every size Tauri needs into
src-tauri/icons, including the .icns and .ico.
"""
from PIL import Image, ImageDraw

S = 1024                      # master size
INSET = int(S * 0.085)        # macOS icons leave their own margin
RADIUS = int(S * 0.225)       # Big Sur corner radius, near enough

BG = (23, 21, 19, 255)        # --k-bg, the warm graphite of the app chrome
SHEET = (214, 205, 194, 255)  # bone, the preview material colour
CUT = (224, 74, 47, 255)      # --k-cut, the DXF CUT layer

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

d.rounded_rectangle([INSET, INSET, S - INSET, S - INSET], RADIUS, fill=BG)

# Layer geometry. Widths follow a rounded profile so the stack reads as a form
# rather than as a bar chart.
# Six layers, not nine. Nine reads beautifully at 256 and turns to mush at 32,
# and 32 is the size a dock icon is actually seen at.
LAYERS = 6
CUT_LAYER = 2                 # counted from the top
inner = S - 2 * INSET
top = INSET + int(inner * 0.13)
bottom = S - INSET - int(inner * 0.13)
span = bottom - top
pitch = span / LAYERS
thickness = pitch * 0.66      # the rest is the spacer gap
half_max = inner * 0.36

for i in range(LAYERS):
    t = (i + 0.5) / LAYERS
    # A superellipse profile: fuller shoulders than a circle, which is what the
    # lamps actually look like.
    # A stronger taper than the lamps really have: the silhouette has to survive
    # being 32 pixels wide.
    half = half_max * (1 - abs(2 * t - 1) ** 2.2) ** (1 / 3.0)
    half = max(half, inner * 0.115)

    y = top + i * pitch
    box = [S / 2 - half, y, S / 2 + half, y + thickness]
    r = thickness / 2

    # One sheet in cut red, the rest in bone. No halo behind it: at 32 pixels a
    # third colour around the edge of the second one reads as blur, not as glow.
    d.rounded_rectangle(box, r, fill=CUT if i == CUT_LAYER else SHEET)

img.save("assets/kerros-icon.png")

print("assets/kerros-icon.png written")
print("regenerate the app icons with: npx tauri icon assets/kerros-icon.png")
