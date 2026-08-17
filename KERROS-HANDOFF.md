# KERROS — Project Handoff / Starting Notes (v0)

Read this first when starting Kerros development. It captures the agreed design,
the conventions inherited from the Muusia project, the pipeline, and the MVP
plan. Once a repo exists, the repo is the source of truth; this file is the map
and must be kept current (same doc-batch discipline as Muusia).

## What Kerros is

A standalone desktop application for designing **sliced lamps**: generate or
sculpt a 3D blob-like form, carve negative space into it, slice it along the
Z axis into sheets of real material (plexi, cardboard, plywood), and export
laser-ready DXF files. The physical result is a stack of laser-cut slices on
threaded rods, with optional spacers between layers so light escapes through
the gaps.

Kerros is a **separate program from Muusia** — different repo, different
architecture. No node graph: the UI paradigm is a **CAD-style feature tree**
(ordered list of operations, each editable, whole model re-evaluated
deterministically from the tree). The workspace is a true 3D world with
multiple views. It does not need to be a hosted web app; it runs as a local
desktop app.

Daniel (Helsinki, AV/video systems + hardware maker) is the developer. Working
language of dev sessions is **Finnish**; all code identifiers, GUI text, and
documentation are **English**. All randomness is **seeded** (deterministic
re-evaluation, same principle as Muusia).

## Locked design decisions

These were agreed in the planning session and are not open questions:

- **Platform**: web-stack desktop app — React + Vite + three.js. Start as a
  plain local Vite app for dev speed; wrap in **Tauri** once native file I/O
  matters (direct save of DXF/projects without the browser download dance —
  a known pain point from Muusia).
- **UI paradigm**: CAD feature tree, NOT a node graph.
- **Geometry core**: SDF (signed distance field) on a voxel grid is the
  working representation. Booleans are trivial (min/max/smooth-min), the
  model is watertight by construction, and slicing falls out of evaluating
  the field at a z-plane. Mesh preview via marching cubes.
- **Shape creation**: BOTH parametric (SDF primitives + blend/subtract
  groups) AND sculpt-style (brush strokes). Shape generators are a
  **module/plugin system** — new designs/generators must be addable later
  without touching the core.
- **Machine profile**: laser bed is configurable. First machine: **730 × 410
  mm** bed. The cutter may change; bed size, margin, and kerf live in
  profiles, never hardcoded.
- **Assembly system**: threaded rods **M3/M4/M5/M6/M8**, **6+ rods**
  supported (arbitrary count), each freely positioned in XY **and given a
  Z-span** — a rod does not have to pass through every slice; holes are
  added only to slices inside the rod's span.
- **Spacers between slices** are the primary mode (light escapes between
  layers); **tight stacking** (spacer = 0) must also work. Spacer rings are
  generated as laser-cut parts on the same sheets.
- **Lamp rig parts**: E27 socket mount, cable cavity/channel, and a chamber
  for Wago connectors. Rig parts are also extensible — more part types will
  be added later.
- **Wall patterns**: perforation/light patterns applied to the walls of the
  slices (see Pattern stage below).
- **Nesting**: slices are auto-laid-out onto bed-sized sheets, parts
  separated by a configurable gap, layer numbers engraved.
- **Export**: DXF R12, layers **CUT** and **ENGRAVE**, units mm — same
  convention as Daniel's existing laser workflow and parametric Python
  generators.
- **Name**: Kerros (Finnish for "layer/storey"). Sibling naming to
  Muusia (software) / Viivain (plotter).

## Pipeline (the feature tree top-to-bottom)

The feature tree is an ordered list. Re-evaluating the tree from top to
bottom always reproduces the same model (seeded, deterministic). Stages:

### 1. SHAPE
- SDF primitives: sphere, capsule, box (rounded), torus, superellipsoid,
  ellipsoid; each with transform + params.
- Combine ops: union, smooth union (blend radius), subtract, smooth
  subtract, intersect. Blob/metaball aesthetics come from smooth union.
- **Sculpt features**: a sculpt feature records a list of brush strokes;
  each stroke is a list of stamped capsules (position, radius, op:
  add/subtract/smooth). Strokes are replayed onto the SDF grid on
  re-evaluation. This keeps sculpting deterministic, undoable
  (stroke-level), and serializable in the project file.
- **Import feature**: STL/OBJ → SDF via distance queries against a BVH
  (three-mesh-bvh) with inside/outside from raycast parity or winding
  number. Import lands as one feature row; the rest of the tree operates
  on it like any other volume.
- Generators are modules: a generator module exports
  `{ key, name, params, evalSDF(p, params) }` (exact contract to be
  specced in KERROS-MODULE-API.md when the first external module is
  written). New designs = new module files.

### 2. CARVE
- Negative volumes: any SHAPE-stage construct in subtract mode (smooth
  subtract gives organic cavities).
- **Shell**: hollow the model with a wall-thickness parameter. Essential
  for a lamp (bulb sits in the cavity). Shell = `abs(d) - t/2` on the SDF,
  optionally only below a z-limit so the top can stay closed.

### 3. RIG (assembly features)
- **Rod**: metric size (M3–M8; clearance hole table 3.2/4.3/5.3/6.4/8.4 mm,
  overridable), XY position (draggable in the top view), Z-span
  [zStart, zEnd]. Adds a clearance hole to every slice whose mid-plane
  falls in the span. Unlimited count; 6+ is the design case.
- **Spacer generation**: per-rod ring parts (ID = rod clearance, OD
  parametric), one per gap in the rod's span, emitted as cut parts into
  the LAYOUT stage. Global default spacer height (= extra layer pitch),
  overridable per gap later (roadmap).
- **E27 mount**: parametric socket-mount feature applied to a designated
  slice: center hole for the socket's threaded tube (default M10 nipple
  hole 10.5 mm, or full socket-body hole ~40.5 mm — parametric, verify
  against the actual socket before first cut), optional screw holes.
- **Cable cavity**: vertical channel (capsule or rounded-rect cross
  section) subtracted through a chosen z-range — becomes a hole in each
  affected slice.
- **Wago chamber**: box cavity across a chosen span of slices (a pocket
  in the stack), with a defined access direction.
- Rig parts are modules too — same extensibility contract as generators.

### 4. SLICE
- Layer pitch = material thickness + spacer height. Slice k's mid-plane
  z_k = z0 + k·pitch + thickness/2. MVP samples the SDF at the mid-plane;
  roadmap: top/bottom-plane intersection or min/max union per layer for
  stepped-accuracy on steep walls.
- SDF plane sample → marching squares → contours (outer boundaries +
  holes, orientation by signed area) → RDP simplify + Chaikin smooth →
  polygon set per slice.
- **Kerf compensation**: outer contours offset outward by kerf/2, holes
  offset inward by kerf/2 (Clipper-style polygon offsetting). Kerf comes
  from the material profile.
- Slice inspector view: step through layers in 2D, see contours, holes,
  rod holes, patterns.

### 5. PATTERN (wall perforation)
- Applied per-slice in 2D, NOT as 3D volume subtraction (manufacturability
  first): the pattern region is the wall band between the outer contour and
  the inner (shell) contour, inset by a margin. Pattern generators (seeded):
  hole grids, seeded scatter, stripes, voronoi cells, ring segments.
- **Min bridge width** parameter guarantees the slice stays in one piece
  and survives cutting/handling — every pattern generator must respect it.
- Pattern generators are modules (same plugin contract).
- 3D volumetric patterns (carved through multiple layers) go to roadmap.

### 6. LAYOUT (nesting)
- Sheets = machine bed minus margin. MVP nesting: bounding-box shelf
  packing with a configurable part gap ("palat irti toisistaan" on the
  sheet). True-shape nesting is roadmap.
- Every part carries its layer number engraved (simple stroke font — the
  Muusia SFONT approach can be ported) + optional orientation tick so
  asymmetric slices can't be assembled rotated.
- Spacer rings and rig plates flow into the same nesting pool.
- Multi-sheet output when parts don't fit one sheet.

### 7. EXPORT
- DXF R12 per sheet: POLYLINE/VERTEX entities (LWPOLYLINE is R13+ — do not
  use it in R12 output), layers CUT and ENGRAVE, units mm. Writer is a
  small in-house module; Daniel's existing Python DXF R12 generators are
  the reference for what the target laser accepts.
- Assembly aid: exploded-stack render + a per-layer manifest (layer number,
  z, sheet, rods passing through).
- Project save/load: `.kerros.json` — machine + material profiles snapshot,
  full feature tree including sculpt strokes, seeds, app version.

## Views

- **Perspective orbit** (main modeling view; sculpting happens here).
- **Orthographic top/front/side** (rod placement primarily in top view).
- **Slice inspector**: 2D, one layer at a time with prev/next.
- **Exploded stack**: 3D preview of the physical result with real layer
  pitch (thickness + spacers), per-layer visibility. Spiritual sibling of
  Muusia's Stack View, but true 3D geometry.
- Roadmap: "lamp preview" with an emissive light source in the cavity.

## Profiles

- **Machine profile**: name, bed W×H mm (default 730×410), sheet margin.
- **Material profile**: name, thickness mm, kerf mm, notes (power/speed
  are the laser's business, but a free-text note field helps). Kerf values
  are calibrated with a test figure (small square + circle + slot ladder)
  cut per material — a built-in "kerf test" export is an early feature.

## Tech stack (pinned intentions)

- React + Vite, three.js for all 3D. TypeScript from day one (geometry
  code with plain JS was a recurring bug source in Muusia).
- SDF voxel grid in a Float32Array; two resolutions: coarse while editing
  (fast marching cubes preview), fine for slicing. Marching cubes and
  marching squares implemented in-house (small, and full control over
  determinism) or from a vetted small dependency.
- three-mesh-bvh for STL import distance/inside queries.
- Polygon offsetting (kerf) via a Clipper port (js-angusj-clipper WASM or
  clipper-lib) — plain polygon-clipping libs don't do offsets.
- Web Worker for slicing + nesting so the viewport never freezes.
- Tauri wrap when file I/O pain justifies it; before that, plain Vite dev
  server locally is fine ("does not need to run in a browser" means no
  hosted-web constraint, not a ban on web tech).

## Conventions inherited from Muusia (binding)

- Finnish sessions; English code, GUI, docs.
- All randomness seeded; a project file must re-evaluate to identical
  geometry. `mulberry32`-style PRNG.
- Every geometry module gets a Node.js validator
  (`tools/validate-<name>.mjs`) run before it ships; validators import the
  REAL shared helpers, never stubs (harness drift caused silent
  lab-pass/ship-fail bugs in Muusia repeatedly).
- Docs batch immediately after every push, never deferred: this handoff +
  a KERROS-FEATURES.md (feature/module catalog, the NODES.md equivalent).
- Version constant in one place; verify with grep after every bump; never
  assume repo state from conversation memory — parallel sessions move the
  repo.
- Command blocks delivered copy-paste-ready, zsh-safe, expected output
  stated, no `#` comments in interactive commands. Downloaded files are
  moved into place by the command block itself (newest-file `find | ls -t
  | head -1` pattern) — until Tauri removes the download dance entirely.
- Design before code: plan the feature completely, then implement.

## MVP milestones (order negotiable, scope not)

- **M0** — Repo scaffold: Vite + React + TS + three.js; orbit + ortho
  views; machine/material profile UI; empty feature tree panel.
- **M1** — SDF core: primitives, smooth ops, voxel grid, marching-cubes
  preview, feature tree CRUD with re-evaluation.
- **M2** — Slicing: pitch from material + spacer, marching squares →
  contours, slice inspector, exploded stack view.
- **M3** — Rods with Z-span + clearance holes; DXF R12 export of one
  sheet (CUT layer); kerf offset; kerf test figure export.
- **M4** — Nesting (shelf packing, part gap), multi-sheet, layer-number
  ENGRAVE, spacer ring generation.
- **M5** — Shell + carve (smooth subtract volumes).
- **M6** — Sculpt brushes (add/subtract/smooth strokes on the grid).
- **M7** — Wall patterns (module API, 2–3 built-in generators, min bridge
  width).
- **M8** — Rig parts: E27 mount, cable cavity, Wago chamber.
- **M9** — STL/OBJ import.
- **M10** — Tauri wrap: native open/save, direct DXF write to disk.

After M4 the program already produces a buildable lamp (blob + shell via
primitives, rods, spacers, cut files) — everything later is expressive
power.

## Known risks / things to watch

- Marching-squares contours at coarse XY resolution produce wobbly edges:
  budget for RDP + Chaikin from the start, and slice at a finer grid than
  the preview.
- Kerf offset can self-intersect on thin features — Clipper handles it,
  but slices with walls thinner than ~2× kerf must be flagged in the slice
  inspector, not silently exported.
- Sculpt determinism depends on grid resolution being part of the recorded
  stroke context — replaying strokes on a different grid resolution gives
  different geometry. Store the sculpt grid resolution in the feature.
- E27 socket dimensions vary by socket model — the mount feature is
  parametric and the defaults must be verified against the physical socket
  before the first cut.
- Wall patterns + kerf + min bridge width interact: enforce the bridge
  check AFTER kerf offsetting.
- No error boundary = one throw whites out a React app (hard-learned in
  Muusia). Kerros gets an error boundary around the viewport and the
  feature tree from M0.

## Roadmap (post-MVP ideas)

True-shape nesting · per-gap spacer heights · 3D volumetric patterns ·
lamp light preview (emissive render) · cross-slicing / eggcrate mode
(X+Y interlocking) · SVG export alongside DXF · module marketplace-style
folder for user generators · assembly PDF with per-layer diagrams ·
material usage/cost estimate · registration notches for glue-stack mode.
