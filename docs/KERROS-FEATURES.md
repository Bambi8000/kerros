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
| `superellipsoid` | Superellipsoid | `rx` `ry` `rz` `e` (exponent; 2 is an ellipsoid, higher squares it off) |

Accuracy notes, because they matter downstream:

- `sphere`, `roundBox`, `capsule`, `torus` are exact Euclidean distance
  fields. Blend radii mean exactly what they say.
- `ellipsoid` uses the standard bounded approximation: accurate near the
  surface, conservative further out.
- `superellipsoid` is a p-norm, **not** a Euclidean distance. The field is
  compressed away from the surface, so blends against it come out slightly
  tighter than the blend radius suggests. Fine for shaping, documented so it
  is not debugged twice.

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

## CARVE — planned (M5)

Shell and subtract volumes. Subtract already works as an operation on any
shape feature; CARVE adds the shell (`abs(d) - t/2`) as its own feature.

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

## PATTERN — planned (M7)

## LAYOUT — planned (M4)

## EXPORT — **shipped in part** (M3)

`src/core/dxf.ts`. One layer per file now; nesting several layers onto a
bed-sized sheet is M4.

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
