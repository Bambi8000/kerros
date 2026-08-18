/**
 * Kerros voxeliser: a triangle soup into a signed distance grid.
 *
 * Two halves, computed differently on purpose.
 *
 * **Magnitude** is the exact distance from each grid point to the nearest
 * triangle, found through a broad phase over triangles — the same structure the
 * sculpt strokes use, for the same reason: one bucket lookup beats walking rings
 * of cells, and a linear scan of the few triangles nearby is cheap.
 *
 * **Sign** comes from crossing counts along the grid's own Z lines, not from
 * casting a ray per sample. Because the samples are a regular lattice, every
 * column can be done once: collect where triangles cross that line, sort them,
 * and inside alternates between them. Exact parity, computed once per column
 * rather than a million times, and with none of the flakiness of picking a
 * nearest triangle's normal at a crease.
 *
 * The handoff planned to use three-mesh-bvh. That is a three.js dependency, and
 * slicing happens in a field the validators load in Node with no three at all.
 * Doing the search here keeps that boundary and costs about forty lines.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

export interface MeshGrid {
  data: Float32Array;
  dims: [number, number, number];
  min: [number, number, number];
  step: number;
  /**
   * Distances are exact out to here and clamped beyond it, inside and out.
   *
   * This is the number that decides whether an import can be shelled. A shell
   * takes its wall off the inside, so it needs the interior distance to be real
   * at least a wall's depth in; where the field is clamped, the cavity surface
   * lands on the clamp instead of where it belongs. Hence a reach that scales
   * with the object rather than a fixed count of cells.
   */
  reach: number;
}

export interface VoxeliseOptions {
  /** Samples along the longest axis. */
  resolution: number;
  /** Air left around the mesh, in cells. */
  pad?: number;
  /** How far from the surface distances stay exact, in cells. */
  reachCells?: number;
}

export interface VoxeliseReport {
  grid: MeshGrid;
  /** Grid points found inside the mesh. Zero means the sign test found nothing. */
  insideCount: number;
  ms: number;
}

interface Soup {
  positions: Float64Array;
  triangleCount: number;
  min: [number, number, number];
  max: [number, number, number];
}

/* ------------------------------------------------------------------ *
 * Point to triangle
 * ------------------------------------------------------------------ */

/**
 * Exact squared distance from a point to a triangle.
 *
 * The standard region-by-region solution: project into the triangle's plane,
 * and when the projection falls outside, fall back to the nearest edge or
 * corner. Squared, because the caller only ever compares.
 */
function pointTriangleSquared(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    const qx = apx - t * abx;
    const qy = apy - t * aby;
    const qz = apz - t * abz;
    return qx * qx + qy * qy + qz * qz;
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    const qx = apx - t * acx;
    const qy = apy - t * acy;
    const qz = apz - t * acz;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bpx + t * (cx - bx);
    const qy = bpy + t * (cy - by);
    const qz = bpz + t * (cz - bz);
    return qx * qx + qy * qy + qz * qz;
  }

  // Inside the face: the perpendicular distance to the plane.
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = apx - (v * abx + w * acx);
  const qy = apy - (v * aby + w * acy);
  const qz = apz - (v * abz + w * acz);
  return qx * qx + qy * qy + qz * qz;
}

/* ------------------------------------------------------------------ *
 * Voxelise
 * ------------------------------------------------------------------ */

export function voxelise(soup: Soup, options: VoxeliseOptions): VoxeliseReport {
  const started = Date.now();

  const resolution = Math.max(8, Math.round(options.resolution));
  const sizeX = soup.max[0] - soup.min[0];
  const sizeY = soup.max[1] - soup.min[1];
  const sizeZ = soup.max[2] - soup.min[2];
  const longest = Math.max(sizeX, sizeY, sizeZ, 1e-6);
  const step = longest / resolution;

  // Scaled to the object, not fixed: 15% of the longest axis is deep enough for
  // any wall thickness anyone would cut from sheet, on a 40 mm trinket and on a
  // 400 mm shade alike. A fixed eight cells is 5 mm on the first and 50 on the
  // second, and the first is not enough.
  const reachCells = Math.max(options.reachCells ?? Math.round(resolution * 0.15), 4);
  // The pad has to be at least the reach, or the band of exact distances is cut
  // off by the edge of the box and a blend reaching past the surface reads the
  // out-of-grid fallback instead of a real distance.
  const padCells = Math.max(options.pad ?? 3, reachCells, 1);
  const pad = padCells * step;
  const reach = reachCells * step;

  const minX = soup.min[0] - pad;
  const minY = soup.min[1] - pad;
  const minZ = soup.min[2] - pad;
  const nx = Math.ceil((sizeX + 2 * pad) / step) + 1;
  const ny = Math.ceil((sizeY + 2 * pad) / step) + 1;
  const nz = Math.ceil((sizeZ + 2 * pad) / step) + 1;

  const data = new Float32Array(nx * ny * nz);
  data.fill(reach);

  /* --- broad phase: triangles bucketed on a coarse XY-Z grid --- */

  const cell = Math.max(reach, step * 2);
  const buckets = new Map<string, number[]>();
  const p = soup.positions;

  for (let t = 0; t < soup.triangleCount; t++) {
    const b = t * 9;
    const lo = [
      Math.min(p[b], p[b + 3], p[b + 6]) - reach,
      Math.min(p[b + 1], p[b + 4], p[b + 7]) - reach,
      Math.min(p[b + 2], p[b + 5], p[b + 8]) - reach,
    ];
    const hi = [
      Math.max(p[b], p[b + 3], p[b + 6]) + reach,
      Math.max(p[b + 1], p[b + 4], p[b + 7]) + reach,
      Math.max(p[b + 2], p[b + 5], p[b + 8]) + reach,
    ];

    for (let cx = Math.floor(lo[0] / cell); cx <= Math.floor(hi[0] / cell); cx++) {
      for (let cy = Math.floor(lo[1] / cell); cy <= Math.floor(hi[1] / cell); cy++) {
        for (let cz = Math.floor(lo[2] / cell); cz <= Math.floor(hi[2] / cell); cz++) {
          const key = `${cx}:${cy}:${cz}`;
          const bucket = buckets.get(key);
          if (bucket) bucket.push(b);
          else buckets.set(key, [b]);
        }
      }
    }
  }

  /* --- magnitude --- */

  const reachSquared = reach * reach;
  for (let k = 0; k < nz; k++) {
    const z = minZ + k * step;
    const cz = Math.floor(z / cell);
    for (let j = 0; j < ny; j++) {
      const y = minY + j * step;
      const cy = Math.floor(y / cell);
      for (let i = 0; i < nx; i++) {
        const x = minX + i * step;
        const bucket = buckets.get(`${Math.floor(x / cell)}:${cy}:${cz}`);
        if (!bucket) continue;

        let best = reachSquared;
        for (const b of bucket) {
          const d = pointTriangleSquared(
            x, y, z,
            p[b], p[b + 1], p[b + 2],
            p[b + 3], p[b + 4], p[b + 5],
            p[b + 6], p[b + 7], p[b + 8],
          );
          if (d < best) best = d;
        }
        if (best < reachSquared) data[i + nx * (j + ny * k)] = Math.sqrt(best);
      }
    }
  }

  /* --- sign, by crossings along each Z column --- */

  /*
   * The parity lines are nudged a hair off the grid points.
   *
   * The half-open barycentric test below makes a shared *edge* count exactly
   * once, which is what parity needs. A shared *vertex* is another matter: four
   * or more triangles meet there, several of them accept the hit, and the count
   * comes out even with zero-length inside spans. A symmetric mesh puts that
   * case squarely on the axis — a sphere's poles at x = y = 0, with grid points
   * landing exactly on them — so it is not a rare accident, it is the first
   * thing that happens.
   *
   * Offsetting by a fraction of a cell in both axes makes exact vertex hits
   * effectively impossible. It moves the inside/outside decision by 2% of a cell
   * near the silhouette and nowhere else, and it does not touch the distance
   * magnitudes at all, which are what put the surface where it is.
   */
  const jitterX = step * 0.0137;
  const jitterY = step * 0.0219;

  const crossings = new Map<number, number[]>();

  for (let t = 0; t < soup.triangleCount; t++) {
    const b = t * 9;
    const ax = p[b];
    const ay = p[b + 1];
    const az = p[b + 2];
    const bx = p[b + 3];
    const by = p[b + 4];
    const bz = p[b + 5];
    const cx2 = p[b + 6];
    const cy2 = p[b + 7];
    const cz2 = p[b + 8];

    const loI = Math.max(Math.ceil((Math.min(ax, bx, cx2) - minX) / step), 0);
    const hiI = Math.min(Math.floor((Math.max(ax, bx, cx2) - minX) / step), nx - 1);
    const loJ = Math.max(Math.ceil((Math.min(ay, by, cy2) - minY) / step), 0);
    const hiJ = Math.min(Math.floor((Math.max(ay, by, cy2) - minY) / step), ny - 1);
    if (hiI < loI || hiJ < loJ) continue;

    // Barycentric solve in XY for a vertical line through the column.
    const e1x = bx - ax;
    const e1y = by - ay;
    const e2x = cx2 - ax;
    const e2y = cy2 - ay;
    const denom = e1x * e2y - e2x * e1y;
    if (denom === 0) continue;

    for (let j = loJ; j <= hiJ; j++) {
      const y = minY + j * step + jitterY;
      for (let i = loI; i <= hiI; i++) {
        const x = minX + i * step + jitterX;
        const rx = x - ax;
        const ry = y - ay;
        const u = (rx * e2y - e2x * ry) / denom;
        const v = (e1x * ry - rx * e1y) / denom;

        // Half-open on purpose: a line through a shared edge is then counted by
        // exactly one of the two triangles, so parity survives it.
        if (u < 0 || v < 0 || u + v >= 1) continue;

        const z = az + u * (bz - az) + v * (cz2 - az);
        const key = i + nx * j;
        const list = crossings.get(key);
        if (list) list.push(z);
        else crossings.set(key, [z]);
      }
    }
  }

  let insideCount = 0;
  for (const [key, list] of crossings) {
    if (list.length < 2) continue;
    list.sort((a, b) => a - b);

    const i = key % nx;
    const j = (key - i) / nx;

    // Between the first and second crossing is inside, between the second and
    // third outside, and so on. An odd count means the mesh leaks; the last
    // span is dropped rather than run to the top of the grid.
    const pairs = Math.floor(list.length / 2);
    for (let s = 0; s < pairs; s++) {
      const from = list[s * 2];
      const to = list[s * 2 + 1];
      const kFrom = Math.max(Math.ceil((from - minZ) / step), 0);
      const kTo = Math.min(Math.floor((to - minZ) / step), nz - 1);
      for (let k = kFrom; k <= kTo; k++) {
        const at = i + nx * (j + ny * k);
        data[at] = -data[at];
        insideCount++;
      }
    }
  }

  return {
    grid: { data, dims: [nx, ny, nz], min: [minX, minY, minZ], step, reach },
    insideCount,
    ms: Date.now() - started,
  };
}

/**
 * Read the grid at any point, by trilinear interpolation.
 *
 * Outside the grid the field is the distance to the grid box plus the reach,
 * which is not the true distance to the mesh but is always positive and grows
 * the right way — enough for a union to ignore it and for a blend to fade out.
 */
export function sampleMeshGrid(grid: MeshGrid, x: number, y: number, z: number): number {
  const [nx, ny, nz] = grid.dims;
  const step = grid.step;

  const fx = (x - grid.min[0]) / step;
  const fy = (y - grid.min[1]) / step;
  const fz = (z - grid.min[2]) / step;

  if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) {
    const dx = Math.max(grid.min[0] - x, x - (grid.min[0] + (nx - 1) * step), 0);
    const dy = Math.max(grid.min[1] - y, y - (grid.min[1] + (ny - 1) * step), 0);
    const dz = Math.max(grid.min[2] - z, z - (grid.min[2] + (nz - 1) * step), 0);
    return grid.reach + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  const i = Math.min(Math.floor(fx), nx - 2);
  const j = Math.min(Math.floor(fy), ny - 2);
  const k = Math.min(Math.floor(fz), nz - 2);
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;

  const at = (a: number, b: number, c: number) => grid.data[a + nx * (b + ny * c)];

  const c00 = at(i, j, k) * (1 - tx) + at(i + 1, j, k) * tx;
  const c10 = at(i, j + 1, k) * (1 - tx) + at(i + 1, j + 1, k) * tx;
  const c01 = at(i, j, k + 1) * (1 - tx) + at(i + 1, j, k + 1) * tx;
  const c11 = at(i, j + 1, k + 1) * (1 - tx) + at(i + 1, j + 1, k + 1) * tx;

  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;

  return c0 * (1 - tz) + c1 * tz;
}

/** World bounds of a grid's box. */
export function meshGridBounds(grid: MeshGrid): {
  min: [number, number, number];
  max: [number, number, number];
} {
  return {
    min: [grid.min[0], grid.min[1], grid.min[2]],
    max: [
      grid.min[0] + (grid.dims[0] - 1) * grid.step,
      grid.min[1] + (grid.dims[1] - 1) * grid.step,
      grid.min[2] + (grid.dims[2] - 1) * grid.step,
    ],
  };
}
