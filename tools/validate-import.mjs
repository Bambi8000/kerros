#!/usr/bin/env node
/**
 * validate-import.mjs
 *
 * Mesh import and voxelisation, checked against shapes whose signed distance is
 * known exactly: a cube and a sphere, built here rather than loaded, so the test
 * knows the right answer to compare against.
 *
 *   node tools/validate-import.mjs
 */

import {
  importMesh,
  looksBinarySTL,
  openEdgeCount,
} from '../src/core/meshImport.ts';

import { voxelise, sampleMeshGrid, meshGridBounds } from '../src/core/voxelise.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------- test meshes ---------- */

/** An axis-aligned box, watertight, twelve triangles. */
function boxTriangles(hx, hy, hz) {
  const v = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ];
  const out = [];
  for (const f of faces) for (const i of f) out.push(...v[i]);
  return out;
}

/** A sphere by subdividing an octahedron, watertight by construction. */
function sphereTriangles(radius, subdivisions) {
  const norm = (p) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l * radius, p[1] / l * radius, p[2] / l * radius];
  };
  let faces = [
    [[1,0,0],[0,1,0],[0,0,1]], [[0,1,0],[-1,0,0],[0,0,1]],
    [[-1,0,0],[0,-1,0],[0,0,1]], [[0,-1,0],[1,0,0],[0,0,1]],
    [[0,1,0],[1,0,0],[0,0,-1]], [[-1,0,0],[0,1,0],[0,0,-1]],
    [[0,-1,0],[-1,0,0],[0,0,-1]], [[1,0,0],[0,-1,0],[0,0,-1]],
  ].map((f) => f.map(norm));

  for (let s = 0; s < subdivisions; s++) {
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = norm([(a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2]);
      const bc = norm([(b[0]+c[0])/2, (b[1]+c[1])/2, (b[2]+c[2])/2]);
      const ca = norm([(c[0]+a[0])/2, (c[1]+a[1])/2, (c[2]+a[2])/2]);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    faces = next;
  }

  const out = [];
  for (const f of faces) for (const p of f) out.push(...p);
  return out;
}

function binarySTL(values) {
  const count = values.length / 9;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    let at = 84 + t * 50 + 12;
    for (let v = 0; v < 9; v++) {
      view.setFloat32(at, values[t * 9 + v], true);
      at += 4;
    }
  }
  return bytes;
}

function asciiSTL(values, name = 'test') {
  const lines = [`solid ${name}`];
  for (let t = 0; t < values.length / 9; t++) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (let v = 0; v < 3; v++) {
      const b = t * 9 + v * 3;
      lines.push(`      vertex ${values[b]} ${values[b + 1]} ${values[b + 2]}`);
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid');
  return new TextEncoder().encode(lines.join('\n'));
}

function objText(values) {
  const lines = ['o test'];
  const count = values.length / 9;
  for (let i = 0; i < count * 3; i++) {
    lines.push(`v ${values[i * 3]} ${values[i * 3 + 1]} ${values[i * 3 + 2]}`);
  }
  for (let t = 0; t < count; t++) {
    lines.push(`f ${t * 3 + 1}//1 ${t * 3 + 2}//1 ${t * 3 + 3}//1`);
  }
  return new TextEncoder().encode(lines.join('\n'));
}

const box = boxTriangles(20, 15, 10);

console.log('import: format detection');
{
  const bin = binarySTL(box);
  check('a binary STL is recognised by its length', looksBinarySTL(bin));
  check('an ASCII STL is not', !looksBinarySTL(asciiSTL(box)));

  // Plenty of binary STLs start with the word "solid", so the word cannot be
  // the test. Arithmetic can.
  const liar = binarySTL(box);
  new TextEncoder().encodeInto('solid exported by something', liar.subarray(0, 80));
  check('a binary STL that starts with "solid" is still read as binary', looksBinarySTL(liar));
  const readLiar = importMesh(liar, 'x.stl');
  check('and parses', readLiar.soup !== null && readLiar.soup.format === 'stl-binary');
  check('with all its triangles', readLiar.soup.triangleCount === 12);
}

console.log('import: the three formats agree');
{
  const fromBinary = importMesh(binarySTL(box), 'box.stl');
  const fromAscii = importMesh(asciiSTL(box), 'box.stl');
  const fromObj = importMesh(objText(box), 'box.obj');

  for (const [label, report] of [['binary', fromBinary], ['ascii', fromAscii], ['obj', fromObj]]) {
    check(`${label}: parses without error`, report.error === null, report.error ?? '');
    check(`${label}: twelve triangles`, report.soup.triangleCount === 12, `${report.soup?.triangleCount}`);
    check(
      `${label}: bounds match the box`,
      near(report.soup.min[0], -20, 1e-4) && near(report.soup.max[2], 10, 1e-4),
    );
    check(`${label}: watertight`, openEdgeCount(report.soup) === 0, `${openEdgeCount(report.soup)} open edges`);
  }

  check('the ASCII name is kept', fromAscii.soup.name === 'test');
  check('the OBJ name is kept', fromObj.soup.name === 'test');
  check('the format is recorded', fromObj.soup.format === 'obj');
}

console.log('import: bad input');
{
  check('empty bytes are refused', importMesh(new Uint8Array(0), 'x.stl').error !== null);
  check('garbage is refused rather than throwing', importMesh(new TextEncoder().encode('hello'), 'x.stl').error !== null);

  const truncated = new TextEncoder().encode(
    'solid x\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n',
  );
  const report = importMesh(truncated, 'x.stl');
  check('a half-written facet is dropped, not guessed', report.error !== null || report.soup.triangleCount === 0);

  const holed = importMesh(binarySTL(box.slice(0, box.length - 9)), 'x.stl');
  check('a mesh with a face missing still parses', holed.soup !== null);
  check('and its open edges are counted', openEdgeCount(holed.soup) > 0, `${openEdgeCount(holed.soup)}`);

  const negativeIndices = new TextEncoder().encode(
    'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n',
  );
  const wrapped = importMesh(negativeIndices, 'x.obj');
  check('OBJ negative indices count from the end', wrapped.soup.triangleCount === 1);

  const quad = new TextEncoder().encode(
    'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n',
  );
  check('an OBJ quad becomes two triangles', importMesh(quad, 'x.obj').soup.triangleCount === 2);
}

console.log('voxelise: a box, where the answer is known');
{
  const soup = importMesh(binarySTL(box), 'box.stl').soup;
  const { grid, insideCount, ms } = voxelise(soup, { resolution: 60 });

  check('it voxelises', grid.data.length > 1000, `${grid.data.length} samples in ${ms} ms`);
  check('and finds an inside', insideCount > 0, `${insideCount} samples inside`);

  const at = (x, y, z) => sampleMeshGrid(grid, x, y, z);

  check('the centre is inside', at(0, 0, 0) < 0);
  check('a corner region is outside', at(30, 30, 30) > 0);
  check('a face is near zero', Math.abs(at(20, 0, 0)) < grid.step, `${at(20, 0, 0).toFixed(3)}`);

  // Exact distances just outside each face.
  for (const [p, expected] of [
    [[25, 0, 0], 5],
    [[0, 20, 0], 5],
    [[0, 0, 14], 4],
  ]) {
    check(
      `distance outside a face at ${p.join(',')} is about ${expected}`,
      Math.abs(at(p[0], p[1], p[2]) - expected) < grid.step,
      `got ${at(p[0], p[1], p[2]).toFixed(3)}`,
    );
  }

  // And just inside, where the nearest face governs.
  check('inside near a face is negative and about right',
    Math.abs(at(16, 0, 0) + 4) < grid.step, `got ${at(16, 0, 0).toFixed(3)}`);

  check('the sign flips exactly once across a face',
    at(19, 0, 0) < 0 && at(21, 0, 0) > 0);

  const box3 = meshGridBounds(grid);
  check('the grid box contains the mesh with air to spare',
    box3.min[0] < -20 && box3.max[0] > 20);
}

console.log('voxelise: a sphere, against the analytic distance');
{
  const R = 30;
  const soup = importMesh(binarySTL(sphereTriangles(R, 3)), 'sphere.stl').soup;
  check('the test sphere is watertight', openEdgeCount(soup) === 0);

  const { grid } = voxelise(soup, { resolution: 64 });
  const at = (x, y, z) => sampleMeshGrid(grid, x, y, z);

  check('the centre is inside', at(0, 0, 0) < 0);
  check('far out is outside', at(60, 0, 0) > 0);

  // A subdivided octahedron sits slightly inside the true sphere, so allow the
  // chord error as well as the grid step.
  const tolerance = grid.step + 0.4;
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    const b = ((i * 7) % 200 / 200) * Math.PI - Math.PI / 2;
    for (const r of [R - 6, R, R + 6]) {
      const x = r * Math.cos(b) * Math.cos(a);
      const y = r * Math.cos(b) * Math.sin(a);
      const z = r * Math.sin(b);
      worst = Math.max(worst, Math.abs(at(x, y, z) - (r - R)));
    }
  }
  check(
    'signed distance matches the analytic sphere within a grid step',
    worst < tolerance,
    `worst ${worst.toFixed(3)} mm, tolerance ${tolerance.toFixed(3)}`,
  );

  const again = voxelise(soup, { resolution: 64 });
  let identical = again.grid.data.length === grid.data.length;
  for (let i = 0; identical && i < grid.data.length; i++) {
    if (again.grid.data[i] !== grid.data[i]) identical = false;
  }
  check('voxelising is bit-identical on repeat', identical);
}

console.log('voxelise: reach and resolution');
{
  const soup = importMesh(binarySTL(box), 'box.stl').soup;
  const coarse = voxelise(soup, { resolution: 24 });
  const fine = voxelise(soup, { resolution: 80 });

  check('a finer resolution gives a smaller step', fine.grid.step < coarse.grid.step);
  check('and more samples', fine.grid.data.length > coarse.grid.data.length);

  const centreCoarse = sampleMeshGrid(coarse.grid, 0, 0, 0);
  const centreFine = sampleMeshGrid(fine.grid, 0, 0, 0);
  check('both agree the centre is inside', centreCoarse < 0 && centreFine < 0);

  check(
    'distances are clamped at the reach rather than left wrong',
    sampleMeshGrid(fine.grid, 0, 0, 0) >= -fine.grid.reach - 1e-6,
  );

  // The reach has to scale with the object. A fixed cell count would give 5 mm
  // of usable interior on a 40 mm import, and a 5 mm shell would then put its
  // cavity exactly on the clamp — which is how this was found.
  check(
    'the reach is a useful fraction of the object, not a few cells',
    fine.grid.reach > 4,
    `${fine.grid.reach.toFixed(2)} mm on a 40 mm box`,
  );
  check(
    'and it does not shrink as the resolution rises',
    Math.abs(fine.grid.reach - coarse.grid.reach) < coarse.grid.reach * 0.35,
    `${coarse.grid.reach.toFixed(2)} then ${fine.grid.reach.toFixed(2)}`,
  );

  const shellWall = 5;
  check(
    'so an import can be shelled without the cavity landing on the clamp',
    sampleMeshGrid(fine.grid, 0, 0, 0) + shellWall < -0.5,
    `interior reads ${sampleMeshGrid(fine.grid, 0, 0, 0).toFixed(2)} mm against a ${shellWall} mm wall`,
  );

  const outside = sampleMeshGrid(fine.grid, 500, 0, 0);
  check('far outside the grid the field is large and positive', outside > fine.grid.reach);
  check('and grows with distance', sampleMeshGrid(fine.grid, 1000, 0, 0) > outside);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    mesh import');
