# Kerros assembly features — implementation plan

Status: implemented for upright sheets in 0.29.0, with rib intersections in 0.31.0.
Odd/Even angle groups and the linear fan extension shipped in 0.32.0.
This document preserves the approved design and acceptance goals. Read the
Assembly expansion section of KERROS-FEATURES.md for the shipped implementation
and its limits. Insertion and collision checks are sampled; physical fit, glue
strength and complete assembly feasibility still require material tests.

## User requests and confirmed choices

- Free placement of ribs, with individual angles or a shared angle adjustment.
- A first version with upright ribs: translation and rotation in plan view,
  without tilting ribs out of vertical. The user explicitly selected this scope.
- Radial arrangements for lamps and linear arrangements for panels.
- Perpendicular support plates with adjustable count and dimensions.
- A wall-mounted backplate to which the ribs attach.
- Glued tab-and-slot joints for the wall-mounted assembly. The user explicitly
  accepted this joint type; removable mechanical locks are not part of it.
- A tubular hole tool for linear assemblies, accommodating an LED tube or an
  LED strip. The proposed tool name is `LED channel`.
- Improvements to direct manipulation, readability and the assembly workspace.
- Intentional rib collisions: the user approved complementary cross slots or
  a clearance cut in one selected rib, with fit and assembly-order checks.
- Odd/Even rib angle groups, an All scope and a symmetric fan gradient.

The following sections specify the proposed implementation behaviour. Physical
fit and assembly feasibility remain to be tested in the actual material.

## Ribs and their placement

Generate initial rib profiles from the source form. Keep the source sampling
frame separate from each rib's assembly placement: moving an already generated
rib changes its placement, not its unjointed cut profile. Editing the source
form can regenerate its profiles. Placement and all subsequent assembly cuts
must then be resolved again from the current geometry.

`Radial` creates a distribution around a centre; `Linear` creates a parallel
distribution with an adjustable spacing. Individual ribs can then be moved and
rotated. `Selected` edits one rib; `Odd`, `Even` and `All` apply shared additive
offsets around each rib's own pivot, preserving individual differences. Odd/Even
membership follows stable rib sequence numbers rather than feature IDs or names.
The linear `Fan edge angle` adds equal steps in left-to-right placement order,
with opposite edge angles and a zero centre (or mirrored middle pair).
Hidden ribs retain their fan slots; count changes and placement reorder
redistribute the fan. Rotating the entire layout is a different
operation, with a shared assembly pivot. Switching the editing scope alone must
not change geometry. Keep existing horizontal-layer twist semantics unchanged.

Assign persistent IDs to ribs, supports and their connections. Regenerating a
distribution must not silently transfer an edited rib, hole or joint to a
different part merely because its display number changed. Preserve IDs for
retained members and identify members affected by count reductions.

## Horizontal supports

Start with two ring supports. Allow count, individual height, outer diameter,
inner diameter and material to be edited. An inner diameter of zero produces a
disc. All upright ribs meet a horizontal support at a right angle, including
after rotation in plan view.

Generate complementary cross slots from the actual overlapping parts, with a
defined opening direction and overlap split. Check the resulting assembly
order as well as the final geometric fit. A pair of slots that overlaps in the
finished drawing is not by itself proof that the parts can be put together.

Report missing contacts, insufficient remaining material and intersections
between unrelated parts by part ID. Shrinking a support must not silently drop
a joint and continue to describe that rib as supported.

## Wall mount

Provide a backplate with adjustable width, height, margin and its own material
profile. Offer fitting its outline to the selected ribs, screw or keyhole
openings, and a wall offset where needed. Hardware dimensions remain explicit
inputs rather than claims about a particular screw or mounting system.

Use glued tabs with shoulders that establish insertion depth. Generate matching
openings in the backplate. Tab dimensions, material thickness, joint fit and
laser kerf are distinct inputs or derived quantities with explicit meanings.
No claim of a mechanical lock or load rating follows from a tight fit.

The initial linear arrangement meets a vertical backplate at 90 degrees.
Individually rotated upright ribs may meet it obliquely. Such joints must use
the actual angle and both plate thicknesses; a slot width copied directly from
the mating thickness is valid only in the perpendicular case. Refuse geometry
whose contact or insertion path cannot be resolved, with the affected part IDs.

## LED channel

One editable straight route in assembly coordinates creates the required cuts
in all selected parts. It follows the assembly when the assembly moves.
Individual rib movement or rotation triggers a new intersection calculation,
so the openings still align with that route. A curved strip route can be added
later; the first route is straight for both cross-section types.

### Controls and placement

- `Tube`: measured component diameter and clearance per side.
- `Strip / Profile`: measured width, height, optional corner radius, cross-section
  rotation, and clearance per side. Dimensions may describe the strip itself or
  the chosen mounting profile; no manufacturer dimensions are assumed.
- Position, direction and finite length, plus a through-assembly length option
  derived from the current selected parts, including their full thickness.
- A closed opening or an edge-open slot for side insertion. Slot opening
  direction must be visible and editable.
- Explicit target selection: ribs, supports and backplate. Default to ribs;
  adding the backplate as a target is an intentional selection.

`Clearance per side` enlarges a requested diameter, width or height by twice
that value. Kerf compensation is applied separately to the resulting cut paths.
Show the component envelope and the cut envelope so users can distinguish fit
allowance from the light source's dimensions.

### Manufacturing meaning

Evaluate intersections in the final assembly, then express each cut in its
part's own 2D coordinates. Angled crossings must account for the whole sheet
thickness, using the swept opening rather than only the mid-plane section.
An angled round channel generally needs a larger, noncircular opening.

The existing laser workflow cuts through sheet stock. An edge-open LED slot is
a through-cut notch in the outline, not a blind pocket machined into a sheet's
face. Reject a requested result that requires a blind pocket, a bevel, or an
inaccessible insertion path instead of presenting it as a laser-ready cut.

Check openings against joints and remaining material after all cuts are known.
An opening that reaches an edge is valid only when explicitly configured as an
edge-open slot. Distinguish zero intersections, a disabled tool, an invalid
route, an undersized opening, and a cut that removes a tab or disconnects a rib.
Report actual affected-part counts and IDs. Channel openings locate a component;
they do not by themselves establish its retention or support design.

### Reuse and constraints

`src/core/sdf.ts` already contains exact round-box and capsule fields, rigid
transforms and subtraction. Reuse applicable geometry without making unrelated
core modules import one another. A capsule has rounded ends and its `h` is the
straight segment length; neither matches a finite flat-ended tube automatically.
Make the chosen end and length semantics explicit before reusing that shape.

`fixture:cable` is a dimensioned opening in selected horizontal sheets, with a
translation-and-Z-rotation frame. Keep that working behaviour. An arbitrary
assembly route needs full coordinate transforms and its own targeting; merely
renaming the cable inspector would leave those requirements unwired.

Do not assume restricting a 3D distance field to an oblique plane leaves an
exact 2D distance field. Validate final in-plane kerf and opening dimensions,
including thick sheets and shallow crossing angles.

## Rib-to-rib intersections

The 0.31.0 extension uses editable joint records for persistent rib pairs.
Current collision reports lead directly to `Create cross joint` or `Create
clearance cut`. Cross slots open on opposite vertical edges, with editable
split and closed-corner relief. Width includes both stock thicknesses at the
actual angle and the shared joint clearance. A clearance cut changes only its
selected rib and must leave that rib connected. Both operations preserve
existing joints or report a refusal; they never silently remove a tab.

Cross-jointed ribs assemble first and the wall plate slides on from behind
last. A deterministic, sampled disassembly search is reversed into the assembly
order. Refuse trapped individual-part sequences; group motion, arbitrary tilt
and cross joints combined with horizontal ring supports are deferred. Keep the
original insertion workflow when no cross joint is applied. Save/open, worker,
cut drawings, DXF, manifest and PDF must all carry the same operations and cuts.
Verify with material coupons before treating the fit or order as established.

## UI and output

Select ribs and supports directly in the 3D assembly, with the same IDs in the
inspector, part view, sheet view and assembly document. Show only controls for
the selected operation. Use an explicit `Selected` / `Odd` / `Even` / `All` scope. A
channel displays its route, cross-section and affected parts while being placed.

`Assembly` replaces the `Stack` view name. Keep the existing
graphite, light material and cut-red language; improve small-text readability
and control contrast. Material previews must remain distinguishable from cut
geometry. These UI changes are part of 0.29.0.

Produce labelled rib and support parts, preserve material separation during
nesting, and include all final openings in DXF and assembly instructions. Old
projects without assembly settings retain the current horizontal workflow.
Project saving must preserve placements, targets, channels and joint settings.

## Delivery and acceptance

1. General plane frames and persistent assembly parts; prove unchanged output
   for legacy horizontal projects before adding new construction behaviour.
2. Radial and linear rib placement, support plates, wall backplates and direct
   manipulation, including save/open and stable selection.
3. Cross slots and glued wall tabs, with fit, collision and insertion checks.
4. LED routes through final part placements, including selected targets and
   full-thickness opening envelopes.
5. Complete part-building, nesting, DXF, assembly-document and browser wiring.

Each geometry batch includes validators importing the real modules. In
particular, check linked angles without losing overrides, mixed material
thicknesses, oblique wall tabs and LED openings, clearance versus kerf, finite
route ends, edge-open slots, untouched excluded parts, joint/channel conflicts,
save/open, deleted targets and stale-result handling. Use suitable plate models
and derive expected geometry from the test model rather than guessed numbers.

Click through the complete user workflow; isolated validator success cannot
prove a tool can be reached or that its output reaches DXF. Run the complete
`npm run verify` chain and read every named OK against `package.json` before
committing each implementation batch.

Physical acceptance starts with a two-rib/two-support joint coupon and a small
linear coupon accepting the actual LED tube or mounting profile. Verify kerf,
fit, insertion sequence and remaining material before cutting a complete lamp.
