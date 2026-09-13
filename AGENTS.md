# AGENTS.md — working agreement for Kerros

This file is written for an agent (Codex or similar) working **directly in this
repository**. It replaces the chat-based session conventions that previous
development used. Read it first; then read `KERROS-HANDOFF.md` before doing
anything substantive.

## The documents, and which one wins

- `KERROS-HANDOFF.md` — the **map**: what the program is, which plan decisions
  were overturned and why, the recurring failure families, what is left. It
  records decisions that were expensive to learn. **Do not quietly revert any
  of them** — the overturned-decisions table exists because each row cost real
  debugging.
- `docs/KERROS-FEATURES.md` — the **territory**: every module and feature,
  with the reasoning and the measurements. When it disagrees with HANDOFF,
  **FEATURES is right and HANDOFF is stale.**
- `docs/KERROS-AUDIT.md` — the audit method and its open checklist (layer 3,
  FEATURES claims vs. code, not yet executed).
- `kerros-inventory.txt` — line counts, the check chain, recent commits.
  Regenerated at every docs batch.

Never assert the version or feature state from memory or from this file — read
`package.json` and the docs in the working tree. A stale rewrite once regressed
the handoff by several versions; `tools/check-docs.mjs` now exists to catch
that structurally.

## Language

All identifiers, comments, strings, commit messages and documentation are in
**English**, without exception. (The human developer converses in Finnish;
that has no bearing on anything committed.)

## Verification — the one rule that outranks the others

```
npm run verify
```

- **Never `npx tsc --noEmit`.** The root tsconfig is a solution file with
  `"files": []`, so `--noEmit` against it checks **nothing** and exits happily.
  Only `tsc -b` (run by `npm run build`, wrapped by `verify`) is a real type
  check.
- Read the result as a **list, never a count**. Every check prints an `OK`
  line; a missing line is the signal, and `grep -c "^OK"` has twice returned a
  plausible number while the chain was broken. Compare against the commands
  listed in `package.json`'s `check` script, which is the source of truth for
  how many there should be.
- **Nothing is committed on a verify that was not seen.** Not "it should
  pass" — run it after the change, read the output, then commit.
- One logical change per commit, with a descriptive message. Verify green
  between each.

## Editing discipline

The previous workflow delivered changes as file bundles into the repo, which
made "read before writing" a hard rule enforced by anchor-based patch scripts.
Working directly in the tree, the rule survives in this form:

- **Read the actual current file before editing it.** Never reconstruct a
  file's contents from documentation, memory, or an earlier state of the
  conversation. Three separate times, reading the file first produced a better
  design than the planned one; a fourth time it deleted a whole planned UI
  control (`fitProfile` already centres — the Centre button was a call that had
  already happened).
- **Grep for the symbol you change, not the topic.** Before removing or
  resignaturing any export, search the whole tree for that identifier and act
  on the result. This rule exists because it was adopted and then failed
  anyway (`composeField` gained a parameter; the search was for other names;
  `main` was pushed in a state that did not compile).
- **Docs are patched, never replaced wholesale.** `KERROS-HANDOFF.md` and
  `docs/KERROS-FEATURES.md` are edited in place, in the same batch as the code
  they describe, never deferred. `tools/check-docs.mjs` asserts the handoff's
  stated version matches `package.json` and enforces minimum section counts on
  both documents — it exists because a wholesale rewrite once silently dropped
  five sections.
- One known local fragility: in `src/ui/Viewport.tsx` the `dragging-changed`
  handler must narrow its event payload (`event.value === true`), because
  three types a control event's `value` as `unknown` and only `tsc -b` catches
  it. If you ever regenerate that file, check this first.

## Architecture constraints that are load-bearing

- **The model is a signed distance field evaluated analytically** — a function
  composed from the feature tree, never a voxel grid that gets edited (imports
  aside). Kerf compensation is the iso-level at `+kerf/2`; smooth blends and
  kerf both depend on `|∇d| = 1`, which is why there is no non-uniform scale
  anywhere and why approximate fields are normalised or rejected.
- **Core modules in `src/core/` have no value imports** (type-only imports are
  fine). Node loads them directly in the validators as the real thing. Keep it
  that way. `pipeline.ts` names its imports with explicit `.ts` extensions so
  the graph resolves in Node, and deliberately does not import `store.ts`.
- **Every geometry change ships with validator checks in the same batch**, in
  `tools/validate-<name>.mjs`, importing the real module — never a stub, never
  a reimplementation of the algorithm under test.
- **Z up, 1 unit = 1 mm.** Rotations are R = Rz·Ry·Rx (three.js Euler `'ZYX'`),
  pinned by a validator. Bed size and kerf come from profiles, never hardcoded.
  All randomness is seeded so adjusting a setting does not reroll a choice.

## Tests

- **Derive a test's expected value from the model in the test**, or run it once
  and read it. Numbers worked out by hand from geometry have been wrong more
  often than the code they were checking.
- **The test's model has to suit the feature.** A socket needs a sheet to sit
  in, legs need a base layer, a sphere has neither. Four times a "zero results"
  reading was the test's model, not the code.
- **A red check is sometimes the test being wrong**, and saying so plainly is
  part of the job. A test asserting something the algorithm has no reason to do
  is worse than no test.

## The failure families to look for on purpose

A green verify says the code compiles and the algorithms are right. It says
nothing about whether anybody can reach them. The families that keep recurring,
all invisible to validators:

1. **Silence read as a bug** — a check that refuses to do something must say
   what it refused and why (counts, what it needed). Six instances so far.
2. **A fluent wrong sentence is worse than silence**, because it stops the
   person looking. When a panel grows conditions, write the truth table into
   the message, not only into the code.
3. **Written, never wired** — functions, promises in comments, whole panels
   that nothing called or reached. Ask of anything new: *what would fail if
   this were never run?*
4. **Two right things in the wrong order** — dispatch fallbacks before narrow
   branches, draws that overpaint each other. Order is not a property either
   piece has; ask which of two things touching the same object runs second.

`docs/KERROS-AUDIT.md` records the method for hunting these deliberately.

## Design and decisions

- **Design before code.** Plan the feature completely, state which decisions
  are yours to make, and ask about the ones that are not — saying what you
  would choose and why, rather than presenting a menu.
- **Physical feedback outranks everything.** The best decisions in this project
  came from cuts that did not behave. When a cut disagrees with the program,
  the program is wrong. Several features are validated in code and unproven in
  material (listed in HANDOFF under "Physically untested"); do not assume they
  work, and do not silently change them without noting they are untested.

## Environment

- Repo: `github.com/Bambi8000/kerros`, local at `/Users/daniel/kerros`
- React + TypeScript + three.js + zustand, Vite, Tauri 2 shell
- Dev server pinned to port **5180** (`strictPort`); `npm run dev` in a browser
  is faster than the WKWebView shell for development
- Setup in a fresh sandbox: `npm ci`, then `npm run verify` to confirm the
  baseline is green before touching anything. The verify chain needs no
  network.

## State at handoff (read the repo to confirm)

At the time this file was written the repo was at **0.27.0**: the morph system
(interpolation between key profiles) had just shipped. Open items, in rough
order:

1. **Physical test cuts** — a list of features validated in code and unproven
   in material, in HANDOFF. Structural first: interleaved pins and bosses.
   Also the morph's measured 1.76× kerf over-compensation at a topology pinch —
   a number off a grid of samples, not off a sheet.
2. **Audit layer 3** — the FEATURES-claims-vs-code checklist in
   `docs/KERROS-AUDIT.md`. Reading and clicking work, safe to defer, not safe
   to forget.
3. **Cross-slicing (fin / eggcrate)** — scoped in HANDOFF in three phases;
   phase A's mathematics is partly paid for by the legs feature.
4. **Material library** (corrugated stock as `z = const + wave(u, v)`), then
   **brush-on-key** (sculpt strokes applied to a morph key).

What does not transfer from the previous setup: conversational memory and chat
transcripts. Everything load-bearing from them was written into HANDOFF,
FEATURES and AUDIT as it happened — which is exactly why the docs-batch rule
exists. If something seems to be missing, it is in those files or it is gone;
ask rather than reconstructing.
