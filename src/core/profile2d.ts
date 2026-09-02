/**
 * Kerros 2D profiles.
 *
 * A profile is a closed outline in a plane, and it is kept as a **distance
 * function** rather than as a polygon. That is the same choice the rest of this
 * program makes, and here it buys something specific: two profiles can be
 * interpolated by mixing their distances, with no correspondence between their
 * points to work out. Morphing between a circle and a square is a `mix`, not a
 * matching problem.
 *
 * Sources are all the same type once they are read: an SVG outline, a brush
 * stroke in the plane, or a slice of the field. This file does the first.
 *
 * TWO THINGS THAT ARE EASY TO GET WRONG AND SILENT WHEN YOU DO:
 *
 * - **SVG's y axis points down.** Every ring is flipped on the way in, or every
 *   imported profile comes out mirrored and nobody notices until it is cut.
 * - **"Outer boundary only" is not a union of the rings.** A letter O has two
 *   rings, and unioning them puts a zero level where the hole was — a boundary
 *   in the middle of solid material. The outer rings have to be found by
 *   nesting depth first.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

/**
 * How the rings of a profile combine.
 *
 * `outline` is a **union**: solid wherever any ring encloses. That covers both
 * cases people mean by "ignore the inner paths" — a letter O comes out a disc,
 * because its counter is inside the union — and it is the only one of the two
 * that survives rings which *cross* each other rather than nesting.
 *
 * The first version defined it as "keep the rings nested inside nothing", which
 * assumed nesting. Given eleven overlapping circles it kept whichever ones
 * happened to have their first vertex outside the others and dropped the rest,
 * so parts of the drawing simply went missing.
 */
export type FillRule =
  /** Union: solid wherever any ring encloses, so inner and crossing paths merge. */
  | 'outline'
  /** Even-odd: a ring inside another is a hole, and one inside that is solid again. */
  | 'holes';

export interface Profile2D {
  /** Closed rings, flat [x0, y0, x1, y1, ...], in millimetres, y up. */
  rings: number[][];
  fill: FillRule;
}

export interface ProfileParse {
  rings: number[][];
  /**
   * What was skipped and why.
   *
   * Reported rather than thrown: an SVG with one unreadable element usually
   * still has the outline somebody wanted, and the person is better placed to
   * judge that than this is.
   */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Signed area. Positive is counter-clockwise, with y up. */
export function ringArea(ring: number[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    sum += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  return sum / 2;
}

/** Distance to a ring's boundary, always positive. Exact. */
export function distanceToRing(ring: number[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const ax = ring[i];
    const ay = ring[i + 1];
    const ex = ring[j] - ax;
    const ey = ring[j + 1] - ay;
    const len2 = ex * ex + ey * ey;
    let t = len2 === 0 ? 0 : ((x - ax) * ex + (y - ay) * ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + ex * t), y - (ay + ey * t));
    if (d < best) best = d;
  }
  return best;
}

/** Crossing test against one ring. */
export function insideRing(ring: number[], x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Which rings are outermost: inside nothing at all.
 *
 * This is what makes `outline` mean what it says. Without it, a letter O unions
 * its two rings and the hole's boundary survives as a zero level in the middle
 * of solid material.
 *
 * **Depth zero, not even depth.** The first version kept a ring nested inside an
 * *even* number of others, which is the even-odd rule wearing the wrong name: on
 * a drawing three levels deep it dropped the ring at depth 1 and kept the one at
 * depth 2, so a shell followed some of the inner outlines and not others.
 * Reported from exactly that, and it looks like a bug in the shell rather than
 * here, which is why it is worth saying plainly: `outline` means the outside,
 * and everything within it is inside.
 */

/**
 * Signed distance to a profile. Negative inside.
 *
 * Exact for both rules: the magnitude is the distance to the nearest boundary
 * that actually bounds the material, and the sign comes from the fill rule.
 */
export function profileDistance(profile: Profile2D, x: number, y: number): number {
  const rings = profile.rings.filter((r) => r.length >= 6);
  if (rings.length === 0) return 1e5;

  /*
   * A union is the minimum of the rings' own **signed** distances, which is how
   * every other union in this program is written. Taking the smallest magnitude
   * and deciding the sign separately is not the same thing, and the difference
   * is not subtle: inside one ring but next to another's boundary it reports a
   * distance of nearly nothing, so a shell of that thickness leaves a wall
   * standing along every interior outline. Reported from a drawing of eleven
   * overlapping circles, where that is most of them.
   *
   * Even-odd is the other case, and there the smallest magnitude *is* right,
   * because every ring's boundary really does bound the region.
   */
  if (profile.fill === 'outline') {
    let best = Infinity;
    for (const ring of rings) {
      const d = distanceToRing(ring, x, y);
      const signed = insideRing(ring, x, y) ? -d : d;
      if (signed < best) best = signed;
    }
    return best;
  }

  let magnitude = Infinity;
  for (const ring of rings) {
    const d = distanceToRing(ring, x, y);
    if (d < magnitude) magnitude = d;
  }

  let inside = false;
  for (const ring of rings) if (insideRing(ring, x, y)) inside = !inside;

  return inside ? -magnitude : magnitude;
}

export function profileBounds(profile: Profile2D) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of profile.rings) {
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * Centre a profile on the origin and scale it so its longest axis is `size` mm.
 *
 * The same choice mesh import made, and for the same reason: a drawing arrives
 * at whatever size the editor left it, often in points or at 96 dpi, and the
 * actual thought is "make this 180 mm across" rather than "multiply by 2.37".
 * Uniform, so the distance property survives.
 */
export function fitProfile(rings: number[][], size: number): number[][] {
  const box = profileBounds({ rings, fill: 'outline' });
  const longest = Math.max(box.w, box.h);
  if (longest <= 0) return rings.map((r) => r.slice());

  const scale = size / longest;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;

  return rings.map((ring) => {
    const out = new Array<number>(ring.length);
    for (let i = 0; i < ring.length; i += 2) {
      out[i] = (ring[i] - cx) * scale;
      out[i + 1] = (ring[i + 1] - cy) * scale;
    }
    return out;
  });
}

/**
 * Centre a profile's rings on the origin, size untouched.
 *
 * This is the Centre button for a morph key. Mixing distances only lines up
 * what the drawings line up: two outlines drawn in opposite corners of their
 * pages morph through a sideways sweep nobody asked for. Centring each key's
 * bounding box is the cheap, predictable alignment; anything finer than that
 * is done in the drawing, where the tools for it live.
 */
export function centreProfile(rings: number[][]): number[][] {
  if (rings.length === 0) return [];
  const box = profileBounds({ rings, fill: 'outline' });
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return rings.map((ring) => {
    const out = new Array<number>(ring.length);
    for (let i = 0; i < ring.length; i += 2) {
      out[i] = ring[i] - cx;
      out[i + 1] = ring[i + 1] - cy;
    }
    return out;
  });
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

/** How finely curves are flattened, in user units. */
const CURVE_STEPS = 24;

function numbers(text: string): number[] {
  const out: number[] = [];
  const re = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[0]));
  return out;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** `transform="translate(..) scale(..) rotate(..) matrix(..)"`, left to right. */
export function parseTransform(text: string): Matrix {
  let out: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const v = numbers(m[2]);
    let step: Matrix = IDENTITY;
    if (m[1] === 'matrix' && v.length >= 6) step = [v[0], v[1], v[2], v[3], v[4], v[5]];
    else if (m[1] === 'translate') step = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (m[1] === 'scale') step = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (m[1] === 'rotate') {
      const a = ((v[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
      if (v.length >= 3) {
        step = multiply(multiply([1, 0, 0, 1, v[1], v[2]], rot), [1, 0, 0, 1, -v[1], -v[2]]);
      } else step = rot;
    }
    out = multiply(out, step);
  }
  return out;
}

/**
 * One `d` attribute as closed rings, in SVG coordinates.
 *
 * Curves are flattened; arcs are converted through their centre form. Only
 * closed subpaths become rings — an open one has no inside, so there is nothing
 * a profile could do with it, and dropping it is reported.
 */
export function parsePath(d: string, warnings: string[] = []): number[][] {
  const rings: number[][] = [];
  let current: number[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl: [number, number] | null = null;
  let openDropped = false;

  const push = (px: number, py: number) => {
    if (current.length >= 2 && Math.hypot(px - current[current.length - 2], py - current[current.length - 1]) < 1e-9) {
      return;
    }
    current.push(px, py);
  };

  const finish = (closed: boolean) => {
    if (current.length >= 6) {
      if (closed) rings.push(current);
      else openDropped = true;
    }
    current = [];
  };

  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let command = '';

  const next = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const token = tokens[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(token)) {
      command = token;
      i++;
    } else if (command === 'M') command = 'L';
    else if (command === 'm') command = 'l';

    const rel = command === command.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;

    switch (command.toUpperCase()) {
      case 'M': {
        finish(false);
        x = next() + ox;
        y = next() + oy;
        startX = x;
        startY = y;
        push(x, y);
        lastControl = null;
        break;
      }
      case 'L': {
        x = next() + ox;
        y = next() + oy;
        push(x, y);
        lastControl = null;
        break;
      }
      case 'H': {
        x = next() + ox;
        push(x, y);
        lastControl = null;
        break;
      }
      case 'V': {
        y = next() + oy;
        push(x, y);
        lastControl = null;
        break;
      }
      case 'C':
      case 'S': {
        let c1x: number;
        let c1y: number;
        if (command.toUpperCase() === 'C') {
          c1x = next() + ox;
          c1y = next() + oy;
        } else {
          // The reflection of the previous control point, which is what makes a
          // smooth curve smooth.
          c1x = lastControl ? 2 * x - lastControl[0] : x;
          c1y = lastControl ? 2 * y - lastControl[1] : y;
        }
        const c2x = next() + ox;
        const c2y = next() + oy;
        const ex = next() + ox;
        const ey = next() + oy;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          push(
            u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
            u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
          );
        }
        lastControl = [c2x, c2y];
        x = ex;
        y = ey;
        break;
      }
      case 'Q':
      case 'T': {
        let cx: number;
        let cy: number;
        if (command.toUpperCase() === 'Q') {
          cx = next() + ox;
          cy = next() + oy;
        } else {
          cx = lastControl ? 2 * x - lastControl[0] : x;
          cy = lastControl ? 2 * y - lastControl[1] : y;
        }
        const ex = next() + ox;
        const ey = next() + oy;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          push(u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey);
        }
        lastControl = [cx, cy];
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const rx = Math.abs(next());
        const ry = Math.abs(next());
        const rotation = (next() * Math.PI) / 180;
        const largeArc = next() !== 0;
        const sweep = next() !== 0;
        const ex = next() + ox;
        const ey = next() + oy;
        flattenArc(push, x, y, rx, ry, rotation, largeArc, sweep, ex, ey);
        x = ex;
        y = ey;
        lastControl = null;
        break;
      }
      case 'Z': {
        x = startX;
        y = startY;
        finish(true);
        lastControl = null;
        break;
      }
      default:
        i++;
    }
  }

  finish(false);
  if (openDropped) {
    warnings.push('An open subpath was skipped: a profile needs a closed outline.');
  }
  return rings;
}

/** Endpoint arc to centre form, then sampled. The formulae are the spec's. */
function flattenArc(
  push: (x: number, y: number) => void,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotation: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): void {
  if (rx === 0 || ry === 0) {
    push(x2, y2);
    return;
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;

  // An ellipse too small to reach both endpoints is grown until it does, which
  // is what the spec asks for rather than an error.
  let rxs = rx * rx;
  let rys = ry * ry;
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
  if (lambda > 1) {
    const grow = Math.sqrt(lambda);
    rx *= grow;
    ry *= grow;
    rxs = rx * rx;
    rys = ry * ry;
  }

  const denominator = rxs * y1p * y1p + rys * x1p * x1p;
  const factor = Math.sqrt(Math.max((rxs * rys - denominator) / denominator, 0)) *
    (largeArc === sweep ? -1 : 1);
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(Math.max(len === 0 ? 1 : dot / len, -1), 1));
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let sweepAngle = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;

  const steps = Math.max(4, Math.ceil((Math.abs(sweepAngle) / (Math.PI * 2)) * CURVE_STEPS * 2));
  for (let s = 1; s <= steps; s++) {
    const a = start + (sweepAngle * s) / steps;
    const px = Math.cos(a) * rx;
    const py = Math.sin(a) * ry;
    push(cos * px - sin * py + cx, sin * px + cos * py + cy);
  }
}

function attribute(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`)) ??
    tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`));
  return m ? m[1] : null;
}

function ellipseRing(cx: number, cy: number, rx: number, ry: number): number[] {
  const ring: number[] = [];
  const steps = CURVE_STEPS * 2;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return ring;
}

/**
 * Every closed outline in an SVG, in millimetres with y up.
 *
 * Text and images are not read, and say so. Groups contribute their transform,
 * which is what makes an Inkscape drawing land where it looks like it should
 * rather than somewhere off the page.
 */
export function parseSvg(text: string): ProfileParse {
  const warnings: string[] = [];
  const rings: number[][] = [];

  // A group's transform applies to everything until its close. Tracking that
  // needs the tags in order, which is why this walks rather than matches.
  const stack: Matrix[] = [IDENTITY];
  const tagRe = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(text)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3];
    const selfClosing = m[4] === '/';

    if (name === 'g') {
      if (closing) {
        if (stack.length > 1) stack.pop();
      } else if (!selfClosing) {
        const t = attribute(attrs, 'transform');
        stack.push(multiply(stack[stack.length - 1], t ? parseTransform(t) : IDENTITY));
      }
      continue;
    }
    if (closing) continue;

    const own = attribute(attrs, 'transform');
    const frame = multiply(stack[stack.length - 1], own ? parseTransform(own) : IDENTITY);

    let local: number[][] = [];
    if (name === 'path') {
      const d = attribute(attrs, 'd');
      if (d) local = parsePath(d, warnings);
    } else if (name === 'rect') {
      const x = Number(attribute(attrs, 'x') ?? 0);
      const y = Number(attribute(attrs, 'y') ?? 0);
      const w = Number(attribute(attrs, 'width') ?? 0);
      const h = Number(attribute(attrs, 'height') ?? 0);
      if (w > 0 && h > 0) local = [[x, y, x + w, y, x + w, y + h, x, y + h]];
    } else if (name === 'circle') {
      const r = Number(attribute(attrs, 'r') ?? 0);
      if (r > 0) {
        local = [ellipseRing(Number(attribute(attrs, 'cx') ?? 0), Number(attribute(attrs, 'cy') ?? 0), r, r)];
      }
    } else if (name === 'ellipse') {
      const rx = Number(attribute(attrs, 'rx') ?? 0);
      const ry = Number(attribute(attrs, 'ry') ?? 0);
      if (rx > 0 && ry > 0) {
        local = [ellipseRing(Number(attribute(attrs, 'cx') ?? 0), Number(attribute(attrs, 'cy') ?? 0), rx, ry)];
      }
    } else if (name === 'polygon' || name === 'polyline') {
      const points = numbers(attribute(attrs, 'points') ?? '');
      if (points.length >= 6) local = [points];
      if (name === 'polyline' && points.length >= 6) {
        warnings.push('A polyline was closed to make a ring.');
      }
    } else if (name === 'text' || name === 'image') {
      warnings.push(`<${name}> is not read. Convert it to a path in your editor.`);
    }

    for (const ring of local) {
      const out = new Array<number>(ring.length);
      for (let i = 0; i < ring.length; i += 2) {
        const [px, py] = apply(frame, ring[i], ring[i + 1]);
        out[i] = px;
        // SVG's y axis points down. Flipped once, here, so nothing downstream
        // has to remember — and so an import is not silently mirrored.
        out[i + 1] = -py;
      }
      rings.push(out);
    }
  }

  if (rings.length === 0) warnings.push('No closed outlines found.');
  return { rings, warnings };
}

/* ------------------------------------------------------------------ *
 * The index, which is the whole cost of doing it this way
 *
 * Measured before it was written: a 200-segment profile costs 17 microseconds a
 * sample, which is **6.2 seconds** for one preview grid. A real drawing with
 * flattened curves has thousands of segments, so the naive walk is not slow, it
 * is unusable.
 *
 * This is the third time this project has needed the same idea — sculpt strokes
 * index whole strokes, `EdgeIndex` in `pattern.ts` buckets contour segments,
 * and now this. They cannot share code, because each of these modules is loaded
 * by a validator as the real thing and may not import. The duplication is
 * deliberate and worth knowing about: if a fourth one appears, the rule is
 * probably worth revisiting rather than copying again.
 *
 * Two structures, because the two questions are different shapes:
 *
 * - **distance** wants segments near a point, so they go in a uniform grid and
 *   the search walks rings of cells outward, stopping as soon as the best
 *   distance found is closer than the next ring could possibly be.
 * - **inside or out** wants every segment a horizontal ray crosses, so they go
 *   in row bands and the ray test walks one band instead of the whole outline.
 * ------------------------------------------------------------------ */

export interface ProfileIndex {
  fill: FillRule;
  /** Segment endpoints, four numbers each. */
  segments: Float64Array;
  /** Which ring each segment belongs to, so parity can be counted per ring. */
  ringOf: Int32Array;
  ringCount: number;
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  /** Segment indices per grid cell. */
  cells: Int32Array[];
  /** Segment indices per row band, for the crossing test. */
  bands: Int32Array[];
  /**
   * How far out the distance is exact, mm. Beyond it the magnitude is clamped.
   *
   * The same contract mesh import already has, and for the same reason: a field
   * only has to be true where anything reads it — a contour, a kerf iso-level, a
   * blend — and walking the whole outline to be exact a metre away costs the
   * same as being exact where it matters. The sign stays right everywhere,
   * because parity is cheap.
   */
  reach: number;
}

/**
 * Bucket a profile's segments.
 *
 * `target` is roughly how many segments should land in a cell — the grid is
 * sized from the outline's own extent so a small drawing and a large one both
 * get a useful cell rather than a fixed millimetre size that suits neither.
 */
export function indexProfile(
  profile: Profile2D,
  /*
   * One segment a cell, measured rather than guessed. Bigger cells are slower,
   * not faster: the cost is in testing segments, not in walking cells, and a
   * coarse grid makes every query test a handful it did not need.
   */
  target = 1,
  /*
   * Six percent of the outline's own size. Same trade as a mesh import's reach
   * — and the same warning belongs with it, since a blend wider than this reads
   * a clamped distance.
   */
  reachFraction = 0.06,
  /**
   * A floor for the reach, in millimetres.
   *
   * The caller usually knows something this cannot: a shell takes its wall off
   * the **inside**, so it needs the interior distance to be real at least a wall
   * deep. Where it is clamped instead, the cavity lands on the clamp — and on a
   * complicated outline that reads as stray lines through the middle of the
   * shape, which is not what anybody would guess from looking at it.
   *
   * A mesh import cannot do this: its grid is baked once and the reach is fixed
   * with it. A profile's index is rebuilt on every composition, so it can be
   * told what this lamp actually needs and pay for exactly that.
   */
  minReach = 0,
): ProfileIndex {
  // Every ring is indexed, whichever rule is in force. A union needs each ring's
  // own signed distance, so none of them can be discarded up front.
  const rings = profile.rings.filter((r) => r.length >= 6);

  const flat: number[] = [];
  const owner: number[] = [];
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      flat.push(ring[i], ring[i + 1], ring[j], ring[j + 1]);
      owner.push(r);
    }
  });

  const box = profileBounds({ rings, fill: profile.fill });
  const count = Math.max(owner.length, 1);
  const span = Math.max(box.w, box.h, 1e-6);
  const cell = Math.max((span * Math.sqrt(target)) / Math.sqrt(count), span / 512, 1e-6);

  const cols = Math.max(1, Math.ceil(box.w / cell) + 1);
  const rows = Math.max(1, Math.ceil(box.h / cell) + 1);

  const cellLists: number[][] = Array.from({ length: cols * rows }, () => []);
  const bandLists: number[][] = Array.from({ length: rows }, () => []);

  for (let s = 0; s < owner.length; s++) {
    const ax = flat[s * 4];
    const ay = flat[s * 4 + 1];
    const bx = flat[s * 4 + 2];
    const by = flat[s * 4 + 3];

    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - box.minX) / cell));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) - box.minX) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - box.minY) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) - box.minY) / cell));

    for (let r = r0; r <= r1; r++) {
      bandLists[r].push(s);
      for (let c = c0; c <= c1; c++) cellLists[r * cols + c].push(s);
    }
  }

  return {
    reach: Math.max(span * reachFraction, cell * 2, minReach),
    fill: profile.fill,
    segments: Float64Array.from(flat),
    ringOf: Int32Array.from(owner),
    ringCount: rings.length,
    minX: box.minX,
    minY: box.minY,
    cell,
    cols,
    rows,
    cells: cellLists.map((list) => Int32Array.from(list)),
    bands: bandLists.map((list) => Int32Array.from(list)),
  };
}

/**
 * Squared distance, because the inner loop runs millions of times.
 *
 * `Math.hypot` is careful about overflow and pays for it; comparing squares and
 * taking one root at the end gives the same answer for a third of the cost.
 */
function segmentDistanceSquared(index: ProfileIndex, s: number, x: number, y: number): number {
  const ax = index.segments[s * 4];
  const ay = index.segments[s * 4 + 1];
  const ex = index.segments[s * 4 + 2] - ax;
  const ey = index.segments[s * 4 + 3] - ay;
  const len2 = ex * ex + ey * ey;
  let t = len2 === 0 ? 0 : ((x - ax) * ex + (y - ay) * ey) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (ax + ex * t);
  const dy = y - (ay + ey * t);
  return dx * dx + dy * dy;
}

/**
 * Signed distance to an indexed profile. Identical to `profileDistance`, and a
 * validator holds it to that: an index that is subtly wrong is a shape that is
 * subtly wrong, which is exactly what nobody notices before cutting.
 */
export function indexedDistance(
  index: ProfileIndex,
  x: number,
  y: number,
  /** Exact out to here; beyond it the magnitude is clamped. */
  reach = Infinity,
): number {
  if (index.ringOf.length === 0) return 1e5;

  const col = Math.floor((x - index.minX) / index.cell);
  const row = Math.floor((y - index.minY) / index.cell);

  const bestPerRing = new Float64Array(index.ringCount).fill(Infinity);
  let bestSquared = Infinity;
  const stopAt = Math.min(reach, index.reach);
  const maxRing = Math.ceil(stopAt / index.cell) + 1;

  for (let ring = 0; ring <= maxRing; ring++) {
    /*
     * After rings 0..ring-1, everything unexamined sits in a cell at least
     * `ring` cells away, and the nearest point of such a cell is at least
     * `(ring - 1) * cell` from anywhere in the middle cell.
     *
     * The first version used `ring * cell`, which is one ring too generous: it
     * stopped while a closer segment was still unexamined and the field came
     * out up to a cell wrong — 5.2 mm on a real drawing, which is a shape
     * nobody would notice was wrong until it was cut.
     */
    if (ring > 0) {
      const bound = (ring - 1) * index.cell;
      if (bestSquared <= bound * bound) break;
    }

    for (let r = row - ring; r <= row + ring; r++) {
      if (r < 0 || r >= index.rows) continue;
      const edge = r === row - ring || r === row + ring;
      for (let c = col - ring; c <= col + ring; c++) {
        if (c < 0 || c >= index.cols) continue;
        if (!edge && c !== col - ring && c !== col + ring) continue;
        const list = index.cells[r * index.cols + c];
        for (let k = 0; k < list.length; k++) {
          const s = list[k];
          const d = segmentDistanceSquared(index, s, x, y);
          if (d < bestSquared) bestSquared = d;
          const ring = index.ringOf[s];
          if (d < bestPerRing[ring]) bestPerRing[ring] = d;
        }
      }
    }
  }

  // Nothing found within the reach: clamped, not invented.
  let best = Number.isFinite(bestSquared) ? Math.sqrt(bestSquared) : stopAt;
  if (best > stopAt) best = stopAt;

  // Parity from the row band, which is every segment a horizontal ray could
  // cross and no others.
  const crossings = new Int32Array(index.ringCount);
  const band = row >= 0 && row < index.rows ? index.bands[row] : null;
  if (band) {
    for (let k = 0; k < band.length; k++) {
      const s = band[k];
      const ay = index.segments[s * 4 + 1];
      const by = index.segments[s * 4 + 3];
      if (ay > y === by > y) continue;
      const ax = index.segments[s * 4];
      const bx = index.segments[s * 4 + 2];
      if (x < ((bx - ax) * (y - ay)) / (by - ay) + ax) crossings[index.ringOf[s]]++;
    }
  }

  /*
   * A union is the minimum of the rings' own signed distances, not the smallest
   * magnitude with a sign bolted on. Inside one ring and beside another's
   * boundary, the second reading says "almost at the edge" when the point is
   * deep in material — and a shell believes it, leaving a wall along every
   * interior outline.
   *
   * A ring whose boundary was not found inside the reach reads as the clamp,
   * which is the same contract the magnitude already carries.
   */
  if (index.fill === 'outline') {
    let union = Infinity;
    for (let r = 0; r < index.ringCount; r++) {
      const magnitude = Number.isFinite(bestPerRing[r])
        ? Math.min(Math.sqrt(bestPerRing[r]), stopAt)
        : stopAt;
      const signed = crossings[r] % 2 === 1 ? -magnitude : magnitude;
      if (signed < union) union = signed;
    }
    return union;
  }

  // Even-odd, where the smallest magnitude really is the nearest boundary of
  // the region, because every ring bounds it.
  let total = 0;
  for (let r = 0; r < index.ringCount; r++) total += crossings[r];
  return total % 2 === 1 ? -best : best;
}

/**
 * The profile extruded, as a 3D distance.
 *
 * `round` takes a radius off every edge of the resulting solid — the profile
 * shrinks by it, the height shrinks by it, and the whole thing is offset back
 * out. That is the same trick `roundBox` uses, and it means a rounded profile
 * is still an exact distance field rather than an approximation.
 */
export function extrudeProfile(
  index: ProfileIndex,
  height: number,
  round: number,
  x: number,
  y: number,
  z: number,
): number {
  const r = Math.max(round, 0);
  const half = Math.max(height / 2 - r, 0);

  const plane = indexedDistance(index, x, y) + r;
  const slab = Math.abs(z) - half;

  const outside = Math.hypot(Math.max(plane, 0), Math.max(slab, 0));
  return Math.min(Math.max(plane, slab), 0) + outside - r;
}

/* ------------------------------------------------------------------ *
 * Morphing between key profiles
 *
 * A morph is a stack of key profiles at heights, and the solid between two
 * keys is their distances **mixed**, not their polygons matched. That is the
 * whole reason profiles are kept as fields: two outlines interpolate with no
 * correspondence between their points to work out, and a topology change —
 * one ring at the bottom, two at the top — costs nothing, because a mix of
 * two continuous fields is continuous and its zero level splits on its own.
 *
 * WHAT THE MIX DOES TO THE DISTANCE PROPERTY, measured rather than reasoned
 * away: a convex combination of two 1-Lipschitz plane fields is 1-Lipschitz
 * in the plane, so the in-plane gradient never exceeds 1 and the kerf
 * iso-shift can only *over*-compensate — by 1/|∇|, and only where the two
 * keys' nearest edges point in different directions, which is near a topology
 * transition. The validator measures the gradient near the surface on a real
 * transition; the normalisation trick the superellipsoid uses stays on the
 * shelf unless that measurement demands it.
 *
 * The vertical gradient is a different matter: a wall that slants because the
 * outline grows reads its horizontal distance, which overstates the true 3D
 * distance by the slant. Slicing and kerf never read that — both work in the
 * slice plane — so the cost lands only on 3D blends against other features
 * and on the preview normal, and it is worth knowing rather than worth
 * fixing.
 * ------------------------------------------------------------------ */

export type MorphEasing = 'linear' | 'smooth';

export interface MorphEntry {
  /** Height of this key in the feature's local Z, millimetres. */
  z: number;
  /** The key's outline, indexed. Rings are fitted and centred before this. */
  index: ProfileIndex;
}

/**
 * Smoothstep between keys, or straight interpolation.
 *
 * `smooth` is 3t² − 2t³: its derivative is zero at both ends, so the field is
 * C¹ across a key plane and the crease a linear mix leaves in the stack at
 * every key disappears. It stays inside [0, 1], so the mix is still a convex
 * combination and the Lipschitz argument above survives unchanged. And it
 * crosses 0.5 exactly at the midpoint, so halfway between two keys the two
 * easings agree — which is what lets one geometric check in the validator
 * cover both.
 */
export function easeMorph(t: number, easing: MorphEasing): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return easing === 'smooth' ? c * c * (3 - 2 * c) : c;
}

/**
 * Signed in-plane distance at height z, mixed between the bracketing keys.
 *
 * Entries are expected sorted by ascending z, few enough that a linear scan
 * beats anything cleverer. Below the first key the first profile holds and
 * above the last the last one does — **clamped, not faded**, for the same
 * reason the layer lookup extrapolates: the extrusion's slab is a `max`
 * against this value at its own edge, and a value that changed outside the
 * slab would eat material at the slab's edge.
 *
 * Exactly on a key plane only that key's index is evaluated, so a slice taken
 * on a key is that profile bit for bit — the identity that keeps a morph
 * honest about the drawings it was given.
 *
 * Two keys on the same height would divide by zero; the span guard hands the
 * whole segment to the lower key instead. The parser reports the duplicate
 * (phase 2); this only has to survive it.
 */
export function morphPlaneDistance(
  entries: MorphEntry[],
  easing: MorphEasing,
  x: number,
  y: number,
  z: number,
  reach = Infinity,
): number {
  const n = entries.length;
  if (n === 0) return 1e5;
  if (z <= entries[0].z) return indexedDistance(entries[0].index, x, y, reach);
  if (z >= entries[n - 1].z) return indexedDistance(entries[n - 1].index, x, y, reach);

  let k = 0;
  while (entries[k + 1].z < z) k++;

  const floor = entries[k];
  const ceil = entries[k + 1];
  const span = ceil.z - floor.z;
  const t = span > 1e-9 ? (z - floor.z) / span : 0;
  const e = easeMorph(t, easing);

  if (e <= 0) return indexedDistance(floor.index, x, y, reach);
  if (e >= 1) return indexedDistance(ceil.index, x, y, reach);
  return (
    (1 - e) * indexedDistance(floor.index, x, y, reach) +
    e * indexedDistance(ceil.index, x, y, reach)
  );
}

/**
 * The morph extruded, as a 3D distance: the mixed plane against the slab
 * between the first and last key, combined exactly the way `extrudeProfile`
 * combines them, `round` included. Two identical keys are therefore the plain
 * extrusion — bit for bit on the key planes, within a rounding step between
 * them, since a mix of two equal numbers is not the IEEE identity — and a
 * validator holds it there.
 *
 * Fewer than two keys is refused with the empty sentinel rather than guessed
 * at: a morph with one key has no span to fill. The pipeline falls back to
 * `extrudeProfile` for that case and says so, which is phase 2's job; this
 * only has to refuse rather than invent a height.
 */
export function extrudeMorph(
  entries: MorphEntry[],
  easing: MorphEasing,
  round: number,
  x: number,
  y: number,
  z: number,
): number {
  const n = entries.length;
  if (n < 2) return 1e5;

  const z0 = entries[0].z;
  const z1 = entries[n - 1].z;
  const r = Math.max(round, 0);

  const plane = morphPlaneDistance(entries, easing, x, y, z) + r;
  // The slab shrinks by at most its own half-span, exactly as `extrudeProfile`
  // clamps `half` at zero, so a round larger than the height cannot invert it.
  const slab = Math.max(z0 - z, z - z1) + Math.min(r, (z1 - z0) / 2);

  const outside = Math.hypot(Math.max(plane, 0), Math.max(slab, 0));
  return Math.min(Math.max(plane, slab), 0) + outside - r;
}
