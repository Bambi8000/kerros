# Orthogonal Grid layout

The user selected three perpendicular sheet families (X, Y and Z) and approved
splitting horizontal sheets. Light simulation is deferred. This plan is separate
from the existing radial and linear assembly contracts.

## Construction

X and Y identify the normals of upright source planes; Z identifies horizontal
planes. Every profile samples the current source, including cavities. Members
retain feature IDs. Counts redistribute centred stations within each family's
chosen spacing; individual offsets remain additive. Disabled members retain their
stations. Horizontal cell IDs derive from their plane and bounding upright IDs.

The upright network uses complementary vertical cross slots, X opening upward
and Y downward. The existing real upright builder checks connected pieces,
full stock collisions and a sampled individual-part insertion sequence. Empty
intersections do not need a joint; unattached upright components are errors.

Horizontal profiles are split at the upright slabs into cells. Each connected
cell attaches to one bordering upright with one glued tab and a matching
through slot. A bounded opposite edge retreats by the tab insertion travel;
this visible assembly gap is required to lower the piece inside its cell and
slide it into the receiving upright. Try X boundaries before Y, deterministically.
Do not change requested stock, joint clearance or tab width to force a fit.
Tab sockets include explicit circular corner relief. The body edge gap includes
one tracing step to keep concave tab roots clear of the full receiver slab;
socket clearance and kerf remain separate. Install horizontal cells bottom to top after the upright network. Slots must
preserve existing joints and minimum surrounding material. Opposing tabs cannot
occupy the same socket. Missing attachment or disconnected material blocks cut
export, with the actual part named. No strength or adhesive rating is implied.

## Scope and interface

Add Grid beside Linear/Radial. Provide counts and spacing for each family,
per-plane offset/enabling, joint clearance, tab width, split height and whole
assembly translation/rotation. Grid planes remain orthogonal. Reuse source
modelling, Part, Assembly, Sheet, stock profiles, save/open, worker freshness,
nesting, DXF, manifest and PDF. Parts and issues select the owning plane;
horizontal tiles remain individually inspectable in Part.

Existing arbitrary free placement, ring/wall supports and LED/rod tools must not
be silently applied with obsolete checks. Refuse incompatible enabled assembly
tools in Grid; source carving can define a light cavity. Later integrations need
their own joint-preservation and insertion checks.

## Acceptance

Validate real production geometry for solid and curved sources, preserved
cavities and explicit unsupported topology, every socket and full stock slab,
insertion clearances, stable identities, source/stock/count edits, disabled
members, stale-result gates, project and worker roundtrips and actual exports.
Click the complete browser workflow. Run and read the full verify chain. A small
physical XYZ coupon remains necessary before cutting a complete lamp.
