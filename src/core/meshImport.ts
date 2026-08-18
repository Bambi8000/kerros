/**
 * Kerros mesh import.
 *
 * STL, binary and ASCII, and OBJ. The output is a triangle soup and nothing
 * else: no normals, no materials, no groups. Kerros only ever asks a mesh one
 * question — how far is this point from your surface, and which side is it on —
 * and a soup answers that as well as anything richer would.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

export interface TriangleSoup {
  /** Nine numbers per triangle: three vertices, x y z each. */
  positions: Float64Array;
  triangleCount: number;
  min: [number, number, number];
  max: [number, number, number];
  /** What the file called itself, when it said. */
  name: string;
  format: 'stl-binary' | 'stl-ascii' | 'obj';
}

export interface ImportReport {
  soup: TriangleSoup | null;
  error: string | null;
  warnings: string[];
}

const BINARY_HEADER = 84;
const BINARY_TRIANGLE = 50;

function boundsOf(positions: Float64Array, count: number) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count * 9; i += 3) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
    if (positions[i + 2] < minZ) minZ = positions[i + 2];
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
  }

  return {
    min: [minX, minY, minZ] as [number, number, number],
    max: [maxX, maxY, maxZ] as [number, number, number],
  };
}

/**
 * Is this a binary STL?
 *
 * Not by looking for the word "solid" at the front: plenty of binary STLs start
 * with it, having been written by a program that filled the 80-byte header with
 * whatever it liked. The reliable test is arithmetic — a binary STL's length is
 * exactly 84 bytes plus 50 per triangle.
 */
export function looksBinarySTL(bytes: Uint8Array): boolean {
  if (bytes.byteLength < BINARY_HEADER) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  return bytes.byteLength === BINARY_HEADER + count * BINARY_TRIANGLE;
}

function parseBinarySTL(bytes: Uint8Array, warnings: string[]): TriangleSoup {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const positions = new Float64Array(count * 9);

  let out = 0;
  for (let t = 0; t < count; t++) {
    // 12 bytes of face normal, which we do not use: the sign comes from the
    // geometry itself, and a file's normals are as often wrong as right.
    let at = BINARY_HEADER + t * BINARY_TRIANGLE + 12;
    for (let v = 0; v < 9; v++) {
      positions[out++] = view.getFloat32(at, true);
      at += 4;
    }
  }

  if (count === 0) warnings.push('The file declares no triangles.');

  return {
    positions,
    triangleCount: count,
    ...boundsOf(positions, count),
    name: '',
    format: 'stl-binary',
  };
}

function parseAsciiSTL(text: string, warnings: string[]): TriangleSoup {
  const values: number[] = [];
  let name = '';
  let malformed = 0;

  const solid = /^\s*solid\s+(.*)$/m.exec(text);
  if (solid) name = solid[1].trim();

  const vertex = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let match = vertex.exec(text);
  while (match !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      values.push(x, y, z);
    } else {
      malformed++;
    }
    match = vertex.exec(text);
  }

  const spare = values.length % 9;
  if (spare !== 0) {
    warnings.push('The last facet was incomplete and was dropped.');
    values.length -= spare;
  }
  if (malformed > 0) {
    warnings.push(`${malformed} vertices had unreadable numbers and were skipped.`);
  }

  const positions = new Float64Array(values);
  const count = values.length / 9;

  return {
    positions,
    triangleCount: count,
    ...boundsOf(positions, count),
    name,
    format: 'stl-ascii',
  };
}

function parseOBJ(text: string, warnings: string[]): TriangleSoup {
  const vertices: number[] = [];
  const values: number[] = [];
  let name = '';
  let skipped = 0;

  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    if (line.startsWith('o ')) {
      if (name === '') name = line.slice(2).trim();
      continue;
    }

    if (line.startsWith('v ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        vertices.push(x, y, z);
      } else {
        skipped++;
      }
      continue;
    }

    if (!line.startsWith('f ')) continue;

    // Faces index vertices from 1, or from the end when negative, and each
    // entry may carry texture and normal indices we have no use for.
    const refs = line.slice(2).trim().split(/\s+/);
    const corners: number[] = [];
    for (const ref of refs) {
      const first = ref.split('/')[0];
      let index = Number(first);
      if (!Number.isFinite(index) || index === 0) {
        skipped++;
        continue;
      }
      if (index < 0) index = vertices.length / 3 + index + 1;
      if (index < 1 || index > vertices.length / 3) {
        skipped++;
        continue;
      }
      corners.push(index - 1);
    }

    // Fan triangulation. Correct for convex faces, which is what exporters
    // produce; a concave quad would come out slightly wrong, and saying so is
    // better than pretending otherwise.
    for (let i = 1; i + 1 < corners.length; i++) {
      for (const corner of [corners[0], corners[i], corners[i + 1]]) {
        values.push(
          vertices[corner * 3],
          vertices[corner * 3 + 1],
          vertices[corner * 3 + 2],
        );
      }
    }
  }

  if (skipped > 0) warnings.push(`${skipped} face or vertex entries were unreadable.`);

  const positions = new Float64Array(values);
  const count = values.length / 9;

  return {
    positions,
    triangleCount: count,
    ...boundsOf(positions, count),
    name,
    format: 'obj',
  };
}

/**
 * Read a mesh from bytes.
 *
 * `filename` only picks between STL and OBJ; the STL flavour is worked out from
 * the bytes.
 */
export function importMesh(bytes: Uint8Array, filename: string): ImportReport {
  const warnings: string[] = [];
  const lower = filename.toLowerCase();

  try {
    let soup: TriangleSoup;

    if (lower.endsWith('.obj')) {
      soup = parseOBJ(new TextDecoder().decode(bytes), warnings);
    } else if (looksBinarySTL(bytes)) {
      soup = parseBinarySTL(bytes, warnings);
    } else {
      soup = parseAsciiSTL(new TextDecoder().decode(bytes), warnings);
    }

    if (soup.triangleCount === 0) {
      return { soup: null, error: 'No triangles could be read from that file.', warnings };
    }

    return { soup, error: null, warnings };
  } catch (error) {
    return { soup: null, error: String(error), warnings };
  }
}

/**
 * How many edges are used by only one triangle.
 *
 * Zero means watertight, which is what the inside/outside test needs to be
 * right. Anything else is reported rather than refused: a mesh with a few holes
 * usually still voxelises usefully, and the person is better placed to judge
 * that than the program is.
 */
export function openEdgeCount(soup: TriangleSoup): number {
  const counts = new Map<string, number>();
  const key = (a: number, b: number) => {
    // Rounded, because exported meshes rarely share vertices exactly.
    const p = soup.positions;
    const one = `${p[a].toFixed(4)},${p[a + 1].toFixed(4)},${p[a + 2].toFixed(4)}`;
    const two = `${p[b].toFixed(4)},${p[b + 1].toFixed(4)},${p[b + 2].toFixed(4)}`;
    return one < two ? `${one}|${two}` : `${two}|${one}`;
  };

  for (let t = 0; t < soup.triangleCount; t++) {
    const base = t * 9;
    for (const [i, j] of [
      [0, 3],
      [3, 6],
      [6, 0],
    ]) {
      const k = key(base + i, base + j);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  let open = 0;
  for (const n of counts.values()) if (n !== 2) open++;
  return open;
}
