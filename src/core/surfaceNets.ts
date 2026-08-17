/**
 * Surface nets: isosurface extraction from a signed distance grid.
 *
 * Chosen over marching cubes for the preview mesh because it needs no 256x16
 * triangle table (that table is the bug farm), it is deterministic, and dual
 * vertices give smoother results on blended blobs. It rounds sharp edges more
 * than marching cubes at low resolution — acceptable for preview, and it has
 * no bearing on cut accuracy, since slicing samples the field directly.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

export interface GridLike {
  data: Float32Array;
  dims: [number, number, number];
  min: [number, number, number];
  step: number;
}

export interface SurfaceNetsResult {
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/**
 * The twelve cube edges as pairs of corner indices.
 * Corner c has offsets dx = c&1, dy = (c>>1)&1, dz = (c>>2)&1.
 */
const EDGES: number[][] = [
  [0, 1],
  [1, 3],
  [2, 3],
  [0, 2],
  [4, 5],
  [5, 7],
  [6, 7],
  [4, 6],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const EMPTY_RESULT: SurfaceNetsResult = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
};

export function surfaceNets(grid: GridLike, isoLevel = 0): SurfaceNetsResult {
  const [nx, ny, nz] = grid.dims;
  if (nx < 2 || ny < 2 || nz < 2) return EMPTY_RESULT;

  const { data, step } = grid;
  const [ox, oy, oz] = grid.min;

  // One dual vertex per cell at most. -1 means "no surface in this cell".
  const cellCount = (nx - 1) * (ny - 1) * (nz - 1);
  const vertexOf = new Int32Array(cellCount).fill(-1);

  const positions: number[] = [];
  const indices: number[] = [];
  const corner = new Float64Array(8);

  const sample = (i: number, j: number, k: number) => data[i + nx * (j + ny * k)];
  const cellIndex = (i: number, j: number, k: number) =>
    i + (nx - 1) * (j + (ny - 1) * k);

  // Pass 1: place one vertex inside every cell the surface crosses.
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = sample(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)) - isoLevel;
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let crossings = 0;

        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0];
          const b = EDGES[e][1];
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;

          const denom = va - vb;
          const t = denom === 0 ? 0.5 : va / denom;

          const ax = a & 1;
          const ay = (a >> 1) & 1;
          const az = (a >> 2) & 1;
          const bx = b & 1;
          const by = (b >> 1) & 1;
          const bz = (b >> 2) & 1;

          sx += ax + (bx - ax) * t;
          sy += ay + (by - ay) * t;
          sz += az + (bz - az) * t;
          crossings++;
        }

        if (crossings === 0) continue;

        vertexOf[cellIndex(i, j, k)] = positions.length / 3;
        positions.push(
          ox + (i + sx / crossings) * step,
          oy + (j + sy / crossings) * step,
          oz + (k + sz / crossings) * step,
        );
      }
    }
  }

  // Pass 2: for every grid edge that crosses the surface, join the four cells
  // that share it into a quad. Winding follows the sign so normals point out.
  const quad = (
    a: number,
    b: number,
    c: number,
    d: number,
    flip: boolean,
  ) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // `flip` is true when the edge's low corner is inside. The cell order below
    // is counter-clockwise seen from that corner, so the outward face is the
    // reversed one. The validator's signed-volume test is what pins this down.
    if (flip) {
      indices.push(a, b, c, a, c, d);
    } else {
      indices.push(a, c, b, a, d, c);
    }
  };

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v0 = sample(i, j, k) - isoLevel;
        const inside0 = v0 < 0;

        // Edge along X, shared by cells offset in -Y and -Z.
        if (j > 0 && k > 0) {
          const v1 = sample(i + 1, j, k) - isoLevel;
          if (inside0 !== v1 < 0) {
            quad(
              vertexOf[cellIndex(i, j, k)],
              vertexOf[cellIndex(i, j - 1, k)],
              vertexOf[cellIndex(i, j - 1, k - 1)],
              vertexOf[cellIndex(i, j, k - 1)],
              inside0,
            );
          }
        }

        // Edge along Y, shared by cells offset in -X and -Z.
        if (i > 0 && k > 0) {
          const v1 = sample(i, j + 1, k) - isoLevel;
          if (inside0 !== v1 < 0) {
            quad(
              vertexOf[cellIndex(i, j, k)],
              vertexOf[cellIndex(i, j, k - 1)],
              vertexOf[cellIndex(i - 1, j, k - 1)],
              vertexOf[cellIndex(i - 1, j, k)],
              inside0,
            );
          }
        }

        // Edge along Z, shared by cells offset in -X and -Y.
        if (i > 0 && j > 0) {
          const v1 = sample(i, j, k + 1) - isoLevel;
          if (inside0 !== v1 < 0) {
            quad(
              vertexOf[cellIndex(i, j, k)],
              vertexOf[cellIndex(i - 1, j, k)],
              vertexOf[cellIndex(i - 1, j - 1, k)],
              vertexOf[cellIndex(i, j - 1, k)],
              inside0,
            );
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}
