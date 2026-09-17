/** A closed drawing revolved about a vertical axis. No sampled voxel volume.
 * Only authored boundary to the right of the axis generates a surface. The
 * artificial edge along the clipping axis must never become a distance seam.
 */
type Segment = { ax: number; ay: number; bx: number; by: number };
type Tree = {
  minX: number; maxX: number; minY: number; maxY: number;
  segments?: Segment[]; left?: Tree; right?: Tree;
};

function treeOf(segments: Segment[]): Tree {
  const box: Tree = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const s of segments) {
    box.minX = Math.min(box.minX, s.ax, s.bx); box.maxX = Math.max(box.maxX, s.ax, s.bx);
    box.minY = Math.min(box.minY, s.ay, s.by); box.maxY = Math.max(box.maxY, s.ay, s.by);
  }
  if (segments.length <= 8) box.segments = segments;
  else {
    const x = box.maxX - box.minX >= box.maxY - box.minY;
    segments.sort((a, b) => x ? a.ax + a.bx - b.ax - b.bx : a.ay + a.by - b.ay - b.by);
    const mid = Math.floor(segments.length / 2);
    box.left = treeOf(segments.slice(0, mid)); box.right = treeOf(segments.slice(mid));
  }
  return box;
}

function boxDistance(tree: Tree, x: number, y: number): number {
  return Math.max(tree.minX - x, 0, x - tree.maxX) ** 2 + Math.max(tree.minY - y, 0, y - tree.maxY) ** 2;
}

function nearest(tree: Tree, x: number, y: number, best = Infinity): number {
  if (boxDistance(tree, x, y) >= best) return best;
  if (tree.segments) {
    for (const s of tree.segments) {
      const dx = s.bx - s.ax, dy = s.by - s.ay;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, (x - s.ax - t * dx) ** 2 + (y - s.ay - t * dy) ** 2);
    }
    return best;
  }
  const a = tree.left!, b = tree.right!;
  return boxDistance(a, x, y) <= boxDistance(b, x, y)
    ? nearest(b, x, y, nearest(a, x, y, best)) : nearest(a, x, y, nearest(b, x, y, best));
}

function crossings(tree: Tree, x: number, y: number): number {
  if (y < tree.minY || y >= tree.maxY || x > tree.maxX) return 0;
  if (!tree.segments) return crossings(tree.left!, x, y) + crossings(tree.right!, x, y);
  let count = 0;
  for (const s of tree.segments) {
    if ((s.ay > y) !== (s.by > y) && x < s.ax + (y - s.ay) * (s.bx - s.ax) / (s.by - s.ay)) count++;
  }
  return count;
}

/** Even-odd loops in drawing coordinates; horizontal is radius, vertical is Z.
 * Distance to a surface of revolution is the meridian's Euclidean distance.
 * A BVH accelerates both distance and sign without clamping deep interiors.
 */
export function radialProfile(rings: number[][], axisX = 0) {
  if (!Number.isFinite(axisX) || Math.abs(axisX) > 100000) throw new Error('The rotation axis must be within ±100000 mm.');
  const segments: Segment[] = [];
  let area = 0;
  for (const ring of rings) {
    if (ring.length < 6 || ring.length % 2 || ring.some(v => !Number.isFinite(v))) throw new Error('The radial drawing needs valid closed loops.');
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      let ax = ring[i] - axisX, ay = ring[i + 1], bx = ring[j] - axisX, by = ring[j + 1];
      if (ax <= 0 && bx <= 0) continue;
      if (ax < 0) { ay += (by - ay) * -ax / (bx - ax); ax = 0; }
      if (bx < 0) { by += (ay - by) * -bx / (ax - bx); bx = 0; }
      if (Math.hypot(bx - ax, by - ay) < 1e-12) continue;
      segments.push({ ax, ay, bx, by });
      twiceArea += ax * by - bx * ay;
    }
    area += Math.abs(twiceArea) / 2;
  }
  const tree = segments.length ? treeOf(segments) : null;
  // Signed areas can cancel across a self-crossing path. Even-odd regions
  // still exist there: probe both sides of its boundary before refusing it.
  const hasArea = tree && (area >= 1e-6 || segments.some(s => {
    const dx = s.bx - s.ax, dy = s.by - s.ay, length = Math.hypot(dx, dy);
    const epsilon = Math.min(1e-5, length * 1e-3), x = (s.ax + s.bx) / 2, y = (s.ay + s.by) / 2;
    return [-1, 1].some(side => {
      const r = x + side * epsilon * dy / length;
      return r >= 0 && crossings(tree, r, y - side * epsilon * dx / length) % 2 === 1;
    });
  }));
  if (!tree || !hasArea) throw new Error('The radial drawing has no area to the right of the rotation axis. Move Axis X left or edit the outline.');
  const radius = tree.maxX;
  return {
    min: [-radius, -radius, tree.minY] as [number, number, number],
    max: [radius, radius, tree.maxY] as [number, number, number],
    sample: (x: number, y: number, z: number) => {
      const r = Math.hypot(x, y);
      return (crossings(tree, r, z) % 2 ? -1 : 1) * Math.sqrt(nearest(tree, r, z));
    },
  };
}
