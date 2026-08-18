# KERROS-FEATURES — feature and module catalog

Every feature type that can appear in the feature tree is documented here,
one entry per module. Updated in the same batch as the code that adds it,
never deferred. `KERROS-HANDOFF.md` is the map; this file is the parts list.

Status legend: **shipped** · **in progress** · **planned**

---

## How a shape feature works

The tree is an accumulator. Evaluation starts with an empty field
(`EMPTY = 1e5`, everywhere outside), then each enabled feature combines its
own distance field into the running result using its operation. The first
feature therefore starts the solid whatever its operation says, because
unioning with nothing returns the shape and subtracting from nothing returns
nothing.

Every shape feature carries, on top of its own parameters:

| Param | Meaning | Default |
| --- | --- | --- |
| `op` | union · smoothUnion · subtract · smoothSubtract · intersect · smoothIntersect | `smoothUnion` (`union` for the first feature) |
| `k` | blend radius in mm, used by the smooth ops only | 10 |
| `px py pz` | position in mm | 0 |
| `rx ry rz` | rotation in degrees, applied X then Y then Z | 0 |

**There is no scale parameter, deliberately.** Non-uniform scaling destroys
the distance property of the field, which would corrupt smooth blends and,
later, kerf offsetting. Primitives are dimensioned in mm instead.

Adding a module means adding an entry to `SHAPE_MODULES` in
`src/core/sdf.ts` with `{ key, name, params, sdf, bounds }`. `sdf` is
evaluated in the module's own local space — the transform is applied by the
core before the call, so a module never handles placement itself. `bounds`
returns a local AABB and is what sizes the voxel grid.

## SHAPE — **shipped** (M1)

| Key | Name | Parameters (mm unless noted) |
| --- | --- | --- |
| `sphere` | Sphere | `r` |
| `roundBox` | Rounded box | `sx` `sy` `sz` `r` (corner radius, clamped to the smallest half-extent) |
| `capsule` | Capsule | `h` (straight length, along local Z) `r` |
| `torus` | Torus | `R` (major) `r` (tube), lies in the local XY plane |
| `ellipsoid` | Ellipsoid | `rx` `ry` `rz` |
| `superellipsoid` | Superellipsoid | `rx` `ry` `rz` `e` (exponent, default 1.4) |

Accuracy notes, because they matter downstream:

- `sphere`, `roundBox`, `capsule`, `torus` are exact Euclidean distance
  fields. Blend radii mean exactly what they say.
- `ellipsoid` uses the standard bounded approximation: accurate near the
  surface, conservative further out.
- `superellipsoid` divides the p-norm by its gradient magnitude, giving the
  first-order distance estimate: exact at the surface and within a few percent
  nearby, which is all a blend or a slice reads. The raw p-norm, which the
  first version used, is compressed or stretched depending on direction and
  throws off every blend that touches it.

  Its exponent defaults to **1.4, deliberately below 2**. At 4 a
  superellipsoid *is* a rounded box — that is what the p-norm does at that
  power — and it adds nothing the rounded box module does not already do. The
  shapes worth having are the pinched ones under 2, where the form pulls in
  between the axes: at e = 1 the diagonal reaches 58% of the axis radius,
  where at e = 2 it reaches 100%.

### Display modes — M3.1

Model mode draws the solid three ways: **Solid**, **X-ray** (translucent, with
depth writes off and both sides drawn, so the cavity and the rods inside are
visible through the shell) and **Wire**. X-ray is the one that answers "is that
rod actually inside the wall", which no amount of orbiting a solid will tell
you.

### Slice inspector and exploded stack — M2

The workspace has three modes: **Model** (SDF preview and direct
manipulation), **Slice** (one layer at a time in 2D), and **Stack** (every
layer extruded to real thickness and placed at its real z, so the gaps on
screen are the spacers that will be cut).

Slicing is computed once per change by `useSlices()` and shared by both
consumers. It runs **only while Slice or Stack is open**, debounced 250 ms, so
nobody pays for it while modelling. It is synchronous: a full lamp is a couple
of hundred milliseconds, which the debounce hides. It moves to a Web Worker
when nesting joins it in M4 and the combined cost stops fitting in a frame gap.

The slice inspector fills parts with even-odd winding so holes read as holes,
and draws a 10 mm grid and a scale bar. **The scale is fixed to the whole
model's footprint, not refitted per layer.** Stepping through a stack is how
you read the form narrowing, and refitting each layer would hide exactly that
— a 20 mm cap would fill the view the same as a 200 mm base. The widest layer
is drawn faintly behind the current one as a reference. `Fit to layer` is
available as an opt-in for inspecting detail on a small layer.

Layer stepping lives in the workspace, not in one panel, so it works in Slice
and Stack alike: arrow keys or `[` and `]` step one layer, `Home` and `End`
jump to the bottom and top. The stack view highlights the current layer in CUT
red and can hide everything above it to see inside the shell — paging with the
arrow keys then drives a live cutaway through the assembly.

### Sculpt strokes — M6

`sculpt` features in `src/core/sdf.ts`. A stroke is a **polyline with a radius**:
the capsule chain the brush swept. Distance to it is distance to the polyline
minus the radius, which is exact — no beading along the length, and a single
point is simply a sphere.

**The handoff's grid caveat disappears rather than being managed.** The plan was
to bake strokes onto the voxel grid, with a recorded warning that replaying them
at a different grid resolution gives different geometry, so the resolution had to
be stored in the feature. Evaluating strokes analytically means there is no grid
in the definition: the same stroke gives the same surface whether the preview
samples at 32 or the slicer at 300. A validator meshes one sculpted form at two
resolutions and checks the volumes agree within 2%.

Strokes combine through the same six operations everything else uses, in the
order they were made, and sit in the feature tree wherever the sculpt feature
does — so sculpting a spout and then shelling the result hollows the spout too,
without the shell knowing a stroke exists.

Additive strokes **set bounds**. Without that, material pulled out past the base
shape would be cut off by the sampling grid; with it, the grid follows the
stroke.

### Strokes are welded to a shape — M6.1

Strokes are recorded in the coordinates of the shape they are **attached to**,
not in world coordinates, and evaluation transforms the query point into that
frame before measuring. Distances survive a rigid transform unchanged, so the
field is identical — just carried along. Moving the shape moves the sculpting;
**turning** it turns the sculpting too.

This is the third time the same gap has shown up. A shell follows the form for
free, because it acts on the accumulated field. A window did not, and got its own
axis. Sculpt strokes did not either, and an axis would not have been enough —
sculpting is glued to a surface, so it needs the whole frame. Attachment is the
general answer, and windows and fixtures could be moved onto it later.

`attachTo` names a feature in the same tree, defaulting to the last shape when a
sculpt is created. Re-attaching **carries the strokes across**: they are lifted
out of the old frame into the new one, so changing the reference moves the
reference and not the geometry. An attachment that no longer exists falls back to
world coordinates and says so, rather than throwing.

Additive stroke bounds go through the frame as all eight corners of their local
box, or a stroke on a moved shape gets clipped by the sampling grid — checked by
a validator that counts boundary samples.

### The index is the whole cost of doing it this way

Evaluating strokes analytically means every sample could walk every stroke. The
first attempt indexed each stroke's *segments* on their own grid and took **five
seconds** for 120 strokes, because walking rings of cells in three dimensions is
hundreds of map lookups per sample per stroke.

The fix was to index **whole strokes** instead: one lookup finds the handful of
strokes near a sample, and their few dozen segments are then scanned linearly,
which is far cheaper than one ring walk. Skipping distant strokes is safe
whatever their operation — unioning or subtracting something far away leaves the
field exactly as it was — so the order of the strokes that matter is preserved.

Measured after: 20 strokes 0.2 s, 200 strokes 0.8 s, 500 strokes 1.5 s at preview
resolution 64. Heavy sculpting wants a lower preview resolution; slicing is
unaffected in kind, only in time.

### Painting

Sculpting is a **mode**, because it needs the left mouse button. While it is on,
left drag paints and **right drag orbits** — you sculpt one side, turn it, sculpt
the other, without leaving the mode. Orbit is switched off outright for the
length of a stroke so a slip cannot spin the model mid-line.

Points are taken once the cursor has moved 35% of the brush radius, so a stroke
is dense enough to be a tube and sparse enough to store. The field is **not**
re-evaluated during the drag: the stroke draws as a plain line overlay and the
surface updates on release. On a shape that takes a quarter of a second to
sample, that is the difference between painting and waiting.

The brush settings apply to the next stroke only. Strokes already made keep what
they were made with, so changing the radius does not disturb what is there.
`Undo last stroke` and `Clear all strokes` are in the inspector; a stroke is the
unit of undo.

### Strokes in the project file

Strokes are bulk data, so they live on the feature as their own array rather than
in `params`, which holds single values. The project file writes them as plain
numbers — `"points": [0, 0, 40, 5, 2, 45]` — so it stays something a person can
read and diff, and the parser stays as defensive as the rest: a stroke ending
mid-coordinate is **trimmed and reported** rather than dropped, one with no
radius is dropped and reported, and the good strokes around it survive.

### Direct manipulation — M1.5

Shapes are selected by clicking them in the viewport and moved with a gizmo,
alongside the numeric fields in the inspector. Both write the same six
parameters; there is no second source of truth for placement.

**Picking.** The tree evaluates to one merged surface, so a raycast hit
cannot say which feature it belongs to — two blended spheres are a single
mesh. `nearestFeatureIndex()` takes the hit point and returns the feature
whose own field is closest to zero there, i.e. the one that owns that patch of
surface. Clicking into a carved cavity therefore selects the shape doing the
carving, which is what pointing at a hole means. Disabled and unknown-module
features are never picked.

**Rotation convention.** Our fields use R = Rz·Ry·Rx, which is three.js Euler
order **'ZYX'**, not the three.js default of 'XYZ'. Every conversion between
the gizmo and the parameters passes that order explicitly.
`tools/validate-sdf.mjs` rebuilds the product from separate axis matrices and
compares, so the convention cannot drift: if it did, a shape rotated by the
gizmo would jump the moment its value round-tripped through the inspector.

**The proxy.** The gizmo drives an empty `Object3D`, and every drag copies its
transform into the feature parameters rounded to 0.1. The reverse sync — from
parameters back to the proxy — is skipped while a drag is in progress, so the
gizmo is never fighting the value it just wrote.

Keys: `M` move (`G` also works), `R` rotate, `Esc` deselect. Snapping is 5 mm and 15°. The
selected feature is outlined with a wireframe box from its module `bounds()`,
which is the only way to see which shape is selected once several have blended
into one surface.

### Grid evaluation

`evaluateGrid(features, res)` samples the tree onto a uniform voxel grid.
`res` is the sample count along the longest axis; voxels stay cubic, so the
other axes get however many samples that spacing gives them.

Bounds come from the union of the **additive** features' AABBs, rotated into
world space, then padded. Padding is `3 · step + 0.35 · maxBlend`: the
polynomial smooth min bulges outward by at most about `k/4`, so padding by a
full blend radius would inflate the grid roughly fourfold in volume for
nothing. `tools/validate-sdf.mjs` asserts across blend radii 10–120 mm that no
sample on the grid boundary ends up inside the solid.

## CARVE — **shipped** (M5)

Subtracting volumes was always available as an operation on any shape feature.
CARVE adds the other half: **modifiers**.

### Modifiers

A modifier is not a solid. It takes the distance the tree has produced so far
and returns a new one, so it reshapes the whole form rather than adding to it.
`ModifierModule` exports `{ key, name, params, apply(d, x, y, z, params) }` and
`prepareFeatures` interleaves modifiers with shapes in tree order.

Three consequences, all enforced by validators: a modifier sets **no bounds**
(it adds no material), it is **never picked** by a click (it has no surface of
its own), and a modifier above an empty tree does nothing — a shell must not
conjure a wall out of the empty-field sentinel.

### Shell

| Param | Meaning | Default |
| --- | --- | --- |
| `t` | wall thickness, mm | 6 |
| `capTop` / `capTopZ` | keep the form solid above a height | off |
| `capBottom` / `capBottomZ` | keep it solid below a height | off |

Written as `max(d, -(d + t))`, **not** the usual `abs(d) - t/2`. The difference
is not cosmetic: the abs form moves the outer surface inward by half the wall,
quietly shrinking the shape you designed. This form leaves the silhouette
exactly where it was and takes the wall off the inside, which is what a lamp
needs — the outline is the design.

Caps stop the cavity at a height, leaving solid slices there: a closed top, a
solid foot, or both. They are a proper intersection of the cavity against a
half-space, not a switch on `z`, so **the field stays continuous** across the
cap plane and slices through the transition come out clean. A validator checks
the field either side of the plane for a jump.

With no caps, every slice of a shelled form is a ring — which is the whole
point for a lamp: light escapes through the middle and between the layers.
Where the form narrows to less than the wall thickness the slice comes back
solid on its own, with no special case.

Kerf and shell compose correctly without either knowing about the other: the
compensated contour grows the outer ring by half a kerf and shrinks the inner
by half a kerf, so the wall as cut ends up the thickness you asked for.

## Fixtures — **shipped** (M9)

`src/core/fixture.ts`. The parts that make it a lamp rather than a sculpture: an
E27 socket mount, a cable channel, and a chamber for Wago connectors.

All three are **dimensioned holes in particular sheets**, applied per slice like
rod clearances rather than as volumes in the field. Same reason as perforation: a
socket hole belongs to the one layer that carries the socket, and the layer where
a carved volume happens to be 2 mm across is the layer that tears.

| Fixture | What it cuts |
| --- | --- |
| `socket` | main hole plus an optional bolt circle of screw holes |
| `cable` | a round hole, or a slot the cable can lie flat in |
| `chamber` | a rounded pocket for the connectors |

**Every dimension is a default, not a fact.** The M10 nipple clearance is 10.5
mm and a socket body is about 40.5 mm, but body diameters vary more between makes
than anything else here, Wago cases vary by series, and cable is whatever was in
the drawer. The inspector says so where it cannot be checked.

Kerf is arithmetic: circles lose half a kerf on the radius, pockets lose a whole
kerf on each overall dimension, so both open out to the numbers typed in.

### Pockets need a home

`polygonFitsInPart()` in the slicer is the polygon counterpart of the circle test
rods already used. It matters more here: a Wago chamber is large, and the layer
it lands on is very often a narrow ring with nowhere near enough material. Holes
that will not fit are **counted and left out**, and the inspector reports how
many and how much material they needed.

A real run showed the point immediately. On a 120 mm sphere with a capped base,
the bottom layer is only 13 mm in radius — the Ø10.5 mm socket hole fits, but a
34 mm bolt circle does not, and three screw holes were reported rather than cut
as bites out of the rim.

Fixtures are applied **after rods and before perforation**, so the pattern sees
them and keeps its bridge clear of them too.

### What the Model view can and cannot show — M9.1

Windows are volumes in the field, so the preview shows them as real gaps.
**Fixtures and perforation are not** — they are cut per slice, and no amount of
looking at the solid will reveal them. They appear in Slice, Stack and Sheet.

That was fine for perforation, which the inspector already said out loud, but
wrong for fixtures: a fixture is placed with a gizmo, and a gizmo attached to
nothing visible is no way to aim a socket. So each fixture now draws **the volume
it will remove** — see-through with depth writes off, so it reads as void rather
than as material, and clickable, so it can be picked like a rod.

Perforation gets no ghosts on purpose. A few hundred translucent cylinders would
bury the form they are meant to describe.

### Centre on model — M9

Windows and fixtures carry their own axis and do not follow the form when it
moves, which is deliberate — an off-centre socket or an eccentric window is a
useful thing. Both inspectors now have a **Centre on model** button, the same
convenience a rod has in `Fit to model height`, so the common case is one click
rather than two numbers copied by eye.

## Windows — **shipped** (M8)

`src/core/window.ts`. A wedge taken out of the form, and the piece that came
out becomes a part in its own right — cut from something else and glued back
in. Plexi in cardboard: the stack stays opaque and the windows pass the light.

### One definition, two parts

The wedge is an angular sector as a distance field, and that is what makes both
halves fall out of one thing:

```
stock  = solid MINUS sector
window = solid AND   sector, shrunk by the fit clearance
```

Both go through the same slicer on the same layer planes, so **the plug's edge
and the hole it fills are the same curve by construction**, not because two
pieces of code agree about a wedge.

| Param | Meaning | Default |
| --- | --- | --- |
| `count` | windows evenly around the axis | 4 |
| `width` | angular width of each, degrees | 40 |
| `angle` | where the first one points | 0 |
| `twist` | degrees the set turns per mm of height | 0 |
| `pz` `length` | middle and height of the window band | model centre, 60% |
| `fit` | total clearance between plug and hole, mm | 0.4 |
| `windowKerf` | kerf of the material the plug is cut from | stock kerf |

`twist` spirals the windows up the stack, so no two layers line up — the same
idea as turning the perforation lattice per layer, and the same reason.

### A window can be attached, or left alone — M8.3

Windows now follow a shape the way sculpt strokes do, with one deliberate
restriction and one deliberate escape.

**The restriction: translation and Z rotation only.** A window is a vertical
wedge tied to the stack's axis, and per-layer mode picks its layers from world Z.
Inheriting a parent's X or Y rotation would tip the wedge out of the stack and
leave the layer planes cutting across it at an angle — meaningless for something
sliced horizontally. Rotation about Z leaves every horizontal plane exactly where
it was, so that is the part worth carrying. A validator checks that a Z rotation
turns the wedges by exactly the frame angle while leaving **which** layers rolled
windows, and how many and how wide, untouched.

**The escape: attachment is optional.** `Nothing — stays where it is` detaches,
and an eccentric opening that holds still while the form moves is a real thing to
want. Attaching or detaching **carries the placement across** — out of the old
frame and into the new — so changing the reference moves the reference and not
the window.

Placements are stored in the parent's frame and resolved into world terms at
prepare time rather than by transforming the query point. That keeps
`sectorDistance` untouched and, more to the point, keeps layer indexing in world
Z where it belongs.

`setOriginWorld` is the other half: a gizmo drag is always in world terms, so it
goes through the frame on the way into an attached window's parameters. Rods and
fixtures use the same call and are unaffected, having no attachment.

Fixtures could be moved onto the same mechanism; they are the last thing that
still stays behind when a form moves.

### A window has an axis — M8.2

A shell follows the form when the form moves, because it acts on the accumulated
field. **A window does not**, because it is its own volume subtracted from that
field — and with no position of its own it stayed on the world axis while the
shape walked away from it. Reported straight from a model where moving the
sphere took the shell along and left the windows behind.

So a window carries `px` `py` for its axis, defaulting to the model's XY centre
when added, and it gets a gizmo. `hasRotation()` now separates the two questions
the viewport was conflating: shapes can be turned freely, while rods and windows
can be moved in all three axes but have no orientation to set — a rod turned
about its own axis is unchanged, and a window is aimed by its `angle` parameter.

Moving the axis does **not** reroll which layers got windows: the rolls are
seeded from the layer number, not from the geometry. Validated, because
otherwise nudging the shape would redesign the lamp.

### Per layer, random — M8.1

The default mode. A window is **something that happens to a sheet**, not a slot
down the side of the lamp: each layer inside the band rolls for itself, and most
layers roll nothing.

| Param | Meaning | Default |
| --- | --- | --- |
| `chance` | probability a layer gets any windows | 0.3 |
| `minCount` `maxCount` | how many that layer gets | 1 to 2 |
| `minWidth` `maxWidth` | angular width range of each, degrees | 20 to 60 |

The field stays a field. Each layer's windows live in a band one pitch tall
centred on that layer's mid-plane, so the whole thing is still one distance
function — continuous within a layer, stepping between layers, which is exactly
what a stack of separately cut sheets does. `LayerPlan` carries the bottom of
the model and the pitch, built from the same numbers the slicer uses, so a
window lands on the plane the slice is taken on rather than near it.

Rolls are seeded from the global seed, the feature's **id**, and the layer
number. Three consequences worth having: the same lamp comes out the same,
adding a second window feature does not reshuffle the first, and changing the
count or width does not change *which* layers were chosen — a validator checks
that last one specifically, because it is the difference between adjusting a
design and rerolling it.

Windows on one layer are placed in their own share of the circle and jittered
within it, rather than thrown anywhere: two that landed on top of each other
would merge into one wide opening and the count would stop meaning anything.

A real run — 120 mm sphere, 10 mm shell, chance 0.3 over a 78 mm band — put
windows on two of fourteen layers, each breaking its ring into two arcs and
producing two plexi plugs.

`band` mode is still there, unchanged, for one set of windows running the whole
height with an optional twist.

### Kerf pulls the two apart in opposite directions

This is the part that has to be right or nothing fits. The hole is a hole, so
its path is cut **narrow** and burns out to size. The plug is a part, so its
path is cut **wide** and burns down to size. With a 0.4 mm fit, a 0.2 mm stock
kerf and a 0.1 mm plexi kerf, the two cut paths differ by only 0.1 mm — while
the finished pieces differ by the full 0.4 mm.

The validator slices both, solves for where each contour crosses a measuring
circle, and asserts **both** numbers: the cut paths differ by the fit less both
kerfs, and the finished pieces differ by the fit. A test that only looked at the
cut paths would have called a correct implementation broken, which is exactly
what happened on the first run.

### The width ceiling

Windows that met would merge into one opening and the ring would fall into
loose arcs, so the half-angle is capped at 90% of each window's share of the
circle, and never past a right angle — beyond which the two-half-plane form the
wedge is built from stops being exact. The inspector says when it has clamped
and why.

### Materials never share a sheet

`nestByMaterial()` groups parts by material and nests each group separately.
Cardboard and plexi are never on the machine at once, so they are never on the
same sheet. Sheets keep a global index for the viewer and an **ordinal within
their own material** for the filename, so `kerros-window-sheet-01.dxf` means
what it says. Grouping is sorted by material name so the order does not depend
on which part happened to come first.

A real run — a 120 mm sphere, 10 mm shell, five windows twisting 1.2°/mm —
gives 14 stock layers and 8 window layers, 46 cardboard parts on one sheet and
40 plexi plugs on another, with each windowed layer coming apart into five
separate arcs.

## RIG — **shipped in part** (M3)

`src/core/rig.ts`. Rods now; spacer rings in M4; E27 mount, cable cavity and
Wago chamber in M8.

### Rod

| Param | Meaning | Default |
| --- | --- | --- |
| `size` | M3 · M4 · M5 · M6 · M8 | M5 |
| `diameter` | clearance override in mm, 0 uses the table | 0 |
| `px` `py` `pz` | position, mm — `pz` is the **middle** of the rod | placed off-centre, centred vertically |
| `length` | how long the rod is, mm | the model's full height |

`pz` is the centre rather than an end, matching every other feature, so the
gizmo moves a rod in all three axes exactly like it moves a shape and the
length stays a number you set rather than a subtraction you do. The span is
derived: `[pz − length/2, pz + length/2]`. `rodSpanOf()` also reads the older
two-ended form, so a tree built before the change still resolves.

Clearance table (medium fit): M3 3.2 · M4 4.3 · M5 5.3 · M6 6.4 · M8 8.4 mm.
Overridable per rod, because a painted rod or a fat cheap thread wants its own
number.

**A rod is not a solid.** It takes no part in the SDF and removes nothing from
the form. It is applied after slicing, adding a clearance hole to every layer
whose **mid-plane** falls inside its span — the same plane the slice itself was
taken on. A rod that stops halfway through a sheet gets no hole in it, because
a half-drilled hole is not something a laser can cut. Spans entered backwards
are ordered before use.

Rod count is unlimited and each rod is independent, which is the whole point:
six rods with different spans is the design case, not an edge case.

`applyRods()` returns new slice objects rather than mutating, so re-running
replaces the holes instead of accumulating them. A validator asserts exactly
that.

Rods are drawn in the viewport as cylinders at clearance diameter over their
span, which makes them clickable — they get first refusal on a raycast, since
otherwise a rod inside the form could never be selected. Rotation is disabled
for them, because rotating a rod about its own axis means nothing.

### Spacer rings — M4

`spacerPlans()` in `src/core/rig.ts`. Per rod: bore = the rod's clearance cut
radius, outside = rod radius + ring width + half a kerf. A rod spanning n
layers has n−1 gaps; a rod reaching one layer or none needs no spacers.

Spacers exist **per rod**, so a model with no rods generates none — there are
no gaps to fill. That is correct, but silence about it reads as a bug, so the
profiles panel says so plainly, and says it again when rods exist but none of
them reaches two layers.

**The handoff says one ring per gap, and that is wrong.** A ring can only be a
whole sheet thick, so a 6 mm gap cut from 3 mm plexi needs **two** rings
stacked, not one. `ringsPerGap()` computes the count and
`spacerHeightAchieved()` reports the gap you will actually get. When the
requested spacer height is not a multiple of the material thickness the
profiles panel says so plainly, because the failure mode is a stack that will
not close on the rods after everything is already cut.

### A rod hole has to fit

`circleFitsInPart()` decides whether a clearance hole genuinely lands inside a
part: centre inside the outer ring, outside every existing hole, and no ring
within a clearance of its edge.

This is not decoration. A hole path that crosses a contour is not a hole, it is
a bite out of the edge — and feeding one to a polygon tessellator makes it emit
a fan of garbage across the whole layer, which is exactly what the stack view
showed before the check existed. Holes that fail the test are left out of the
extrusion, but they are **still drawn in the slice inspector**, where the
thin-feature warning rings them: the maker needs to see the problem, not have
it silently disappear.

## SLICE — **shipped** (M2)

`src/core/slice.ts`. Turns a scalar field into per-layer polygons.

**The slicer does not know what an SDF is.** It takes a sampler
`(x, y, z) => distance` plus bounds, so the same code slices a feature tree, an
imported mesh's field in M9, or an analytic test shape. That is precisely what
lets `tools/validate-slice.mjs` check it against surfaces whose contours are
known exactly — a disc's area and perimeter, an annulus's two rings, a sphere's
cross-section at every height.

### Layer planning

Pitch is `thickness + spacerHeight`. Layer k's sheet occupies
`[z0 + k·pitch, z0 + k·pitch + thickness]` and the field is sampled at its
**mid-plane**, which splits the error on a steep wall evenly between over- and
under-cut. Top/bottom-plane union for stepped accuracy stays on the roadmap.

Only layers that produced geometry are returned, numbered 1..n from the bottom,
and each carries its own `z`. A model with a gap along Z therefore keeps that
gap: there is simply no part for the empty layer, and the rods still pass
through the space.

`maxLayers` (default 400) caps the count so a mistyped thickness cannot lock
the app up. A pitch of zero returns no planes rather than looping forever.

### Contour extraction

Marching squares with segments directed so the solid lies to the **left**. That
single convention means outer rings come out counter-clockwise and holes
clockwise with no post-processing, and `signedArea()` classifies them.

Crossing points are identified by **which grid edge they sit on**, not by
coordinates, so rings stitch together exactly instead of matching
floating-point endpoints. Each crossing has exactly one outgoing segment, so
walking the rings is a straight traversal.

Saddle cells (masks 5 and 10) are resolved from the cell's mean value, which is
consistent across the shared edge and keeps every ring closed.

The sampling window is padded by two cells so the surface never touches its
edge. Any contour that still comes out open is **dropped, not closed with a
guess** — inventing an edge would cut a wrong part.

### Simplify and smooth, in that order

Chaikin runs **before** RDP, which is the reverse of the order the handoff
sketched, and the reversal matters:

- Marching squares emits one vertex per cell crossing, so every edge is about
  one sample long. Chaikin then rounds corners by a fraction of a cell — the
  same scale as the staircase it is removing.
- Simplify first and a real 90° corner collapses to a single vertex between two
  long straight runs. Chaikin cuts a quarter off each of those runs, and a
  square slice comes out visibly rounded. On a 20 mm square, two passes remove
  62.5 mm² — over 15% of the part.

`tools/validate-slice.mjs` slices a sharp 80 × 80 mm box and asserts the
cross-section area is within 1% of 6400 mm² and that a vertex lands within one
sample of the true corner. That test exists because the original
implementation had the order the other way round.

### Grouping

`groupContours()` pairs each hole with the smallest outer ring containing it,
so a part can be extruded, nested and cut as a unit. An island sitting inside a
hole becomes its own part, which is correct for cutting: it falls out and gets
placed back by hand.

### Kerf compensation — M3

**Kerros needs no polygon offsetting library, and this is why.**

A laser cutting along a path removes kerf/2 on each side of it. A part cut on
its true outline therefore comes out kerf/2 undersized, and a hole comes out
kerf/2 oversized. The handoff planned to fix this with Clipper: offset outer
contours outward by kerf/2, holes inward by kerf/2.

With a distance field the whole thing is one number. Take the contour at the
iso-level **+kerf/2** instead of 0. The contour moves away from the solid
everywhere, which means outward on an outer boundary and inward on a hole,
because the field's sign already knows which side the material is on. One
subtraction while sampling, in `sliceModel`, and both cases are correct.

It is also more robust than polygon offsetting: a wall thinner than the kerf
simply vanishes from the field, where an offsetting algorithm would produce a
self-intersecting polygon that has to be cleaned up. The validator cuts a
0.1 mm wall with a 0.6 mm kerf and checks that nothing degenerate comes out.

Rod holes are generated rather than sampled, so they compensate arithmetically:
cut radius = diameter/2 − kerf/2.

Clipper may still return for M7, where wall patterns are pure 2D geometry with
no field behind them. It is not needed for the MVP.

### Manufacturability check — M3

`minFeatureGap()` finds the narrowest place in a slice: the smallest gap
between any two pieces of cut geometry. That covers a thin shell wall, two
lobes nearly touching, a rod hole too close to an edge, and two rod holes too
close to each other. Points far apart **along the same ring** are compared too,
because that is what a narrow neck looks like; immediate neighbours are
excluded so an ordinary smooth curve is not mistaken for one.

Points are bucketed into a grid of cell size `threshold`, so the cost stays
linear in point count rather than quadratic.

The threshold is whichever is larger: the maker's `minFeature` setting or two
kerfs, below which material burns through however good the geometry is.
Flagged layers are ringed in the slice inspector and counted in the profiles
panel. **They are flagged, not blocked** — the maker decides, but not by
accident.

## PATTERN — **shipped** (M7)

`src/core/pattern.ts`. Perforation in the wall of each slice.

### Per slice, not through the solid

Patterns are applied **in 2D, per layer**, never as a 3D volume subtraction.
That is a manufacturability decision rather than a shortcut: a hole carved
through the form becomes a different shape on every layer it crosses, and the
layer where it happens to be half a millimetre wide is the one that falls apart
on the bed. Placing holes per slice means every hole is checked against the
material it is actually cut from.

### It is a perforation tool for flat parts

Worth being plain about, because the name says "wall": this perforates the
**material of each slice**, wherever there is room, and a slice is a flat part.
On a shelled layer that material is a narrow ring, so the holes land in the
wall. On a solid layer — a cap, a foot, a layer where the form has narrowed past
the wall thickness — the material is the whole disc, and the holes fill it. The
`band` parameter limits them to a given distance from an edge when that is not
what you want.

### Clearance is measured in the plane — M7.2

The region needs no polygon offsetting, but it does need the **right distance**.
The first version asked the 3D field how deep the material was, and that is
wrong in a way that shows up immediately on a curved lamp.

Near the top of a sphere the nearest surface to a point in the middle of a slice
is **above** it, not out at the edge. The field reports 8 mm of depth where the
flat part has 30 mm of room in plane. Holes then vanish from the middle of a
perfectly solid slice in an irregular blotch — reported from a screenshot of
exactly that, a disc with a sparse scatter where a hex lattice was asked for.

So the sign comes from the field, which knows which side of the surface a point
is on, and the **magnitude comes from the slice's own contours**, measured with
`EdgeIndex` — segments bucketed on a uniform grid, searched outwards a ring of
cells at a time, every query bounded by the clearance actually being asked
about. The slice is a flat piece of board: the only bridge that matters is the
one you could measure on it with calipers.

A real lamp — 14 layers, 12.7 mm wall, Ø1.4 mm holes at 6 mm pitch — perforates
in 54 ms and places 1312 holes where the old code placed a few hundred in
patches.

### One acceptance test, four generators

| Kind | What it does |
| --- | --- |
| `grid` | square lattice |
| `hex` | staggered lattice, more even light |
| `scatter` | seeded dart throwing with rejection |
| `radial` | rings out from the centre, angular step matched to the radial one |

Every generator funnels through `holeFits()`, so **`minBridge` is respected by
construction** rather than by each generator remembering to. Three clearances,
all the same number, because a bridge is a bridge whatever is on the other side
of it: to the wall face, to holes already in the slice (rod clearances), and to
the pattern holes placed so far.

`measuredBridge()` measures the result independently of the code that placed it,
and the validator asserts the limit on the output of all four generators, with
and without rod holes present. A wall too thin to hold the hole yields **no
holes at all**, which is the honest answer rather than holes that break out of
it — checked with a 2.5 mm wall and a 4 mm hole.

Patterns are generated **after** rods, and each pattern sees the ones before it,
so nothing ever crowds anything. Holes are kerf-compensated the same way rod
holes are: cut radius = radius − kerf/2.

### Defaults have to be able to work — M7.1

The first release shipped fixed defaults: a 2 mm hole with a 1.5 mm bridge,
which needs 7 mm of wall. The default shell wall is 6 mm. So adding a shell and
then a pattern, both at their defaults, correctly placed **nothing at all** —
and said nothing about it.

Two fixes, and the second matters more:

- `addPattern` now sizes the holes to the wall it will cut them in, reading the
  last enabled shell in the tree. Across walls from 3 mm to 20 mm the derived
  hole, bridge and pitch always fit with room to spare.
- The pattern inspector reports **how many holes were actually placed**. Zero
  is called out with the wall it needs and the wall it has. And because
  patterns are per-slice and never appear in the Model preview, the inspector
  says that too rather than leaving someone rotating a solid looking for holes.

This is the third time silence has read as a bug — spacers with no rods, a
pattern with no room, a gizmo that wrote parameters nothing reads. A check that
refuses to do something has to say what it refused and why.

### Per-layer variation

`rotatePerLayer` turns each layer's lattice by a seeded angle, so no two layers
line up and the light through the stack breaks up. Seeded from the global seed
mixed with the layer number: the same seed gives the same lamp, and consecutive
layers differ. With it off, a symmetric form gives identical layers, which a
validator also checks.

### Not yet

Polygon-shaped patterns — slots, voronoi cells, ring segments — need the region
as geometry rather than as a test, and go on the roadmap with true-shape
nesting.

### A pattern has no position — M7

Neither does a shell. Both act on the whole form rather than sitting somewhere
in it, so `hasTransform()` reports false for them and the gizmo does not attach.
Before this it did attach, and dragging wrote transform parameters that nothing
read — a drag that appeared to do nothing while quietly filling the feature with
values. The Move, Rotate and Snap buttons are disabled for them too.

## LAYOUT — **shipped** (M4)

`src/core/nest.ts`, plus the stroke font in `src/core/font.ts`.

### Shelf packing

First-fit decreasing-height on bounding boxes: parts sorted tallest first,
placed left to right along a shelf, a new shelf opening above at the height of
the tallest part below it. Not optimal, but deterministic, instant, and legible
— you can look at the sheet and see why each part is where it is. Ties break on
part id so the same job always nests identically. True-shape nesting, which
would let a small part sit inside a large ring's waste, stays on the roadmap.

**Parts are not rotated.** For lamp slices, which are mostly round, rotation
buys nothing and costs determinism.

Parts too large for the bed go into `unplaced` and are reported, never
silently dropped. `maxSheets` (default 60) stops a runaway job.

### Bounds follow what is actually cut

`boundsOf()` uses a part's true circle when it has one, not the polygon
standing in for it. Spacer rings are exported as exact `CIRCLE` entities but
carry a polygonised outline for preview and label fitting; that polygon is
**inscribed**, so it is up to the chord tolerance smaller than the circle.
Bounding by the polygon let a ring overhang the sheet edge by 0.02 mm — found
by an end-to-end run that measured the DXF extents against the usable area,
and now pinned by a validator.

### Label placement

The centre of a lamp slice is usually a hole, so the obvious spot is wrong most
of the time. `findLabelSpot()` scans candidate positions across the bounding
box, tests all four corners and the centre of the text box against the outer
ring, every hole and every circular hole, and picks the valid position nearest
the part centre. If nothing fits, the height is reduced to 60% and retried —
a small number on the part beats no number — and only then is the part left
unlabelled and counted in the sheet readout.

### Stroke font

`src/core/font.ts`. **Engraved text goes out as polylines, never as the DXF
TEXT entity**: laser front-ends treat TEXT inconsistently, and a layer number
that renders as a filled outline on one machine and as nothing at all on
another is worse than useless.

Glyphs sit on a 3 × 5 cell with the origin at the baseline left, advance 4.
Digits are drawn seven-segment style, which stays readable at 3 mm on scorched
plywood where a stylised 6 or 9 does not. A–Z and a few symbols are stroked.
Unknown characters render as a hyphen rather than vanishing, so a wrong label
is visible instead of silent.

### Sheet view

A fourth workspace mode. The **whole bed is always in view**, never zoomed to
the parts: nesting is about the bed, and a view that framed the parts would
hide the free space, which is the thing you are judging. Cuts draw in CUT red,
labels in ENGRAVE blue as the actual strokes that will be burned.

### Manual placement — M4.1

Automatic nesting is a starting point; the last stretch of a real sheet is
always done by eye. Parts can be dragged in the sheet view, nudged with the
arrow keys (1 mm, or 10 mm with Shift), and moved between sheets.

A dragged part becomes **pinned**: `applyPlacements()` runs after the nester,
so re-slicing or changing the part gap rearranges everything except what a
person deliberately put somewhere. Placements are keyed by part id, and part
ids are deterministic (`slice-7-0`, `spacer-r1-3`), so a pin survives a
re-slice. A placement naming a sheet that no longer exists is clamped into
range rather than dropped — shrinking a job must not silently lose parts.

**Overlap is not prevented.** A person dragging a part has a reason, and the
honest response is to show what happened rather than refuse the drag. The check
is a warning, not a lock, and export writes exactly what is on the sheet.

### Rotation and stock grain — M4.3

Corrugated board has flutes running one way inside it, and a cut edge exposes
them. Cut every part at the same angle and every layer's edge looks identical
and passes light identically. **The angle a part is cut at is a material
decision, not a packing one** — which is why rotation lives with placement and
why the sheet view draws the flutes.

`rotatePart()` turns a part about its **bounding-box centre**, which is what
turning a piece on the bed feels like. Rotation is **baked into the geometry**
rather than carried as a transform, so bounds, clamping, hit testing, collision
and export all read the same fields they always did and need no special case.
The validator checks that area and orientation survive, that a 40 × 10 bar
turned 90° measures 10 × 40, that a there-and-back rotation returns the
original to 1e-9, and that a concentric spacer ring is unmoved.

**The engraved label stays upright.** A rotated part number is hard to read, so
after rotation the label spot is found again on the turned material — which
also guarantees it still lands on material rather than in a hole that has moved
under it.

Rotated parts are clamped to the sheet using their **rotated** size, so turning
a part near an edge slides it back in rather than hanging it off the bed.

**The pivot is carried, not recomputed.** Rotating a shape about a point does
not leave the resulting bounding box centred on that point, so `PlacedPart`
holds `pivot` — the centre of the part's *unrotated* box. Without it a rotation
handle hung off the bounding box drifts away from the part as it turns, and a
lopsided part rotates about a moving point. A validator uses a deliberately
lopsided wedge to prove the box centre really does move while the pivot does
not.

Any rotation already on a part is undone before a new one is applied, about the
same pivot, so `applyPlacements` is safe to run on its own output: turning to
40° and then to 80° gives the same geometry as turning to 80° once, rather than
compounding to 120°.

`scatterRotations()` gives every part a seeded random angle within a chosen
limit. Angles derive from the global seed mixed with each part's index, so the
same seed gives the same lamp and adding a part at the end does not reshuffle
the ones before it.

The sheet view draws the flutes as parallel lines at a settable pitch — B flute
is about 6.5 mm, C about 7.9, E about 3.5 — under everything else, so the angle
each part's edge cuts across the grain is visible before anything is cut.
Controls: drag the **knob** above a selected part to turn it freely — press,
turn, let go — landing on 1° or, with Shift held, on 15°. The knob takes pointer
events before the part does, so grabbing it never drags the part. `⟲` `⟳` or
`[` `]` step 15° (Shift 5°), the part inspector takes an exact angle, and
`Scatter` does the whole sheet at once.

### Project files — M4.5

`src/core/project.ts`, saved as `.kerros.json`. Holds the profiles, the whole
feature tree, the seed, the slicing settings and every hand placement —
everything needed to cut the same lamp again. Transient interface state (which
mode is open, which layer is showing, what is selected) is deliberately left
out: it is not part of the design.

**Parsing is defensive**, because a project file is the one artefact a person
keeps for years, edits by hand, and opens in a newer build than the one that
wrote it:

- A file from a **newer format version is refused**, not guessed at. Quietly
  misreading geometry is worse than not opening.
- Anything else wrong is a **warning, not a failure**: a feature with no kind
  is skipped, an unknown stage falls back to SHAPE, a duplicate id is
  renumbered, a parameter that is not a value is dropped, out-of-range numbers
  are clamped, a placement without a position is discarded. A file with one bad
  feature still opens.
- Feature numbering resumes past the highest loaded `fN`, so newly added
  features cannot collide with loaded ones.

The validator round-trips a full project byte-for-byte, then feeds the parser
garbage, a foreign file, a future version, an empty file, and a file where
nearly every field is the wrong type.

### The canvas must not size the layout — M4.6

Both 2D views paint into a canvas whose drawing buffer is sized from the
measured element size. Setting the element's **CSS** size in pixels as well
turns that measurement into a feedback loop: a canvas with a pixel width has an
intrinsic min-content width, a bare `1fr` grid track cannot shrink below its
content's min-content width, so the track is pinned open at the canvas width —
and the next measurement reads the wider track and grows the canvas again. The
grid creeps wider on every repaint until the right-hand rail is pushed off
screen, and every edit that triggers a redraw makes the whole layout twitch.

Two changes, both necessary:

- the middle track is `minmax(0, 1fr)`, so it may shrink below its content;
- the canvas is positioned absolutely at `100%` of its box and **only its
  drawing buffer is sized in JS**, so it contributes no intrinsic width at all.

This was reported as two separate complaints — an inspector that would not
appear, and a sheet view that jittered while parts were rotated. They were the
same bug.

### The panel choice lives in the store — M4.5

Selecting something **is** a request to inspect it, so `selectFeature` and
`selectPart` set the panel themselves. Before this the panel was local state
driven by two effects — one forcing Profiles on leaving Model mode, one pulling
Inspector back on selection — and which won depended on effect ordering. One
action, one place, no race.

### Part inspector — M4.4

A part is not a feature: it has no parameters of its own, it is what the tree
produced. What it does have is a place on the bed and an angle, and those
deserve exact numbers as well as dragging. Selecting a part on a sheet brings
the inspector forward and shows its label, layer, size, position, rotation,
whether it is pinned, its angle to the flutes, and any clearance problem. Before
this the panel was locked to Profiles the moment you left Model mode, so
selecting a part showed nothing at all.

### What the collision check actually measures — M4.2

`analyseSheet()` measures the **real geometry**: closest approach between
outlines, segment to segment, plus a containment test for the case where one
part sits wholly on another's material without any outline crossing.

Bounding boxes cannot answer the question, and the first version of this check
used them, which was wrong in the most common case. A crescent nested into
another crescent's concavity shares a bounding box completely and cuts
perfectly — that is good nesting, not an error. Meanwhile two discs whose boxes
barely touch can still be half a millimetre apart and char into each other.
The validator pins both cases: an L-shaped part with a square in its notch
reports 2.00 mm and no collision, while the same pair stacked reports a
collision.

Three states, three treatments:

- **Colliding** — the outlines meet or one part is on the other's material.
  Amber outline, counted in the readout, warned about in the profiles panel.
- **Tight** — no overlap, but closer than the part gap. Dimmed outline and the
  measured distance in the readout. Worth a look only if the material chars
  easily.
- **Clear** — nothing said, but the closest approach on the sheet is always
  shown, because that number is what tells you whether a hand-placed layout is
  actually safe.

A part sitting inside a ring's hole is explicitly **not** a collision: that is
the free space true-shape nesting would use, reachable here by hand.

Only pairs whose boxes overlap by more than the clearance are examined, and
very dense outlines are thinned to 400 points, so the cost stays with the
handful of pairs that could possibly be in trouble.

`findOverlaps()` is still there and still bounding-box based, because that is
the measure the automatic shelf nester works to and it explains why the
algorithm placed things where it did. It is not a manufacturing check.

Dragging is clamped so a part cannot hang off the bed, snapped to 0.5 mm, and
`partAt()` prefers a hit on actual material over a mere bounding-box hit and
the smallest part among those — so a small part sitting in a large ring's waste
stays reachable. Backspace unpins the selected part; the profiles panel unpins
everything at once.

## EXPORT — **shipped** (M4)

`src/core/dxf.ts` writes the file; `src/core/job.ts` composes what goes in it.

One DXF per nested sheet, in sheet coordinates with the origin at the usable
corner. `Export all sheets` fires them 350 ms apart, because browsers throttle
a burst of downloads from a single gesture. A plain-text build manifest lists
every layer with its z, part count, hole count and sheet, every spacer plan,
and what is on each sheet — plain text because it gets printed and marked up
with a pencil next to the pile of slices.

`src/core/job.ts` is the wiring layer and the only module that imports across
the others. It is deliberately thin: every algorithm it calls — contour
grouping, hole fit, circle generation, label placement, nesting, the font, the
DXF writer — is validated on its own.

R12 (AC1009) because that is what the target laser accepts, and because it is
small enough to write correctly by hand. Two consequences:

- **LWPOLYLINE is R13+ and is never emitted.** Closed rings go out as
  POLYLINE with a VERTEX per point and a SEQEND, with group 66 = 1 (vertices
  follow) and group 70 = 1 (closed). A validator asserts the string contains
  no LWPOLYLINE at all.
- **R12 has no real unit tag.** Coordinates are simply millimetres.
  `$INSUNITS` is written as a hint that newer readers honour.

Rod holes go out as **CIRCLE** entities rather than polygonised rings: a hole
is a circle, and handing the laser the exact primitive beats approximating it
with chords.

Numbers are fixed notation to four decimals, with no exponent form and no
negative zero — both of which some older laser front-ends choke on.

### Kerf test figure

`kerfTestDocument()` produces the figure to cut once per material:

- an outer square, giving kerf = nominal − measured
- a concentric square hole and a round hole, giving kerf = measured − nominal
- a ladder of slots from 1.0 to 3.0 mm, showing the narrowest feature this
  material and machine can actually hold

**Nothing in it is kerf-compensated**, and a validator enforces that: the
figure is a measurement, and compensating it would measure nothing. If the
square-outside and square-inside numbers disagree, the beam is not
perpendicular to the bed and no single kerf value will fix the fit.

---

## Infrastructure

### World convention — M0

Z is up, 1 three.js unit = 1 mm. Set in `src/ui/Viewport.tsx`; three.js
defaults to Y-up so every camera sets `up` explicitly. Any geometry code that
assumes Y-up is a bug.

### Preview mesher — M1

`src/core/surfaceNets.ts`. **Surface nets, not marching cubes.** Chosen
because it needs no 256×16 triangle table, is deterministic, and gives
smoother results on blended blobs. The cost is that it rounds sharp edges more
than marching cubes at low resolution — a rounded box looks rounder than it is
at 32 samples. This affects the preview only: slicing samples the SDF directly
and never touches this mesh. A marching cubes extractor can be added behind
the same `GridLike -> SurfaceNetsResult` interface if the edges start to
mislead.

Preview resolution is user-selectable (32 / 48 / 64 / 96 / 128, default 64)
and re-evaluation is debounced by 120 ms so dragging a value stays smooth.
Slicing gets its own, finer grid in M2, and moves to a Web Worker there.

### Feature tree — M0, extended M1

`src/core/store.ts` — ordered list with add, remove, reorder,
enable/disable, rename, per-parameter edit and selection. Ids are `f1`, `f2`,
… from a monotonic counter so a saved project reloads with stable ids.

### Profiles — M0

`src/core/profiles.ts` — machine (bed 730 × 410 mm, margin), material
(thickness, kerf, notes), stack (spacer height). Layer pitch is derived in one
place, `layerPitch()` in `src/core/types.ts`, and nothing else may compute it.
Bed size and kerf are never hardcoded in geometry code.

### Error boundaries — M0

`src/ui/ErrorBoundary.tsx` wraps the app, the viewport, the feature tree and
the right-hand panel separately, so a throw in one region leaves the rest
usable.

### Validators

Run all of them with `npm run check`.

- `tools/check-version.mjs` — package.json version matches `KERROS_VERSION`.
- `tools/validate-sdf.mjs` — primitives against analytic distances,
  operation identities (smooth ops with `k = 0` must equal their hard
  counterparts), the EMPTY sentinel, module registry integrity, rotation
  matrix orthonormality, the Rz·Ry·Rx composition that the gizmo depends on,
  feature picking, bit-identical re-evaluation, and blend padding.
- `tools/validate-rig-export.mjs` — kerf compensation measured as actual
  radius change on a sliced tube (outer +kerf/2, hole −kerf/2) and the
  sub-kerf wall case; the rod clearance table, span inclusivity at both ends,
  reversed and zero-length spans, cut-radius arithmetic and non-accumulating
  application; the thin-feature check against known-width walls, holes near
  edges and holes near each other; DXF R12 structure down to group-code
  pairing, section balance, absence of LWPOLYLINE and of negative zero; and
  the kerf test figure's nominal dimensions.
- `tools/validate-slice.mjs` — polygon area, perimeter and containment
  helpers; RDP and Chaikin behaviour including the exact corner area two
  passes remove; marching squares against an analytic disc, annulus, separated
  discs and near-touching saddle cells; layer planning including the cap and
  zero-pitch case; and full slicing of a sphere, a sharp box and a bored solid
  through the real SDF core, with cross-section areas checked against the
  analytic answer at every height.
- `tools/validate-surfacenets.mjs` — vertex accuracy against analytic
  sphere and torus, watertightness (every edge used exactly twice), outward
  winding via signed volume, volume within a few percent of analytic,
  determinism, and degenerate inputs.

Validators import the real modules with Node's native TypeScript support —
never stubs, never a reimplementation of the algorithm under test. That rule
caught the inverted triangle winding in surface nets on its first run: the
mesh was watertight and its volume was accurate to 0.5%, but negative, which
would have rendered the model inside-out.

`src/core/sdf.ts` and `src/core/surfaceNets.ts` therefore have **no value
imports**. Keep it that way — type-only imports are erased by Node and are
fine, value imports would drag the whole app into the validator.
