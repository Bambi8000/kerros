# KERROS-AUDIT — findings from the 0.26.0 audit

A targeted pass over the whole codebase at version 0.26.0, done before starting
the morph feature so a clean baseline separates audit findings from new-feature
faults. The bulk of the code was written across many sessions with an earlier
model, and the audit looked specifically for the failure families this project
has already named — silence read as a bug, written but never wired, two right
things in the wrong order, duplicated logic that drifts — rather than reading
32,500 lines for their own sake.

**Method, so it can be re-run.** Three layers:

1. **Mechanical** — scripts: exports nothing imports, store actions no UI
   calls, registered parameters nothing reads, value imports in the no-imports
   core modules, comments claiming `always`/`never`/`guarantee`.
2. **Order and silence** — targeted greps read by hand: dispatch chains
   (broad condition before narrow one), early returns that refuse without
   reporting.
3. **Claim cross-check** — every "the inspector says/warns/counts" sentence in
   FEATURES read against the code that would have to say it. Completed on
   2026-09-13 at 0.27.0; the original checklist and the findings are below.

Verify was green (21 OK lines) before and throughout; nothing here was found by
a validator, which is the point — these families live outside what validators
can see.

## Findings

Severity is about consequence, not certainty: everything below was confirmed by
reading the code, not inferred from a scan alone.

### A1 — `workerAvailable` written, never wired — **medium**

`src/ui/workerBridge.ts:117` exports a function whose whole purpose is to
report whether jobs run in the worker or in the inline fallback. Nothing calls
it. Consequence: when the worker fails to construct, everything runs 1.5–2×
slower on the main thread and the program says nothing about why — the silence
family and the never-wired family in one function.

**Fix:** wire it into the profiles panel as a plain line when the fallback is
active ("running without a worker — slicing and nesting happen on the UI
thread"). Do not remove the function; the missing piece is the reader.

### A2 — `CLEARANCE_HOLES` is a dead duplicate of `ROD_CLEARANCE` — **medium, latent**

`src/core/profiles.ts:40` exports a clearance table nothing reads.
`src/core/rig.ts:21` has `ROD_CLEARANCE`, which everything uses. Two sources of
truth where one is disconnected is the dangerous form of dead code: future code
finds the profiles version by its plausible name and believes it, and the two
tables can differ without anything noticing.

**Fix:** delete `CLEARANCE_HOLES`. Grep the whole tree for the symbol first —
that rule exists because it failed once.

### A3 — `labelWidthOf` is dead — **low**

`src/core/job.ts`, one occurrence: the declaration. Likely left behind when
`findLabelSpot` grew its own width computation. **Fix:** delete, grep first.

### A4 — `stage === 'RIG'` fallback is a trap for the next RIG kind — **low, preventive**

`src/ui/Inspector.tsx:2585` and `src/ui/SliceInspector.tsx:240` still end their
chains with `kind === 'rod' || stage === 'RIG'`. Harmless today: every known
RIG kind (fixture, boss, pins, legs) is caught earlier, and the comment at
Inspector.tsx:2558 records the FixtureInspector lesson. It stops being harmless
the day a new kind lands in RIG and its inspector branch is forgotten — the new
feature silently gets the rod panel, exactly the way fixtures did.

**Fix:** replace the fallback with an explicit unknown-feature panel that
**names the kind it did not recognise**. A forgotten branch then shows up on
screen as a sentence instead of as the wrong panel's silence — a vaccine for
the family, not a fix for a bug.

### A5 — `ringThickness` logic duplicated in the panel — **low**

`(spacerThickness ?? 0) > 0 ? spacerThickness : material.thickness` is written
out by hand in `src/ui/ProfilePanel.tsx:263` (and again around line 194) while
`ringThickness()` in `src/core/rig.ts:203` is the real resolver and is already
exported. This is logic duplication, the kind that drifts — the exact
distinction HANDOFF draws against shape duplication, which is safe. If
"0 means follow the stock" ever grows a third condition, the panel and the plan
disagree silently.

**Fix:** the panel calls `ringThickness()`.

### Closed without a finding

- **A6, `removed` pin keys** — flagged by a scan that only saw quoted-string
  reads. The parameter is read as `params.removed` (store.ts:1056,
  pipeline.ts:423) and honoured at pipeline.ts:448. Scanner limitation, not a
  bug.
- **`selectorForFixture` unused by tools** — the validator tests the claim
  behaviourally ("a fixture with no selector still uses its band",
  validate-pipeline.mjs:400–404), which is the stronger test. The FEATURES
  claim holds.
- **Store actions** — all 78 reachable from the UI. Now seen, not assumed.
- **No-imports invariant** — zero value imports across all nineteen core
  modules. Now seen, not assumed.
- **Comment claims** (`always`/`never`/`must`) — twenty hits, all matching
  documented behaviour; none asserts anything untested. Cross-checked properly
  in layer 3.
- **~50 exported types nothing imports** — types cannot run anything wrong.
  Cosmetic; strip the `export` keyword opportunistically, not as an audit item.

## Layer 3 checklist — FEATURES claims vs. code

The remaining pass is reading, not scripting. For every claim of the form "the
inspector says / warns / counts / reports", confirm three things: the branch
exists, the branch can open (its condition is reachable), and the panel it
lives in can be reached for that feature. The FixtureInspector was described at
length in FEATURES and had never been on screen; this list exists so that class
of gap is looked for on purpose.

Claims to check, by module:

- **fixture** — "the inspector reports how many and how much material they
  needed" (holes that did not fit); "every dimension is a default, not a fact"
  note; Centre on model button. The fixture inspector is the one panel that was
  once unreachable, so its every claim gets checked first.
- **pattern** — zero-holes callout with the wall it needs vs. has; "patterns
  never appear in the Model preview" note.
- **paint** — dropped-stroke count (strokes outside the stack).
- **legs** — `legGaps` report (chosen layers that produced no part); thin-bridge
  warning reaching the profiles panel.
- **pins** — `loosePins` naming sheets held on one side, in both the pins
  inspector and the profiles panel; the stagger/climb sentence.
- **spacers / gradient** — the three-state truth table (uniform / same-by-
  rounding / graded) as written in FEATURES, each row provoked and read.
- **boss** — `spokesStickOut` warning; "which rod it wanted" when the rod is
  gone.
- **import** — reach warning against the deepest shell; open-edge count;
  locate-again message on project open.
- **profile** — reach note; locate-again message.
- **twist** — model-view readout when a twist is set; `twistPeriod` sentence.
- **nesting** — `busy` and last-pack time; unplaced-parts report; the
  resolution-is-not-monotonic note next to the dial.
- **worker** — after A1 ships: the fallback line itself.

Method per claim: provoke the condition in the running app (browser, not the
webview), read the sentence, compare it against the truth table in FEATURES.
Where a condition is hard to provoke by hand, note it here rather than skipping
silently.

## Fix plan

One small bundle, one commit per finding, verify seen between each:

1. **A2 + A3** — deletions. Grep each symbol across the whole tree first,
   paste the result, then delete.
2. **A5** — panel calls `ringThickness()`.
3. **A1** — fallback line in the profiles panel, reading `workerAvailable()`.
4. **A4** — unknown-feature panel replacing both `stage === 'RIG'` fallbacks;
   `kind === 'rod'` keeps its own branch above it.

None of the findings cuts a wrong part — geometry is behind validators, and
reachability and silence are not, which is exactly where all five came from.

## Status

- Layers 1 and 2: **done** (2026-09-02, at 0.26.0, verify green).
- Layer 3: **done** (2026-09-13, at 0.27.0). Claims were provoked in the browser
  and compared with real pipeline outputs, including the worker fallback.
- Fixes A1–A5: **shipped** (2026-09-02, five commits, verify seen green after
  each, smoke-tested in the browser). One deviation from the plan as written:
  the unknown-RIG panel sits at the end of the dispatch rather than at the rod
  branch, because the chain's tail was ShapeInspector — removing the stage
  fallback alone would have swapped one wrong panel for another.

## 0.27.0 audit repairs — 2026-09-13

All seventeen findings were reproduced before editing. The baseline verify
passed every named check; it did not detect these UI and integration failures.

| ID | Finding | Repair status |
| --- | --- | --- |
| B1 | Opening another project reused mesh grids by feature id | Fixed: clear caches and advance revisions; real-store validator |
| B2 | Model mode could export an old project's or old design's slices | Fixed: project ownership, immediate freshness checks, exports gated on a current pack |
| B3 | Thin-feature check compared vertices and missed long-segment interiors | Fixed: segment/circle distances, geometric neighbourhood, sparse-rim and dense-curve validators |
| B4 | Pin warnings claimed one-sided fastening and guessed the cause | Fixed: inspector uses the actual state and shared pipeline selectors |
| B5 | Boss inspector treated a disabled rod as an active support | Fixed: inspector uses the actual state and shared pipeline selectors |
| B6 | Fixture layer counts ignored the actual band and layer plan | Fixed: inspector uses the actual state and shared pipeline selectors |
| B7 | Paint inspector disagreed with the pipeline's nearest-plane assignment | Fixed: inspector uses the actual state and shared pipeline selectors |
| B8 | Gradient rounding text ignored the middle gap | Pending |
| B9 | Spacer messages confused pending results, zero gaps and short rods | Pending |
| B10 | Import reach warning used the last shell and recommended resolution | Pending |
| B11 | Profile reach warning measured a different index from the pipeline | Pending |
| B12 | Twist and pin repetition messages missed multi-turn repeats | Pending |
| B13 | Legs selected planned planes but the inspector counted nonempty sheets | Fixed: inspector uses the actual state and shared pipeline selectors |
| B14 | Every zero-hole pattern was blamed on wall thickness | Pending |
| B15 | Window clamp notice still used the superseded mathematical limit | Pending |
| B16 | Known import/profile/sculpt features were labelled unknown | Pending |
| B17 | Unsliced kerf text and all-unplaced nesting status were obsolete | Fixed: current kerf description and explicit completed-pack status |

Project-state validation loads the actual store through Vite's module loader,
with no HTTP or WebSocket listener. It bakes an OBJ, opens another project with
the same feature id, checks both cache invalidation signals, and locates the
new mesh again. It is part of `npm run verify`.
