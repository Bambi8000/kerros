# KERROS-FEATURES — feature and module catalog

Every feature type that can appear in the feature tree is documented here,
one entry per module. Updated in the same batch as the code that adds it,
never deferred. `KERROS-HANDOFF.md` is the map; this file is the parts list.

Status legend: **shipped** · **in progress** · **planned**

## Entry format

Each entry states: module key, stage, what it does, parameters with units and
defaults, determinism notes (what it does with the seed), and the validator
that covers it.

---

## SHAPE

_None yet. M1 adds the SDF primitives: sphere, capsule, rounded box, torus,
ellipsoid, superellipsoid, plus union / smooth union / subtract / smooth
subtract / intersect._

## CARVE

_None yet. M5 adds shell and subtract volumes._

## RIG

_None yet. M3 adds rods with Z-span and clearance holes; M4 adds spacer
rings; M8 adds the E27 mount, cable cavity and Wago chamber._

## SLICE

_None yet. M2 adds the slicer: mid-plane sampling, marching squares, RDP
simplify, Chaikin smooth. M3 adds kerf offsetting._

## PATTERN

_None yet. M7 adds the pattern module API and the first generators._

## LAYOUT

_None yet. M4 adds shelf packing with a configurable part gap._

## EXPORT

_None yet. M3 adds the DXF R12 writer (POLYLINE/VERTEX only — LWPOLYLINE is
R13+ and the target laser will not take it), layers CUT and ENGRAVE._

---

## Infrastructure shipped in M0

### World convention

Z is up, 1 three.js unit = 1 mm. Set in `src/ui/Viewport.tsx`; three.js
defaults to Y-up so every camera sets `up` explicitly. Any geometry code that
assumes Y-up is a bug.

### Feature tree

`src/core/store.ts` — ordered list with add, remove, reorder, enable/disable
and selection. Ids are `f1`, `f2`, … from a monotonic counter so a saved
project reloads with stable ids. `src/core/types.ts` defines `Feature` and the
seven stages.

### Profiles

`src/core/profiles.ts` — machine (bed 730 × 410 mm, margin), material
(thickness, kerf, notes), stack (spacer height). Layer pitch is derived in one
place, `layerPitch()` in `src/core/types.ts`, and nothing else may compute it.
Bed size and kerf are never hardcoded in geometry code.

### Error boundaries

`src/ui/ErrorBoundary.tsx` wraps the app, the viewport, the feature tree and
the profile panel separately, so a throw in one region leaves the rest usable.

### Validators

- `tools/check-version.mjs` — package.json version matches `KERROS_VERSION`.

Every geometry module gets its own `tools/validate-<name>.mjs` before it
ships, importing the real shared helpers, never stubs.
