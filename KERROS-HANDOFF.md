# KERROS — Project Handoff

Read this first when picking up Kerros development. It is the **map**: what the
program is, how it is built, which of the original plan's decisions were
overturned and why, what is left, and how these sessions run.
`docs/KERROS-FEATURES.md` is the **territory** — the module-by-module catalogue,
kept current in the same batch as the code it describes. When the two disagree,
FEATURES is right and this file is stale.

**State at the time of writing: version 0.39.2.** The MVP as originally scoped is
complete, plus five feature families that were not in the plan at all. Kerros has
cut real lamps.

**Grid** adds three orthogonal sheet families: X/Y upright planes and split Z
cells. The user approved splitting the horizontal sheets. All profiles follow
the current source; counts, spacing and per-plane offsets rebuild their joints.
X/Y use the existing upright cross-slot and insertion solver. Horizontal cells
use one glued tab in a bordering upright, with distinct sockets for opposing
cells, square-corner relief and a visible opposite-edge insertion gap. Build
uprights first and lower/slide horizontal cells bottom to top. Empty cells are
counted; disconnected or unattachable parts block export. Source cavities are
preserved, but multi-band upright crossings can still refuse; Grid never fills
a cavity to make it fit. Grid does not yet combine with rods, LED routes, free
plates or wall/ring supports. Parts reach the real worker, Part/Assembly/Sheet,
DXF, manifest and PDF. Layout buttons preserve other layouts while disabling
them. See FEATURES, `docs/KERROS-GRID-PLAN.md` and `validate-grid.mjs`.
Fit, adhesive and the XYZ assembly sequence remain physically untested.

Grid now accepts 0–64 horizontal Z planes and 1–8 planes in each upright family,
with a conservative ceiling of 1,024 planned cut parts. Enter a count and commit
with Apply or Enter; typing intermediate digits does not rebuild or delete
planes. The inspector shows enabled Z coverage and the planned part ceiling.
Spacing remains explicit. Receiver connectivity is checked after all sockets,
avoiding a complete upright retrace for each enclosed socket.

Since 0.39.2, each Grid axis offers `Fit to source`, with `Fit all axes to source`
as one action. Fitted spacing follows current source bounds, stock and count;
Manual spacing and offsets are retained for switching back. Existing layouts
remain Manual. The earlier count-only change could move outer sheets outside
the source and return zero parts. Refusals now name the plane, actual station,
allowed full-sheet range and repair control. Fit keeps stations inside the box;
it does not guarantee material or joints at every station. Excessive density
still refuses without reducing the requested count or stock.

**Native curve profiles** now open a drawing editor in Slice. Add `Curve profile`
under source tools, draw a closed Bézier path or ellipse/circle, then reshape
anchors and handles. Repeat the base through the height, or copy drawings to
actual layers such as 1, 5 and 10 and morph between those keys. Native controls
are saved in the project; imported SVG profiles keep their external-file contract.
Keys retain physical local heights when the layer plan changes, and the slab
includes every saved key. A drag previews locally and commits once on release;
Undo/Redo and project ownership guards protect edits. Selecting a key does not
recalculate geometry. This uses the existing distance-field morph and retains
its measured gradient/kerf limitations; physical cuts remain untested. See
FEATURES and `tools/validate-curves.mjs`.

**Branched vertical supports** now join one continuous lower cavity to upward
branches through a shared horizontal sheet. `Fit: Automatic` exposes `Supports
per branch` (1–6): one gives three joints at a two-way fork, three gives nine.
`Count` still controls an unbranched cavity. The trunk reaches the shared sheet
and every child extends down to it; no interior sheet is skipped. The inspector,
manifest and PDF name shared layers, joint counts, section coverage, omitted
pieces and a sampled straight insertion order. More supports are a geometry
choice, not a load rating or approval for glass or other brittle stock.

This handles splits, not cavity merges. The earlier Sphere → Shell → Capsule →
Shell example also contains a merge and still gets an explicit refusal; removing
that intermediate Shell is a user design change, never an automatic correction.
Disconnected cavity starts and ambiguous paths also refuse the group. Closed
end pieces still require separate attachment. See FEATURES and
`tools/validate-support-branches.mjs`; the three- and nine-joint shared sheet
coupons remain physically untested.

Numeric inspector fields now display at most two decimal places without
rounding the model. In-progress edits remain editable until blur; external
changes replace stale drafts. This keeps long gizmo-generated values legible.

Cut views now show a shared calculation status, completion time and an explicit
`Recalculate` action. Edits still update automatically outside Model; Model
continues to defer cuts until entering a cut view. The support inspector no
longer offers navigation to Assembly while already there. A completed geometric
refusal is labelled as such and Manual split-layer refusals name every affected
layer. These status changes are separate from the branch fitter described above.
Worker calculation failures now reach the UI instead of becoming successful
empty results. `Retry calculation` submits current inputs; retry freshness,
project/import ownership and cancellation guards keep old cuts out of export.
A stopped worker can use the existing inline fallback on the next request.

**Automatic vertical support fitting** now follows the cavity of the original
horizontal stack. New groups default to `Fit: Automatic`; old projects retain
Manual until explicitly switched. Count, rotation and joint clearance remain
editable. Centre, inclusive layer range and local depth/engagement are derived
from the actual slices and update with the source. Closed or unsuitable end
layers are trimmed and listed by number and reason; an unusable interior layer
refuses the group. A shelled sphere no longer needs guessed first/last layers.
Automatic shoulder webs protect the curved spine beside each slot, while the
continuous profile connects close rows. Automatic fitting never reduces stock,
clearance or count and never overwrites stored Manual values. Derived dimensions
and coverage reach the inspector, manifest and PDF. Joint fit, insertion and
separate end-layer attachment still need a physical test.

**Vertical supports** adds internal radial plate spines to the original
horizontal stack. Add it under `Source shapes and layer tools`; it opens
Assembly and its inspector. One group supplies 1–12 supports, with rotation,
centre, cavity depth, wall engagement, clearance and an inclusive layer range.
Opposing cross-lap slots use actual sheet heights and twist, and the spine
profile follows the cavity. Selected sheets must have a connected ring and an
open centre; Manual rejects closed caps, and both modes name thin walls,
crowded insertion and tight gaps. Layers outside the range explicitly remain unsupported.
Assemble the selected layers and spines first, then separately attach the end
layers and fit rods. Upright cut parts stay separate from horizontal layer
numbering but join Assembly, Sheet, DXF, manifest and PDF. All use the stock
profile and one kerf compensation after nominal tracing. Rod interference
blocks export; rods do not drill these spines. This is a sampled geometry
check, not a strength claim. See FEATURES and `validate-vertical-supports.mjs`;
cross-lap fit and assembly still require a physical coupon.

**Free plates and cloning** now support arbitrary XYZ placement and full ZYX
rotation in Assembly. `Add free plate` creates an editable rounded rectangle.
`Clone plate` snapshots any selected rib, support, wall plate or free plate,
selects a new persistent ID and activates Move; the copy starts 10 mm clear of
the source face. It owns the finished nominal outline (including holes/slots)
and stock, so kerf is applied once. `Free placement` saves the selected linked
part in place and unlocks all axes; `Restore linked placement` returns to its
retained source settings. Saved `plateOutline` loops are independent of external
SVGs and source geometry. A damaged loop invalidates the whole snapshot instead
of quietly filling a hole. Copy actions require the current completed result.
Move/Rotate drags preview immediately and commit one pose on release; numerical
pose edits use the same fast frames. Free parts join collision, LED/rod, Part,
nesting, DXF and PDF paths, but have no generated attachments or checked insertion
sequence. Existing cut slots are frozen geometry, not live joints. Linked rib
operations referencing a freed rib need correction or disabling. Odd/Even/All
and Fan move only linked ribs; freed rib sources retain their sequence slots.
See FEATURES and `tools/validate-free-plates.mjs`; mounting still needs design
and a physical test.

The 0.34.1 follow-up removes stale success notices after plate actions: restored
linked placement must not still say “Free placement enabled”. Refusal messages
remain; the current controls identify the active placement mode.

Rods now rotate freely with the Rotate gizmo in Model and upright Assembly,
or with Rotation X/Y/Z in the inspector. Rotation preserves centre and length;
`Fit length to model` fits along the current axis. Old two-end projects keep
their centre on first edit. Rods remain world-anchored when a layout is moved.
Inclined rods cut the full stock-thickness envelope, with in-plane kerf, in
horizontal stacks and Linear/Radial ribs. Upright rods share the LED cylinder
kernel and target ribs, supports and backplates automatically; they remain rod
features in the project. Refused crossings name the sheet and block export.
Horizontal vertical rods retain the original circular, mid-plane-selected path.
Ordinary spacer rings are omitted for inclined rods; vertical bosses cannot
follow them and must be disabled or returned to a vertical rod before export.
These limits are visible in the inspector and export panel. Manifests and PDFs
carry inclined rod endpoints and actual cut layers/parts. Physical fit still
needs a coupon. See FEATURES and `tools/validate-rod-rotation.mjs`.

Angle edits now reorient the last cut outlines immediately in Assembly,
including Selected/Odd/Even/All and Fan. The viewport labels this as a placement
preview and fades the old supports while final cuts and checks are pending.
Repeated rib rotations remain available; a completed job cannot replace meshes
under a held handle. Source, stock and membership edits still need a rebuild.
The shared worker queue runs one job and retains only the latest waiting job
of each kind; input changes cancel superseded waiting work even during debounce.
Active synchronous work may finish once. Generation, project/import ownership
and export freshness checks remain in place; preview frames never supply cuts.

Rib angles now have `Selected`, `Odd`, `Even` and `All` scopes. Odd/Even use
the rib sequence (1/3/5 and 2/4/6), not feature IDs; hiding or renaming a rib
does not change membership. Shared offsets are additive and preserve each
rib's manual angle. The rotation gizmo previews and commits that same scope;
translation and LED handles remain individual. Linear layouts also have
`Fan edge angle`: equal angle steps in left-to-right placement order, positive
outward and negative inward, added to the other angles. Hidden ribs retain
their fan position; changing count or moving ribs past one another recomputes
the distribution. Missing new fields are zero, preserving old projects.
All angles regenerate real joints, LED openings and export geometry.

Rib collisions now offer `Create cross joint` and `Create clearance cut`.
Both create an editable `assembly:joint` feature referencing persistent rib IDs.
Cross joints cut complementary upward/downward slots, with an editable split
and circular tip relief. Clearance cuts modify one selected rib and must leave
it connected. Both include the actual crossing angle, both sheet thicknesses
and shared joint clearance; kerf follows the finished nominal profile.
Existing wall/support joints and earlier rib cuts are protected. Cross-jointed
networks assemble before the wall plate: a sampled disassembly search supplies
the reversed assembly order, and the wall must slide on from behind. Trapped
networks block export. Horizontal rings, nearly parallel crossings, group
motions and arbitrary tilt remain outside this rib-joint workflow. The cuts,
references and instructions reach project files, worker, Part, Sheet, DXF and
PDF. These joints still need physical coupons, including their relief corners.

`Minimal solid` is a third wall-mount Outline option, alongside `Open frame`
and `Solid rectangle`. It fills the profile-following frame's centre before
cutting tab slots, mounting holes and LED openings, preserving the same outer
shape and fitted rib joints. Both profile-following modes share their settings;
switching between them is reversible. The default remains Open frame and old
projects keep their selected outline. The filled plate also needs a physical
coupon; geometry checks do not establish strength.

New linear assemblies use a minimal, open wall frame. Its upper and lower rails
follow each rib's usable shoulder profile and placement. Since 0.30.1, short ribs
reduce the rail inset locally to fit two tabs, or use one centred tab if a pair
cannot fit; the requested tab height is preserved. The old two-tab spacing
requirement could omit a small end rib from the entire frame. Wall attachment
checks now count every enabled linked rib, including empty source planes, and block
export when any is unattached. An unplaceable tab stops frame generation rather
than leaving a plausible partial support. Rail width and profile inset are editable. Two mounting holes
follow the upper rail, with small inward pads where a dense rib row needs room.
Old projects retain their rectangular backplate until `Outline` is changed to
`Open frame`. The sphere validator uses 72.2% less backplate area
than the old rectangle, with all nine joints and both screw holes. This is a
geometry result, not a strength rating: the frame still needs a physical coupon.

**Ribs & Supports** adds upright radial and linear assemblies. Each rib has a
persistent feature ID, a source sampling plane and a separate editable placement.
Horizontal ring supports use complementary half slots; a wall backplate uses
glued tabs and full-thickness, angle-aware slots. A straight LED channel
cuts round or rectangular openings through selected final parts. Its clearance
is per side and separate from kerf. Finished 2D contours are redistanced before
kerf; restricting the source SDF to an oblique plane is not enough.
Assembly, Part, Sheet, project files, DXF and the assembly PDF share part IDs.
Projects persist the allocation watermark so a deleted target ID cannot be
reassigned to a different part after reopening.
LED channels have their own XYZ move and full 3D rotation gizmo, selected in
the tree or by clicking the channel. The pivot is the route anchor, independent
of fitted endpoints. A drag commits one pose on release and regenerates cuts;
world-space edits are converted back through the assembly frame, including
section roll at vertical directions. Angle groups remain rib-only.
The original horizontal pipeline is unchanged when the assembly is disabled;
horizontal-only fixtures, paint and punches are explicitly reported as excluded
while it is enabled. Joint geometry and sampled insertion/collision checks are
validated, but all new joints and LED fits still require physical coupons.

**Hole punch** adds one exact circular cut to the sheet being edited in Slice.
Click a centre after choosing the diameter; each punch is an editable feature,
anchored to its sampled height through the same nearest-plane rule as paint.
It stays in sheet coordinates, takes kerf from the material and is added after
structural holes are turned, before perforation. A complete circle must fit;
rejected cuts name the reason. The shared circle-fit guard now measures complete
segments, because simplified long edges could previously be crossed between
their vertices. Hole punches appear in Slice, Stack, Sheet and DXF, not Model.
The button is in the bottom toolbar of horizontal Slice; upright Part does not
yet have a single-part punch tool.

The 2026-09-13 audit completed the layer-3 claim cross-check and found seventeen
issues, recorded and repaired in `docs/KERROS-AUDIT.md`. Project
opening now clears imported mesh caches; cached slices carry ownership and
freshness, and stale cut jobs cannot be exported. Model mode still retains its
own last slice for fixture ghosts without paying for a reslice.
The thin-feature check now measures whole cut segments and circles: the audit's
0.7115 mm leg-to-rim bridge is warned about even after contour simplification.
Inspector layer readings now use the pipeline's actual fixture bands, planned
leg layers and nearest-plane paint assignment. Pin warnings include fully
unfastened sheets without guessing why pins are absent; bosses name disabled rods.
Gap-rounding messages include the middle request, and zero spacer counts wait
for current results and distinguish touching layers from short rods. Twist and
pin repetition readings now include multi-turn repeats with a stated search limit.
Import/profile reach warnings now read the same shell depth and index settings
as the pipeline. Window messages use the physical ceilings, zero perforation
results name the known cause, and imported/profile/sculpt features are recognised
in the tree.

The browser release is served from `https://bambi8000.github.io/kerros-web/`.
The source repository `Bambi8000/kerros` is public by the owner's choice. The
separate `Bambi8000/kerros-web` deployment repository contains only verified
`dist/` contents and `.nojekyll`, served from its `main` branch root. It was
created when the source repository was private and keeps the existing site URL
working. `.github/workflows/pages.yml` verifies
source pushes and saves a build artifact; publishing remains a separate
maintainer step documented in README, with no cross-repository token stored in
CI. `GITHUB_PAGES=true` selects `/kerros-web/`; local and native builds use the
root. Project files stay in the browser and are saved by download.
On 2026-09-17 the owner explicitly authorized current and future Kerros source
and documentation releases to `Bambi8000/kerros`, and compiled browser releases
to `Bambi8000/kerros-web`. Routine verified updates to these existing public
repositories do not need another release-specific permission question.

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
| polygon booleans for a leg hole over the rim | cut legs from the field | estimated at eighty lines, honestly nearer two hundred, and its failure mode is a plausible-looking wrong polygon — the field does it in none, and gives kerf and the empty case away free |
| `polygonFitsInPart` guards every per-slice hole | it guards the ones with no partial shape | right for a rod and a socket, wrong for a leg, which should take a bite out of the rim rather than vanish |
| a window's width is limited by where the wedge stops being exact | by what can be glued back together | 178° was the mathematics; 100° is the bench, and only when the plexi plugs are not cut |
| seven-segment digits are unambiguous at 3 mm | they are one unburnt segment apart | measured on the cell: the closest seven-segment pair differs in 2.8% of its area, the shape-led digits in 20%. Written as fact and never checked until a pile of parts could not be sorted |
| "ignore the inner paths" means keep the outermost rings | it means **union** | the first form assumes the rings nest. Eleven circles laid over each other kept whichever happened to have their first vertex outside the others and dropped the rest |
| a union is the smallest distance with the right sign | a union is the smallest **signed** distance | inside one ring beside another's boundary, the first form reads "almost at the edge" while the point is deep in material — and a shell believes it and leaves a wall along every interior outline |
| per-layer editing is dragged contour vertices | it is **strokes** | a vertex is produced by the field and has no identity that survives the form changing; a stroke is a thing a person made |
| a brush stroke needs its own bulk type | a paint stroke **is** a sculpt stroke whose z never changes | the project file and the parser already knew how to carry one, and the operation being on the stroke gave one brush that both adds and carves |
| a bend is a domain warp on the query point | a bend is an **arc**, and the distance to one is closed form | a warp is not an isometry, so the gradient stops being unit and every blend and kerf iso-level that reads the field is off by however much it stretches |
| the corrugation in board is a texture inside it | the sheet itself is the wave | so a layer's cut outline is the model met by the wave surface, not by a plane — and turning a layer changes the part rather than only its edge |
| bounds come from the SHAPE stage | anything that **adds** material sets bounds, whatever its stage | true for the whole program's life because every RIG feature removed. A boss adds, and a spoke past the form was clipped at the grid — a flat plate in the preview and a whole layer's outer ring dropped in the slicer |
| a morph key needs a **Centre** button, since two drawings rarely share an origin | `fitProfile` already centres as it sizes | it was scoped, agreed and about to be built. Every key is fitted to its own longest axis on the way in, and fitting *is* centring — the button was a call that had already happened. Read the file before writing to it, a fourth time |
| a morph's solid is `height` tall, like any other profile | it is the **span between its lowest and highest key** | a 40 mm height under keys 60 mm apart beheads the form. Bounds come from what adds material, which is the boss lesson wearing a profile's clothes, and the inspector replaces the field with a sentence rather than leaving a number that does nothing |

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
- **`workerAvailable()`**, found by the 0.26.0 audit: a function whose whole
  purpose was to report that jobs run in the inline fallback, called by
  nothing — so a missing worker meant everything ran 1.5–2x slower in silence.
  Wired to the profiles panel. `docs/KERROS-AUDIT.md` exists because this
  family cannot be caught by a validator, only looked for.

The rule that comes out of it: **a green `npm run verify` says the code compiles
and the algorithms are right. It says nothing about whether anybody can reach
them.** Every validator then in the chain was green through all three. The cures are cheap
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
  verticalSupports.ts  cavity-following stack spines and slots    [type imports]
  supportBranches.ts   cavity forks, shared sheets, insertion     [type imports]
  grid.ts         orthogonal planes, split cells and glued tabs [type imports]
  layers.ts       which layers a per-slice feature applies to     [no imports]
  legs.ts         splayed leg holes: the swept ellipse hull        [no imports]
  profile2d.ts    2D outlines from SVG, indexed, as a field         [no imports]
  twist.ts        the angle each sheet is turned at assembly        [no imports]
  paint.ts        per-layer brush strokes, one sheet's band          [no imports]
  nest.ts         shelf packing, raster true-shape packing,
                  placement, collision, rotation, labels           [no imports]
  font.ts         stroke font for engraved labels                  [no imports]
  dxf.ts          DXF R12 writer, kerf test figure                 [no imports]
  pdf.ts          hand-written PDF, ASCII only                     [no imports]
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
  the full validator chain plus a real type check. Compare each named OK line
  with `package.json`'s `check` script; do not substitute a count.
- **Bed size and kerf come from profiles**, never hardcoded in geometry code.
- **All randomness seeded**, and seeded so that adjusting a setting does not reroll
  a choice. Per-layer window rolls key on the layer number; scatter keys on part
  index; changing a count must not change which layers were chosen.
- **Every geometry module gets a validator** in `tools/validate-<name>.mjs`,
  importing the real module. The current check list lives in `package.json`.
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
- **Docs change in the same batch as the code**, never deferred: this file plus
  `docs/KERROS-FEATURES.md`, patched in place, and a regenerated inventory.
- **Command blocks copy-paste ready**, zsh-safe, expected output stated, no `#`
  comments in interactive commands.
- **Design before code**: plan the feature completely, then implement.
- **No error boundary means one throw whites out the app.** There are four, around
  the app, the viewport, the feature tree and the right-hand panel. They earn it:
  a temporal-dead-zone slip in `Viewport.tsx` showed up as *"VIEWPORT STOPPED ·
  Cannot access 'measureMode' before initialization"* with the rest of the
  interface still working, rather than as a white page with nothing to read.

## Pipeline as built

Feature tree stages evaluate in order. A shell or a window applies where it sits,
so sculpting a spout and then shelling hollows the spout too.

1. **SHAPE** — eight SDF primitives with six combine ops; sculpt strokes; mesh
   imports; extruded SVG outlines. `roundBox` at `r = 0` is an exact box; `prism` and `cone` cover the
   angular forms it cannot. No scale on primitives, deliberately; imports carry a uniform one.
   Shapes can be grouped under other shapes.
2. **CARVE** — shell with optional solid caps; windows, which subtract a wedge and
   emit the removed piece as a part in another material.
3. **RIG** — finite, freely oriented rods with clearance holes, spacer rings, the lamp
   fixtures, and splayed legs. Legs are the one thing in this stage cut from
   the field rather than per slice, so that a leg over the rim notches it.
4. **SLICE** — mid-plane sampling, marching squares, Chaikin then RDP, kerf at the
   iso-level, thin-feature check.
5. **PATTERN** — perforation per slice, four generators, one bridge test.
6. **LAYOUT** — nesting per material in the worker, either bounding-box shelves
   or raster true-shape; stroke-font layer numbers engraved; manual placement with pinning
   and rotation; true-shape collision reporting.
7. **EXPORT** — DXF R12 per sheet, build manifest, assembly PDF, kerf test and
   glyph test figures, project file.
   Native save dialogs through Tauri; the browser download path still works.

Four workspace modes: **Model** (preview, direct manipulation, sculpting),
**Slice** (one layer in 2D, fixed scale, and where per-slice holes are picked up
and moved), **Stack** (exploded at real pitch), **Sheet** (nesting on the bed).

Slice mode routes the pointer through a **tool**, of which there are four:
select, measure, the brush and Hole punch. That the pointer went through a tool at all is
what made the brush an addition rather than a rewrite — and the guard that ends
the select branch sits *after* the others, or another tool is unreachable the
way `FixtureInspector` was.

## Known limits

- **The browser workspace lives in memory.** Save a project before refreshing
  or closing the page. GitHub Pages serves the application; it stores no lamp
  projects or imported files.
- **WKWebView is 1.5–2× slower than Chrome** at the numeric work, and the native
  shell uses it. `npm run dev` in a browser is still the faster way to develop.
- **True-shape nesting resolution is not monotonic.** Greedy bottom-left packing
  can do better at 1.5 mm than at 1 mm. The panel offers the dial and says so.
- **A profile's field is exact only to its reach**, which the pipeline sizes
  from the deepest shell in the tree. A blend wider than the reach reads a
  clamped number, and the inspector says so.
- **A profile's SVG is not saved**, only its path — the same trade mesh import
  makes, and it has to be located again after opening.
- **A twisted sheet's outline is identical to an untwisted one**, so nothing
  about a cut part says which way round it goes. The assembly PDF carries the
  angle; without it, the parts alone cannot be assembled.
- **An import's field is exact only to `reach × scale`** from the surface, clamped
  beyond. A shell thicker than that puts its cavity on the clamp. The inspector
  warns; raising the resolution or the scale fixes it.
- **Project files record an import's path, not its geometry.** A grid is megabytes
  and the project file is meant to stay readable, so imports must be located again
  after opening.
- **A paint stroke outside the stack does nothing.** It is anchored to the
  height it was drawn at, so changing the material thickness can leave one above
  the top sheet or below the bottom one. It is dropped rather than moved, and
  the inspector counts them.
- **A pin's removal keys do not survive a change in sheet count.** They are
  `gap:position` against the layer numbering, so changing the material thickness
  points them at different sheets. The same fragility hand placements on the bed
  already carry, but structural here rather than cosmetic.
- **A leg hole is not guarded.** `polygonFitsInPart` refuses a rod or a socket
  that crosses a contour, because a partial one of those is not a thing; a leg
  is cut from the field precisely so it *can* notch the rim, which means a thin
  bridge left between a leg and the edge will be cut. The thin-feature check
  rings it and the profiles panel counts it, but nothing refuses it.
- **A fixture is skipped on any layer it does not fit**, which is right for a
  socket and arguable for a Wago chamber selected across the whole stack: a
  missing pocket in the middle is a floor inside what was meant to be a cavity,
  and the inspector reports a count rather than which layers. Left alone
  deliberately — the failure mode was reasoned about, not met, and physical
  feedback outranks reasoning here. Fix it when a stack refuses to take a
  connector.
- **A morph's kerf can over-compensate where the outline pinches.** A convex
  mix of two 1-Lipschitz fields is 1-Lipschitz, so the iso-shift can never
  under-cut — but where two keys' nearest edges point in different directions
  the in-plane gradient drops below 1 and the shift lands further out than
  asked. Measured on one circle becoming two: worst gradient 0.569, so at most
  1.76× the kerf, and only within a couple of millimetres of the pinch.
  Unproven in material, and on the list below.
- **A morph key's SVG is not saved either**, and every key has to be located
  again separately after opening. The inspector counts the ones still waiting
  and says whether the morph is live meanwhile — a profile with one located
  key falls back to its original outline, which is a working lamp and not what
  anybody asked for, so it is said out loud rather than left to be noticed.
- **A morph ignores `height`.** Its span is its keys, so the field would write
  a number nothing reads — the pattern gizmo's failure exactly. The inspector
  replaces the field with a sentence instead.
- **Automatic joints remain upright.** Radial and linear ribs with ring supports or a
  wall backplate are available. Rib-to-rib cross joints support upright wall
  and loose-rib networks with a checked straight individual-part order.
  Free plates can tilt arbitrarily and preserve saved cutouts, but do not
  generate attachments. Tilted automatic joints, group insertion motions and
  cross-jointed networks with horizontal rings remain deferred. Ring and wall support systems cannot be combined
  because their insertion paths differ.
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

- **Orthogonal Grid.** Cut an XYZ coupon in the selected stock. Check the
  upright cross slots, horizontal tab/socket relief, opposite-cell tab positions,
  visible insertion gaps and bottom-to-top cell insertion. The single glued
  cell tab needs a retention/adhesive test; geometry supplies no load rating.

- **Vertical stack supports.** Cut a two-layer cross-lap coupon in the stock,
  check the layer-height shoulders, slot clearance, inward staging room and
  outward insertion, including the automatically fitted curved shoulders and
  their locally varying engagement. Test retention and adhesive. Unselected end layers need
  separate attachment; support plates do not establish a load rating. Also cut
  a shared-sheet fork with three joints and with nine joints, checking distinct
  shoulders, remaining sheet webs and the recorded insertion order. Brittle
  materials are not approved by increasing the support count.

- **Upright assemblies.** Cut a two-rib/two-ring coupon and a two-rib wall
  coupon using the actual LED tube or profile. Measure kerf, slot and tab fit,
  including the open frame's rails, mounting pads, profile-following tab pairs
  and the single-tab joint on short ribs,
  insertion sequence, remaining bridges and wall clearance. Glued oblique
  shoulders meet at an edge rather than a laser-cut bevel. No load rating or
  LED retention follows from the geometric checks.
- **Rib intersections.** Test complementary slots at the intended angle in
  both stock thicknesses, including relief radius, split, remaining bridges
  and wall-last insertion. Clearance cuts need the same fit test and do not
  attach the ribs. Sampled collision/order checks do not prove joint strength.
- **Inclined rods.** Cut a full-thickness angled-hole coupon at the intended
  angle, kerf and diameter. Verify actual rod clearance, insertion and support;
  flat spacer rings and vertical bosses are not generated for inclined rods.
- **Hole punch.** The exact circle, single-layer assignment, kerf, save/open
  and DXF path are validated; its finished diameter still needs a cut in the
  chosen stock with a measured kerf.
- **True-shape nesting.** The validator proves no collisions, but that is code
  proving code. Look at the DXF on screen before burning a sheet: a part inside a
  ring's hole is correct and looks alarming.
- **Per-layer random windows.** Whether they look good in a finished stack is
  unknown. The maths is proven; the aesthetics are not.
- **Plexi window fit.** `fit` defaults to 0.4 mm. Loose is fixable with glue,
  tight is not fixable at all, so start loose. Plexi needs its own kerf test.
- **Wago chamber and cable channel** dimensions are defaults, not measurements.
- **A morph across a topology change.** The field splits on its own and the
  gradient was measured rather than reasoned about, but 1.76× kerf at the pinch
  is a number off a grid of samples and not off a sheet. Cut a
  one-circle-to-two morph and measure the bridge where the lobes part; if it
  holds, the superellipsoid's normalisation trick stays shelved for good.

## Candidates, in the order I would take them

1. ~~**Assembly PDF.**~~ **Shipped**, and waiting for the cut was right: the
   thing that turned out to be hard was telling one part from another, not
   remembering the order, so the drawings became the document and the table the
   appendix. All at one scale, because fitting each to its own box makes a 40 mm
   ring and a 200 mm ring identical on the page.
2. **Cross-slicing (fin / eggcrate mode)**: the upright subset of phases A-C
   shipped in 0.29.0; upright rib cross joints and one-rib clearance cuts
   shipped in 0.31.0. Free placement and plate snapshots shipped in 0.34.0.
   Three-direction Grid with split, tabbed horizontal cells shipped in 0.39.0.
   Automatic joints for tilted plates, group assembly motions and crossing
   networks with horizontal rings remain future work. The original phase breakdown
   below records the rationale.
   The current design is recorded in
   [the assembly implementation plan](docs/KERROS-ASSEMBLY-PLAN.md): upright
   radial and linear ribs, adjustable supports, a wall backplate with approved
   glued tab joints, and an LED channel through selected assembly parts. These
   are implemented for upright sheets. The plan records the user's confirmed
   scope; FEATURES describes the shipped controls, sampled checks and limits.
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
3. Roadmap, unranked: a brush that edits one morph key — the per-layer brush
   and the key list already exist, so it is the stroke landing in a key's
   coordinates rather than a sheet's — per-gap spacer heights, polygon-shaped perforation, a lamp
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
| ~~**One `LayerSelector`**~~ — **shipped**, for per-slice features; windows keep their band, and legs count planes because the field precedes the sheets | interleaved pins and per-layer cable holes are now mostly wiring |
| ~~**`profile2d.ts`**~~ — **shipped**, an indexed 2D distance field with two fill rules | SVG import *(shipped)*; morph between key layers *(shipped)*; per-layer editing *(shipped)*. All three turned out to be composition on top of it, which is what the foundation was for |
| ~~**Per-layer editing**~~ — **shipped**, as brush strokes anchored to a height and confined to one sheet's band | the last of the eleven that needed a foundation rather than wiring |
| **A material library** — calliper, flute pitch and profile, direction, phase | corrugated sheet as stock; stack pitch that depends on it. Two things are already in place: layer twist, which is what turns a wave strong enough to be geometry, and a slice sampler that takes its height per layer, so the wave arrives as `z = const + wave(u, v)` in one place. The gap between two sheets will depend on the angle between their waves, and `planLayers` already carries `gapAbove` per plane rather than one pitch |

The layer plan breaks a binding convention on purpose: `layerPitch()` in
`types.ts` is currently the one place pitch is derived, and with varying gaps
there is no single pitch to derive. The rule is replaced rather than dropped —
**the layer plan is built in one place** — which is the same idea in a form that
survives. Everything that computes `k · pitch` reads the list instead.

Two constraints that have to be said before anyone builds against them:

- ~~A gap is always a whole number of spacer rings.~~ **Shipped**, and the ring
  material is now separate from the stock, which is what makes 0.5 mm sheet
  usable at all. The panel says how many steps a gradient can actually take.
- ~~A slanted leg hole is not the mid-plane ellipse.~~ **Shipped.** The sweep
  between the two faces, as the hull of two ellipses, and measured: 421 points
  of 720 around a 45° leg's outline at the top face fall outside the mid-plane
  ellipse. Same mathematics as cross-slicing Phase A, which is now part paid.

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

- **Measure the board, not the packet.** A lamp cut at 3 mm settings from 4 mm
  card came out an ellipsoid rather than a sphere: eighteen sheets a millimetre
  taller than planned is eighteen millimetres of extra height. The program
  planned correctly for the number it was given, and a sphere is not obtainable
  from unmeasured stock.
- **Cut the glyph test with it.** `glyphTestDocument` answers what size a layer
  number has to be on *this* board. Seven-segment digits were adopted on
  reasoning and had to be replaced after a pile of parts could not be sorted;
  the size is the same kind of question and gets the same treatment.
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

## Two right things in the wrong order

A fourth family, and it is invisible to every validator because **both halves
are correct on their own**. Three instances:

- `stage === 'RIG'` tested before the kind, so `FixtureInspector` was
  unreachable — and legs and pins would each have repeated it.
- A state declaration read by a dependency array above the line that declares
  it: a temporal dead zone, caught by an error boundary rather than by `tsc`.
- Pin colours stroked before the selection highlight, which paints over every
  hole belonging to the selected feature — so the colours vanished exactly when
  the pins feature was selected.

Nothing type-checks this and nothing can: order is not a property either piece
has. The habit that helps is to ask, of any two things that touch the same
object, *which of these runs second, and does it overwrite the other?*

## Where the views deliberately disagree

Everywhere else, two pictures of the same thing agreeing is a requirement — a
validator checks that the preview and the slicer put the top of the model in the
same place, because if they ever stop agreeing the shape on screen is not the
shape that gets cut.

**Layer twist is the one exception, and it is on purpose.** The field knows
nothing about it, because the turning happens when the stack is assembled:

- **Model** shows the design the parts are cut from.
- **Slice** shows a part as the laser cuts it, holes turned against the outline.
- **Stack** shows the lamp, sheets turned and holes back in line.

Because it is an exception to a rule this file states elsewhere, it is said out
loud where somebody meets it: the model view's readout carries it whenever a
twist is set. An exception that lives only in the code is indistinguishable from
the bug it resembles.

## The ghost is a second implementation

Worth its own note because it has been wrong three times while the geometry was
right every time: a leg ghost tilted the wrong way, then drawn the full height
of the model whatever layers were chosen, then guessing a depth with nothing
sliced.

A ghost is drawn in three dimensions from the same numbers the holes are cut
from in two, and **nothing compares the two**. It is the one place in this
program where the same thing is worked out twice, and a second implementation
drifts. Every other duplication here is a *shape* — `WindowFrame` and
`PlaneFrame` — which is safe precisely because shapes do not drift.

The cure, when it is worth paying for, is to derive the ghost from the same
`legSections` the field uses rather than from the spec. Until then: when a
picture and a slice disagree, suspect the picture.

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
- **And the test's *model* has to suit the feature, not only its numbers.** A
  fourth time the derived number was right and the shape was wrong: a socket
  aimed into a shelled sphere's cavity, then legs on a sphere's narrowest
  sheets, then legs whose spread was measured at the bottom and aimed halfway
  up. Each read as zero holes and looked like a bug in the code. If a feature is
  for base sheets, the test model needs a base sheet — a sphere has none.
- **Every geometry change comes with validator checks in the same batch**, and the
  checks are written to fail for the right reason. Several times a red check has
  been the test being wrong rather than the code, and saying so plainly is part of
  the job — a test that asserts something the algorithm has no reason to do is
  worse than no test.
- **Physical feedback outranks everything.** The best design decisions in this
  project came from cuts that did not behave: flute direction, bridge width, the
  socket needing a solid layer. When a cut disagrees with the program, the program
  is wrong.
