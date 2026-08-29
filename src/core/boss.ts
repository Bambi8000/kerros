/**
 * Kerros bosses.
 *
 * A local thickening around a rod, so that a rod standing where there is no
 * material has something to be drilled through. The word comes from moulding,
 * where a boss is the lump of plastic around a screw hole; the problem here is
 * the same one. A shelled lamp is a ring on every layer and the middle is
 * cavity, so a rod near the axis lands in air — `circleFitsInPart` refuses the
 * hole, correctly, and the rod fastens nothing.
 *
 * A BOSS IS NOT JUST A CYLINDER. A cylinder alone in the cavity gives every
 * layer an **island**: a disc floating inside the ring, which `groupContours`
 * makes a part of its own, which falls off the sheet loose and has to be placed
 * back by hand on every layer. So a boss carries **spokes** — narrow radial
 * bars out to the wall — and they are the same thing as a rib in a moulding.
 * They are what make it one piece.
 *
 * ADDITIVE, WHICH IS WHY IT IS AWKWARD. Everything else in RIG removes
 * material. A boss adds it, so it has to be applied after the shell has done
 * its hollowing — put it before and the shell carves out the boss as well and
 * the whole point is lost. Legs set the precedent for a RIG feature living in
 * the field; this is the same, unioned rather than subtracted.
 *
 * NO PER-LAYER WORK. A leg's hole differs on every sheet because the sweep
 * depends on the sheet's thickness. A boss is a straight column: the same
 * section at every height. So the layer selector collapses to a z range and the
 * field costs one expression per sample rather than a layer lookup.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

const DEG = Math.PI / 180;

export interface BossSpec {
  id: string;
  label: string;
  /** The rod it thickens, taken from that rod's position. */
  x: number;
  y: number;
  /** Bottom and top of the column, mm, resolved from the chosen layers. */
  z0: number;
  z1: number;
  /** Radius of the thickening itself, mm. */
  radius: number;
  /** How many spokes reach out to the wall. */
  spokes: number;
  /** Width of a spoke, mm. */
  spokeWidth: number;
  /**
   * How far a spoke reaches, measured from the axis.
   *
   * From the axis rather than from the boss's edge, because that is the number
   * a person can read off the model against the wall's own radius. Anything at
   * or under `radius` sticks out nowhere and leaves the boss an island.
   */
  spokeLength: number;
  /** Where the first spoke points, degrees from +X. */
  angle: number;
  /**
   * Blend radius where the boss meets the form, mm.
   *
   * A fillet rather than a sharp inside corner, which in a flat cut part is a
   * place that tears. 0 is a hard union.
   */
  blend: number;
}

/** Distance to a 2D box centred at the origin, half-extents (hx, hy). Exact. */
function boxDistance2D(x: number, y: number, hx: number, hy: number): number {
  const dx = Math.abs(x) - hx;
  const dy = Math.abs(y) - hy;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0);
}

/**
 * The boss's cross-section at any height inside its span: the disc, plus a bar
 * for each spoke. Negative inside.
 */
export function bossSection(spec: BossSpec, x: number, y: number): number {
  const dx = x - spec.x;
  const dy = y - spec.y;

  let best = Math.hypot(dx, dy) - Math.max(spec.radius, 0.05);

  const spokes = Math.max(Math.round(spec.spokes), 0);
  const reach = Math.max(spec.spokeLength, 0);
  const half = Math.max(spec.spokeWidth, 0.1) / 2;

  for (let i = 0; i < spokes; i++) {
    const a = (spec.angle + (i * 360) / spokes) * DEG;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // Into the spoke's own frame, then a bar running from the axis outwards.
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    const bar = boxDistance2D(u - reach / 2, v, reach / 2, half);
    if (bar < best) best = bar;
  }

  return best;
}

/** The whole column, the section extruded between its two ends. */
export function bossDistance(spec: BossSpec, x: number, y: number, z: number): number {
  const low = Math.min(spec.z0, spec.z1);
  const high = Math.max(spec.z0, spec.z1);
  const mid = (low + high) / 2;
  const halfHeight = Math.max((high - low) / 2, 1e-6);

  const section = bossSection(spec, x, y);
  const dz = Math.abs(z - mid) - halfHeight;

  return Math.min(Math.max(section, dz), 0) + Math.hypot(Math.max(section, 0), Math.max(dz, 0));
}

/**
 * Polynomial smooth minimum.
 *
 * The same one `sdf.ts` uses, written out here rather than imported: this
 * module has no imports so the validators can load it as the real thing, and
 * three lines of arithmetic is a cheaper price than that. `k <= 0` is a plain
 * union.
 */
function smoothUnion(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * The form with every boss added to it, and none of them outside it.
 *
 * `envelope` is the form before it was hollowed — the shape tree without the
 * shell. Each boss is intersected with it before being unioned in, so a boss
 * fills the cavity and never bulges out of the lamp.
 *
 * That clip is the whole difference between a thickening and a lug. Without it
 * a spoke long enough to reach the wall carries straight on through it and out
 * the other side, which looks like a fin stuck to the outside of the form and
 * is nobody's idea of a boss. Reaching *too far* then costs nothing, which is
 * the behaviour worth having: you aim past the wall on purpose and the wall
 * decides where the spoke stops.
 *
 * It also keeps the sampling grid honest. A boss confined to the form cannot
 * push the model's bounds outwards, so the grid stays the size the shape asked
 * for and its samples stay where they were.
 *
 * Returns the field unchanged when there are no bosses, so a lamp without them
 * pays nothing — the same shape `stockField` takes for windows.
 */
export function bossField(
  solid: (x: number, y: number, z: number) => number,
  bosses: BossSpec[],
  envelope?: (x: number, y: number, z: number) => number,
): (x: number, y: number, z: number) => number {
  if (bosses.length === 0) return solid;
  return (x, y, z) => {
    let d = solid(x, y, z);
    // Intersection is a max, so the boss stops wherever the envelope does.
    const outside = envelope ? envelope(x, y, z) : -Infinity;
    for (const spec of bosses) {
      const boss = Math.max(bossDistance(spec, x, y, z), outside);
      d = smoothUnion(d, boss, Math.max(spec.blend, 0));
    }
    /*
     * And the blend has to be clipped too, not only the boss.
     *
     * A fillet pulls the union outwards by up to a quarter of its radius, and
     * at the outer wall the boss and the form are both on the surface — so the
     * two blend into each other and the outline grows a bump exactly where a
     * spoke lands. Half a millimetre at k = 2, which is small and completely
     * wrong: the silhouette is the design.
     *
     * Clipping the result costs nothing anywhere else. The shell only ever
     * removes material, so the form is already inside its own envelope and this
     * max leaves every other point exactly as it was.
     */
    return envelope ? Math.max(d, outside) : d;
  };
}

/**
 * Whether a spoke reaches past the boss at all.
 *
 * The one thing about a boss that fails quietly: a spoke shorter than the boss
 * is inside it, the boss is an island, and the island only shows up as a loose
 * disc on the sheet — by which point it is cut. Reaching the wall cannot be
 * checked here, since this module has no idea where the wall is, but reaching
 * past its own edge can be, and that is the mistake people actually make.
 */
export function spokesStickOut(
  /** Only the three numbers the answer depends on, so a panel can ask too. */
  spec: Pick<BossSpec, 'spokes' | 'radius' | 'spokeLength'>,
): boolean {
  if (Math.max(Math.round(spec.spokes), 0) === 0) return false;
  return spec.spokeLength > spec.radius + 1e-9;
}
