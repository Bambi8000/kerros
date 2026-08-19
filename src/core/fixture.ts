/**
 * Kerros fixtures — the parts that make it a lamp rather than a sculpture.
 *
 * A socket mount, a cable channel and a chamber for Wago connectors. All three
 * are dimensioned holes in specific sheets, so they are applied per slice like
 * rod clearances rather than as volumes in the field. That is the right choice
 * for the same reason it is right for perforation: a socket hole belongs to the
 * one layer that carries the socket, and the layer where a carved volume
 * happens to be 2 mm across is the layer that tears.
 *
 * Every dimension here is a **default, not a fact**. Sockets vary by
 * manufacturer, Wago cases vary by series, and cable varies by whatever was in
 * the drawer. Measure the part in your hand before the first cut — the
 * inspector says so too.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

export const FIXTURE_KINDS = ['socket', 'cable', 'chamber'] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export const FIXTURE_LABELS: Record<FixtureKind, string> = {
  socket: 'E27 socket mount',
  cable: 'Cable channel',
  chamber: 'Wago chamber',
};

/**
 * How an E27 socket is held.
 *
 *   nipple  the socket's threaded tube passes through — an M10 lamp nipple,
 *           10.5 mm clearance, and the socket is clamped by its own nut
 *   body    the socket body drops through and sits on its shoulder, about
 *           40.5 mm, which varies more between makes than anything else here
 */
export const SOCKET_PRESETS: Record<string, number> = {
  nipple: 10.5,
  body: 40.5,
};

/**
 * The part of a parent's transform a flat, Z-aligned feature can follow.
 *
 * Translation and rotation about Z, and no more. A socket hole belongs to one
 * horizontal sheet; inheriting a parent's X or Y rotation would tip it out of
 * that sheet and there is nowhere for it to go. Structurally identical to
 * `WindowFrame`, and for the same reason — both describe what a feature that
 * lives in layers can inherit — but declared here so neither module has to
 * import the other.
 */
export interface PlaneFrame {
  x: number;
  y: number;
  z: number;
  /** Rotation about Z, degrees. */
  rz: number;
}

export const PLANE_WORLD: PlaneFrame = { x: 0, y: 0, z: 0, rz: 0 };

export interface FixtureSpec {
  id: string;
  label: string;
  kind: FixtureKind;

  /** Centre on the bed, mm. */
  x: number;
  y: number;
  /** Middle of the band of layers this applies to, mm. */
  z: number;
  /** Height of that band, mm. One layer pitch does one layer. */
  length: number;
  /** Turned about its own centre, degrees. */
  rot: number;

  kerf: number;

  /* socket */
  /** 'nipple', 'body', or anything else to use `diameter`. */
  preset: string;
  /** Used when the preset is not a known one. */
  diameter: number;
  /** Screws around the main hole. 0 for none. */
  screws: number;
  /** Diameter of the circle the screws sit on, mm. */
  boltCircle: number;
  /** Finished diameter of each screw hole, mm. */
  screwDiameter: number;

  /* cable */
  /** 'round' or 'slot'. */
  shape: string;
  /** Straight length of a slot, mm. Its width is `diameter`. */
  slotLength: number;

  /* chamber */
  width: number;
  depth: number;
  /** Corner radius of the pocket, mm. */
  corner: number;
}

export interface FixtureCircle {
  x: number;
  y: number;
  /** Radius of the cut path, kerf-compensated. */
  r: number;
  label: string;
}

export interface FixtureHoles {
  circles: FixtureCircle[];
  /** Closed rings, flat [x0, y0, ...], wound clockwise as holes are. */
  polygons: number[][];
}

const DEG = Math.PI / 180;
const EMPTY: FixtureHoles = { circles: [], polygons: [] };

/** Finished diameter of a socket's main hole. */
export function socketDiameter(spec: FixtureSpec): number {
  const preset = SOCKET_PRESETS[spec.preset];
  return preset ?? Math.max(spec.diameter, 0.2);
}

/** Cut radius for a finished hole: the laser widens it by half a kerf. */
export function cutRadius(diameter: number, kerf: number): number {
  return Math.max(diameter / 2 - Math.max(kerf, 0) / 2, 0.05);
}

/** Does this fixture reach the plane a slice was taken on? */
export function fixtureSpansZ(spec: FixtureSpec, z: number): boolean {
  const half = Math.max(spec.length, 0) / 2;
  return z >= spec.z - half && z <= spec.z + half;
}

/**
 * A rounded rectangle as a closed ring, wound clockwise.
 *
 * Clockwise because it is always used as a hole, and the slicer classifies
 * rings by the sign of their area. Getting this backwards would make a pocket
 * read as a separate part.
 */
export function roundedRect(
  cx: number,
  cy: number,
  width: number,
  height: number,
  radius: number,
  rotDeg = 0,
  segments = 8,
): number[] {
  const w = Math.max(width, 0.1) / 2;
  const h = Math.max(height, 0.1) / 2;
  const r = Math.max(Math.min(radius, w, h), 0);

  const corners: [number, number, number][] = [
    [w - r, h - r, 0],
    [-(w - r), h - r, 90],
    [-(w - r), -(h - r), 180],
    [w - r, -(h - r), 270],
  ];

  const local: number[] = [];
  for (const [ox, oy, start] of corners) {
    if (r <= 0) {
      local.push(ox, oy);
      continue;
    }
    for (let i = 0; i <= segments; i++) {
      const a = (start + (i / segments) * 90) * DEG;
      local.push(ox + r * Math.cos(a), oy + r * Math.sin(a));
    }
  }

  // Built counter-clockwise above, so reverse it into hole winding.
  const cos = Math.cos(rotDeg * DEG);
  const sin = Math.sin(rotDeg * DEG);
  const out: number[] = [];
  for (let i = local.length - 2; i >= 0; i -= 2) {
    const lx = local[i];
    const ly = local[i + 1];
    out.push(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
  }
  return out;
}

/**
 * The holes one fixture puts in one slice.
 *
 * Kerf is applied here, arithmetically: a hole is cut smaller than it needs to
 * end up, because the beam widens it. Circles shrink by half a kerf on the
 * radius; pockets shrink by a whole kerf on each overall dimension.
 */
export function fixtureHolesAt(spec: FixtureSpec, z: number): FixtureHoles {
  if (!fixtureSpansZ(spec, z)) return EMPTY;

  const kerf = Math.max(spec.kerf, 0);

  if (spec.kind === 'socket') {
    const circles: FixtureCircle[] = [
      {
        x: spec.x,
        y: spec.y,
        r: cutRadius(socketDiameter(spec), kerf),
        label: `${spec.label} socket`,
      },
    ];

    const screws = Math.max(Math.round(spec.screws), 0);
    if (screws > 0 && spec.screwDiameter > 0) {
      const ring = Math.max(spec.boltCircle, 0) / 2;
      for (let i = 0; i < screws; i++) {
        const a = (spec.rot + (i / screws) * 360) * DEG;
        circles.push({
          x: spec.x + ring * Math.cos(a),
          y: spec.y + ring * Math.sin(a),
          r: cutRadius(spec.screwDiameter, kerf),
          label: `${spec.label} screw`,
        });
      }
    }

    return { circles, polygons: [] };
  }

  if (spec.kind === 'cable') {
    if (spec.shape === 'slot') {
      // A slot is a rounded rectangle whose corner radius is half its width,
      // which is exactly the shape a cable wants to lie in.
      const width = Math.max(spec.diameter - kerf, 0.1);
      const length = Math.max(spec.slotLength - kerf, width);
      return {
        circles: [],
        polygons: [roundedRect(spec.x, spec.y, length, width, width / 2, spec.rot)],
      };
    }

    return {
      circles: [
        {
          x: spec.x,
          y: spec.y,
          r: cutRadius(Math.max(spec.diameter, 0.2), kerf),
          label: `${spec.label} cable`,
        },
      ],
      polygons: [],
    };
  }

  // chamber
  return {
    circles: [],
    polygons: [
      roundedRect(
        spec.x,
        spec.y,
        Math.max(spec.width - kerf, 0.1),
        Math.max(spec.depth - kerf, 0.1),
        Math.max(spec.corner - kerf / 2, 0),
        spec.rot,
      ),
    ],
  };
}

/**
 * Widest dimension a fixture needs, for warning about layers too small to
 * carry it before anything is cut.
 */
export function fixtureExtent(spec: FixtureSpec): number {
  if (spec.kind === 'socket') {
    const main = socketDiameter(spec);
    const screws =
      Math.round(spec.screws) > 0 ? spec.boltCircle + spec.screwDiameter : 0;
    return Math.max(main, screws);
  }
  if (spec.kind === 'cable') {
    return spec.shape === 'slot' ? Math.max(spec.slotLength, spec.diameter) : spec.diameter;
  }
  return Math.hypot(spec.width, spec.depth);
}

/**
 * A spec with its placement resolved into world terms.
 *
 * The stored numbers are in the parent's frame; everything downstream — the
 * band test, the hole positions, the bolt circle — works in world coordinates,
 * so the conversion happens once here rather than at every use.
 */
export function resolveFixture(spec: FixtureSpec, frame: PlaneFrame): FixtureSpec {
  if (frame.x === 0 && frame.y === 0 && frame.z === 0 && frame.rz === 0) return spec;

  const a = (frame.rz * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  return {
    ...spec,
    x: frame.x + spec.x * cos - spec.y * sin,
    y: frame.y + spec.x * sin + spec.y * cos,
    z: frame.z + spec.z,
    // The fixture's own rotation and the frame's add: a turned plate carries a
    // turned bolt circle.
    rot: spec.rot + frame.rz,
  };
}

/** The inverse, for writing a world-space drag back into stored parameters. */
export function localiseFixture(
  world: { x: number; y: number; z: number; rot: number },
  frame: PlaneFrame,
): { x: number; y: number; z: number; rot: number } {
  const a = (-frame.rz * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = world.x - frame.x;
  const dy = world.y - frame.y;

  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
    z: world.z - frame.z,
    rot: world.rot - frame.rz,
  };
}
