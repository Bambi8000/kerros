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
| `prism` | Prism | `n` (sides, 3–24) `r` (to a vertex) `h` `corner` |
| `cone` | Cone | `r1` (bottom) `r2` (top) `h` |

Accuracy notes, because they matter downstream:

- `sphere`, `roundBox`, `capsule`, `torus`, `prism`, `cone` are exact Euclidean
  distance fields. Blend radii mean exactly what they say.
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

### Sharp forms

A square plate with a sphere taken out of it needed no new module: `roundBox`
is `boxSDF(p, s − r) − r`, so at `r = 0` it *is* an exact box, sharp on every
edge. The default corner radius is 12 mm, which is the only thing that ever
made it look otherwise.

What was missing was everything angular that is not a box.

**`prism` is exact, and the reason is the fold.** The query point is rotated
into the sector belonging to one edge, and inside that sector the nearest
boundary is either that edge or the vertex ending it — nothing else can be
closer, because the polygon is convex and the sectors are symmetric. One
comparison answers it at any number of sides.

A vertex sits on +X, so the first edge midpoint is at angle π/n and the fold is
about *that*, not about zero. Getting the phase wrong is silent and large: the
first attempt was out by 25 mm on a triangle, less on a hexagon, and looked
plausible in the viewport. A validator now pins a vertex, an edge midpoint and
a point 7 mm off the edge, which is the smallest set that cannot pass with the
phase rotated.

`corner` rounds the vertical edges by shrinking the apothem and offsetting back
out, the same trick `sdRoundBox` uses: the flats stay exactly where they were
and the corners come off, which is what rounding a corner means. Top and bottom
rims stay sharp — a stack of sheets has no radius there.

`n` is the registry's only integer parameter, and the **field rounds it**
rather than trusting the inspector to. The inspector renders every parameter
generically from `mod.params`, so its step of 1 is a convenience, not a
constraint, and a hand-edited project file asking for 5.5 sides has to give 6
rather than NaN.

**`cone` is written truncated** because the pointed case falls out of it for
nothing — `r2 = 0` is a plain cone, `r1 = r2` a cylinder — and because a
tapered stack is the shape a lamp actually wants. The point is where you stop
having material to cut.

**There is deliberately no pyramid.** A rectangular-base pyramid's exact
distance needs five faces plus their edges and vertices handled separately, and
an approximate field would corrupt every blend and every kerf offset that reads
it — the same reason the superellipsoid divides by its gradient. A four-sided
prism gives a square column and a cone gives a round taper; the missing case is
a square taper, and it will be done properly or not at all.

Both were checked against brute-force distance to a densely sampled surface,
and both hold `|∇d| = 1` to four decimals across the whole sampled volume. That
unit gradient is the property smooth blends and the kerf iso-level depend on;
it is what "exact" means here, not that the zero level is in the right place.

### Sausage: a capsule bent into an arc

`bend` is a third parameter on the capsule rather than a ninth module, and at
zero it **is** the capsule, bit for bit — so no saved lamp changes the day it
appears. `h` is the length along the centreline and `bend` the total turn, so
the bend radius is `h / bend` and a sausage keeps the length asked for however
far it curves.

**Exact, and that is the whole point.** The obvious way to bend a field is to
warp the query point, and it is wrong here for the reason this program has
refused non-uniform scale three times: a warp is not an isometry, so `|∇d|` stops
being 1 and every smooth blend and every kerf iso-level that reads the field is
corrupted by however much it stretches.

A capsule is a segment with a radius. A bent capsule is an **arc** with a
radius, and the distance to a circular arc is closed form: take the point into
the arc's plane, clamp its angle to the arc's span, and measure to the point
that lands on. The same shape of answer as the straight case, where the clamp is
along a segment instead of around a circle.

Measured: `|∇d| − 1` under 2 × 10⁻⁹ at every bend, the centreline exactly the
length asked for, and the bounding box tight without leaking. Removing the arc
clamp fails five checks; deriving the bend radius from anything but the arc
length fails twelve.

### A parameter is not always a dimension

Some primitives are dimensioned by a part of themselves. A capsule's length is
its straight section and the two caps add a diameter on top, so 80 mm of capsule
at radius 25 stands 130 mm tall. A torus is given its centreline radius, which
is not a measurement anybody can take with callipers. A prism is given the
radius to a vertex, while the across-flats it will actually be is
`2r · cos(π/n)`.

None of that is guessable from the field name, and the measuring tool made it
visible immediately: the panel says 80 and the tape says 130, and the first
conclusion anybody draws is that the tape is broken.

So those four carry a derived line under their parameters saying what the shape
actually measures. The sphere, the box and the ellipsoid get none — their
parameters *are* their dimensions.

The alternative was to redefine `Length` as the overall height and derive the
straight section from it. That was considered and dropped: it changes every
saved capsule, it needs a new rule for a radius over half the length, and the
mathematical definition of a capsule really is a segment with a radius. Saying
what it comes to is cheaper than redefining what it is.

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

### Two ceilings the bench put there

Both came off a cut lamp rather than out of the mathematics, and both matter
only when the wedges are left as openings instead of being filled with plexi.

**A window is at most 100° across.** It used to be 178°, where the two-half-plane
form of the wedge stops being exact. The real limit is lower and physical: left
as an opening, a wider window leaves too little ring to hold while the glue
sets.

**A rolled layer gets at most two.** Two openings leave two arcs to hold, three
leave three of nothing much.

The count is clamped on the **per-layer roll** and not in `band` mode, and that
asymmetry is deliberate rather than an oversight. The limit only bites when the
plugs are not cut; put them back and a ring with five windows in it is whole
again, which is a documented working lamp. The program cannot know which you
will do — a plug is a part on a sheet, not a setting — so it holds the line
where it invents the number itself and leaves the one you typed alone.

Clamping both was tried first and six checks went red, all of them describing
that five-window lamp. The red was right: a hard ceiling there would encode an
assumption the program cannot check.

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
wedge is built from stops being exact. The tighter physical ceiling is 100°
across. The inspector reads the actual `windowHalfAngle` result and explains
both limits. Per-layer count fields stop at two and width fields at 100°;
loaded requests outside those limits show the effective count and width range.
The count range is shared with the roll generator, preserving its seeded rolls.

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

The zero-ring explanation waits for a current completed job. A rod spanning
touching sheets needs no rings, so that state is distinguished from no rod
reaching two layers. Requested-gap rounding is read directly from
`ringsForGap`, independent of nesting progress; the manifest's achieved bottom
gap comes from the actual layer plan, including a gap rounded down to zero.

**The handoff says one ring per gap, and that is wrong.** A ring can only be a
whole sheet thick, so a 6 mm gap cut from 3 mm plexi needs **two** rings
stacked, not one. `ringsPerGap()` computes the count and
`spacerHeightAchieved()` reports the gap you will actually get.

### Rings are their own material

Tying the ring thickness to the stock's is what makes thin sheet unusable, and
the arithmetic is brutal. A 200 mm lamp in 0.5 mm steel, simulated:

| stock | ring material | rings per rod |
| --- | --- | --- |
| 0.5 mm | 0.5 mm | **372** |
| 0.5 mm | 3 mm | 62 |

Nobody stacks 372 washers by hand. So `spacerThickness` is its own setting, 0
meaning "follow the stock", which is what every profile written before it meant
by saying nothing.

Two things follow that were not obvious until they were said out loud.

**Rings nest as their own material once they have their own thickness.** They
are not even the same height of stuff; they cannot share a sheet. `spacer` goes
through the same `nestByMaterial` path as the plexi window plugs and gets its
own sheet and its own ordinal. At equal thickness they are the stock and share
its sheets, exactly as before. This one came from Daniel mentioning in passing
that of course he cuts them separately — not from anything failing.

**Rings are counted from the gaps that are actually there.** `spacerPlans` walks
the sheets a rod reaches and measures sheet to sheet, rather than multiplying a
requested spacer height by a gap count. On a uniform stack the two agree; on a
graded one only the measured gap can be right, since a rod does not care what was
asked for. It also gets a void along Z right for free — two sheets three pitches
apart need three pitches of rings, not one gap's worth. `SpacerPlan` lost
`ringsPerGap` in the process, because a graded stack has no single number, and
carries `ringsMin`, `ringsMax` and the total instead.

### Three states in the panel, not two

The gradient controls needed a sentence saying how many steps the ring material
can actually take, because nobody can work that out from two millimetre readings.
The first version got it wrong in the exact case it existed for.

`graded` was computed from the **ring counts**, so 3 mm and 4 mm — both one 3 mm
ring — came out as "both gaps the same". True about the result, wrong about the
question, and the warning written for that case lived inside a branch that could
never open.

Asking for different gaps and getting different gaps are separate facts:

| typed | rings | what the panel says |
| --- | --- | --- |
| 6 and 6 | same | uniform, and how to change that |
| 3 and 4, 3 mm rings | same | **both are one ring, so the stack is uniform**; rings of 1.00 mm or thinner would grade it |
| 3 and 9, 3 mm rings | differ | the gap goes 3 → 9 mm in 3 steps |

With a middle gap, all three requests participate in every state. For example,
3 → 4 → 3 mm with 3 mm rings is uniform by rounding, and the panel names all
three requests and suggests 1 mm rings. The suggested thickness uses the
nonzero span from the smallest to largest request; equal ends cannot produce
the old, impossible suggestion to use 0 mm rings.

The advice in the middle row is derived rather than guessed: when the ring
thickness equals the difference between the two gaps, the counts differ by
exactly one. A larger ring is not guaranteed to — 2 mm rings round both 3 and 4
to two — so the sentence states the thing that is always true.

The panel logic is the one part of this program that never runs before it runs
in front of a person. The habit that came out of it: **when a panel grows
conditions, write the truth table into the message, not only into the code.**
Three rows and two branches would have shown the mismatch before the browser
did.

### A rod hole has to fit

`circleFitsInPart()` decides whether a clearance hole genuinely lands inside a
part: centre inside the outer ring, outside every existing hole, and no ring
within a clearance of its edge.

Distance is measured to **whole segments**, not just vertices. Hole punch
exposed the same sparse-outline trap as the thin-feature check: a circle can
cross the middle of a long straight edge while remaining far from both ends.
A tangent circle is refused too; a hole touching the rim has no bridge.

This is not decoration. A hole path that crosses a contour is not a hole, it is
a bite out of the edge — and feeding one to a polygon tessellator makes it emit
a fan of garbage across the whole layer, which is exactly what the stack view
showed before the check existed. Holes that fail the test are left out of the
extrusion, but they are **still drawn in the slice inspector**, where the
thin-feature warning rings them: the maker needs to see the problem, not have
it silently disappear.

## Layer selection — **shipped**

`src/core/layers.ts`. One way to say **which layers** a per-slice feature
applies to. There were four: a window's band, a fixture's band, a rod's z span,
and perforation, which had no way of saying anything and went on every layer.
Four spellings of one question is how the attachment problem started, and the
answer is the same shape — one mechanism, composed rather than copied.

| Kind | Means |
| --- | --- |
| `all` | every layer, which is what perforation always did |
| `band` | a height and a depth in world Z, in millimetres |
| `range` | first and last layer, numbered as the slice inspector numbers them |
| `every` | one layer in n, with a phase |

### Two boundaries, both load-bearing

**This is for holes in sheets, not volumes in the field.** A window is a wedge
subtracted from the field and rolls its layers at sampling time from world Z; it
cannot see a list of slices. Moving it onto this would mean either dragging the
slice list into the field or rolling every window twice — and the second would
reroll every saved lamp. Windows keep their band, and `window.ts` did not change
at all.

**Selectors resolve once, in the pipeline.** The geometry modules are handed a
finished set of layer numbers. Letting each resolve its own would put a copy of
this logic in four modules that may not import one another. `WindowFrame` and
`PlaneFrame` are duplicated deliberately, but those are *shapes*; logic drifts
and shapes do not.

### The two details that are traps

**`range` counts sheets, not planes.** A model with a void along Z examines a
plane there and produces no sheet, and "the bottom three sheets" means three
sheets a person can hold. Tested against a stack with a gap in it.

Legs and bosses are field features and therefore select the **planned** layers,
including empty planes, before nonempty sheets can be known. Their shared
inspector explicitly says which numbering it uses. Legs share their default
first-two-plane selector with the pipeline; plane 4 can cut output sheet 2 in
a model with a void along Z.

**`every` counts by position, not by layer number.** What matters for a pin is
which sheets are *next to each other*, and a void must not put the phase out.
Three phases at n = 3 never overlap and together cover the whole stack — which
is exactly what interleaved pins will need.

### A fixture's band is its position

`fixtureSpansZ` is gone from `fixture.ts`, and it could not have stayed even if
it wanted to: a fixture's z is resolved through its attachment frame, so which
layers it reaches depends on where its parent has moved to. That is knowledge
the pipeline has and a module with no imports cannot.

So `selectorForFixture` builds `{ kind: 'band', z: the resolved z, length }`,
which is the default and is exactly what the old test did — a project that has
never heard of selectors lands on the same sheets, and a validator asserts it.

The fixture inspector uses that same resolved world-space band against the
actual sliced layers. It reports no layers for a band above, below or between
sheets; a band length divided by a nominal pitch cannot answer this question,
especially with attachment or rounded, varying gaps.

The other kinds ignore the position entirely, which buys something that was not
the point: **"this socket is on the bottom two sheets"** is now sayable, instead
of aiming a band at a height and hoping. Choosing one moves `pz` to the middle
of the chosen run, because a fixture draws a ghost of what it will remove and a
ghost standing somewhere the holes are not is the silent lie M9.1 existed to
remove.

### Every layer is a hole in a sheet, not a wall

Perforation is the exception that proves the boundary: it takes a selector too,
defaulting to `all`, which is its old behaviour written down rather than assumed.

## The fixture inspector had never been on screen

Found by pointing at a socket mount and getting a rod panel. The dispatch read:

```
if (feature.stage === 'RIG') return <RodInspector />;   // fixtures are RIG
...
if (feature.kind.startsWith('fixture:')) { ... }        // three lines later
```

Fixtures are created with `stage: 'RIG'`, so the first line caught them and
`FixtureInspector` was unreachable from the day it was written. Every socket,
cable channel and Wago chamber had been edited through the rod panel — which is
why a fixture's band arrived labelled "Length" with a rod's tooltip under it,
and why one showed up holding `8.099999999999994`.

Everything this document says about the fixture inspector — the presets, Centre
on model, the warning about a hole that will not fit, the note that the model
view cannot show fixtures — was written and had never been seen.

The test is on the kind now, and fixtures are checked first. Matching a whole
stage was always going to catch whatever moved into that stage next, and
something did.

**This is the third thing in one working session that was written and never
wired**: `layerPitch()`, which nothing called; `parseProject`'s
backwards-compatibility promise, which was a comment until a broken test forced
it to be proved; and a whole panel. A green `npm run verify` says the code
compiles and the algorithms are right. It says nothing about whether anybody can
reach them.

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

### The stack is a list of planes, not a pitch

`planLayers()` returns `{ index, z0, z, thickness, gapAbove }` per sheet.
`LayerPlan` in `window.ts` mirrors the type structurally — the same deliberate
duplication as `WindowFrame` and `PlaneFrame`, because neither module may import
the other.

A single pitch is true only while every gap is the same. A list says the same
thing when they are and keeps saying it when they are not.

**The change was made identity-preserving on purpose**, and proved rather than
asserted: the same model through the old and new code gave the same layer
indices over the whole sampling window, the same sector field across 200,000
samples, the same slices, and the same layers rolled windows. A refactor that
can be shown to change nothing and a feature that changes the result are two
different jobs, and doing them together means neither can be shown.

Two properties turned out to be load-bearing, and neither is visible in the
code that depends on them:

- **The layer number is not free to change.** Per-layer window rolls are seeded
  from it, and it counts planes *examined* from the bottom, from 0 — not slices
  produced. Numbering from 1, or indexing by slice, would have rerolled the
  windows of every saved project. Ties matter too: `Math.round` sends a half
  toward +infinity, so a height exactly between two mid-planes belongs to the
  upper one. The first binary search written disagreed with that at 20 heights
  out of 3600.
- **The lookup extrapolates rather than clamping.** The sampling grid pads well
  past the stack, and over a 280 mm window the old arithmetic produced indices
  from −3 to 22 — 440 samples below the bottom sheet get negative layers.
  Clamping them to the ends would change the field there, and `stockField` is a
  `max` against the sector, so a changed value outside the band can eat material
  at the band edge.

A validator compares the list against the arithmetic it replaced at 5601
heights. It is an unusual test — it keeps the old implementation alive as an
oracle — and it is what made the change safe to make at all.

Looking it up costs **16 ns** against the arithmetic's 26, on a stack of 40
planes, where one window sample costs 198. The list is cheaper than the thing it
replaced.

### Gaps that vary up the stack, in three steps

`spacerHeight` is the gap at the bottom, `spacerHeightTop` at the top, and
`spacerHeightMid` in the middle. All three equal, or the last two omitted, is a
uniform stack.

**The middle is halfway up in height, not halfway up in layers.** The number of
layers depends on the gradient, so a midpoint counted in sheets would be defined
in terms of its own result — the same reason the two-ended version interpolates
by height.

**A middle equal to the ends must change nothing at all**, and that is checked
rather than assumed: uniform is its own branch, so the middle has to leave that
branch alone rather than turn every uniform stack into a gradient with the same
numbers.

Two things went wrong wiring it up, and both are worth keeping:

- **The slicer did not get it.** `layerOptions` in the pipeline lists its fields
  by name, while `composeField` takes the whole stack object — so the new number
  reached the field and not the slicer, and the stack came out uniform while the
  panel described a gradient. No check could see it, because every check called
  `planLayers` directly and the missing argument was on the caller's side. There
  is now a check that asserts the *contract*: every gap setting `SliceOptions`
  names has to change the plan.
- **The panel said "9.00 → 9.00 mm in 4 steps".** The range read only the two
  ends while the step count included the middle. A fluent wrong sentence, which
  this program treats as worse than silence because it stops the person looking.
  The `graded` test had the same hole: tight in the middle with equal ends would
  have been called uniform.

### Gaps that vary up the stack

`spacerHeight` is the gap at the bottom and `spacerHeightTop` the one at the top;
equal, or the top omitted, is a uniform stack.

**Gaps are counted in rings, not millimetres.** A ring is one sheet of spacer
material and half a ring does not exist, so a gradient interpolates the *ring
count* and the quantisation is structural rather than rounded afterwards. One
consequence worth stating plainly: the smoothness of a gradient is a property of
the ring material. 3 mm rings give three steps between 3 and 9 mm; 1 mm rings
give seven.

**The interpolation is by height, not by gap number.** The number of gaps depends
on the gradient, so a gradient defined per gap would be defined in terms of its
own result. Height is also what a gradient physically means — the gap depends on
where in the form you are.

**Uniform is its own branch, not the gradient with equal ends.** Marching
`z += pitch` accumulates rounding that the closed form `z0 + k·pitch` does not.
They agree to about 1e-12, which is not the same as agreeing, and a uniform stack
is the case that must come out bit-identical to what it always has. A validator
requires that spelling out an equal top gap gives *exactly* the uniform list.

**The plan is built from the achievable gap, not the requested one.** Asking for
4 mm from 3 mm rings used to slice the model at a 7 mm pitch while the panel
warned that the stack could only be 6 — the program designed a lamp it could not
build, and said so in the same panel. Now the two agree, and the warning has
softened accordingly: it is a note that a number came back different, not a
threat that the stack will not close.

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
cross-section area is within **0.1%** of 6400 mm² and that a vertex lands within
one sample of the true corner. That test exists because the original
implementation had the order the other way round.

#### Chaikin does not need to be taught about corners

The obvious next move is to stop Chaikin cutting a vertex that turns sharply,
so a square stays square. It was built, measured, and thrown away.

The turn-angle distributions separate cleanly, so the mechanism would have
worked: on raw marching-squares rings, curved forms turn by at most about 12°
per vertex — a sphere manages 0.4° — while a real corner turns by 40° or more.
A threshold of 30° sits between them with room on both sides.

What it produced was nothing:

| | area of a sharp box | nearest vertex to the true corner |
| --- | --- | --- |
| plain Chaikin | −0.006% | 0.79 samples |
| corners kept | −0.005% | **1.00 samples** |

It does not help, and it makes the corner slightly *worse*. When a corner does
not land on a grid crossing, marching squares emits two roughly 45° vertices
bracketing it, and averaging them lands nearer the truth than either one is.
Keeping both freezes them a full sample out.

So the premise was wrong: **Chaikin does not round corners at slicing
resolution.** The 15% a square lost was the ordering bug, not Chaikin, and
reversing the order was already the whole fix. Checked across 60° corners and
resolutions from 40 to 300, the largest difference anywhere was 0.05% of area —
about 0.02 mm on a 100 mm edge, under the kerf.

The measurement is kept here because the idea is an obvious one and will occur
to somebody again. What came of it instead was tightening the box assertion from
1% to 0.1%: the measured error is 0.006%, so a hundredfold margin still catches
the ordering bug that would eat whole percent.

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

### Moving things in the slice view

A hole can be pointed at and dragged where it is cut, one layer at a time, at
true scale, with the neighbours visible. That is a better place to aim a socket
than a perspective view of a curved surface, and it was asked for after the
layer selector shipped — choosing layers by number is fine, but seeing the sheet
you chose is better.

**A hole remembers who cut it.** `CircleHole` and `Contour` carry an optional
`owner`, stamped at the moment the hole is made — rods in `rig.ts`, fixtures and
perforation in the pipeline. The model view cannot do this: it asks every
feature for its own distance, because a merged surface cannot say who owns a
patch of it. A hole cut per slice was made by exactly one feature, so
remembering is both cheaper and more truthful than reconstructing.

Contours that came out of the field carry no owner, deliberately. They belong to
the whole accumulated form and no single feature owns them.

**Perforation is not grabbable.** Its holes come in hundreds and none has a
position of its own; taking hold of one would drag the entire lattice by
whichever hole happened to be under the cursor, which is not what the gesture
looks like it does. They are stamped anyway — it costs nothing and the pattern
inspector may want it.

**Smallest wins.** A socket hole can sit inside a Wago pocket, and pointing at
the small one should get the small one — the rule the sheet view already uses
when a part rests in a ring's waste.

#### Nothing is written while the button is down

The first version wrote to the tree on every pointer move and drew the preview
as the distance from the *stored* position — which the previous move had just
updated. The offset was therefore always about zero, the hole did not appear to
move, and the only thing that did move was the slicing: 250 ms behind, and
restarted by every write. The hole sat still and then jumped when the hand
stopped.

A sculpt stroke had the same problem and the same answer. Nothing is
re-evaluated during the drag; the offset is measured from where the feature was
when the drag began, and the move is committed once on release. **The preview
then stays on screen until the new slices arrive**, because clearing it at
release would put the hole back for a quarter of a second and jump it forward —
the same flinch, moved to the end of the gesture.

#### A move is a delta, not a position

An attached fixture stores `px`/`py` in its parent's frame, so treating the
stored numbers as world coordinates throws it sideways by the frame the moment
anybody drags it. Reconstructing the world position only to convert it straight
back is work in service of a mistake.

A translation needs no origin. `moveOriginWorldBy` turns a world delta against
the frame's Z rotation and adds it; nothing else about the frame matters, and
height is not touched at all, which is what dragging inside a slice plane means.
Holding the hole where it was grabbed then costs nothing — it falls out of using
deltas.

#### A pointer layer, not a drag handler

The interaction is routed through a tool, and there is currently one tool. A
push brush belongs in this view for the same reasons a drag does — one layer at
a time, true scale, the neighbours visible through onion skin — and wiring the
drag straight into the canvas events would mean writing the brush on top of it,
with two interactions arguing over the same button. Model mode already learned
this: sculpting is a *mode*, and orbit moves to the right button for its
duration.

Arrow keys are deliberately absent. They already mean "step a layer", which is
older and stronger; drag for coarse, and the inspector's numbers — now one click
away, since selecting a hole brings its feature forward — for exact.

### Measuring

Two points, and the distance between them. It exists because a number in a
panel and a number on the bench disagreeing is the most expensive kind of
disagreement this program can have, and within an hour of being built it found
one — a capsule whose `Length` is its straight section, standing 130 mm tall
with 80 mm in the box.

**In the slice view it snaps to the geometry.** A wall measured by eye is not a
measurement, so an end catches the nearest point on any outline, the rim of a
drilled circle, or its centre — and the marker says which it caught: a ring for
a centre, a square for an edge or a rim, a bare cross for a free point. Centres
beat rims and rims beat edges when several are in range, because a centre is
usually the thing wanted and it is the one that cannot be hit by accident.
Alt holds a point free of everything, for the cases where the answer is not on
an edge.

The measurement survives stepping through layers, which is the point: the same
wall on three sheets is exactly the comparison worth making.

**In the model view the ray is only a starting guess.** It hits the preview
mesh, which is surface nets at whatever resolution the preview is running — one
cell is 3 mm on a 200 mm model at 64 samples, and a tape measure three
millimetres out is worse than none. So the real field is bisected along the same
ray to find where it crosses zero, forty halvings, a few dozen field evaluations
per click. If there is no sign change to bracket — a tangent grazing the surface
— it falls back to the mesh hit rather than inventing a number.

The readout gives the distance and `dx`, `dy`, `dz`, because how tall and how
wide are usually the actual questions. There is no floating label: three.js has
no text without a sprite, and a label in space turns edge-on while the readout
can be read from any angle.

**Deliberately not in the sheet view.** `analyseSheet` already measures the
closest approach between real outlines and reports it, which is a better number
than a hand-placed one — it finds the tightest place you did not think to look
for.

### Manufacturability check — M3

`minFeatureGap()` finds the narrowest place in a slice: the smallest gap
between any two pieces of cut geometry. That covers a thin shell wall, two
lobes nearly touching, a rod hole too close to an edge, and two rod holes too
close to each other. Points far apart **along the same ring** are compared too,
because that is what a narrow neck looks like; immediate neighbours are
excluded so an ordinary smooth curve is not mistaken for one.

Whole segments are compared, including their interiors, and circular cuts are
measured against those segments and each other. An X sweep and bounding-box
rejection keep distant edges out of the distance calculation. On one ring,
adjacent edges and points within two thresholds along its perimeter are local
neighbours; that distance is measured in millimetres, independent of vertex
count. Dense smooth curves therefore do not become warnings, while a simplified
four-vertex neck can still be checked. A regression slices an 80 mm box with
three 12 mm leg holes at 33.5 mm spread: its eight-vertex rim has a measured
0.7115 mm bridge, which the old vertex-only check missed at a 1 mm threshold.
Circle/segment crossings report zero clearance and place the marker on their
actual intersection, including a segment whose nearest point is an endpoint.

The threshold is whichever is larger: the maker's `minFeature` setting or two
kerfs, below which material burns through however good the geometry is.
Flagged layers are ringed in the slice inspector and counted in the profiles
panel. **They are flagged, not blocked** — the maker decides, but not by
accident.

## Legs — **shipped**

`src/core/legs.ts`. Round legs — turned wood, steel tube — splayed outwards
from the stack's axis and passing through some number of sheets near the
bottom. Counts of 3 to 8, which is 120° to 45° apart; the angle follows from
the count rather than being typed.

### The shape to cut is not the mid-plane ellipse

A cylinder tilted by θ meets a horizontal plane in an ellipse: semi-minor `r`
across the tilt, semi-major `r / cos θ` along it. That much is ordinary. What
matters is that a leg does not meet one plane — it passes through a **sheet**,
and between the underside and the top face the axis moves sideways by
`t · tan θ`. At 45° through 3 mm stock that is a full 3 mm, most of a leg's
width.

Measured, because it is the whole reason this module exists: of 720 points
around a 45° leg's outline at the top face, **421 fall outside the mid-plane
ellipse**. Cut only that ellipse and the leg does not go through at all, and
you find out with everything already cut.

So the hole is the **convex hull of the two end-face ellipses**, and that is
exact rather than approximate: a cylinder is convex, a slab is convex, their
intersection is convex, and the sections are translates of one ellipse moving
linearly — so the union of them all is the hull of the two extremes.

### One line, because the hull is a Minkowski sum

The hull of a convex set and its own translate **is** the Minkowski sum with
the segment between them. So there is no hull to walk and no polygon to
intersect: slide the query point back along that segment to whichever position
sits closest to the ellipse's centre, and one ellipse answers the whole shape.

```ts
const slid = u > 0 ? u : u + shift < 0 ? u + shift : 0;
return ellipseDistance(slid, v, a, b);
```

The ellipse distance is the gradient-normalised first-order estimate, the same
one the ellipsoid and the superellipsoid already use. Against the true distance
to a 4096-sided hull it is out by **0.0001 mm within 0.2 mm of the surface** —
which is where the kerf iso-level reads — and 0.002 mm at half a millimetre.

### Cut from the field, not pasted into the slices

The first version generated polygons and pushed them into each slice, gated by
`polygonFitsInPart`. That is right for a rod or a socket, which have no sensible
partial shape, and wrong for a leg: a leg that runs over the rim should take a
**bite** out of it.

Doing that with polygons means a boolean subtraction. The estimate was eighty
lines; the honest number is nearer two hundred, because a sheet's outline is
concave and can cross a leg hole several times, so Sutherland–Hodgman is not
enough. And its failure mode is the one true-shape nesting already rejected NFP
for: a subtly wrong polygon that looks plausible until it is cut.

In the field it is nothing at all. Three things fall out and none needed
writing:

- **A leg over the rim takes a bite.** The field goes positive past the edge and
  marching squares walks round the notch.
- **A leg entirely off the sheet does nothing**, with no special case.
- **Kerf is free.** The contour is taken at +kerf/2, which moves it away from
  the material — inward on a hole — so the hole is cut narrow and burns out to
  size, exactly as every other hole here does. `legSections` carries no kerf at
  all, and a validator pins that: applying it twice would cut every leg hole a
  full kerf small and no leg would go in.

The change was made safe by keeping the polygon hull and proving the field
against it: **270,400 samples across four tilts and leg counts, zero
disagreements** about which side of the boundary a point is on.

### What it costs

**`polygonFitsInPart` no longer protects a leg.** A thin bridge between a leg
hole and the rim will be cut; the thin-feature check sees it and rings it in the
slice inspector, but it warns rather than refuses. That is the trade, and it is
the same one the rest of this program already made.

**Layers are counted as planes, not sheets.** The field has to exist before any
sheet does, so counting sheets would define the selection in terms of its own
result — the same boundary that keeps windows on a band. The two agree unless
the model has a void along Z, and where they do not, `legGaps` reports how many
chosen layers produced no part.

### The spread is measured at the bottom

`radius` is where the legs meet the lamp, at the bottom of the model, and a leg
leans **in** as it rises: a sheet higher up takes its hole closer to the axis by
the height times the tangent.

Worth knowing because it makes some settings nonsense rather than merely odd. At
30° over 60 mm of height a leg has moved 35 mm inwards — past the axis and out
the other side. Legs belong on the bottom sheets, which is what the selector
defaults to.

The sign of that was wrong in the first version, with a comment above it saying
the opposite of what the arithmetic did; the holes marched outwards up the stack
and the legs would have had to bend to fit. It was wrong a second time in the
Model view's ghost, which drew them converging at the floor while the holes were
right the whole time — a picture disagreeing with the geometry, which is the
worse way round to find out.

## Per-layer brush — **shipped**

`src/core/paint.ts`. A stroke that edits **one sheet**, drawn in the slice view
at true scale with its neighbours visible. The thing a person wants when they
say "this layer needs to come out a bit here".

### It is a stroke, not a dragged vertex

Decided before any of it was written, and worth repeating because dragging a
contour point is the obvious thing to reach for. A contour vertex is produced by
the field and has no identity that survives the form changing: nudge the sphere
a millimetre and every vertex is somewhere else by a different amount, so there
is nothing to store. A stroke is a thing a person made, and it survives.

### A paint stroke is a sculpt stroke whose z never changes

The same type on purpose. `SculptStroke` is already points plus a radius plus an
operation, so the project file already knows how to write one and the parser
already knows how to be careful with it — neither had to learn a second kind of
bulk data.

The operation being **on the stroke rather than on the feature** fell out of
that, and it is better than what was planned: one brush holds what was painted
on and what was carved off, in the order they were made, instead of a feature
per direction and a tree full of them. TypeScript refused the worse model before
it could be built.

### Anchored to a height, not to a sheet number

Hand-removed pins and hand-set twists key on the layer number and stop meaning
what they meant the moment the material thickness changes. A stroke keys on the
millimetre it was drawn at, so it stays where it was put and lands on whichever
sheet is there.

A stroke whose height falls outside the stack is **dropped, not clamped to an
end** — clamping would silently move somebody's edit onto a sheet they never
drew on — and the inspector counts them, because a drop that says nothing is the
silence this program keeps having to fix.

Here "outside" means outside the nearest-mid-plane assignment, including the
extrapolated half-pitch bands beyond the first and last mid-planes. It does not
mean outside the physical sheet faces. The inspector and pipeline share
`paintPlaneIndex`: ties go upward, a stroke at -1 mm can belong to the first
plane at 1.5 mm, and touched-sheet numbers come from the assigned plane rather
than an exact match to the stroke's height.

### One pitch tall, and after the shell

The band is one pitch, centred on the plane the slice is sampled at, so a stroke
reaches the whole sheet and neither neighbour. The field stays a field:
continuous within a layer, stepping between layers, which is exactly what a
stack of separately cut sheets does.

It is applied after the shell, like a boss, for the same reason: painting
material on and then handing it to the shell to hollow out again is not what
anybody means by painting it on. **Additive strokes set bounds** — the fifth
time that has had to be said here — because a stroke painted past the rim is
material the sampling grid would otherwise cut off.

### The gestures

The pointer goes through the slice view's tool; Hole punch adds a fourth tool.
Nothing is written while the button is down: the stroke draws as a plain line
and the field is evaluated on release, the same arrangement the 3D brush and the
hole drag both arrived at.

**Shift draws straight** back to where the stroke began — a modifier rather than
a fourth button, so it can be picked up mid-gesture. The **wheel sizes the
brush**, which is free here because this view has no zoom to argue with: the
scale is fixed to the model's footprint on purpose. It is attached as a
non-passive listener, since React registers `onWheel` passively and
`preventDefault` would do nothing.

### Onion skin

The sheets either side, drawn behind this one in **the same two colours the pin
holes use**: green above, violet below. One convention for "which way through
the stack" rather than two.

Off by default — most of the time a part is read on its own and two extra
outlines are noise — and it replaces the widest-layer reference rather than
joining it, because three outlines at once is a number nobody can read apart.

Neighbours are **not turned** when the stack is twisted. This view draws parts as
the laser cuts them, and a turned neighbour would be a picture of something that
is never cut that way.

## Hole punch — **shipped** (0.28.0)

One exact circular hole in the sheet currently being edited. In **Slice**, pick
**Hole punch** in the bottom toolbar, set **Diameter** in millimetres and click the centre. The cursor
shows the finished circle, amber when it fits and red when it cannot be cut.
Release creates one `holePunch` feature in the SLICE stage, selects it and
returns to the selection tool. Arming and cancelling the tool creates nothing.
This is the horizontal-layer workflow. Upright assemblies use **Part**, which
does not yet offer Hole punch; disabling the assembly layout restores Slice.
Holding the button while aiming moves the preview and commits its final centre.
Esc and a cancelled pointer gesture create nothing either. A pending slice or
a layer change during the gesture is refused rather than punching stale data.

Each feature stores `px`, `py`, `pz` and `diameter`. The inspector edits the
diameter, X, Y and anchor height; **Show layer** returns to its resolved sheet,
**Use current layer** reassigns the height, and **Delete hole** removes it.
Selecting and dragging the circle uses the existing release-only position edit.
Enable/disable, rename, deletion and project saving use the normal feature tree.
No bulk data or project-format migration is needed.

### The current layer is a height, not a permanent sheet number

The stored height is the mid-plane that was on screen, resolved with the same
`paintPlaneIndex` rule as per-layer brush strokes. Changing stock thickness or
spacing can change which sheet is nearest; a height outside the plan is dropped
rather than clamped. If its planned plane has no part, it stays uncut and says
so instead of jumping to another nonempty sheet.

### Exact circles, after structural holes and before perforation

`placePunch` and `runSliceJob` in `src/core/pipeline.ts` produce a `CircleHole`
with an owner. Cut radius is `(diameter - material.kerf) / 2`; a diameter no
larger than the kerf is refused. The guard uses the finished cut geometry and
leaves a full kerf between paths, accounting for the beam on both cuts.
It tests every contour segment and existing circle, so a partial hole or two
overlapping laser paths cannot slip into triangulation or export.

Punches run in tree order after rods, fixtures and pins have been turned back
for assembly twist. A punch belongs to the **sheet**, like perforation, so it
stays where it was clicked in Slice when twist changes. Perforation follows and
keeps clear of the punched circles. The existing thin-feature check still warns
about narrow remaining bridges; a full hole fitting does not prove the bridge
is strong enough.

The same owned circle is drawn in Slice, extruded in Stack, nested in Sheet and
exported as a DXF CIRCLE. It is absent from Model, like other per-slice drilled
holes; the inspector states that limitation. The slice readout counts circular
cuts as well as contour holes.

### A refused punch says why

The initial placement refuses an invalid diameter, a diameter at or below kerf,
insufficient material around the full circle, or overlap with an existing
circular cut. It creates no feature on refusal. Later parameter edits retain
the feature even if it cannot cut: the current pipeline result reports one hole
on its sheet, outside the stack, an empty plane, insufficient material, overlap,
too small, or invalid parameters. Disabled and pending results have their own
messages. An old result is never presented as the result of a new setting.

`tools/validate-hole-punch.mjs` uses the real pipeline to check one-sheet-only
output, unchanged neighbours, kerf, disabling, twist, changed plans, empty
planes, cut ordering, sparse edges and thin-bridge warnings.
`tools/validate-state.mjs` follows creation through saving, reopening, dragging,
part construction, nesting, DXF and deletion using the real modules. Finished
hole dimensions remain unproven in material until a physical test cut.

Browser checks covered placement, diameter editing, dragging, unchanged
neighbouring sheets, reassigning a layer, rejected placements, kerf and height
warnings, and the resulting Stack and Sheet views. The browser error log was
also checked rather than relying on the pictures alone.

## Layer twist — **shipped**

`src/core/twist.ts`. The angle each sheet is turned by **when the stack goes
together**, not when it is cut. A spiral offset turns each layer a little
further than the one below, and any single layer can be overridden by hand.

The rule is one line, and it is worth stating in one line because it is the
whole feature: **the outline is cut as designed, the holes are drilled at
−twist, and the sheet is turned by +twist when it is assembled.**

### Why it is about holes

A turned sheet cuts exactly the outline it always did, so the DXF, the nesting
and the part count are untouched. What cannot stay where it was is anything that
has to line up *through* the stack: a rod is straight, so its clearance hole has
to be drilled turned back by the same angle, or the sheet will not go on.

Rods, fixtures and pins are turned after their holes are made. Legs are turned
one step earlier, where their sections are built, because a leg is cut from the
field rather than drilled per slice and its hole is part of the outline.

**Perforation is deliberately not turned.** It belongs to the sheet rather than
to the stack — nothing lines up with it — so turning it would only rotate a
pattern against its own part.

The sign is the one thing here that looks fine on screen and cannot be
assembled, so a validator measures it: a 2° spiral over eighteen layers moves a
hole 5.3 mm, which is more than a rod's clearance forgives.

### An override replaces the spiral, it does not add to it

"This one at 40 degrees" is what people mean, and a value that quietly compounded
with the spiral would be impossible to aim. The overrides live on the stack as a
space-separated string of `layer:degrees` — the same shape the hand-removed pins
already use, and the same fragility: change the material thickness and layer 12
is a different sheet.

### The Model view and the Stack view disagree on purpose

The field knows nothing about twist, because the turning happens at assembly. So
**Model shows the design the parts are cut from and Stack shows the lamp**. On a
form of revolution they look identical; on anything else the difference is the
whole point.

That is the one place this program deliberately shows something other than what
gets built, and it is the class of thing it treats as its worst bug — so the
model view says so in its readout rather than leaving it to be discovered.

The slice view does not turn anything either, and for the same reason from the
other side: it draws the part as the laser cuts it, so the holes appear turned
against the outline, which is exactly what is drilled. Turning it there would
have two views claiming different things about one part.

### A spiral that comes back round

`twistPeriod` finds the first repeated orientation within 3600 increments, to
1e-7 degrees. It includes multi-turn repeats: 100° returns after 18 increments,
and 7° after 360. The panel names layers 1 and period+1 to make the counting
explicit. When no repeat is found it states the search horizon, never that a
decimal angle cannot repeat. Pin rings use the same function with their angular
spacing as the cycle: three pins staggered by 80° repeat every three gaps.

### What the assembly document has to add

A turned sheet is cut exactly like an untwisted one, so **nothing about the part
says which way round it goes**. The assembly PDF grows a turn column when there
is a twist, and the angle goes under the layer number in the identification
drawings — on the bench the drawing is what you match a part against, and the
turn is the next thing you need once you have found it.

### Written so the corrugated stock can arrive later

Twist does not appear in the sampler. The wave in a corrugated sheet is fixed to
the sheet, and slicing happens in the sheet's own frame, so that future is
`z = const` becoming `z = const + wave(u, v)` — and the twist is not in that
expression. The two are orthogonal, which is what keeps the material library a
change of surface rather than a rewrite.

## Interleaved pins — **shipped**

`pinGaps` and `loosePins` in `src/core/rig.ts`. Short pins joining one sheet to
the next, instead of a threaded rod through the whole stack. A stack of n
sheets has n−1 gaps, and every gap needs at least one pin or the two sheets
either side of it are not fastened to each other.

### Why they have to be interleaved

The pins in gap k−1 pass through sheets k−1 and k. The pins in gap k pass
through sheets k and k+1. **Both drill sheet k** — so at the same angle the two
pins would meet inside it. Turning each gap from the one below is not
decoration; it is what makes the idea possible at all.

Every sheet except the two ends therefore carries two rings of holes, one from
the gap below and one from the gap above. That arithmetic is also the proof
that pins are being drilled into *both* sheets of each gap rather than one, and
a validator counts it.

`stagger` defaults to half a position, which is as far apart as neighbouring
gaps can be. Zero — or a whole turn, the same thing — falls back to that rather
than obeying.

**The default keeps the rings upright rather than climbing.** Half a position
twice is a whole position, so with three pins the pattern repeats every second
gap and every sheet looks alike. That is a choice and not an oversight: turning
each gap as far as possible from its neighbour and making the pattern climb are
different goals. The panel says which one you have — and what to type for the
other. A repeat can take several full positions: the inspector checks the
first repeated orientation rather than testing whether one spacing divides by
the turn. It reports the period, or the bounded search horizon, without claiming
the pattern never comes back round.

### The generator checks its own work

`loosePins` names sheets missing any required neighbouring connection, including
completely unfastened sheets. The inspectors report that state without claiming
every missing pin failed to fit: hand-removed pins can also leave a gap empty.
A pattern of holes is
not a structure: if a gap's pins do not fit the sheets they pass through, those
two sheets are simply not fastened together, and a stack that comes apart in the
middle is worse than one that was never pinned.

It returns **which sheets**, not how many. End sheets need one connection and
interior sheets need two. An unconnected end is reported; an end with its one
required connection is not asked for a nonexistent second neighbour.

The count also appears in the profiles panel rather than only in the pins
inspector. A thin wall is a warning about how a part will cut; a sheet fastened
on one side is a warning about whether the lamp stands up, and that is checked
once before exporting rather than by clicking through features.

**A pin has to fit both sheets, not one.** Half a pin is not a joint, so a hole
that lands on material below and off the edge above is refused in both —
otherwise the stack would carry a hole that fastens nothing and reads as if it
did.

### Two colours, and the order they are drawn in

On any one sheet half a pin's holes carry on upwards and half downwards, so each
hole carries `pinTo`, the other sheet it reaches, and the slice view strokes it
green going up and violet going down. A ring of identical holes hides the
interleave, which is the only thing about pins worth seeing.

The first version drew them **before** the selection highlight, which strokes
every hole belonging to the selected feature — so the colours were painted over
in amber exactly when the pins feature was selected, which is when anybody looks
at them. Two correct things in the wrong order, and no validator can see that
because both halves are right on their own.

### Taken out by hand

A pin can be pointed at in the slice view and removed with Backspace, and put
back the same way. The keys live on the feature as a space-separated string of
`gap:position` keys — a handful of short keys is not bulk data the way sculpt
strokes are, so it needs no array of its own and no change to the project
format, and `12:0 12:2` is something a person can read in the file.

**A removed pin is not a miss.** It never had to fit, so counting it as one
would put a warning next to a deliberate act. It does still count as *absent*
for the structural check, which is the point: empty a gap by hand and the two
sheets either side are genuinely unfastened, and saying so is why that check
exists.

The keys survive a re-slice but not a change in the number of sheets: change the
material thickness and sheet 12 is a different sheet. Same fragility as hand
placements on the bed, and structural here rather than cosmetic.

## Bosses — **shipped**

`src/core/boss.ts`. A local thickening around a rod, so that a rod standing
where there is no material has something to be drilled through. The word comes
from moulding, where a boss is the lump of plastic around a screw hole; the
problem is the same. A shelled lamp is a ring on every layer and the middle is
cavity, so a rod near the axis lands in air — `circleFitsInPart` refuses the
hole, correctly, and the rod fastens nothing.

**A boss is not just a cylinder.** A cylinder alone in the cavity gives every
layer an island: a disc floating inside the ring, which `groupContours` makes a
part of its own, which falls off the sheet loose and has to be placed back by
hand on every layer. So a boss carries **spokes**, which are the same thing as a
rib in a moulding, and they are what make it one piece.

### Additive, which is the whole difficulty

Everything else in RIG removes material. A boss adds it, so it has to be applied
**after the shell has hollowed the form** — put it before and the shell carves
the boss out again and the point is lost. `composeField`'s `solid` is already
the accumulated SHAPE and CARVE tree, so unioning there is after the shell and
before the windows, which should still be able to cut through a boss.

**No per-layer work.** A leg's hole differs on every sheet because the sweep
depends on the sheet's thickness. A boss is a straight column with the same
section at every height, so the layer selector collapses to a z range and the
field costs one expression per sample rather than a layer lookup.

### Kept inside the form

Each boss is intersected with the **envelope** — the shape tree without the
shell — before being unioned in. Without that, a spoke long enough to reach the
wall carries straight on through it and hangs off the outside as a fin.

Two things follow. **Aiming past the wall costs nothing**, so the reach can be
left at 0 and the wall decides where each spoke stops — which matters because
the distance that lands is different on every layer of a curved form, and a
typed number is right exactly once. And the sampling grid stays honest: a boss
confined to the form cannot push the model's bounds outwards.

**The blend has to be clipped too, not only the boss.** A fillet pulls the union
outwards by up to a quarter of its radius, and at the outer wall the boss and
the form are both on the surface — so they blend into each other and the outline
grows a bump exactly where a spoke lands. Half a millimetre at k = 2, which is
small and completely wrong: the outline is the design. Clipping the result costs
nothing elsewhere, since the shell only removes material and the form is already
inside its own envelope.

### What fails quietly

`spokesStickOut` compares the reach against the boss's own radius. A spoke
shorter than the boss is inside it, the boss is then an island, and an island
shows up as a loose disc on the sheet — on every layer, and only once it is cut.

Whether a spoke reaches the *wall* cannot be answered in this module, which has
no idea where the wall is. Reaching past its own edge can be, and that is the
mistake people actually make.

A boss whose rod has been deleted or switched off contributes **nothing** rather
than falling back to the axis: a boss silently jumping to the middle of the lamp
is worse than one that is missing, and the inspector says which rod it wanted.
Disabled rods remain selectable and are labelled as switched off. A disabled
boss or a boss with no enabled rod reports that it adds nothing; spoke and
island statements are only shown for an active boss with an enabled rod.

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
  distinguishes a disabled feature, zero requested density, an unavailable
  calculation and an empty layer selection. If nothing fits after that, the
  panel asks to check hole size, bridge, band and spacing against actual local
  material. A solid part needs no shell to be perforated; nominal shell
  thickness alone cannot diagnose every zero result. And because
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

## Nesting off the main thread — **shipped**

`runNestJob` joins the slice and preview jobs in `src/core/pipeline.ts`, and
`useSheets` talks to the same shared worker. True-shape costs about half a
second on a real lamp and the webview makes that closer to a second — a freeze
in exactly the mode where somebody is deciding whether to buy material, and
made worse by the resolution dial not being monotonic, so the honest workflow is
to try two or three settings before cutting.

### The boundary is a placement table, not parts

Slicing and the preview are handed the **tree**, because a field is a chain of
closures and closures do not survive `postMessage`. Nesting is the opposite
case: parts are polygons, circles and strings, which is to say plain JSON, and
they travel as themselves.

What comes back is deliberately **not** parts. Neither packer touches geometry —
both end at `{ ...part, bbox, pivot, dx, dy, labelAt, labelHeight }` — so the
only thing the nester decides is where each part goes. Sending the geometry back
would be sending it home again, and it would quietly invite a future packer to
modify it in transit, which nothing downstream expects. Rotation is the proof of
the rule: it is baked into geometry, and it happens in `applyPlacements` on the
main thread, after this.

`rehydrateNest` puts the geometry back under the placements, and must be given
the parts the table was computed from. Those two travel together in `useSheets`,
which is also what lets the previous layout stay on screen while a new one is
packed: it stays consistent with itself rather than becoming a set of positions
for parts that no longer exist.

### Dragging no longer re-packs the sheet

`partPlacements` was a dependency of the memo that did the packing, so **every
drag of a part re-nested the whole job** — half a second with true shape on, and
the layout redrawn from scratch underneath the hand doing the dragging. Manual
placement is applied *after* the pack now, which is where it always belonged.

This is a relative of the failure mode this project keeps meeting, but a
different one: not silence read as a bug, but **work nobody asked for**. The
program was not quiet about what it refused; it was quiet about what it kept
redoing. Both are cured by the same habit of saying what is happening — the
panel now carries `busy` and the time the last pack took.

### What stays on this thread, and why

`applyPlacements` and `rotatePart` are interactive and cheap, and routing them
through a message would trade one freeze for something worse — a part that lags
the cursor.

`analyseSheet` stays too, and that is a decision rather than laziness. The
collision reading is feedback to that dragging, so it has to be on screen while
the part is in the wrong place rather than a round trip later. It only examines
pairs whose boxes overlap and thins dense outlines to 400 points, so the cost is
already bounded.

Pinned parts are safe against a reply landing mid-drag, because placements live
in the store and are read after the reply, never sent with the job. The drag
always wins, which is right.

### What the validator can and cannot prove

`tools/validate-pipeline.mjs` asserts that `rehydrateNest(runNestJob(job),
parts)` is exactly what calling `nestByMaterial` directly gives, for both
packers, and that both directions survive `structuredClone`. A precondition
check comes with it: the two packers must *disagree* on the test job, or a
dropped `trueShape` option would pass both equivalence checks unnoticed.

There is deliberately **no test claiming the worker and the inline fallback nest
identically**. Node has no worker, so such a test would run the fallback twice
and assert something other than what it says. The guarantee is structural — the
worker holds no packing logic at all, both paths call the same function — and
the equivalence check is what pins it.

The test job needed one part that is neither round nor centred on the origin.
Without it every pivot was `[0, 0]` by coincidence and a rehydration that lost
the pivot entirely still passed, which is what the first version did.

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

### The digits are not seven-segment, and this file used to say they should be

`font.ts` claimed seven segments stay unambiguous at 3 mm on scorched board
where a stylised 6 or 9 does not. It was reasoned, never measured, and cutting a
real lamp disproved it: 3 and 8 could not be told apart on a pile of parts.

The reason is structural. In seven segments a 6 differs from an 8 by two short
verticals and nothing else, so **every digit is one unburnt segment away from
another one**. Rasterised on the cell and compared pair by pair:

| | closest pair | 6 against 8 |
| --- | --- | --- |
| seven-segment | **2.8%** of the cell | 2.8% |
| shape-led | **20%** | 33% |

So the digits carry their differences in the shape. The **8 has a waist** — two
loops pinched at the middle, and no other digit has one, which is what stopped
3, 6 and 0 being read as 8s. The **3's middle runs out to the left** past the
centre, so the open left side reads as deliberate rather than as a segment that
failed to burn. The **7 is crossed**, the **1 has a foot**, the **0 keeps its
slash**.

A validator pins the 12% threshold, between the two measurements, so this fails
if anybody quietly reverts to segments. The waist is pinned separately, and a
mutation test shows why: putting the seven-segment 8 back fails only that one
check, because the other digits are still shape-led.

Cut and read at 3, 4 and 5 mm before being adopted. 3 mm is legible, so
`findLabelSpot`'s fallback to 60% height stays as it was.

### The figure that says what size to use

`glyphTestDocument` in `font.ts` — digits at five sizes with the confusable
pairs after them, each row labelled with its own height at a fixed comfortable
size so the label stays readable on the row that turns out not to be.

It lives in `font.ts` rather than beside `kerfTestDocument` in `dxf.ts` because
that module may not import values, and a figure made of glyphs has to reach the
font. The `DxfDocument` import is type-only, so both constraints hold.

**Its question changed once already.** It was built to compare two fonts; that
comparison is over and the seven-segment digits are gone. What is left is the
part that recurs: a new board scorches differently, and 3 mm on cardboard is not
3 mm on plywood. It is the kerf test's sibling — cut once per material, read,
and stop guessing.

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
- Feature numbering resumes past the highest loaded `fN` and the saved
  allocation watermark (since 0.29.0), so deleted assembly targets cannot bind
  to newly created parts after save/open. Older files without the optional
  `nextFeatureNumber` still derive the next ID from loaded features. Newly added
  features cannot collide with loaded ones.
- Opening a project clears baked mesh imports and advances both the import
  revision and the project revision. Feature ids may recur in another file;
  they never grant access to the previous project's geometry. Imported meshes
  must be located again, even when reopening the same project.

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

### The assembly document — **shipped**

`src/core/pdf.ts` writes it, `assemblyDocument` in `job.ts` composes it. The
pages that go to the bench with the parts.

**The drawings are the document and the table is the appendix**, which is the
other way round from the manifest — and that ordering came from the bench, not
from a plan. A numbered stack is not self-explanatory once it is a pile of
parts, but what was actually hard turned out to be *telling one part from
another*, not remembering the order.

It was deliberately built after a real lamp had been cut. What it has to say —
whether a gap takes one ring or two, which sheet a layer ended up on — was a
guess before there was a pile to sort.

#### One scale for every drawing

The whole trick. Fitting each layer to its own box makes a 40 mm ring and a
200 mm ring the same size on the page, and telling those two apart is the job.
`commonScale` works the factor out from the largest drawing and applies it to
all of them, so the size progression up the stack is the first thing the eye
gets.

Gaps are given in **rings**, not millimetres: a ring is what you pick up off the
bench and half of one does not exist.

#### ASCII only, and that is a constraint rather than a style

Every file leaves through `download.ts`, which writes **strings** — a Blob in
the browser, `write_text_file` in the native shell. So the PDF has to be a
string: no compression, no binary streams, no byte offsets a string cannot
count. An uncompressed content stream of `m`, `l`, `S` and numbers is plain
text, and the cross-reference table's byte offsets are then just character
counts. A validator asserts every byte is printable.

That constraint was found by reading `download.ts` before writing anything, and
it decided the whole design. Reaching for a PDF library would have produced a
binary file that the one export boundary in this program cannot carry.

#### No font in the file, and none in the output

Labels arrive as polylines from `font.ts` — the same strokes the laser engraves.
No font to embed, no encoding to get wrong, and no reader that can render it
differently from another one. It is the same argument that keeps the DXF free of
TEXT entities, and it means the assembly pages and the engraved parts are set in
the same digits.

#### What the validator can prove

That a reader will accept it, which is the failure that is total rather than
partial. The header and the marker, a catalogue and a page tree, and the parts
that are silently wrong or exactly right: **every cross-reference offset lands
on its object**, and the declared stream length is the stream length. A reader
seeks to those offsets and either finds an object or gives up.

Plus the drawing itself: millimetres become points, a closed path is closed,
paths are stroked and never filled, and state is emitted only when it changes —
not as an optimisation, but because a stream that restates the same width a
thousand times is unreadable when something goes wrong in it.

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

## Mesh import — **shipped** (M9)

`src/core/meshImport.ts` reads the file, `src/core/voxelise.ts` turns it into a
signed distance grid, and from there an import behaves like any other solid:
blend it, subtract from it, shell it, slice it, click it, move it.

STL binary, STL ASCII and OBJ. Binary is detected **by arithmetic**, not by
looking for the word `solid` at the front — plenty of binary STLs begin with it,
their 80-byte header having been filled with whatever the exporter felt like. A
binary STL's length is exactly 84 bytes plus 50 per triangle, and that is the
test.

Face normals in the file are ignored. The sign comes from the geometry, because
a file's normals are as often wrong as right.

### No three-mesh-bvh

The handoff specified it. It is a three.js dependency, and slicing happens in a
field the validators load in Node with no three at all — so the search is done
here instead, with the same broad phase the sculpt strokes use, in about forty
lines.

### Magnitude and sign are computed differently on purpose

**Magnitude** is the exact point-to-triangle distance, through a broad phase over
triangles: one bucket lookup, then a linear scan of the few triangles nearby.

**Sign** comes from crossing counts along the grid's own Z lines, not from a ray
per sample. The samples are a regular lattice, so each column can be done once:
collect where triangles cross that line, sort, and inside alternates between
them. Exact parity, once per column rather than a million times, and with none of
the flakiness of choosing a nearest triangle's normal at a crease.

**The parity lines are nudged a fraction of a cell off the grid points**, and that
is not a nicety. The half-open barycentric test makes a shared *edge* count once,
which parity needs. A shared *vertex* is another matter: four or more triangles
meet, several accept the hit, and the count comes out even with zero-length
inside spans. On a symmetric mesh that case sits squarely on the axis — a
sphere's poles at x = y = 0, with grid points landing exactly on them — so it is
the first thing that happens, not a rare accident. It was: the whole central
column of the test sphere came out hollow.

### The reach is what decides whether an import can be shelled

Distances are exact out to a reach and clamped beyond it, inside and out. A shell
takes its wall off the **inside**, so it needs the interior distance to be real at
least a wall's depth in; where the field is clamped the cavity lands on the clamp
instead of where it belongs.

The first version used a fixed eight cells, which is 5 mm on a 40 mm import — and
a 5 mm shell then put its cavity exactly on the clamp, giving a field of exactly
zero at the centre. So the reach scales with the object: 15% of the longest axis,
deep enough for any wall anyone would cut from sheet, on a trinket and on a shade
alike. The inspector reports it in millimetres and warns when a shell in the tree
is thicker.

The comparison uses the deepest **enabled** shell, not the last shell in the
tree. Increasing resolution preserves approximately the same physical reach;
it improves detail, so the warning recommends scaling the mesh or thinning the
wall instead of promising deeper distances from a finer grid.

### Uniform scale, and only for imports

No primitive has a scale, and the reason is written into `TRANSFORM_PARAMS`:
non-uniform scaling destroys the distance property, which blends and kerf
offsetting both depend on. **Uniform scaling does not.** `s · d(p / s)`
multiplies every distance by the same number, so the field stays true and a
10 mm blend still means 10 mm.

An import needs it. A mesh arrives at whatever size the exporter left it, often
in inches or at a hundred times the intended size, and a feature that cannot be
resized is a feature nobody can use. So an import carries `scale`, uniform, and
gets a gizmo like anything else with a position — `hasTransform` and
`hasRotation` had both missed it, which is why neither the gizmo nor the
selection outline appeared.

The inspector leads with **longest axis in millimetres** rather than the
multiplier, because the actual thought is "make this 180 mm tall", not "multiply
by 2.3714". The measurement is taken from the mesh itself rather than the padded
grid: the person means the object, not the box of air around it. Scale survives
replacing the file, since resizing is usually the first thing done to an import
and should not be undone by swapping in a fixed version of the same mesh.

The reach scales too, so the shell warning compares the wall against
`reach × scale`. Scaling a small import up is therefore also a way to make it
shellable.

### The project file records the path, not the geometry

A 96³ grid is 884,000 floats. Embedding that as base64 would break the one thing
the project format is for — being a file a person can read and diff — so the
project stores the path, the resolution and the transform, and an import has to
be **located again** after opening. That is how CAD handles external references,
and the inspector says so plainly rather than presenting an empty feature.

Grids live in a module-level map outside the store, not in state: a grid is
megabytes of Float32 and has no business in an object that gets compared on every
render. The store carries `importRevision`, the one number that has to change for
the memos to notice.

### Not closed is reported, not refused

`openEdgeCount` counts edges belonging to a single triangle. Zero means
watertight, which is what parity needs to be right. Anything else is **reported
with a count** and imported anyway: a mesh with a few holes usually still
voxelises usefully near the parts that matter, and the person is better placed to
judge that than the program is.

## 2D profiles and SVG import — **shipped**

`src/core/profile2d.ts`. An outline in a plane, kept as a **distance function**
rather than as a polygon. The sources are an SVG file now, a brush stroke or a
slice of the field later; once read they are all the same thing.

Keeping it as a field is what makes morphing possible at all. Two profiles are
interpolated by mixing their distances, with no correspondence between their
points to work out — which is the whole difficulty of morphing polygons and is
solvable only badly.

### Two fill rules, and the first one was the wrong idea

| Rule | Means |
| --- | --- |
| `holes` | even-odd: a path inside another is a hole, one inside that is solid again |
| `outline` | **union**: solid wherever any path encloses |

`outline` started as "keep the rings that are inside nothing", which quietly
assumes the rings *nest*. Given a drawing of eleven circles laid over each other
it kept whichever ones happened to have their first vertex outside the others
and dropped the rest, so parts of the drawing went missing and the outer edge
came apart. Reported from exactly that.

A union covers both things people mean by "ignore the inner paths": a letter O
comes out a disc because its counter is inside the union, and crossing rings
merge instead of fighting.

### A union is the minimum of signed distances

Not the smallest magnitude with a sign decided separately, and the difference is
not subtle. Inside one ring and next to another's boundary, the second reading
says *almost at the edge* when the point is deep in material — and a shell
believes it, so `max(d, -(d + t))` leaves a wall standing along every interior
outline. On eleven overlapping circles that is most of them.

Even-odd is the other case, and there the smallest magnitude **is** right,
because every ring's boundary really does bound the region.

### The y axis, flipped once

SVG's y points down. It is flipped on the way in, in one place, or every import
is silently mirrored — which does not look like a bug, it looks like a drawing
somebody made, and it is found after it is cut. A validator pins it, and
removing the flip fails nine checks.

### The index is the whole cost, again

Measured before it was written: the plain walk costs **17 microseconds** a
sample, which is 6.2 seconds for one preview grid, and that was 200 segments —
a real drawing with flattened curves has thousands.

Two structures, because the two questions are different shapes: segments in a
uniform grid for distance, searched outward a ring of cells at a time; and
segments in row bands for the crossing test, so the parity ray walks one band
instead of the whole outline. After that, **1.35 microseconds**.

Three things came out of measuring rather than reasoning:

- **Bigger cells are slower.** The cost is in testing segments, not in walking
  cells, so a coarse grid makes every query test a handful it did not need. One
  segment a cell won.
- **`Math.hypot` was half the time.** It guards against overflow and charges for
  it; comparing squares and taking one root at the end is the same answer.
- **The bound that ends the search was one ring too generous**, so it stopped
  while a closer segment was unexamined and the field came out up to a cell
  wrong — 5.2 mm on a real drawing, which is a shape nobody notices is wrong
  until it is cut.

This is the third time this project has needed the same idea — sculpt strokes
index whole strokes, `EdgeIndex` buckets contour segments, and now this. They
cannot share code, because each is loaded by a validator as the real thing and
may not import. If a fourth appears, the rule is worth revisiting rather than
copying again.

### The reach, sized from the tree

Distances are exact out to a reach and clamped beyond it — the same contract a
mesh import carries, and for the same reason: a field only has to be true where
something reads it. The sign stays right everywhere, because parity is cheap.

But a profile can do something an import cannot. **An import's grid is baked
once and its reach is frozen with it; a profile's index is rebuilt on every
composition**, so the pipeline works out what this lamp actually needs — the
deepest shell in the tree, half again — and pays for exactly that. A lamp with
no shell pays nothing for one.

The profile volume exposes the reach of the index it actually built, taking
the current blend, 1.6 times the deepest enabled shell and the 60%-of-span cap
into account. The inspector memoizes that volume metadata instead of building a
default index with different settings. A morph reports its tightest usable key.
For an 80 mm circular outline, a 20 mm blend gives 20 mm reach; a 20 mm shell
gives 32 mm. Those values are checked against the actual clamped field.

### A profile is a volume

`sdf.ts` may not import values, so it cannot call the extrusion. It does not
need to: `MeshVolume` is `{ sample, min, max }` and an extruded outline is the
same shape of thing. The change there is one condition — `kind === 'import' ||
kind === 'profile'` — and the frame, the scale, the bounds and the picking all
work unchanged, because everything downstream reads the prepared step's *type*
rather than the feature's kind.

The boundary was built for meshes and took an SVG outline without being touched.

### Height is not scale

An import carries a uniform scale, deliberately, because non-uniform scaling
destroys the distance property. A profile's **height** stretches Z only and
leaves the outline alone, so the field stays true and the number can be anything.
Sizing the outline is a separate control, and that one is uniform.

### The rings travel, the file does not

Rings live **on the feature**, like sculpt strokes rather than like an import's
grid. They are kilobytes of plain numbers, so they cross to the worker with the
tree for nothing, where a megabyte of Float32 has to be sent once per bake and
cached on both sides.

They are still not saved. `project.ts` copies `params`, `strokes` and a morph's
**key list** — paths, sizes and fill rules, never any rings — so a reopened
profile has its path and no geometry and the SVG has to be located again. The
trade mesh import already made, made deliberately a second time, and a third
time per key.

The feature tree recognises imports, profiles and sculpt features alongside
registered primitives. Loaded-state subtitles read actual mesh entries or
outline rings, not saved counts; a live morph names its usable keys and their
height span instead of claiming its unused base outline is missing.

## Morphing between key profiles — **shipped**

`morphPlaneDistance` and `extrudeMorph` in `src/core/profile2d.ts`. Two or
more outlines at different heights, and the solid between them. A circle at the
bottom becoming a star at the top, or a base, two waists and a rim.

### It is the profile feature, not a new kind

A morph is a `profile` carrying a **key list** — `{ z, size, fill, path,
rings }` per key — and the list being absent is how a plain profile is spelled.
Nothing migrates, because a file written before keys existed already means what
it always meant, and there is no conversion step to get wrong.

**Fewer than two *usable* keys is the plain profile**, and usable means a finite
height and rings that have actually been read. A morph whose SVGs have not been
located again after opening therefore falls back to the original outline rather
than cutting nothing — a working lamp, but not the one that was asked for, so
the inspector says which it is.

`usableProfileKeys` is exported from the pipeline and the inspector imports
**that same function** rather than writing the condition again. The panel and
the sampler cannot disagree about whether the morph is live, which is the
`FixtureInspector` gap closed by construction instead of by care.

### The mix is the whole feature

Between two keys the outline is their **distances mixed**, not their polygons
matched:

```
d(x, y, z) = (1 − e) · d_below(x, y) + e · d_above(x, y),  e = ease(t)
```

There is no correspondence between the two drawings' points to work out, which
is the entire difficulty of morphing polygons and is solvable only badly. And a
**topology change costs nothing**: one ring at the bottom and two at the top
needs no rule about when to split, because a mix of two continuous fields is
continuous and its zero level parts on its own. Measured on exactly that — a
40 mm circle becoming two 15 mm circles 60 mm apart — the walk along the axis
finds two sign changes near the bottom and four near the top, and no height
steps the field by as much as a millimetre per half-millimetre of rise.

### Any number of keys, and the cost does not grow

Keys bracket **piecewise**: the height picks the pair either side of it and only
that pair is mixed. So a base, two middles and a top is four rows in a list, and
every sample still evaluates at most two indexes — one on a key plane, where
only that key's index is read and the slice is that drawing **bit for bit**.
Three keys are checked for symmetry: the same point the same distance above and
below the middle key reads the same number to 1e-12.

### Easing, and why it is on by default

`easing` is `'linear'` or `'smooth'`, and smooth — the smoothstep
3t² − 2t³ — is the default. Three reasons, and the third is why the validator
can be short:

- **Its derivative is zero at both ends**, so the field is C¹ across a key
  plane. A linear mix creases at every interior key: measured on a symmetric
  three-key stack, linear arrives at −0.2 mm/mm and leaves at +0.2 while smooth
  is flat to 0.02. The crease is a visible kink in the stack at exactly the
  height somebody put a drawing.
- **It stays inside [0, 1]**, so the mix is still a convex combination and the
  Lipschitz argument below survives unchanged.
- **smoothstep(0.5) = 0.5**, so halfway between two keys the two easings agree
  exactly. One geometric check — concentric circles mixing to the circle of the
  mixed radius — therefore covers both, and a *second* check asserts they
  differ at the quarter, because an easing option that reaches the field but
  changes nothing would pass every other check in the file. That is the
  `SliceOptions` lesson: a setting has to be shown to change the result.

Measured through the whole pipeline on a cone from r = 20 to r = 50: the
surface radius a quarter of the way up is 27.5 mm linear and 24.6 mm smooth,
and at the midpoint both are 34.99 mm.

### What the mix does to the distance property

The question that decides whether the kerf iso-level can be trusted, and it was
**measured rather than reasoned away**.

A convex combination of two 1-Lipschitz plane fields is 1-Lipschitz, so the
in-plane gradient can never exceed 1 and the kerf shift can only
*over*-compensate — by 1/|∇d|. Where the two keys' nearest edges point the same
way the gradient is 1; where they disagree, which is near a pinch, it drops.
Sampled near the surface across the one-to-two transition: **max 1.0000,
min 0.569**, so the worst kerf over-compensation is 1.76×, within a couple of
millimetres of where the lobes part. The validator records both numbers in its
detail line rather than only asserting a bound.

That is small enough to leave alone until a cut says otherwise, so the
normalisation trick the superellipsoid uses — dividing by the gradient
magnitude — **stays shelved**, with the measurement written down so the next
person does not have to take it again.

The **vertical** gradient is a different matter and is not unit on a slanted
wall: as the outline grows with height, the horizontal distance overstates the
true 3D distance by the slant. Slicing and kerf never read it — both work in
the slice plane — so the cost falls on 3D blends against other features and on
the preview normal, which is worth knowing rather than worth fixing.

### The ends clamp rather than fade

Below the lowest key the lowest profile holds; above the highest, the highest.
**Clamped, not faded to nothing**, and for the same reason the layer lookup
extrapolates rather than clamping: the extrusion's slab is a `max` against this
value at its own edge, so a value that changed outside the slab would eat
material at the slab's edge.

### Two equal keys are the extrusion they came from

The identity that made the change safe to make, and it is checked at both
levels: in the module, `extrudeMorph` with two identical keys matches
`extrudeProfile` to under 1e-9 over 3000 points, for both easings and with the
round applied; through `profileVolume`, the worst disagreement is 1.8e-15, and
the pipeline check compares sheet counts and material areas layer by layer.

`round` uses the same shrink-and-offset-back-out arithmetic as
`extrudeProfile`, with the slab's shrink clamped at half the span, so a round
larger than the whole morph cannot invert it.

### The span is the keys, so bounds are too

Bounds are the union of the keys' bounding boxes crossed with
`[z_lowest, z_highest]`. A convex combination cannot leave that union, and the
round only shrinks, so it is the outer box.

This is where `height` stopped applying, and it had to: keys 60 mm apart under
a 40 mm height put no sheet near the top and the form arrives beheaded. Anything
that adds material sets bounds, whatever the parameters say — the boss lesson,
met again in a place nothing about a boss suggested.

### Every key is centred, which is why there is no Centre button

The plan had one, scoped and agreed: two drawings rarely share an origin, so
outlines drawn in opposite corners of their pages would morph through a sideways
sweep nobody asked for. Reading `profile2d.ts` before writing to it showed the
button had already been pressed — `fitProfile` centres the bounding box on the
origin *as* it sizes, so every key arrives centred by the same call that fits
it. `centreProfile` exists for the case where sizing is not wanted, and is
validated; the panel needs no button.

Changing a key's size **re-fits its rings** rather than re-reading the file, the
same exactness `setProfileSize` already relied on: scaling rings that are
already in millimetres is exact, and the drawing may be long gone.

### The file records paths, and the parser is defensive per key

A key list is written as paths, sizes and fill rules — **never rings**, the same
trade the profile's own outline makes. On the way back in:

- a key with no usable height is **dropped and reported**, because a profile at
  no height is nowhere;
- the list is **sorted by height**, so nothing downstream has to wonder;
- two keys at the same height are **reported**: the field survives them, handing
  the whole segment to the lower key rather than dividing by zero, but somebody
  almost certainly meant to type two different numbers;
- an unusable size or fill rule falls back rather than failing;
- rings in a hand-edited file are **ignored**, because the path is the record.

In the store the keys stay in the order they were made rather than sorted live.
The parser sorts on load and the pipeline sorts at composition, so the order in
the panel is cosmetic — and a row that jumps while its height is being typed is
worse than a list that reads slightly out of order.

### A test that read the clamp

Worth recording because it looked exactly like a broken feature. The first run
of the morph checks failed three assertions, reporting −20 mm where the geometry
says −40. Nothing was wrong with the mix: a 64-gon's default reach is two cells,
about 15 mm, and the checks read the field 30 mm deep, so they were reading the
clamp the index promises rather than a distance.

The fix was in the test — index the keys with a `minReach` floor, which is what
the pipeline does from the deepest shell in the tree — and the lesson is for the
pipeline as much as the validator: **a morph's keys each need the reach the
composition asks for**, or a shell deeper than two cells lands its cavity on the
clamp on every key.

## Native shell — **shipped** (M10)

Tauri 2 wraps the same Vite app in a native window. `src-tauri/` is a sibling of
`src/` and does not touch it; `npm run dev` in a browser still works and is still
the faster way to develop, because there is no compile step and reload is
instant.

`devUrl` points at **5180**, the port pinned in `vite.config.ts` with
`strictPort` back in M0 for exactly this.

### The Rust side does two things

Host the window, and write a text file where the person said to put it. That is
all.

Writing is an **application command rather than the fs plugin**, deliberately.
The plugin would need filesystem scopes declared in the capabilities file, and
getting those subtly wrong shows up as a silent refusal at the worst possible
moment. An application's own commands do not go through that ACL at all, so
there is less to get wrong and the result is identical. The **dialog** plugin
stays, because asking the operating system where to save is exactly what a
plugin should be for — so `capabilities/default.json` grants `dialog:default`
and nothing else.

Path joining happens in Rust with `PathBuf`, so the separator is right on every
platform rather than assumed.

### One module changed

`src/ui/download.ts` was made the single boundary for getting files out in M3,
when there was nothing behind it but the browser download. This is where that
pays: the native shell landed and **it is the only module that changed**. Sheet
DXFs, the build manifest, the kerf test and the project file all went native at
once, because they all already went through it.

Two branches, one API:

| | native | browser |
| --- | --- | --- |
| one file | save dialog | download to Downloads |
| many files | one folder, chosen once | sequential downloads, 350 ms apart |
| opening | open dialog | a file input created on the spot |

**A folder is chosen once per session, not once per file.** Exporting eleven
sheets should not mean eleven dialogs, and it should not mean eleven throttled
downloads either. The chosen folder is shown in the panel with a button to
change it, and it is forgotten if a write fails, since a folder that has gone
away should not be remembered.

Every save funnels through one `announce()` so the panel reports a path, a count
or a failure the same way whichever button was pressed — and a dismissed dialog
says nothing at all, because cancelling is not an error.

### Version stays in one place

`tauri.conf.json` sets `"version": "../package.json"` rather than a number, so
the shell reads it by reference and there is no third copy to drift.
`check-version.mjs` now asserts the **reference** is still there, which is the
thing that can break, rather than comparing a number that cannot.

### Known: the webview is slower than Chrome

macOS uses WKWebView, so the JS engine is Safari's rather than V8. Kerros spends
its time on plain numeric work — field sampling, marching squares, sculpt
strokes — and V8 is roughly 1.5 to 2 times quicker at it. The Rust side is not
the bottleneck; it only hosts the window. Lowering the preview resolution is the
immediate answer; moving slicing to a Web Worker, promised in the handoff since
M2, is the real one.

## Slicing off the main thread — **shipped**

`src/core/pipeline.ts` holds the whole path from feature tree to sliced, drilled,
perforated layers as **one pure function**. `src/ui/kerros.worker.ts` is a thin
shell around it, and `useSlices` talks to that.

### The field cannot cross a thread boundary

`composeField` returns a chain of closures, and closures do not survive
`postMessage`. So the worker is not handed a field — it is handed the **tree**,
and builds the field itself. A tree is plain JSON; a closure is not.

The one thing that is not plain JSON is an imported mesh's grid, megabytes of
Float32. Those are sent **once per bake**, not once per job, and cached on both
sides by feature id. `useSlices` tracks which `importRevision` the worker has been
told about and only re-sends when it changes. The grids are copied rather than
transferred, because the main thread still needs its own for clicking on an import
and for the preview mesh.

### The pipeline had to leave the store

The first attempt had `pipeline.ts` importing helpers from `store.ts`. That works
in a browser and fails the more important test: Node cannot resolve `zustand`, so
the pipeline could not be loaded in a script, and the whole reason for extracting
it was to make the worker's logic testable.

So `composeField`, `isFieldFeature`, `rodsFromFeatures`, `windowsFromFeatures`,
`fixturesFromFeatures`, `patternOptionsOf`, `rodSpanOf` and `windowFrameFor` moved
from the store into the pipeline, which now imports only modules that have no
imports of their own — with **explicit `.ts` extensions**, so the graph resolves
in Node. The store re-exports them, since every caller in the UI already imported
them from there.

`composeField` takes the volume map as an argument rather than reaching for a
module-level cache: the main thread has the store's, a worker has its own, and the
pipeline must not know which it is talking to. The store keeps a wrapper that
supplies its own.

`tools/validate-pipeline.mjs` then checks the thing that actually runs: an empty
tree, a shelled body, rods and fixtures and perforation composing in the right
order, windows coming out as their own sets, an import arriving as a payload and
rebuilt on the far side, a missing grid contributing nothing, and determinism.
Sixteen checks over one entry point, where before there were none over the
composition at all.

### Stale replies are dropped

Every job carries a token, and a reply whose token is not the newest is discarded.
During a drag several jobs are in flight and only the last one asked for is worth
showing — without that, a slow job finishing late would overwrite a newer result.

Invalidation starts when the inputs change, including the debounce interval.
Slice and preview replies also belong to a project revision. Opening another
project hides old results immediately, before the next effect or worker reply.
The preview's empty waiting result has stable identity: its consumer redraws
and sets statistics when that object changes, so allocating it on every render
would create a redraw loop while a newly opened project's preview is pending.
Empty preview buffers are cloned without transfer. They belong to a shared
empty result, and transferring even a zero-byte buffer would detach it and
break the next empty reply. The state validator exercises the actual worker
handler with structured-clone transfers for repeated empty and normal previews.
Model mode retains its own project's last slice for fixture ghosts without
reslicing, but that cache carries explicit freshness: changed slice inputs
disable cut-job exports until Slice, Stack or Sheet has recalculated them.
Nesting only consumes current slices, and exports require a completed pack for
the current inputs. A completed pack with every part unplaced says so; it does
not ask the user to start the pack again. The kerf test is independent and
remains available.
An empty model with a completed calculation says it produced no cut layers,
rather than asking for that same calculation again.

### If the worker will not start

`useSlices` falls back to running the pipeline on the main thread, which is
exactly what the program did before the worker existed. A worker that fails to
construct is a reason to be slower, not a reason to stop working.

## True-shape nesting — **shipped**

Bounding-box shelf packing reserves a rectangle for every part, so the inside of
every ring is waste — and a lamp is mostly rings. `nestTrueShape()` packs against
the real outline by rasterising each part with **material solid and holes free**,
then looking for somewhere its cells do not collide with what is already down.
A small part dropping into a ring's hole needs no special case: the hole simply is
not occupied.

Off by default, chosen in the profile panel. It costs about half a second per
layout, which is worth paying when you are about to buy material and not worth
paying while you are still deciding what the lamp looks like.

### Why a raster and not no-fit polygons

NFP is the tighter method. It also needs Minkowski sums and convex decomposition,
and every one of its failure modes is a subtly wrong polygon that looks plausible
right up until it is cut. A raster is coarse in a way that is **measurable,
obvious and always conservative**: a cell is either free or it is not.

### Two optimisations that made it usable

The first version took **2.3 seconds** on a 71-part job. Two changes brought it to
0.7:

A **summed-area table** over each sheet rejects a candidate position in constant
time when the part's bounding box covers nothing occupied — which is most
positions on a half-empty sheet. Rebuilt after each placement, which is cheap
compared to what it saves.

A **sparse pass before the exact one**: every eighth cell first, the full walk only
if that passes. Without it the exact test walked tens of thousands of cells for
nearly every candidate on a filling sheet. A real overlap almost always hits one of
every eighth cell, so the expensive walk is left for near misses.

Candidates are also tried on a coarser lattice than the raster — roughly 4 mm of
search granularity whatever the cell size. The raster decides whether a part
*fits*; the lattice only decides how finely the search *looks*.

### Measured

A 220 mm sphere, 10 mm wall, 3 mm sheets at 3 mm spacing, plus 24 spacer rings and
10 window plugs — 71 parts, 2489 cm² of material, on a 700 × 400 bed:

| | sheets | first sheet holds |
| --- | --- | --- |
| bounding box | 8 | 3 parts |
| true shape, 2 mm | 7 | 47 parts |
| true shape, 1.5 mm | **6** | 48 parts |
| true shape, 1 mm | 7 | 47 parts |

**A finer grid is not reliably better.** Greedy bottom-left packing is not
monotonic in resolution: 1.5 mm beat both 1 mm and 2 mm on this job. The inspector
says so and offers the dial rather than pretending there is a best value — try a
couple before cutting and keep whichever wins.

### The check that matters more than the saving

If the raster is wrong, parts overlap and the sheet is ruined. So the validator
nests a job and runs the existing true-shape collision analysis over the result:
**zero collisions**, and nothing closer than the raster can promise. It also
asserts that bounding boxes **do** overlap, since that overlap is the whole point,
and — on a sheet sized to exactly one ring, where the only free space is that
ring's hole — that small parts really do end up inside it.

That last test took three attempts to state correctly. A greedy packer fills from
the bottom left, so small parts sit *beside* the rings for as long as open sheet
remains, which is correct behaviour and made the first two versions of the test
assert something the algorithm had no reason to do.

### Fill now counts material

`fill` was the share of the sheet covered by bounding boxes. Once parts nest inside
each other's holes those boxes overlap and the total can pass 100%, which would
make the number meaningless exactly where it matters most. It is now the share
covered by **material**, in both packers and in `applyPlacements`, computed by a
local shoelace formula — local because `nest.ts` has no imports and one small
formula is a cheaper price than breaking that.

## Grouping shapes — **shipped**

Several shapes can be moved and turned as one. There is **no group feature and no
new concept in the tree**: a shape is attached to another shape, its own
parameters are read in that shape's coordinates, and moving or turning the leader
carries the followers. A group of five is four shapes pointing at a fifth.

This is the same mechanism a fourth time — sculpt strokes, windows, fixtures, now
shapes — and the fourth time it needed nothing new except composition.

**A shape inherits the whole rotation**, unlike a window or a fixture. Those live
in horizontal sheets and can only follow translation and Z; a shape is a volume,
so tipping over is a move it can make.

**A group is a coordinate unit, not a boolean one.** How the shapes combine is
still the tree order and the operations. Grouping five spheres does not make them
one solid; it makes them one thing to aim.

### What had to be exact

`worldRigidOf` walks the chain of attachments and composes: R = Rp·Rc,
t = Rp·tc + tp. Chains work — a follower of a follower — and a cycle or a chain
over sixteen deep resolves to the identity rather than hanging. Neither is
reachable through the interface, which only offers parents from **earlier in the
tree**, but a hand-edited project file is not bound by the interface.

`eulerFromMatrix` is the part that had to be right. A gizmo hands back a world
orientation and a grouped shape stores a local one, so somewhere a matrix has to
become three numbers again — in the order Kerros uses, R = Rz·Ry·Rx. A validator
round-trips seven orientations through `rotationMatrix` and back and requires
agreement to 1e-9, including one at 89.9° where the extraction is nearly
degenerate, plus the gimbal-locked case where only the sum of X and Z is
recoverable. An approximate inverse here would make a grouped shape jump the
instant it was dragged, which is exactly the class of bug that is maddening to
chase from the symptom.

The gizmo and the selection outline both stand at the **composed** transform, or
they would sit beside the shape rather than on it — the outline had its own
`applyTransform` inside the builder, which is where the fix belonged rather than
at the call site.

Bounds compose too, checked by counting samples on the faces of the sampling grid:
a grouped shape moved 200 mm must not be clipped.

### In the tree

A grouped row is **indented**. A group has no row of its own, so the indent is the
only thing that shows it, and it is worth the six lines of `groupDepth`.

## Attachment, finished — **shipped**

Fixtures now follow a shape, which was the last thing in the program that stayed
behind when a form moved. It closes a pattern that came up four times: a shell
follows for free because it acts on the accumulated field, and everything that is
its own volume needs a frame to live in.

Windows and fixtures share `attachFrameFor()` and the same restriction:
**translation and rotation about Z, and no more.** Both live in horizontal sheets.
A socket hole inheriting a parent's X or Y rotation would tip out of the sheet it
is drilled in and there is nowhere for it to go — the validator asserts that X and
Y rotation are *not* inherited, which is the unusual case of a test that exists to
pin down what deliberately does not happen.

A fixture's own `rot` and the frame's add, so a turned plate carries a turned bolt
circle. `setOriginWorld` converts a gizmo drag back through the frame, and
attaching or detaching carries the placement across so changing the reference moves
the reference and not the hole.

`PlaneFrame` is declared in `fixture.ts` and is structurally identical to
`WindowFrame` in `window.ts`. That duplication is deliberate: both describe what a
layer-bound feature can inherit, and neither module imports the other, which is
what keeps both loadable in Node.

## The preview surface off the main thread — **shipped**

`runPreviewJob` joins `runSliceJob` in the pipeline, and the worker handles both.
This was the last heavy thing left on the main thread: a quarter of a second of
field sampling and meshing, on every edit, in the mode where editing happens.

**One worker, shared.** `src/ui/workerBridge.ts` owns it, so slicing and the
preview send to the same instance and share one copy of the imported grids —
sending megabytes of Float32 twice would have cost more than the work does. The
bridge also owns the fallback: if a worker cannot be constructed, both jobs run
inline, exactly as the program did before.

The mesh buffers are **transferred** rather than copied on the way back, since
nothing in the worker needs them once they are drawn. A worker's `postMessage`
takes its transfer list as the second argument, unlike a window's — worth knowing,
because the type error it produces otherwise is about `targetOrigin` and reads like
something else entirely.

**The preview debounce is shorter than the slice debounce** — 90 ms against 250.
The preview is the thing being looked at while a value is dragged, so it should
keep up; slicing can wait for the hand to stop. And the old surface stays on screen
until the new one arrives, which is cheaper than blanking the viewport and less
distracting to watch.

A validator now checks that the preview and the slicer **agree on where the top
is**. They read the same field, so they must — and if they ever stop agreeing, the
shape on screen is not the shape that gets cut, which is the worst class of bug
this program could have.

Picking got a fix along the way: it was passing features without their baked import
volumes, so an imported mesh could never be clicked. `fieldFeaturesWithVolumes()`
attaches them.

## Packaging — **shipped**

`npm run tauri build` produces `Kerros.app` and a `.dmg` under
`src-tauri/target/release/bundle/`.

### Browser build for GitHub Pages

`.github/workflows/pages.yml` builds the same UI as the native shell. Pushes to
`main` and manual runs install the locked dependencies on Node.js 24, run the
complete `npm run verify` and upload **only `dist/`** as a build artifact. The
workflow has read-only repository access and no deployment job or credentials
for another repository. Actions are pinned to commit hashes.

The source repository `Bambi8000/kerros` is public by the owner's choice. The
separate public `Bambi8000/kerros-web` deployment repository was created for the
initial release while the source repository was private; it retains the same
site URL and holds only the compiled site and `.nojekyll`. Its Pages source is
**Deploy from a branch**, `main`, `/`.
Releases copy a locally verified `dist/` into a separate clone of that public
repository, inspect the staged files, then commit and push with the maintainer's
GitHub login. README records this process. A source push verifies the
code but does not update the public site. Source files, documentation and source
Git history are never copied to the deployment repository.

The URL is `https://bambi8000.github.io/kerros-web/`.
`GITHUB_PAGES=true` switches Vite's base to `/kerros-web/`, so scripts, styles,
icons, dynamic imports and the worker resolve
under the project path. Development and Tauri builds retain `/`. The Pages
verification command builds the actual release artifact; no second unverified
build replaces it before upload.

The site exposes the browser application and its static assets. Repository
visibility is a separate setting; publishing `dist/` does not require uploading
the source tree, docs, imported meshes or saved projects as site files. The
compiled JavaScript delivered to a browser is public. All geometry and file
processing remain local to that browser, using the existing file-input and
download branches. No backend, account system or remote project storage is added.
The workspace is in memory: save a `.kerros.json` before refreshing, and locate
external meshes and SVG files again when reopening it.

### The icon is source, not output

`assets/kerros-icon.png` is a 1024 px master, drawn by `tools/make-icon.py`.
`npx tauri icon` expands it into every size Tauri needs, including the `.icns`.
Keeping the generator in the repository rather than only the PNG means the icon can
be changed by editing the numbers that describe it, which is the same reason every
other piece of geometry in this program is a function rather than a file.

**Three colours, and exactly three**: the warm graphite of the application chrome,
the bone of the preview material, and the CUT red the DXF export uses. An earlier
version put an amber halo behind the red sheet to stand in for escaping light; at
32 pixels a third colour around the edge of the second one reads as blur rather
than as glow, and dropping it made the red layer *more* distinct, not less.

**Six layers, not nine.** Nine reads beautifully at 256 pixels and turns to mush at
32, and 32 is the size a dock icon is actually seen at — so the taper is stronger
than the real lamps have and the layer count is lower than any real stack. An icon
that has to work at small sizes can carry one idea; the idea here is the stack.

### Unsigned, and what that means

The bundle is not code-signed or notarised, which needs a paid Apple Developer
account. It runs on the machine that built it. Moved to another Mac it will be
quarantined, and the way past that is either a right-click Open or
`xattr -dr com.apple.quarantine` on the app — worth knowing before handing a build
to anyone, and worth solving properly if that ever becomes a habit.

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

**Marching cubes would not fix the rounded edges, and the note above is
wrong about that.** Both extractors place their vertices on cell *edges*, so a
sharp edge comes out chamfered by one and rounded by the other; neither can
produce a corner the grid does not contain. The only thing that does is putting
the vertex *inside* the cell, at the point that best fits the planes through its
crossings — dual contouring with a QEF. That fits behind the same
`GridLike -> SurfaceNetsResult` interface and needs no new imports, so the
architecture allows it whenever the prisms and cones start to mislead. Slicing
is unaffected either way: it samples the field directly and never reads this
mesh.

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
- `tools/validate-hole-punch.mjs` — exact circular cuts on one planned layer,
  kerf, unchanged neighbours, empty planes, twist, cut ordering and fit guards.
- `tools/validate-sdf.mjs` — primitives against analytic distances,
  operation identities (smooth ops with `k = 0` must equal their hard
  counterparts), the EMPTY sentinel, module registry integrity, rotation
  matrix orthonormality, the Rz·Ry·Rx composition that the gizmo depends on,
  feature picking, bit-identical re-evaluation, and blend padding. The prism
  and the cone additionally get a **unit-gradient check over thousands of
  points**, because a zero level in the right place is not the same as a
  distance field, and it is the gradient that blends and kerf depend on.
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

## Assembly expansion — **shipped** (0.29.0)

The approved scope remains in [KERROS-ASSEMBLY-PLAN.md](KERROS-ASSEMBLY-PLAN.md).
This first version supports upright ribs: free XYZ translation and rotation in
plan, without arbitrary tilt. Choose a source shape, then `Radial ribs` or
`Linear ribs` in the tree. Only one assembly layout can be active. Disabling it
restores the horizontal workflow. Existing horizontal fixtures, paint, punches
and patterns are listed as excluded while an upright assembly is enabled.

### Persistent parts and source profiles

`assembly:layout`, `assembly:rib`, `assembly:support`, `assembly:backplate` and
`assembly:channel`, plus `assembly:joint` since 0.31.0, are SLICE-stage feature records. Their params and group IDs
travel through the existing project format and worker transport. `assembly.ts`
and `assemblyFeatures.ts` have no value imports. `pipeline.ts` supplies the real
sheet tracer, indexed polygon distance and thin-feature checker.

Each rib keeps a source station separate from its assembly frame. Moving or
turning a rib changes its placement, not its unjointed outline. A source edit or
explicit source-station redistribution regenerates its profile. Radial profiles
sample the source shell band with adjustable depth and clear-centre radius;
the latter prevents upper and lower rib ends meeting on the central axis.
Linear profiles sample vertical YZ planes at recorded source X coordinates.

Ribs initially number 12 radial or 9 linear. Count edits retain the IDs, source
stations, placement offsets and angles of retained members. New radial ribs fill
the largest angular gap; new linear ribs extend the row. Count reduction removes
the last-created members and names them. Deleted IDs are not reused, including after save/open: the project stores the
allocation watermark. Explicit
channel targets and rib joints referring to deleted parts require correction. `Distribute
source stations evenly` is a separate, visible regeneration action. Ribs are
limited to 64 and horizontal supports to 12 per assembly to bound interactive
work. Switching `Selected` / `All follow` does not change any feature parameters;
turning with All follow applies an equal delta about each rib's own pivot.
Whole-layout rotation uses the common assembly pivot instead.

### Ring supports and wall mount

Radial assemblies start with two horizontal rings. Set each height, centre,
outer and inner diameter; inner diameter zero makes a disc. A usable overlap
produces complementary half slots: the support opens toward the rib's positive
U direction and the rib opens toward negative U. Hold the supports in place and
insert each rib along negative U. Missing or disconnected overlap regions,
collisions and blocked insertion paths name their parts. Different support
heights or diameters do not silently preserve obsolete joints.

Since 0.30.0, new linear assemblies start with `Open frame` as
the wall mount's Outline. The upper and lower rails follow the longest
continuous band of material at each rib's shoulder. Their centre heights sit
half a frame width plus `Profile inset` inside the sampled band ends. The rails
connect those stations in X order and close with rounded end rails, leaving an
open centre. The same heights place mating tabs. Moving a rib or editing its
source updates both the frame and its joints.

Since 0.30.2, `Minimal solid` (`outline: 'solid'`) uses the same outer offset
but fills the centre. The fill is applied before tab slots, mounting openings
and LED cuts, so functional holes remain open. It shares Frame width, Profile
inset, offsets, automatic mounting and fitted tabs with Open frame. Changing
Outline preserves those settings; selecting Open frame again restores its
centre opening. Minimal solid keeps the rib/contact and bridge checks but does
not require a centre opening. Manual mounting holes can use the filled centre.
Both profile-following outlines need at least two usable ribs spread wider than
Frame width. New assemblies still default to Open frame; missing Outline still
means Solid rectangle. This choice is carried by the project, worker, Part,
Assembly, Sheet, DXF, manifest and PDF through the existing shared cut contours.

Since 0.30.1, the inset is a preference on short ribs: it reduces locally until
two full-height tabs fit, keeping a minimum bridge plus sampling slack between
their clearance slots. If a pair cannot fit, one centred tab uses the requested
height. Upper and lower rails meet at that tab; they may merge locally while
the rest of the frame stays open. The checks name each adaptation. Tab height,
joint clearance and stock thickness are never reduced by this fitting step.
Previously the stricter two-tab spacing test dropped a short end rib from the
frame plan, leaving it unattached. A rib with no room even for one tab now stops
frame generation and names the reason instead of producing a partial frame.
Wall attachment checks count complete joints against every enabled rib ID,
including ribs with empty source planes. Any missing joint blocks export;
disabled ribs are excluded from the count. Single-tab assembly instructions
also appear in the manifest and PDF.

`Frame width` controls the band around that closed path; `Profile inset` moves
the rails inward. A frame needs at least two usable ribs and enough separation
for an open centre. Too little shoulder material, narrow rails, crossing slots
and a closed centre are named errors, not a fallback to a solid plate. X/Z
frame offsets move the outline while mating slots remain at the ribs; zero
offsets keep the outline aligned automatically. Front face Y still sets the
wall plane. Width and height controls and the Fit button are hidden for frames
because their dimensions are derived from the ribs.

Saved projects without an Outline retain the original `Solid rectangle`,
editable in width, height, position, margin, rounded corners and stock.
`Fit plate to current ribs` fits that rectangle around the assembled rib extents.
Switch Outline explicitly to adopt the frame. Each rib is trimmed to the
front face and gains glued tabs: two for rectangles, fitted pairs or a single
centred tab for frames. Tab height, rectangle tab spacing, protrusion,
wall offset, stock thickness, joint clearance per side and laser kerf are
separate values. Both full sheet thicknesses determine oblique slot envelopes;
a copied mating thickness would be wrong. Ribs must face away from the wall and
cross it at at least approximately 15 degrees (U dot front direction >= 0.25).
The shoulder clears the wall across the complete rib thickness; at an oblique
angle it contacts on an edge rather than requiring a bevel.

Screw holes or keyholes use explicit shank/head dimensions. A frame defaults to
`Follow upper rail` mounting: one opening on each side, trying positions between
tab slots near the quarter points. Dense rib rows can need a small pad toward
the centre opening. Pads preserve all earlier slots; no hole is silently filled
back in. Manual mounting uses explicit spacing and height and must fit the
existing frame. Rectangles retain their original manual placement.
Mount openings must clear edges and existing tab slots. A faint wall plane and
the manifest show the offset behind the plate; hardware and stand-off spacers
are not generated. Tabs protruding beyond the wall offset are refused. Use one
backplate. Ring supports and wall tabs cannot be combined because their straight
insertion paths differ. These are glued joints, with no mechanical lock or load
rating, and remain physically untested.

### Rib intersections — **shipped** (0.31.0)

Each current rib/rib collision in the inspector offers `Create cross joint`
and `Create clearance cut`, with a `Cut rib` selector for the latter. These
actions create an `assembly:joint` in the tree. A repeated action selects the
existing operation for that unordered pair, including a disabled one; it does
not silently switch its mode or create duplicates. The inspector edits Action,
the two rib references, slot direction, split and relief. `Inspect R…` opens
the selected rib in Part. Removing or disabling an operation restores the cuts;
missing/disabled rib references remain visible and block export. Operations
follow current placements and materials rather than storing stale cut outlines.

Cross joints need one continuous shared vertical band, a crossing angle with
absolute sine at least 0.25 (about 15 degrees), and real material around the
slot ends. One slot opens upward and the other downward. `Automatic` gives the
lower persistent rib ID the upward opening; either rib can be chosen explicitly.
`Joint split` is a percentage of the shared band, default 50. Both closed ends
extend by the shared joint clearance across that split. `Tip relief radius`
adds circles at the closed corners, default 0.5 mm; zero leaves square corners.
It must not exceed half the narrower slot width.

For stock thicknesses ta and tb at angle theta, the full slot width in A is
`(tb + 2 * clearance + abs(cos(theta)) * ta) / abs(sin(theta))`.
This clears the complete slab sweep rather than only the other mid-plane.
Cross-joint cuts are applied atomically to both ribs only when both remain
connected and clear existing wall tabs, support slots and earlier rib cuts by
the configured bridge threshold. Closely spaced crossings or a crossing near
an edge can therefore be refused, with the affected IDs and reason shown.

Clearance cut removes the other rib's full-thickness projection from `Cut rib`;
`Keep rib` retains its profile. It creates no rib-to-rib attachment. The cutter
samples the mating profile over the slab-clipped target thickness, with
Lipschitz slack covering gaps between samples. It can make a closed opening in
a larger rib around a shorter rib, or an edge opening if the part stays
connected. A disconnected result or damaged joint is refused without applying
the operation. All operations use rib profiles after wall/ring joints but
before any rib operations, so a preceding cut cannot silently shrink the next
cutter. LED channels run afterwards and respect the new protected joint zones.

Successful cross joints switch insertion planning to **ribs first, wall last**.
The solver searches straight disassembly upward, downward and along each rib's
positive U direction, removes a clear rib, and reverses that sequence for
assembly. The wall must separately clear the finished rib network when sliding
on from behind along assembly +Y. A cyclic or blocked sequence names the ribs
and blocks export. Directions refer to the assembly frame. These sweeps use
24–96 steps over the projected extents and the existing slab collision sampler;
they are resolution-dependent, not a continuous motion proof. Moving groups
together, tilting ribs and combining cross joints with horizontal rings are
not supported. With no successful cross joints, the existing negative-U
insertion workflow is preserved.

Joint instructions and the complete order appear in the manifest and assembly
PDF; actual cut contours feed Part, Assembly, nesting and DXF. Kerf is applied
only after the finished nominal profile is redistanced. Physical acceptance
still requires a coupon in the chosen stock; corner relief and geometric fit
do not establish strength or a load rating.

### LED channel and manufacturing meaning

Add `LED channel` from the assembly inspector. Its straight, flat-ended route is
expressed in assembly coordinates and follows whole-layout translation and
rotation. Position, yaw, elevation, cross-section roll and finite length are
editable. `Fit through targeted parts` derives the route endpoints from full
sheet extents. Tube diameter or strip/profile width, height and corner radius
are measured component inputs. Clearance per side adds twice the entered value
to the envelope dimensions; kerf is applied later to cut paths.

Since 0.29.1, selecting the channel in the tree or clicking its visible envelope
or centreline attaches its own gizmo in Assembly. `Move channel` and `Rotate
channel` in Straight route also open Assembly and choose the tool. The toolbar
and M/R shortcuts work too. Move exposes XYZ arrows; Rotate exposes all three
axes plus the screen/free rotation handles. Snap uses the shared 5 mm / 15 degree
increments. Rotation pivots about Route X/Y/Z, not the midpoint of automatically
fitted endpoints. Only the selected channel moves; rib All follow never applies.
The envelope previews the drag and a single atomic pose update on release
rebuilds the cut paths. Fitted endpoints can then adjust to the new direction.

The pipeline emits the route anchor in assembly and world coordinates alongside
the section basis. `channelFrame` supplies that basis to the cutting kernel;
`channelAngles` converts a rotated world basis back through the layout rotation
to yaw, elevation and roll. This preserves the complete section orientation,
including vertical directions and the reference-axis switch near the poles.
The gizmo detaches while results are stale or the selected channel is disabled.

Ribs are the default targets. Supports and the backplate are opt-in; an optional
ID list restricts the checked types. The inspector distinguishes disabled tools,
missing targets, invalid dimensions, missed parts, refused cuts and actual hit
counts. An excluded part that obstructs the component is named and remains
uncut. A closed channel needs access from at least one straight insertion end;
material obstructing both directions is reported.

The channel prism is intersected with each complete sheet slab and projected
into local 2D coordinates. This includes the sweep across the sheet thickness:
an oblique round bore is wider than the mid-plane ellipse. Round sections use
96 circumscribed segments (radius excess below 0.054% before contour tracing);
rounded rectangle corners use the same angular step. Finite caps ending inside
a sheet and near-parallel closed crossings are refused. `Edge-open notch`
explicitly extends the projected opening to a chosen local-sheet edge direction
(0 degrees right, 90 degrees up in Part). It is a laser through-cut, never a
blind face pocket. Openings that conflict with tabs, support joints or mounting
holes are refused. Disconnected finished parts are errors; thin remaining
bridges are warnings. An opening locates an LED component but does not design
its retention or establish its thermal or electrical suitability.

### Geometry checks and their limits

`traceSheet` reuses the existing marching-squares and RDP implementation in local
sheet coordinates. The source profile is traced at nominal iso zero. After all
joints and channels, the finished nominal 2D profile is indexed as an exact
in-plane distance near the boundary, then traced at +kerf/2. Thus a restricted
3D source field's oblique gradient cannot multiply the kerf. The legacy
`sliceModel` path is unchanged and an identity test covers disabled assemblies.

Final tracing uses the smaller of the requested sample spacing and a quarter
of the relevant sheet/bridge scale, with a longest-axis cap of 1400 samples.
There is no post-joint smoothing that could round tab corners away. Polygon
simplification is limited by both the requested tolerance and step/12.
Distance magnitude is clamped away from contours, preserving signs, as with
existing imported profiles. The bridge threshold includes the configured
minimum feature and twice the largest enabled stock kerf.

Collision checks sample a 3-by-3 family of slab-plane intersection lines, rather
than only the mid-planes. Without rib cross joints, straight rib insertion is
sampled from outside along negative U; rib-to-rib obstructions form a dependency
graph, and cycles are refused. Cross joints use the wall-last sequence described
above. These are resolution-dependent checks, not an exhaustive continuous
motion proof. The inspector and assembly document explicitly require a physical
dry-fit coupon. Narrow contacts between samples and material flex remain limits.

### UI, nesting and output

`Assembly` replaces the old Stack tab label. Upright assemblies additionally use
`Part` for the local 2D cut drawing. Click a 3D part to select it; Move/Rotate,
snapping and M/R shortcuts operate on its placement. The inspector provides
numeric controls and Selected/All follow angle scope. The component and larger
LED clearance envelope appear in the assembly preview. Source modelling tools
remain in a collapsible tree section, and small UI text has higher contrast.

Labels are persistent IDs: R3 means rib feature f3, S15 support f15, and so on.
The same labels and feature IDs appear in the inspector, Part, Sheet, DXF
engraving, manifest and paginated assembly PDF. The PDF includes all part frames,
material/kerf values, sheet references, joint instructions, channel routes and
checks, plus every final part outline at one common drawing scale. Shared stock
is inherited; optional per-part stock name/thickness/kerf creates a separate
nesting material. Equal stock settings share sheets. Horizontal spacer rings
are not generated for these assemblies.

Existing worker generation and project ownership checks cover the new feature
records. Stale calculations cannot be exported. Current assembly geometry errors
also block export; warning-only results remain inspectable/exportable. Ordinary
sheet collision and unplaced-part warnings keep their existing semantics.

### Validation and physical acceptance

`tools/validate-assembly.mjs` imports the actual kernel and pipeline: orthonormal
frames, thick-sheet oblique projections, unchanged source profiles after manual
placement, cross slots, mixed stock, glued tabs, mounting holes, tube and rounded
strip routes, roll, clearance versus kerf, finite ends, edge openings, joint
conflicts, missing targets, legacy identity and exact in-plane kerf.
`tools/validate-assembly-state.mjs` exercises the real store, linked angle deltas,
count reductions and retained IDs, save/open, material-separated nesting, DXF,
manifest/PDF and actual worker message handler. `tools/validate-wall-frame.mjs`
covers the open centre and single connected part, all mating tabs and mounting
holes, curved source profiles, individual rib movement, width and inset, keyholes,
mixed stock, oblique joints, kerf direction, LED coexistence and explicit refusal
cases. Short end and middle rib regressions check actual slot contours, unchanged
tab height, tab material through both backplate faces, a connected frame and
complete attachment coverage. Too-short and empty source profiles block export;
disabled ribs are excluded explicitly. Minimal solid checks compare the actual
outer contour and functional holes against Open frame, including a short rib,
rib movement and mixed stock; they also check reversible switching, kerf and
manual holes in the filled centre. The state/export validator carries Minimal
solid through save/open, nesting, DXF, manifest/PDF and the real worker.
The open sphere fixture uses 72.2% less backplate area than the rectangle;
this does not establish strength.
`tools/validate-rib-joints.mjs` covers multiple oblique crossings, unchanged wall
attachments, actual full-thickness fit and slot width, mixed stock, split,
opening directions, relief, kerf, reversible operations, a trapped three-rib
cycle and its repair, invalid/missing/duplicate references, near-parallel and
ring-support refusals, connected clearance cuts, unchanged mating ribs and LED
conflicts. The state/export validator also carries rib operations through real
store actions, save/open, dangling references, nesting, DXF, vector PDF
instructions and the worker. All four assembly validators are in `npm run verify`.
Channel gizmo checks cover quaternion roundtrips, vertical poles, section roll,
rotated layouts, a route anchor distinct from fitted midpoint, actual bore
centres after a pose edit, atomic state writes and save/open. They do not replace
a browser check that selecting and dragging the rendered handles is reachable.

Before a complete lamp, cut a small two-rib/two-ring coupon and a two-rib wall
coupon in the chosen stock. Use the actual LED tube/profile. Measure slot and
tab fit (including a short rib's single tab), test the documented insertion sequence, inspect bridges and confirm
wall clearance. The current software results are not physical acceptance.
