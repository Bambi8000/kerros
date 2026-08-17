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

Keys: `G` move, `R` rotate, `Esc` deselect. Snapping is 5 mm and 15°. The
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

## RIG — planned (M3, M4, M8)

Rods with Z-span and clearance holes, spacer rings, E27 mount, cable cavity,
Wago chamber.

## SLICE — planned (M2)

Mid-plane sampling, marching squares, RDP simplify, Chaikin smooth. Kerf
offsetting in M3.

## PATTERN — planned (M7)

## LAYOUT — planned (M4)

## EXPORT — planned (M3)

DXF R12 writer, POLYLINE/VERTEX only — LWPOLYLINE is R13+ and the target
laser will not take it. Layers CUT and ENGRAVE.

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
