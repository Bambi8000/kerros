import * as THREE from 'three';
import type { SurfaceNetsResult } from './surfaceNets';

/**
 * Surface nets output -> three.js geometry.
 *
 * Normals are computed from the triangles rather than the field gradient:
 * dual vertices already sit close to the surface, and averaged face normals
 * read cleanly on blended blobs without another grid pass.
 */
export function buildGeometry(mesh: SurfaceNetsResult): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
