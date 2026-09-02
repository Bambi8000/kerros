/**
 * Kerros project files.
 *
 * A `.kerros.json` holds everything needed to reproduce a lamp: the machine and
 * material profiles it was designed against, the whole feature tree, the seed,
 * the slicing settings and every hand placement. Transient interface state —
 * which mode is open, which layer is showing, what is selected — is
 * deliberately left out: it is not part of the design.
 *
 * Parsing is defensive. A project file is the one thing a person will keep for
 * years, will edit by hand, and will open in a newer build than the one that
 * wrote it. Anything unreadable is reported as a warning and skipped rather
 * than throwing, so a file with one bad feature still opens.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

export const PROJECT_FORMAT = 'kerros-project';
export const PROJECT_FORMAT_VERSION = 1;

export type ParamValue = number | string | boolean;

export interface ProjectStroke {
  op: string;
  radius: number;
  k: number;
  points: number[];
}

/** One key of a morphing profile. Its rings are not saved; the path is. */
export interface ProjectProfileKey {
  /** Height in the feature's local Z, mm. */
  z: number;
  /** Longest axis the outline is fitted to when its SVG is read, mm. */
  size: number;
  /** 'outline' or 'holes'. */
  fill: string;
  path: string;
}

export interface ProjectFeature {
  id: string;
  kind: string;
  stage: string;
  name: string;
  enabled: boolean;
  params: Record<string, ParamValue>;
  /** Sculpt features only. Omitted entirely when there are none. */
  strokes?: ProjectStroke[];
  /** Profile features only: morph keys. Omitted entirely when there are none. */
  keys?: ProjectProfileKey[];
}

export interface ProjectPlacement {
  sheet: number;
  dx: number;
  dy: number;
  rot: number;
}

export interface ProjectData {
  name: string;
  machine: { name: string; bedWidth: number; bedHeight: number; margin: number };
  material: { name: string; thickness: number; kerf: number; notes: string };
  stack: {
    spacerHeight: number;
    spacerHeightTop?: number;
    spacerHeightMid?: number;
    spacerThickness?: number;
    twistPerLayer?: number;
    twistOverrides?: string;
  };
  seed: number;
  features: ProjectFeature[];
  slicing: {
    sliceRes: number;
    sliceTolerance: number;
    sliceSmoothing: number;
    minFeature: number;
    previewRes: number;
  };
  layout: {
    partGap: number;
    labelHeight: number;
    ringWidth: number;
    makeSpacers: boolean;
    fluteDirection: string;
    flutePitch: number;
    scatterAngle: number;
    partPlacements: Record<string, ProjectPlacement>;
  };
}

export interface ProjectFile extends ProjectData {
  format: string;
  formatVersion: number;
  /** Version of Kerros that wrote it, for bug reports. */
  app: string;
  savedAt: string;
}

export interface ParseResult {
  ok: boolean;
  data: ProjectData | null;
  /** Everything that was wrong but survivable. */
  warnings: string[];
  /** Set when nothing could be read at all. */
  error: string | null;
  /** Highest `fN` id seen, so new features do not collide with loaded ones. */
  nextFeatureNumber: number;
}

/* ------------------------------------------------------------------ *
 * Coercion helpers
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export function serializeProject(data: ProjectData, appVersion: string, savedAt: string): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    app: appVersion,
    savedAt,
    ...data,
  };
  // Indented on purpose: this is a file people will read and diff.
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A filename that will not surprise anyone, derived from the project name. */
export function projectFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'kerros-project'}.kerros.json`;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const DEFAULTS: ProjectData = {
  name: 'Untitled',
  machine: { name: 'Laser 730x410', bedWidth: 730, bedHeight: 410, margin: 5 },
  material: { name: 'Material', thickness: 3, kerf: 0.15, notes: '' },
  // 0 for the ring thickness means "follow the stock", which is what a file
  // written before rings had their own material meant by saying nothing.
  stack: {
    spacerHeight: 6,
    spacerHeightMid: 6,
    spacerHeightTop: 6,
    spacerThickness: 0,
    twistPerLayer: 0,
    twistOverrides: '',
  },
  seed: 1,
  features: [],
  slicing: {
    sliceRes: 200,
    sliceTolerance: 0.05,
    sliceSmoothing: 1,
    minFeature: 1,
    previewRes: 64,
  },
  layout: {
    partGap: 4,
    labelHeight: 4,
    ringWidth: 4,
    makeSpacers: true,
    fluteDirection: 'horizontal',
    flutePitch: 6.5,
    scatterAngle: 180,
    partPlacements: {},
  },
};

const STAGES = ['SHAPE', 'CARVE', 'RIG', 'SLICE', 'PATTERN', 'LAYOUT', 'EXPORT'];

function parseFeature(
  raw: unknown,
  index: number,
  warnings: string[],
): ProjectFeature | null {
  const row = asRecord(raw);
  const kind = asString(row.kind, '');
  if (kind === '') {
    warnings.push(`Feature ${index + 1} has no kind and was skipped.`);
    return null;
  }

  const stage = asString(row.stage, 'SHAPE');
  if (!STAGES.includes(stage)) {
    warnings.push(`Feature ${index + 1} has unknown stage "${stage}"; treated as SHAPE.`);
  }

  const params: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(asRecord(row.params))) {
    if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    else if (typeof value === 'string' || typeof value === 'boolean') params[key] = value;
    else warnings.push(`Feature ${index + 1} parameter "${key}" was not a value and was dropped.`);
  }

  const feature: ProjectFeature = {
    id: asString(row.id, `f${index + 1}`),
    kind,
    stage: STAGES.includes(stage) ? stage : 'SHAPE',
    name: asString(row.name, kind),
    enabled: asBoolean(row.enabled, true),
    params,
  };

  if (Array.isArray(row.strokes)) {
    const strokes: ProjectStroke[] = [];
    row.strokes.forEach((raw2, at) => {
      const stroke = asRecord(raw2);
      const points = Array.isArray(stroke.points)
        ? stroke.points.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        : [];

      // Points come in threes. A trailing fragment means the file was truncated
      // or hand-edited, and half a coordinate is not a place.
      const usable = points.length - (points.length % 3);
      if (usable < 3) {
        warnings.push(`Feature ${index + 1} stroke ${at + 1} had no usable points and was dropped.`);
        return;
      }
      if (usable !== points.length) {
        warnings.push(`Feature ${index + 1} stroke ${at + 1} ended mid-point; the fragment was trimmed.`);
      }

      const radius = asNumber(stroke.radius, 0);
      if (!(radius > 0)) {
        warnings.push(`Feature ${index + 1} stroke ${at + 1} had no radius and was dropped.`);
        return;
      }

      strokes.push({
        op: asString(stroke.op, 'union'),
        radius,
        k: Math.max(asNumber(stroke.k, 0), 0),
        points: points.slice(0, usable),
      });
    });
    if (strokes.length > 0) feature.strokes = strokes;
  }

  if (Array.isArray(row.keys)) {
    const keys: ProjectProfileKey[] = [];
    row.keys.forEach((raw2, at) => {
      const key = asRecord(raw2);
      const z = asNumber(key.z, NaN);
      // A key is a profile at a height, and a key with no height is nowhere.
      if (!Number.isFinite(z)) {
        warnings.push(`Feature ${index + 1} key ${at + 1} had no height and was dropped.`);
        return;
      }
      const fill = asString(key.fill, 'holes');
      keys.push({
        z,
        size: Math.max(asNumber(key.size, 100), 0.1),
        fill: fill === 'outline' ? 'outline' : 'holes',
        path: asString(key.path, ''),
      });
    });

    /*
     * Sorted on the way in, so nothing downstream has to wonder. Rings are
     * deliberately not read even when a hand-edited file carries them: like
     * the profile's own rings, they are located again from the path, and a
     * file is not the place megabytes of outline belong.
     *
     * Two keys on one height survive — the field holds the lower one between
     * them rather than dividing by zero — but it is a thing to say, because
     * the person almost certainly meant to type two different numbers.
     */
    keys.sort((a, b) => a.z - b.z);
    for (let i = 1; i < keys.length; i++) {
      if (keys[i].z === keys[i - 1].z) {
        warnings.push(`Feature ${index + 1} has two keys at the same height (${keys[i].z} mm).`);
      }
    }
    if (keys.length > 0) feature.keys = keys;
  }

  return feature;
}

function parsePlacements(
  raw: unknown,
  warnings: string[],
): Record<string, ProjectPlacement> {
  const out: Record<string, ProjectPlacement> = {};
  for (const [id, value] of Object.entries(asRecord(raw))) {
    const row = asRecord(value);
    const sheet = Math.round(asNumber(row.sheet, 1));
    const dx = asNumber(row.dx, NaN);
    const dy = asNumber(row.dy, NaN);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      warnings.push(`Placement for "${id}" had no usable position and was dropped.`);
      continue;
    }
    out[id] = { sheet: Math.max(sheet, 1), dx, dy, rot: asNumber(row.rot, 0) };
  }
  return out;
}

/** Highest `fN` in a set of ids, so new features get fresh numbers. */
export function highestFeatureNumber(features: ProjectFeature[]): number {
  let highest = 0;
  for (const feature of features) {
    const match = /^f(\d+)$/.exec(feature.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      data: null,
      warnings: [],
      error: 'That file is not valid JSON.',
      nextFeatureNumber: 1,
    };
  }

  const file = asRecord(raw);
  const warnings: string[] = [];

  if (asString(file.format, '') !== PROJECT_FORMAT) {
    return {
      ok: false,
      data: null,
      warnings: [],
      error: 'That is not a Kerros project file.',
      nextFeatureNumber: 1,
    };
  }

  const formatVersion = asNumber(file.formatVersion, 0);
  if (formatVersion > PROJECT_FORMAT_VERSION) {
    // Refuse rather than guess: a newer file may mean things this build would
    // silently misread, and quietly wrong geometry is worse than not opening.
    return {
      ok: false,
      data: null,
      warnings: [],
      error: `That project was saved by a newer Kerros (format ${formatVersion}, this build reads ${PROJECT_FORMAT_VERSION}).`,
      nextFeatureNumber: 1,
    };
  }
  if (formatVersion < PROJECT_FORMAT_VERSION) {
    warnings.push(`Project format ${formatVersion} was upgraded to ${PROJECT_FORMAT_VERSION}.`);
  }

  const machine = asRecord(file.machine);
  const material = asRecord(file.material);
  const stack = asRecord(file.stack);
  const slicing = asRecord(file.slicing);
  const layout = asRecord(file.layout);

  const rawFeatures = Array.isArray(file.features) ? file.features : [];
  if (!Array.isArray(file.features)) {
    warnings.push('The project had no feature list; it opened empty.');
  }

  const features: ProjectFeature[] = [];
  rawFeatures.forEach((row, index) => {
    const feature = parseFeature(row, index, warnings);
    if (feature) features.push(feature);
  });

  const seen = new Set<string>();
  for (const feature of features) {
    if (seen.has(feature.id)) {
      warnings.push(`Duplicate feature id "${feature.id}"; it was renumbered.`);
      feature.id = `f${highestFeatureNumber(features) + 1}`;
    }
    seen.add(feature.id);
  }

  const data: ProjectData = {
    name: asString(file.name, DEFAULTS.name),
    machine: {
      name: asString(machine.name, DEFAULTS.machine.name),
      bedWidth: Math.max(asNumber(machine.bedWidth, DEFAULTS.machine.bedWidth), 1),
      bedHeight: Math.max(asNumber(machine.bedHeight, DEFAULTS.machine.bedHeight), 1),
      margin: Math.max(asNumber(machine.margin, DEFAULTS.machine.margin), 0),
    },
    material: {
      name: asString(material.name, DEFAULTS.material.name),
      thickness: Math.max(asNumber(material.thickness, DEFAULTS.material.thickness), 0.1),
      kerf: Math.max(asNumber(material.kerf, DEFAULTS.material.kerf), 0),
      notes: asString(material.notes, ''),
    },
    stack: {
      spacerHeight: Math.max(asNumber(stack.spacerHeight, DEFAULTS.stack.spacerHeight), 0),
      /*
       * All three default to the stack a file written before them described:
       * the middle and the top to the bottom gap, and the ring thickness to the
       * stock's. An older project therefore opens as exactly the lamp it was,
       * which is the whole reason the defaults are these and not something
       * tidier — and it is checked rather than promised.
       *
       * They are written bottom, middle, top because that is the order they are
       * physically in and the order the panel shows them.
       */
      spacerHeightMid: Math.max(
        asNumber(stack.spacerHeightMid, asNumber(stack.spacerHeight, 0)),
        0,
      ),
      spacerHeightTop: Math.max(
        asNumber(stack.spacerHeightTop, asNumber(stack.spacerHeight, DEFAULTS.stack.spacerHeight)),
        0,
      ),
      spacerThickness: Math.max(asNumber(stack.spacerThickness, 0), 0),
      /*
       * Absent means no twist, which is what every file written before this
       * existed meant by saying nothing. Clamped short of a full turn, since a
       * spiral of 360 a layer is the stack it already was.
       */
      twistPerLayer: Math.max(Math.min(asNumber(stack.twistPerLayer, 0), 359), -359),
      twistOverrides: typeof stack.twistOverrides === 'string' ? stack.twistOverrides : '',
    },
    seed: Math.max(Math.round(asNumber(file.seed, DEFAULTS.seed)), 0),
    features,
    slicing: {
      sliceRes: Math.max(asNumber(slicing.sliceRes, DEFAULTS.slicing.sliceRes), 16),
      sliceTolerance: Math.max(asNumber(slicing.sliceTolerance, DEFAULTS.slicing.sliceTolerance), 0),
      sliceSmoothing: Math.max(Math.round(asNumber(slicing.sliceSmoothing, DEFAULTS.slicing.sliceSmoothing)), 0),
      minFeature: Math.max(asNumber(slicing.minFeature, DEFAULTS.slicing.minFeature), 0),
      previewRes: Math.max(asNumber(slicing.previewRes, DEFAULTS.slicing.previewRes), 8),
    },
    layout: {
      partGap: Math.max(asNumber(layout.partGap, DEFAULTS.layout.partGap), 0),
      labelHeight: Math.max(asNumber(layout.labelHeight, DEFAULTS.layout.labelHeight), 0),
      ringWidth: Math.max(asNumber(layout.ringWidth, DEFAULTS.layout.ringWidth), 0.5),
      makeSpacers: asBoolean(layout.makeSpacers, DEFAULTS.layout.makeSpacers),
      fluteDirection: ['none', 'horizontal', 'vertical'].includes(
        asString(layout.fluteDirection, ''),
      )
        ? asString(layout.fluteDirection, DEFAULTS.layout.fluteDirection)
        : DEFAULTS.layout.fluteDirection,
      flutePitch: Math.max(asNumber(layout.flutePitch, DEFAULTS.layout.flutePitch), 0.5),
      scatterAngle: Math.min(
        Math.max(asNumber(layout.scatterAngle, DEFAULTS.layout.scatterAngle), 0),
        180,
      ),
      partPlacements: parsePlacements(layout.partPlacements, warnings),
    },
  };

  return {
    ok: true,
    data,
    warnings,
    error: null,
    nextFeatureNumber: highestFeatureNumber(features) + 1,
  };
}
