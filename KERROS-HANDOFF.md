# KERROS — Project Handoff

Read this first when picking up Kerros development. It is the **map**: what the
program is, how it is built, which of the original plan's decisions were
overturned and why, and what is left. `docs/KERROS-FEATURES.md` is the
**territory** — the module-by-module catalogue, kept current in the same batch as
the code it describes. When the two disagree, FEATURES is right and this file is
stale.

**State at the time of writing: version 0.12.1.** The MVP as originally scoped is
complete, plus two feature families that were not in the plan at all. Kerros has
cut real lamps.

## What Kerros is

A desktop application for designing **sliced lamps**. Build a blob-like form,
hollow it, carve it, slice it along Z into sheets of real material, and export
laser-ready DXF. The physical result is a stack of cut slices on threaded rods
with spacers between them so light escapes through the gaps.

Daniel (Helsinki, AV/video systems and hardware maker) is the developer. Working
language of dev sessions is **Finnish**; all code identifiers, GUI text and
documentation are **English**. All randomness is seeded.

The UI paradigm is a **CAD-style feature tree**, not a node graph: an ordered
list of operations, each editable, the whole model re-evaluated deterministically
from the tree.

## The one architectural idea

**The model is a signed distance field evaluated analytically, point by point.**
Not a voxel grid that gets edited — a function composed from the feature tree,
sampled on demand at whatever resolution the caller needs.

Almost every good outcome in this project follows from that, and so does almost
every performance problem:

- **Booleans are arithmetic.** `min`, `max`, and their smooth variants.
- **Kerf compensation is one number.** Take the contour at iso-level `+kerf/2`
  instead of 0 and outer boundaries grow while holes shrink, because the field's
  sign already knows which side the material is on. This is why Kerros needs no
  polygon offsetting library, which the original plan required.
- **Nothing has a resolution.** Sculpt strokes, imports aside, give the same
  surface whether the preview samples at 32 or the slicer at 300. The plan
  expected to have to record grid resolutions in features to keep replays stable;
  there is nothing to record.
- **Slicing is sampling a plane.** No mesh intersection.
- **The cost is per-sample work.** Every feature that cannot be rejected cheaply
  is walked at every sample, which is why sculpt strokes and mesh imports both
  needed spatial indices, and why the second attempt at each index was the one
  that worked.

## Where the plan was wrong

These are the decisions the original handoff got backwards. Each cost real
debugging, and each is documented at length in FEATURES. Do not quietly revert
them.

| Plan | What shipped | Why |
| --- | --- | --- |
| Clipper/WASM for kerf offsetting | iso-level shift | the field does it exactly, with no self-intersection to clean up |
| Marching cubes for preview | surface nets | no 256×16 table to mistype; rounder edges, which only affect preview |
| RDP simplify, then Chaikin smooth | **Chaikin, then RDP** | simplify-first collapses a 90° corner to one vertex, and Chaikin then eats 15% of a square |
| one spacer ring per gap | `round(spacer / thickness)` rings | a ring is one sheet thick; 6 mm from 3 mm plexi is two rings |
| three-mesh-bvh for imports | own broad phase | it is a three.js dependency, and the validators load the field in Node with no three |
| bake sculpt strokes to the grid, record the resolution | evaluate strokes analytically | removes the drift instead of managing it |
| shell as `abs(d) - t/2` | `max(d, -(d + t))` | the abs form quietly shrinks the silhouette by half a wall |
| pattern region by offsetting contours | in-plane distance to the slice's own rings | the 3D field under-reports depth near a curved top and empties the middle of a solid slice |

## The recurring failure mode

**Silence read as a bug, four times.** Spacers with no rods. A perforation with
no room. A gizmo writing parameters nothing read. An import with no gizmo at all.
Every time the program did the correct thing and said nothing, and every time it
was reported as broken.

The rule that came out of it, and which is now honoured throughout: **a check
that refuses to do something is obliged to say what it refused and why.** Counts
of what was placed, what did not fit, and what it would have needed.

## The other recurring one

**Things that do not follow the form when the form moves**, three times: windows,
sculpt strokes, imports. A shell follows for free because it acts on the
accumulated field. Anything that is its own volume needs either a position of its
own or a frame to live in.

The general answer is **attachment**: geometry stored in a parent's coordinates,
with the query point transformed into that frame at evaluation. Sculpt strokes
and windows use it. Fixtures still do not — they are the last thing that stays
behind, and if you find yourself dragging a socket hole after a moved shape, that
is the fix, not a new feature.

## Module map

Core modules with **no value imports** are loaded directly by Node validators as
the real thing, never stubs. That constraint is load-bearing: keep it.

```
src/core/
  sdf.ts          the field: primitives, ops, modifiers, sculpt strokes,
                  import steps, frames, grid evaluation          [no imports]
  slice.ts        marching squares, simplify, smooth, grouping,
                  kerf iso-level, thin-feature and fit checks    [no imports]
  surfaceNets.ts  isosurface extraction for the preview mesh     [no imports]
  window.ts       angular sector wedges, per-layer rolls         [no imports]
  fixture.ts      E27 mount, cable channel, Wago chamber         [no imports]
  pattern.ts      perforation generators, EdgeIndex              [no imports]
  rig.ts          rod clearances, spans, spacer ring planning    [no imports]
  nest.ts         shelf packing, placement, collision, rotation  [no imports]
  font.ts         stroke font for engraved labels                [no imports]
  dxf.ts          DXF R12 writer, kerf test figure               [no imports]
  project.ts      .kerros.json read and write                    [no imports]
  meshImport.ts   STL binary/ASCII and OBJ parsing               [no imports]
  voxelise.ts     triangle soup to signed grid                   [no imports]
  types.ts        Feature, stages, layer pitch
  profiles.ts     machine and material defaults
  mesh.ts         surface nets output to three.js geometry
  job.ts          composition: parts, sheets, manifest           (imports freely)
  store.ts        zustand state and all feature actions          (imports freely)
```

`job.ts` and `store.ts` are the wiring layers and the only ones that import
across the others. `job.ts` is deliberately thin; every algorithm it calls is
validated on its own.

## Conventions, binding

- **Z up, 1 unit = 1 mm.** three.js defaults to Y-up, so every camera sets `up`
  explicitly. Rotations use R = Rz·Ry·Rx, which is three.js Euler order `ZYX` —
  pinned by a validator, because the gizmo and the field must agree or a rotated
  part jumps the moment its value round-trips.
- **Layer pitch is derived in one place**, `layerPitch()` in `types.ts`. Nothing
  else computes it.
- **Bed size and kerf come from profiles**, never hardcoded in geometry code.
- **All randomness seeded**, and seeded so that adjusting a setting does not
  reroll a choice. Per-layer window rolls key on the layer number; scatter keys
  on part index; changing a count must not change which layers were chosen.
- **Every geometry module gets a validator** in `tools/validate-<name>.mjs`,
  importing the real module. Twelve of them, run by `npm run check`.
- **Version lives in one place.** `src/version.ts` and `package.json` must agree;
  `tauri.conf.json` reads `"../package.json"` by reference so there is no third
  copy. `check-version.mjs` asserts the reference is still there.
- **Docs batch immediately after every push**, never deferred: this file plus
  `docs/KERROS-FEATURES.md`.
- **Command blocks copy-paste ready**, zsh-safe, expected output stated, no `#`
  comments in interactive commands.
- **Design before code**: plan the feature completely, then implement.
- **No error boundary means one throw whites out the app.** There are four,
  around the app, the viewport, the feature tree and the right-hand panel.

## Pipeline as built

Feature tree stages evaluate in order. A shell or a window applies where it sits,
so sculpting a spout and then shelling hollows the spout too.

1. **SHAPE** — six SDF primitives (sphere, rounded box, capsule, torus,
   ellipsoid, superellipsoid) with six combine ops; sculpt strokes; mesh
   imports. No scale parameter on primitives, deliberately; imports carry a
   **uniform** scale, which preserves the field.
2. **CARVE** — shell with optional solid caps; windows, which subtract a wedge
   and emit the removed piece as a part in another material.
3. **RIG** — rods with Z-span and clearance holes, spacer rings, and the lamp
   fixtures.
4. **SLICE** — mid-plane sampling, marching squares, Chaikin then RDP, kerf at
   the iso-level, thin-feature check.
5. **PATTERN** — perforation per slice, four generators, one bridge-width test
   they all funnel through.
6. **LAYOUT** — shelf nesting per material, stroke-font layer numbers engraved,
   manual placement with pinning and rotation, true-shape collision reporting.
7. **EXPORT** — DXF R12 per sheet, build manifest, kerf test figure, project
   file. Native save dialogs through Tauri; the browser download path still
   works.

Four workspace modes: **Model** (preview, direct manipulation, sculpting),
**Slice** (one layer in 2D, fixed scale), **Stack** (exploded at real pitch),
**Sheet** (nesting on the bed).

## Known limits

- **WKWebView is 1.5–2× slower than Chrome** at the numeric work, and the native
  shell uses it. `npm run dev` in a browser is still the faster way to develop.
- **Slicing and import baking are synchronous** and freeze the UI for up to a
  second or two. The Web Worker has been promised since M2 and is the only real
  fix. This is the largest outstanding piece of work.
- **An import's field is exact only to `reach × scale`** from the surface,
  clamped beyond. A shell thicker than that puts its cavity on the clamp. The
  inspector warns; raising the resolution or the scale fixes it.
- **Project files record an import's path, not its geometry.** A grid is
  megabytes and the project file is meant to stay readable, so imports must be
  located again after opening.
- **Nesting is bounding-box shelf packing** and does not rotate parts. True-shape
  nesting would let a small part sit inside a large ring's waste; manual
  placement covers that case by hand today.
- **Fixtures do not follow a moved shape** — see attachment, above.

## Candidates, in the order I would take them

1. **Web Worker for slicing and baking.** Fixes the only complaint that is about
   the program rather than a feature it lacks.
2. **`npm run tauri build`** and a first `.app`, with an icon that is not the
   Tauri default.
3. **Attachment for fixtures**, the last thing that stays behind.
4. Roadmap, unranked: true-shape nesting, per-gap spacer heights, polygon-shaped
   perforation, a lamp preview with an emissive source in the cavity,
   cross-slicing / eggcrate mode, SVG export, a folder of user generator modules,
   an assembly PDF, material usage and cost, registration notches for glue-stack
   mode.

## Practical notes from cutting actual lamps

- **Cut the kerf test into the real material before anything else**, and measure
  the outer square and inner square separately. If they disagree the beam is not
  perpendicular and no single kerf value will save the fit.
- **Plexi needs its own kerf**, and it is usually much smaller than cardboard's.
  Window fit depends on both directly.
- **Corrugated board's flutes show in the cut edge.** Turning parts against the
  grain is what makes a stack look alive rather than like twelve identical
  lines — hence part rotation, seeded scatter, and the flute preview.
- **Start with a wider bridge than seems necessary** in corrugated stock: 2 mm
  rather than 1.5. The vertical flute between the liners does not carry like
  solid material.
- **A socket mount needs a solid layer**, not a ring. Make one with the shell's
  solid cap and aim the fixture's band at it.
