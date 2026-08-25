# KERROS — Project Handoff

Read this first when picking up Kerros development. It is the **map**: what the
program is, how it is built, which of the original plan's decisions were
overturned and why, what is left, and how these sessions run.
`docs/KERROS-FEATURES.md` is the **territory** — the module-by-module catalogue,
kept current in the same batch as the code it describes. When the two disagree,
FEATURES is right and this file is stale.

**State at the time of writing: version 0.19.0.** The MVP as originally scoped is
complete, plus five feature families that were not in the plan at all. Kerros has
cut real lamps.

## What Kerros is

A desktop application for designing **sliced lamps**. Build a blob-like form,
hollow it, carve it, slice it along Z into sheets of real material, nest the parts
on the laser bed, and export laser-ready DXF. The physical result is a stack of
cut slices on threaded rods with spacers between them so light escapes through the
gaps.

Daniel (Helsinki, AV/video systems and hardware maker) is the developer. Working
language of dev sessions is **Finnish**; all code identifiers, GUI text and
documentation are **English**. All randomness is seeded.

The UI paradigm is a **CAD-style feature tree**, not a node graph: an ordered list
of operations, each editable, the whole model re-evaluated deterministically from
the tree.

- Repo: `github.com/Bambi8000/kerros`, local at `/Users/daniel/kerros`
- React + TypeScript + three.js + zustand, Vite, Tauri 2 native shell
- Z up, 1 unit = 1 mm, dev server pinned to port 5180, Node 25.8.2

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
- **Nothing has a resolution**, imports aside. Sculpt strokes give the same
  surface whether the preview samples at 32 or the slicer at 300.
- **Slicing is sampling a plane.** No mesh intersection.
- **The cost is per-sample work.** Every feature that cannot be rejected cheaply
  is walked at every sample, which is why sculpt strokes and mesh imports both
  needed spatial indices, and why the second attempt at each index was the one
  that worked.

## Where the plan was wrong

Decisions the original handoff got backwards, or that later work overturned. Each
cost real debugging, and each is documented at length in FEATURES. **Do not
quietly revert them.**

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
| no-fit polygons for true-shape nesting | raster occupancy | NFP's failure modes are subtly wrong polygons that look plausible until cut; a raster is coarse in a way that is measurable and always conservative |
| no scale parameter, ever | **uniform** scale on imports | uniform scaling preserves the distance property; a mesh arrives at whatever size the exporter left it |
| `npx tsc --noEmit` as the type check | `npm run verify` | the root tsconfig is a solution file with `"files": []`, so `--noEmit` against it checks **nothing** and exits happily |
| marching cubes if the preview's edges start to mislead | dual contouring, if anything | both put vertices on cell edges, so MC chamfers what surface nets rounds; only a vertex placed *inside* the cell gives a corner the grid does not contain |
| teach Chaikin to keep sharp corners | leave Chaikin alone | measured: it does not round corners at slicing resolution once the order is right, and keeping them lands the corner *further* from true |
| layer pitch derived in one place, `layerPitch()` | the **layer plan** built in one place, `planLayers()` | `layerPitch` was never called, once, anywhere, while `store.ts` computed the same sum inline — a rule written and never wired to anything. And with gaps that vary there is no single pitch to derive |
| spacer rings cut from the stock | rings are their own material | 0.5 mm steel wants 372 rings per rod from 0.5 mm rings and 62 from 3 mm ones; and once they differ they cannot share a sheet |
| a claim in a comment is documentation | a claim in a comment is a guess | `parseProject`'s backwards-compatibility promise was a comment until a broken round-trip test forced it to be proved |
| four ways to say which layers, one per feature | one `LayerSelector`, resolved in the pipeline | the same shape as the attachment problem; four modules that may not import one another would each have needed a copy of the *logic*, which drifts |
| dispatch a panel on a feature's stage | dispatch on its kind | `stage === 'RIG'` caught fixtures three lines before the fixture branch, and `FixtureInspector` was unreachable from the day it was written |

## The recurring failure mode

**Silence read as a bug, five times.** Spacers with no rods. A perforation with no
room. A gizmo writing parameters nothing read. An import with no gizmo at all. A
type check that checked nothing.

The rule that came out of it, and which is now honoured throughout: **a check that
refuses to do something is obliged to say what it refused and why.** Counts of what
was placed, what did not fit, and what it would have needed.

A seventh, which is the same disease wearing the opposite coat: the gradient
panel's "both gaps the same" was **said confidently and wrongly**. 3 mm and 4 mm
are both one 3 mm ring, so the result was right and the reason was nonsense, and
the warning written for exactly that case sat in a branch that could not open.
Silence is one failure; a fluent wrong sentence is worse, because it stops the
person looking.

There is a sixth, kept separate because the cure is the same but the disease is
not. `partPlacements` was a dependency of the memo that packed the sheets, so
every drag of a part re-nested the whole job — half a second with true shape on,
and the layout redrawn underneath the hand doing the dragging. **Not silence
about what was refused, but silence about work nobody asked for.** The general
form is worth having: an expensive derived value should be recomputed only by
the things it actually depends on, and a hand placement does not depend on the
packing — it comes after it.

## The third recurring one: written, never wired

Three in a single session, and they look nothing alike until they are put next
to each other.

- **`layerPitch()`** was named in this file as a binding rule — pitch derived in
  one place, nothing else allowed to compute it. Nothing called it, while
  `store.ts` computed the same sum inline.
- **`parseProject`'s compatibility promise** was a comment saying an older file
  opens as exactly the lamp it was. Nothing checked it until an unrelated test
  broke and forced the question.
- **`FixtureInspector`** was a whole panel, described at length in FEATURES,
  that could not be reached because the dispatch matched a stage instead of a
  kind.

The rule that comes out of it: **a green `npm run verify` says the code compiles
and the algorithms are right. It says nothing about whether anybody can reach
them.** Fourteen validators were green through all three. The cures are cheap
and different in each case — call the function, test the claim, click the thing
— and the habit is to ask, of anything newly written, *what would fail if this
were never run?*

## The other recurring one, now closed

**Things that do not follow the form when the form moves**, four times: windows,
sculpt strokes, imports, fixtures. A shell follows for free because it acts on the
accumulated field. Anything that is its own volume needs a frame to live in.

The general answer is **attachment**: geometry stored in a parent's coordinates,
with the query point transformed into that frame at evaluation. All four now use
it, and shapes use it too, which is what grouping is.

Two flavours, and the difference is load-bearing:

- **Shapes and sculpt strokes inherit the whole transform.** They are volumes;
  tipping over is a move they can make.
- **Windows and fixtures inherit translation and Z rotation only.** They live in
  horizontal sheets. A socket hole inheriting an X rotation would tip out of the
  sheet it is drilled in, and there is nowhere for it to go. A validator asserts
  that X and Y rotation are *not* inherited — the unusual case of a test that
  exists to pin down what deliberately does not happen.

## Module map

Core modules with **no value imports** are loaded directly by Node validators as
the real thing, never stubs. That constraint is load-bearing: keep it.

```
src/core/
  sdf.ts          the field: primitives, ops, modifiers, sculpt strokes,
                  import steps, frames, rigid algebra, grid eval   [no imports]
  slice.ts        marching squares, simplify, smooth, grouping,
                  kerf iso-level, thin-feature and fit checks      [no imports]
  surfaceNets.ts  isosurface extraction for the preview mesh       [no imports]
  window.ts       angular sector wedges, per-layer rolls, frames   [no imports]
  fixture.ts      E27 mount, cable channel, Wago chamber, frames   [no imports]
  pattern.ts      perforation generators, EdgeIndex                [no imports]
  rig.ts          rod clearances, spans, spacer ring planning      [no imports]
  layers.ts       which layers a per-slice feature applies to     [no imports]
  nest.ts         shelf packing, raster true-shape packing,
                  placement, collision, rotation, labels           [no imports]
  font.ts         stroke font for engraved labels                  [no imports]
  dxf.ts          DXF R12 writer, kerf test figure                 [no imports]
  project.ts      .kerros.json read and write                      [no imports]
  meshImport.ts   STL binary/ASCII and OBJ parsing                 [no imports]
  voxelise.ts     triangle soup to signed grid                     [no imports]
  types.ts        Feature, SculptStroke, stages, layer pitch
  profiles.ts     machine and material defaults
  mesh.ts         surface nets output to three.js geometry
  pipeline.ts     the whole slice and preview path, pure           (.ts imports)
  job.ts          composition: parts, sheets, manifest             (imports freely)
  store.ts        zustand state and all feature actions            (imports freely)

src/ui/
  kerros.worker.ts  thin shell around the pipeline
  workerBridge.ts   owns the one worker, the import cache, the fallback
  useSlices.ts      slicing, 250 ms debounce
  usePreview.ts     preview surface, 90 ms debounce
  useSheets.ts      nesting, 120 ms debounce; hand placement and the
                    collision check stay on this thread, deliberately
```

`pipeline.ts` names its imports with **explicit `.ts` extensions**. That is what
lets Node load it, and therefore validate the whole slicing path in one call
rather than one algorithm at a time. It deliberately does not import `store.ts`,
which imports zustand, which Node cannot resolve — the helpers it needs were moved
out of the store for exactly this reason and are re-exported from there.

## Conventions, binding

- **Z up, 1 unit = 1 mm.** three.js defaults to Y-up, so every camera sets `up`
  explicitly. Rotations use R = Rz·Ry·Rx, three.js Euler order `ZYX` — pinned by a
  validator, because the gizmo and the field must agree or a rotated part jumps the
  moment its value round-trips. `eulerFromMatrix` is its exact inverse, also
  pinned, because grouping depends on the round trip.
- **`npm run verify`, never `npx tsc --noEmit`.** See the table above. `verify` is
  the thirteen validators plus a real type check.
- **Layer pitch is derived in one place**, `layerPitch()` in `types.ts`.
- **Bed size and kerf come from profiles**, never hardcoded in geometry code.
- **All randomness seeded**, and seeded so that adjusting a setting does not reroll
  a choice. Per-layer window rolls key on the layer number; scatter keys on part
  index; changing a count must not change which layers were chosen.
- **Every geometry module gets a validator** in `tools/validate-<name>.mjs`,
  importing the real module. Thirteen checks, run by `npm run check`.
- **Version lives in one place.** `src/version.ts` and `package.json` must agree;
  `tauri.conf.json` reads `"../package.json"` by reference. `check-version.mjs`
  asserts the reference is still there.
- **Import grids live outside the store**, in a module-level map, because a grid is
  megabytes of Float32 and has no business in state that gets compared on every
  render. `importRevision` is what tells the memos to recompute.
- **The layer plan is built in one place**, `planLayers()` in `slice.ts`. This
  replaces the old rule about `layerPitch()`, which named a function nobody
  called. `pitchAt()` answers "which pitch, where" for the one caller that wants
  a local number.
- **Gaps are whole rings of the spacer material**, and the plan is built on the
  gap that can be made, never the one that was asked for. A program that plans a
  lamp it cannot build is worse than one that rounds and says so.
- **A worker returns decisions, not geometry.** Slicing and the preview are handed
  the tree, because a field is closures and closures do not cross a boundary.
  Nesting is handed parts and returns a placement table, because neither packer
  touches geometry — and a reply that carried it back would invite one to.
- **Docs batch immediately after every push**, never deferred: this file plus
  `docs/KERROS-FEATURES.md`.
- **Command blocks copy-paste ready**, zsh-safe, expected output stated, no `#`
  comments in interactive commands.
- **Design before code**: plan the feature completely, then implement.
- **No error boundary means one throw whites out the app.** There are four, around
  the app, the viewport, the feature tree and the right-hand panel.

## Pipeline as built

Feature tree stages evaluate in order. A shell or a window applies where it sits,
so sculpting a spout and then shelling hollows the spout too.

1. **SHAPE** — eight SDF primitives with six combine ops; sculpt strokes; mesh
   imports. `roundBox` at `r = 0` is an exact box; `prism` and `cone` cover the
   angular forms it cannot. No scale on primitives, deliberately; imports carry a uniform one.
   Shapes can be grouped under other shapes.
2. **CARVE** — shell with optional solid caps; windows, which subtract a wedge and
   emit the removed piece as a part in another material.
3. **RIG** — rods with Z-span and clearance holes, spacer rings, and the lamp
   fixtures.
4. **SLICE** — mid-plane sampling, marching squares, Chaikin then RDP, kerf at the
   iso-level, thin-feature check.
5. **PATTERN** — perforation per slice, four generators, one bridge test.
6. **LAYOUT** — nesting per material in the worker, either bounding-box shelves
   or raster true-shape; stroke-font layer numbers engraved; manual placement with pinning
   and rotation; true-shape collision reporting.
7. **EXPORT** — DXF R12 per sheet, build manifest, kerf test figure, project file.
   Native save dialogs through Tauri; the browser download path still works.

Four workspace modes: **Model** (preview, direct manipulation, sculpting),
**Slice** (one layer in 2D, fixed scale, and where per-slice holes are picked up
and moved), **Stack** (exploded at real pitch), **Sheet** (nesting on the bed).

Slice mode routes the pointer through a **tool**, of which there is one. The
push brush belongs there — one layer at a time, true scale, neighbours visible —
and it will be a second tool rather than a second set of canvas handlers.

## Known limits

- **WKWebView is 1.5–2× slower than Chrome** at the numeric work, and the native
  shell uses it. `npm run dev` in a browser is still the faster way to develop.
- **True-shape nesting resolution is not monotonic.** Greedy bottom-left packing
  can do better at 1.5 mm than at 1 mm. The panel offers the dial and says so.
- **An import's field is exact only to `reach × scale`** from the surface, clamped
  beyond. A shell thicker than that puts its cavity on the clamp. The inspector
  warns; raising the resolution or the scale fixes it.
- **Project files record an import's path, not its geometry.** A grid is megabytes
  and the project file is meant to stay readable, so imports must be located again
  after opening.
- **A fixture is skipped on any layer it does not fit**, which is right for a
  socket and arguable for a Wago chamber selected across the whole stack: a
  missing pocket in the middle is a floor inside what was meant to be a cavity,
  and the inspector reports a count rather than which layers. Left alone
  deliberately — the failure mode was reasoned about, not met, and physical
  feedback outranks reasoning here. Fix it when a stack refuses to take a
  connector.
- **No cross-slicing.** Everything is horizontal layers. See the plan below.
- **The bundle is unsigned.** It runs on the machine that built it; another Mac
  quarantines it. Proper notarising needs a paid Apple Developer account.

## Local state that is not in the repo

**One local fix has been overwritten twice by file bundles.** In
`src/ui/Viewport.tsx`, the `dragging-changed` handler must narrow the event
payload:

```ts
const onDraggingChanged = (event: { value: unknown }) => {
  const dragging = event.value === true;
  draggingRef.current = dragging;
  controls.enabled = !dragging;
};
```

three types a control event's payload as `unknown`. Only `tsc -b` catches it, so it
comes back whenever `Viewport.tsx` is replaced wholesale. If a bundle includes that
file, check this first.

## Physically untested

Everything here is validated in code and unproven in material. Test cuts were
about to happen when this handoff was written; ask before assuming.

- **True-shape nesting.** The validator proves no collisions, but that is code
  proving code. Look at the DXF on screen before burning a sheet: a part inside a
  ring's hole is correct and looks alarming.
- **Per-layer random windows.** Whether they look good in a finished stack is
  unknown. The maths is proven; the aesthetics are not.
- **Plexi window fit.** `fit` defaults to 0.4 mm. Loose is fixable with glue,
  tight is not fixable at all, so start loose. Plexi needs its own kerf test.
- **Wago chamber and cable channel** dimensions are defaults, not measurements.

## Candidates, in the order I would take them

1. **Assembly PDF.** A numbered stack is not self-explanatory once it is a pile of
   parts on a bench. Deliberately *after* the next real cut: what it has to say —
   whether a gap takes one ring or two, which plexi plug goes in which hole — is a
   guess until there is a pile of parts on the bench.
2. **Cross-slicing (fin / eggcrate mode)**, discussed and scoped:
   - **Phase A: generalised slice planes.** `sliceModel` assumes `z = const`, but
     marching squares, Chaikin, RDP, kerf and grouping all work in the plane's own
     coordinates and do not care which plane it is. Generalise to an origin plus
     two plane axes and everything downstream — DXF, nesting, engraved numbers,
     the thin-feature check — continues unchanged, because it all works on 2D
     polygons. Roughly a third of the work, and mechanical. Useful alone: you can
     see what fins your form gives before committing to joints.
   - **Phase B: cross joints.** Notches, half the overlap from each part, width the
     other part's thickness, computed per fin-and-disc pair. Same kerf lesson as
     windows but inverted — the notch is a hole, so it is cut narrow and opens to
     size, while the tongue entering it is uncut material. Get that backwards and
     all two dozen notch pairs are wrong the same way.
   - **Phase C: assembly.** A fin stack holds nothing up before it is assembled,
     so it needs an order and new refusals: a fin crossing no disc, a disc too
     narrow for a notch, a notch that eats a fin thin enough to snap.
3. Roadmap, unranked: per-gap spacer heights, polygon-shaped perforation, a lamp
   preview with an emissive source in the cavity, SVG export, a folder of user
   generator modules, material usage and cost, registration notches for glue-stack
   mode.

## Eleven asked for, and the four things they need first

Scoped in conversation and recorded here so the plan does not live only in a chat
log. Each idea is listed against the foundation it waits on rather than in the
order it was asked for, because the foundations are shared and building them
once is the whole saving.

| Foundation | What it unlocks |
| --- | --- |
| ~~**An explicit layer plan**~~ — **shipped**, as `{ index, z0, z, thickness, gapAbove }` | varying gaps *(shipped)*; interleaved short pins; per-layer cable holes; per-layer sculpting |
| ~~**One `LayerSelector`**~~ — **shipped**, for per-slice features; windows keep their band | interleaved pins and per-layer cable holes are now mostly wiring |
| **`profile2d.ts`** — a 2D profile as a first-class thing, from SVG, a brush, or a slice of the field | SVG import; morph between key layers; per-layer editing |
| **A material library** — calliper, flute pitch and profile, direction, phase | corrugated sheet as stock; stack pitch that depends on it |

The layer plan breaks a binding convention on purpose: `layerPitch()` in
`types.ts` is currently the one place pitch is derived, and with varying gaps
there is no single pitch to derive. The rule is replaced rather than dropped —
**the layer plan is built in one place** — which is the same idea in a form that
survives. Everything that computes `k · pitch` reads the list instead.

Two constraints that have to be said before anyone builds against them:

- ~~A gap is always a whole number of spacer rings.~~ **Shipped**, and the ring
  material is now separate from the stock, which is what makes 0.5 mm sheet
  usable at all. The panel says how many steps a gradient can actually take.
- **A slanted leg hole is not the mid-plane ellipse.** A 45° leg moves 3 mm
  sideways through a 3 mm sheet, so the shape to cut is the sweep between the
  ellipses at the sheet's top and bottom faces. Cut only the mid-plane ellipse
  and the leg does not pass through at all. Same mathematics as cross-slicing
  Phase A, so the two share the work.

Two of the eleven turned out to exist already: solid top and bottom are the
shell's caps, and measuring the distance between overlapping parts by their real
outlines is what `analyseSheet` and true-shape nesting already do — though
true-shape is off by default, so a first look shows bounding boxes.

Two need a decision recorded. Per-layer editing is **brush strokes and 2D
profiles, not dragged vertices**: a vertex is produced by the field and has no
identity that survives the form changing, so the durable thing to store is the
stroke. And interleaved pins **must leave every layer fastened to both
neighbours**, which means the generator has to check its own output and say so
when a layer ends up held on one side only.

## Practical notes from cutting actual lamps

- **Cut the kerf test into the real material before anything else**, and measure
  the outer square and inner square separately. If they disagree the beam is not
  perpendicular and no single kerf value will save the fit.
- **Plexi needs its own kerf**, usually much smaller than cardboard's. Window fit
  depends on both directly, and they pull in opposite directions.
- **Corrugated board's flutes show in the cut edge.** Turning parts against the
  grain is what makes a stack look alive rather than like twelve identical lines —
  hence part rotation, seeded scatter, and the flute preview. This is also why the
  nester does not rotate parts to save material: it would silently overwrite an
  aesthetic choice.
- **Start with a wider bridge than seems necessary** in corrugated stock: 2 mm
  rather than 1.5. The vertical flute between the liners does not carry like solid
  material.
- **A socket mount needs a solid layer**, not a ring. Make one with the shell's
  solid cap and aim the fixture's band at it.
- **Watch for layers that come apart into separate pieces.** A form with two lobes
  gives layers in two groups, and each group needs a rod through it or the smaller
  piece has nothing holding it. It is easy to miss because the Model view looks
  continuous.

## How these sessions run

Worth knowing, because it is a working agreement rather than a preference.

- **Finnish conversation, English code.** Explanations, reasoning and commands in
  Finnish; every identifier, comment and string in English.
- **Numbered command blocks, copy-paste ready, with the expected output stated.**
  Daniel runs them and pastes the result. When something fails, the failure is the
  useful information — read it rather than guessing around it.
- **Work arrives as a zip of changed files only**, unpacked to `/tmp` and rsynced
  over the repo. That is why local edits get overwritten: say so when you have made
  one, and it will be carried into the next bundle.
- **Grep for the symbol you changed, not the topic you changed.** Before removing
  or resignaturing an export, search the whole tree for that identifier and paste
  the result. This rule exists because it was adopted mid-session and then failed
  anyway: `composeField` gained a parameter, the search was for `spacerHeight`
  and `.pitch`, and `main` was pushed in a state that would not compile.
- **Nothing is committed on a verify that was not seen.** The same push happened
  because a commit was made between a red run and the fix for it.
- **A test's expected value derived by hand from geometry is a guess.** Three
  times in one session a check asserted a number worked out on paper — a band
  edge, a fixture's layers, a mid-plane — and the arithmetic was wrong, not the
  code. Derive the expectation from the model in the test, or run it once and
  read it.
- **Every geometry change comes with validator checks in the same batch**, and the
  checks are written to fail for the right reason. Several times a red check has
  been the test being wrong rather than the code, and saying so plainly is part of
  the job — a test that asserts something the algorithm has no reason to do is
  worse than no test.
- **Physical feedback outranks everything.** The best design decisions in this
  project came from cuts that did not behave: flute direction, bridge width, the
  socket needing a solid layer. When a cut disagrees with the program, the program
  is wrong.
