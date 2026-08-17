#!/usr/bin/env node
/**
 * validate-surfacenets.mjs
 *
 * Imports the REAL src/core/surfaceNets.ts and the REAL sdf core, and meshes
 * actual fields. Checks accuracy against analytic surfaces, watertightness,
 * outward winding, and determinism.
 *
 *   node tools/validate-surfacenets.mjs
 */

import { surfaceNets } from '../src/core/surfaceNets.ts';
import { evaluateGrid, defaultParams, findModule } from '../src/core/sdf.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** Build a grid analytically so the mesher is tested in isolation. */
function fieldGrid(fn, half, n) {
  const step = (2 * half) / (n - 1);
  const data = new Float32Array(n * n * n);
  let idx = 0;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        data[idx++] = fn(-half + i * step, -half + j * step, -half + k * step);
      }
    }
  }
  return { data, dims: [n, n, n], min: [-half, -half, -half], step };
}

/** Undirected edge use counts. A closed manifold uses every edge exactly twice. */
function edgeUseCounts(indices) {
  const counts = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Signed volume from the triangle soup. Positive means outward winding. */
function signedVolume(positions, indices) {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    vol +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

console.log('surfaceNets: sphere r=40');
{
  const R = 40;
  const grid = fieldGrid((x, y, z) => Math.sqrt(x * x + y * y + z * z) - R, 60, 48);
  const mesh = surfaceNets(grid);

  check('produces vertices', mesh.vertexCount > 500, `got ${mesh.vertexCount}`);
  check('produces triangles', mesh.triangleCount > 1000, `got ${mesh.triangleCount}`);

  let maxErr = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const r = Math.sqrt(
      mesh.positions[i] ** 2 + mesh.positions[i + 1] ** 2 + mesh.positions[i + 2] ** 2,
    );
    maxErr = Math.max(maxErr, Math.abs(r - R));
  }
  check(
    'all vertices lie within one voxel of the true surface',
    maxErr < grid.step,
    `max error ${maxErr.toFixed(3)} mm, step ${grid.step.toFixed(3)} mm`,
  );

  const counts = edgeUseCounts(mesh.indices);
  let nonManifold = 0;
  for (const n of counts.values()) if (n !== 2) nonManifold++;
  check('mesh is watertight (every edge used twice)', nonManifold === 0, `${nonManifold} bad edges`);

  const vol = signedVolume(mesh.positions, mesh.indices);
  const trueVol = (4 / 3) * Math.PI * R ** 3;
  check('winding is outward (positive volume)', vol > 0, `volume ${vol.toFixed(0)}`);
  check(
    'volume is within 3% of analytic',
    Math.abs(vol - trueVol) / trueVol < 0.03,
    `got ${vol.toFixed(0)}, expected ${trueVol.toFixed(0)}`,
  );

  const again = surfaceNets(grid);
  let identical = again.positions.length === mesh.positions.length;
  for (let i = 0; identical && i < mesh.positions.length; i++) {
    if (mesh.positions[i] !== again.positions[i]) identical = false;
  }
  check('meshing is bit-identical on repeat', identical);
}

console.log('surfaceNets: torus (genus 1, checks the hole)');
{
  const R = 50;
  const r = 15;
  const grid = fieldGrid(
    (x, y, z) => {
      const q = Math.sqrt(x * x + y * y) - R;
      return Math.sqrt(q * q + z * z) - r;
    },
    80,
    64,
  );
  const mesh = surfaceNets(grid);
  const counts = edgeUseCounts(mesh.indices);
  let nonManifold = 0;
  for (const n of counts.values()) if (n !== 2) nonManifold++;

  check('torus is watertight', nonManifold === 0, `${nonManifold} bad edges`);
  const vol = signedVolume(mesh.positions, mesh.indices);
  const trueVol = 2 * Math.PI ** 2 * R * r * r;
  check('torus winding is outward', vol > 0);
  check(
    'torus volume is within 4% of analytic',
    Math.abs(vol - trueVol) / trueVol < 0.04,
    `got ${vol.toFixed(0)}, expected ${trueVol.toFixed(0)}`,
  );
}

console.log('surfaceNets: two blended spheres through the real pipeline');
{
  const sphere = findModule('sphere');
  const tree = [
    { kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'union', r: 30, px: -25 } },
    { kind: 'sphere', enabled: true, params: { ...defaultParams(sphere), op: 'smoothUnion', k: 25, r: 30, px: 25 } },
  ];
  const grid = evaluateGrid(tree, 48);
  const mesh = surfaceNets(grid);

  check('blend meshes to a single closed surface', mesh.triangleCount > 0);
  const counts = edgeUseCounts(mesh.indices);
  let nonManifold = 0;
  for (const n of counts.values()) if (n !== 2) nonManifold++;
  check('blended shape is watertight', nonManifold === 0, `${nonManifold} bad edges`);
  check('blended shape winding is outward', signedVolume(mesh.positions, mesh.indices) > 0);

  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]);
    maxX = Math.max(maxX, mesh.positions[i]);
  }
  check('blend spans both spheres', minX < -50 && maxX > 50, `x range ${minX.toFixed(1)} .. ${maxX.toFixed(1)}`);
}

console.log('surfaceNets: degenerate input');
{
  const empty = surfaceNets({
    data: new Float32Array(8).fill(1),
    dims: [2, 2, 2],
    min: [0, 0, 0],
    step: 1,
  });
  check('all-outside grid yields no geometry', empty.vertexCount === 0 && empty.triangleCount === 0);

  const tiny = surfaceNets({ data: new Float32Array(1), dims: [1, 1, 1], min: [0, 0, 0], step: 1 });
  check('1x1x1 grid is handled without throwing', tiny.vertexCount === 0);

  const solid = surfaceNets({
    data: new Float32Array(27).fill(-1),
    dims: [3, 3, 3],
    min: [0, 0, 0],
    step: 1,
  });
  check('all-inside grid yields no geometry', solid.triangleCount === 0);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    surface nets');
