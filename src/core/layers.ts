/**
 * Kerros layer selection.
 *
 * One way to say *which layers* a per-slice feature applies to.
 *
 * There were four before this: a window's band, a fixture's band, a rod's z
 * span, and perforation, which had no way of saying anything and went on every
 * layer. Four spellings of one question is how the attachment problem started
 * too, and the answer is the same — one mechanism, composed rather than copied.
 *
 * TWO BOUNDARIES, both deliberate.
 *
 * **This is for holes in sheets, not for volumes in the field.** A window is a
 * wedge subtracted from the field and rolls its layers at sampling time from
 * world Z; it cannot see a list of slices, and moving it onto this would mean
 * either dragging the slice list into the field or rolling every window twice.
 * The second would reroll every saved lamp. So windows keep their band, and
 * this covers fixtures, perforation, rods' extra holes, and what comes next.
 *
 * **Selectors are resolved once, in the pipeline.** The geometry modules are
 * handed a finished set of layer numbers. Letting each resolve its own would
 * put a copy of this logic in four modules that may not import one another —
 * duplicated *logic*, not a duplicated shape like `WindowFrame` and
 * `PlaneFrame`, and the difference is that logic drifts.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

export const LAYER_SELECTOR_KINDS = ['all', 'band', 'range', 'every'] as const;
export type LayerSelectorKind = (typeof LAYER_SELECTOR_KINDS)[number];

export interface LayerSelector {
  kind: LayerSelectorKind;
  /**
   * `band`: middle of the band, mm, in world Z.
   *
   * Millimetres rather than layer numbers because a band is aimed at a place on
   * the form — the height a socket sits at — and it should stay there when the
   * layer pitch changes underneath it.
   */
  z: number;
  /** `band`: height of the band, mm. Anything under one pitch reaches one layer. */
  length: number;
  /**
   * `range`: first and last layer, inclusive, **numbered as the slice inspector
   * numbers them** — from 1, counting sheets that exist.
   *
   * Not plane indices. A model with a void along Z examines a plane there and
   * produces no sheet, and "the bottom three sheets" means three sheets you can
   * hold, not three planes two of which are air.
   */
  from: number;
  to: number;
  /** `every`: one layer in n. 1 is every layer. */
  n: number;
  /** `every`: which of the first n to start on, counting from 0. */
  offset: number;
}

export const DEFAULT_LAYER_SELECTOR: LayerSelector = {
  kind: 'all',
  z: 0,
  length: 12,
  from: 1,
  to: 1,
  n: 2,
  offset: 0,
};

/** The little a selector needs to know about a slice. */
export interface LayerLike {
  /** Layer number as shown, from 1. */
  index: number;
  /** Mid-plane, mm. */
  z: number;
}

/** 1st, 2nd, 3rd, 4th — including the teens, which do not follow the last digit. */
function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function clampInt(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.round(value), low), high);
}

/**
 * Read a selector out of loose parameters, filling in whatever is missing.
 *
 * Feature parameters are a flat bag of numbers and strings, and a selector is
 * seven of them. Keeping the reading in one place means a feature that predates
 * selectors, or one edited by hand into nonsense, resolves to something rather
 * than throwing — and to `all`, which is what every such feature did before it
 * had a selector at all.
 */
export function selectorFromParams(
  params: Record<string, number | string | boolean> | undefined,
  fallback: Partial<LayerSelector> = {},
): LayerSelector {
  const base = { ...DEFAULT_LAYER_SELECTOR, ...fallback };
  if (!params) return base;

  const num = (key: string, def: number): number => {
    const raw = params[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : def;
  };

  const rawKind = params.selKind;
  const kind = LAYER_SELECTOR_KINDS.includes(rawKind as LayerSelectorKind)
    ? (rawKind as LayerSelectorKind)
    : base.kind;

  return {
    kind,
    z: num('selZ', base.z),
    length: num('selLength', base.length),
    from: num('selFrom', base.from),
    to: num('selTo', base.to),
    n: num('selN', base.n),
    offset: num('selOffset', base.offset),
  };
}

/**
 * The layers a selector picks, as layer numbers, ascending.
 *
 * Ends entered backwards are ordered before use, the same courtesy a rod span
 * gets, because dragging a range the wrong way round is a slip rather than a
 * request for nothing.
 */
export function resolveLayers(selector: LayerSelector, slices: LayerLike[]): number[] {
  if (slices.length === 0) return [];

  switch (selector.kind) {
    case 'all':
      return slices.map((slice) => slice.index);

    case 'band': {
      const half = Math.max(selector.length, 0) / 2;
      const low = selector.z - half;
      const high = selector.z + half;
      // Inclusive at both ends, matching the rod span and the fixture band this
      // replaces: a layer sitting exactly on the edge is in the band.
      return slices.filter((slice) => slice.z >= low && slice.z <= high).map((s) => s.index);
    }

    case 'range': {
      const low = Math.min(selector.from, selector.to);
      const high = Math.max(selector.from, selector.to);
      return slices.filter((slice) => slice.index >= low && slice.index <= high).map((s) => s.index);
    }

    case 'every': {
      const n = clampInt(selector.n, 1, 999);
      // Wrapped, not clamped. A phase of -1 out of 3 is the last of three, and
      // clamping it to 0 would silently make it the first — a different set of
      // sheets, chosen by nobody.
      const offset = ((clampInt(selector.offset, -998, 998) % n) + n) % n;
      // Counted by position in the stack rather than by layer number, so a void
      // along Z does not put the pattern out of phase: what matters for a pin
      // is which sheets are next to each other.
      return slices.filter((_, at) => (at - offset) % n === 0).map((s) => s.index);
    }

    default:
      return slices.map((slice) => slice.index);
  }
}

/** The same answer as a set, for the per-slice loops that ask once per layer. */
export function resolveLayerSet(selector: LayerSelector, slices: LayerLike[]): Set<number> {
  return new Set(resolveLayers(selector, slices));
}

/**
 * What the selector did, in words, for the inspector.
 *
 * A selection that comes to nothing has to say so and say why — the rule this
 * program keeps relearning. "0 layers" on its own reads as a bug; "the band sits
 * above the top sheet" reads as something to fix.
 */
export function describeSelector(selector: LayerSelector, slices: LayerLike[]): string {
  const total = slices.length;
  if (total === 0) return 'Nothing sliced yet.';

  const picked = resolveLayers(selector, slices);
  const count = picked.length;
  const plural = count === 1 ? 'layer' : 'layers';

  if (count === 0) {
    switch (selector.kind) {
      case 'band': {
        const half = Math.max(selector.length, 0) / 2;
        const lowest = slices[0].z;
        const highest = slices[total - 1].z;
        if (selector.z + half < lowest) {
          return `No layers: the band tops out at ${(selector.z + half).toFixed(1)} mm and the lowest sheet is at ${lowest.toFixed(1)} mm.`;
        }
        if (selector.z - half > highest) {
          return `No layers: the band starts at ${(selector.z - half).toFixed(1)} mm and the highest sheet is at ${highest.toFixed(1)} mm.`;
        }
        return `No layers: the band is ${selector.length.toFixed(1)} mm tall and falls between two sheets.`;
      }
      case 'range':
        return `No layers: ${Math.min(selector.from, selector.to)}–${Math.max(selector.from, selector.to)} is outside the ${total} there are.`;
      default:
        return 'No layers.';
    }
  }

  switch (selector.kind) {
    case 'all':
      return `Every layer — ${count} of ${total}.`;
    case 'band':
      return `${count} ${plural} in the band, ${picked[0]} to ${picked[count - 1]} of ${total}.`;
    case 'range':
      return `${count} ${plural}, ${picked[0]} to ${picked[count - 1]} of ${total}.`;
    case 'every': {
      const n = clampInt(selector.n, 1, 999);
      const nth = n === 1 ? 'every layer' : `every ${ordinal(n)} layer`;
      return `${nth} — ${count} of ${total}, starting at ${picked[0]}.`;
    }
    default:
      return `${count} of ${total}.`;
  }
}
