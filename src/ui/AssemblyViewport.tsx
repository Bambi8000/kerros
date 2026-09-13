import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SliceSet } from '../core/slice';
import { groupContours } from '../core/slice';
import { useKerros, SNAP_ROTATE_DEG, SNAP_TRANSLATE_MM } from '../core/store';

interface SceneState {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer;
  orbit: OrbitControls; transform: TransformControls; parts: THREE.Group; channels: THREE.Group;
  proxy: THREE.Object3D; fit: () => void; dragging: boolean;
}
const disposeGroup = (group: THREE.Group) => {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Line) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((m) => m.dispose());
    }
  });
  group.clear();
};
export function AssemblyViewport({ set, pending }: { set: SliceSet | null; pending: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<SceneState | null>(null);
  const current = useRef(set); current.current = set;
  const selectedId = useKerros((s) => s.selectedId);
  const view = useKerros((s) => s.view);
  const gizmoMode = useKerros((s) => s.gizmoMode);
  const snap = useKerros((s) => s.snapEnabled);
  const report = set?.assembly;

  useEffect(() => {
    const element = host.current!;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#191715');
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20000); camera.up.set(0, 0, 1);
    camera.position.set(240, -360, 250);
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Assembly preview. Select a part to move or rotate it.');
    scene.add(new THREE.HemisphereLight(0xfff4e3, 0x555566, 2.3));
    const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(200, -300, 400); scene.add(key);
    const fill = new THREE.DirectionalLight(0xe0d5c2, 1.5); fill.position.set(-200, 200, 150); scene.add(fill);
    const orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true;
    const parts = new THREE.Group(), channels = new THREE.Group(); scene.add(parts, channels);
    const proxy = new THREE.Object3D(); scene.add(proxy);
    const transform = new TransformControls(camera, renderer.domElement);
    scene.add(transform.getHelper());
    const fit = () => {
      const box = new THREE.Box3().setFromObject(parts);
      if (box.isEmpty()) return;
      const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 20) / Math.min(camera.aspect, 1);
      const view = useKerros.getState().view;
      const direction = view === 'top' ? new THREE.Vector3(0, -0.0001, 1) : view === 'front' ? new THREE.Vector3(0, 1, 0.0001) : view === 'side' ? new THREE.Vector3(1, 0, 0.0001) : new THREE.Vector3(1, 1.6, 1);
      camera.position.copy(centre).addScaledVector(direction.normalize(), span * 1.9);
      orbit.target.copy(centre); camera.lookAt(centre); orbit.update();
    };
    const state: SceneState = { scene, camera, renderer, orbit, transform, parts, channels, proxy, fit, dragging: false };
    engine.current = state;
    let dragStart = new THREE.Vector3(), dragId = '', angleStart = 0;
    let originals: { object: THREE.Object3D; matrix: THREE.Matrix4; pivot: THREE.Vector3 }[] = [];
    transform.addEventListener('dragging-changed', (event) => {
      const dragging = event.value === true;
      state.dragging = dragging; orbit.enabled = !dragging;
      const store = useKerros.getState();
      if (dragging) {
        dragStart = proxy.position.clone(); dragId = store.selectedId || '';
        angleStart = Number(store.features.find((f) => f.id === dragId)?.params.angle || 0);
        originals = parts.children.flatMap((object) => {
          const part = current.current?.slices.find((s) => s.part?.id === object.userData.featureId)?.part;
          if (!part || (part.id !== dragId && !(store.gizmoMode === 'rotate' && store.assemblyAllFollow && part.kind === 'rib'))) return [];
          object.updateMatrix();
          return [{ object, matrix: object.matrix.clone(), pivot: new THREE.Vector3(...part.origin) }];
        });
      } else if (dragId) {
        const feature = store.features.find((f) => f.id === dragId);
        const layout = store.features.find((f) => f.id === feature?.params.groupId);
        if (feature && layout) {
          if (store.gizmoMode === 'rotate' && feature.kind === 'assembly:rib') store.setAssemblyAngle(dragId, angleStart + THREE.MathUtils.radToDeg(proxy.rotation.z), store.assemblyAllFollow);
          else {
            const delta = proxy.position.clone().sub(dragStart).applyAxisAngle(new THREE.Vector3(0, 0, 1), -Number(layout.params.angle || 0) * Math.PI / 180);
            store.setTransform(dragId, { px: Number(feature.params.px || 0) + delta.x, py: Number(feature.params.py || 0) + delta.y, pz: Number(feature.params.pz || 0) + delta.z });
          }
        }
        proxy.rotation.set(0, 0, 0); dragId = '';
      }
    });
    transform.addEventListener('objectChange', () => {
      if (!state.dragging) return;
      for (const { object, matrix, pivot } of originals) {
        const change = new THREE.Matrix4();
        if (useKerros.getState().gizmoMode === 'rotate') {
          change.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new THREE.Matrix4().makeRotationZ(proxy.rotation.z)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
        } else {
          const delta = proxy.position.clone().sub(dragStart); change.makeTranslation(delta.x, delta.y, delta.z);
        }
        change.multiply(matrix).decompose(object.position, object.quaternion, object.scale);
      }
    });
    // Picking only after a short click prevents orbiting from changing selection.
    let down: [number, number] = [0, 0];
    const onDown = (event: PointerEvent) => { down = [event.clientX, event.clientY]; };
    const onUp = (event: PointerEvent) => {
      if (state.dragging || transform.axis || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const hit = ray.intersectObjects(parts.children, true).find((hit) => hit.object.userData.featureId);
      if (hit) {
        const store = useKerros.getState(); store.selectFeature(String(hit.object.userData.featureId));
        const index = current.current?.slices.find((s) => s.part?.id === hit.object.userData.featureId)?.index;
        if (index) store.setCurrentLayer(index);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'm' || key === 'r') useKerros.getState().setGizmoMode(key === 'm' ? 'translate' : 'rotate');
      else if (key === 'escape') useKerros.getState().selectFeature(null);
      else if (key === 'f') fit();
    };
    window.addEventListener('keydown', onKey);
    const resize = new ResizeObserver(() => { const w = element.clientWidth, h = element.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix(); }); resize.observe(element);
    let raf = 0;
    const animate = () => { raf = requestAnimationFrame(animate); orbit.update(); renderer.render(scene, camera); }; animate();
    return () => {
      cancelAnimationFrame(raf); resize.disconnect(); window.removeEventListener('keydown', onKey); transform.dispose(); orbit.dispose();
      disposeGroup(parts); disposeGroup(channels); renderer.dispose(); renderer.domElement.remove(); engine.current = null;
    };
  }, []);
  const fitted = useRef<string | undefined>(undefined);
  useEffect(() => {
    const e = engine.current; if (!e) return;
    disposeGroup(e.parts); disposeGroup(e.channels);
    for (const slice of set?.slices ?? []) {
      const part = slice.part; if (!part) continue;
      const matrix = new THREE.Matrix4().makeBasis(new THREE.Vector3(...part.u), new THREE.Vector3(...part.v), new THREE.Vector3(...part.n));
      matrix.setPosition(new THREE.Vector3(...part.origin).addScaledVector(new THREE.Vector3(...part.n), -part.thickness / 2));
      for (const group of groupContours(slice.contours)) {
        const path = (points: number[], target: THREE.Path) => { target.moveTo(points[0], points[1]); for (let i = 2; i < points.length; i += 2) target.lineTo(points[i], points[i + 1]); target.closePath(); };
        const shape = new THREE.Shape(); path(group.outer.points, shape);
        for (const hole of group.holes) { const inner = new THREE.Path(); path(hole.points, inner); shape.holes.push(inner); }
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: part.thickness, bevelEnabled: false, steps: 1 });
        const color = part.id === selectedId ? '#e89155' : part.kind === 'rib' ? '#d9c9ac' : '#778c91';
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide }));
        mesh.applyMatrix4(matrix); mesh.userData.featureId = part.id; e.parts.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: part.id === selectedId ? '#ffc389' : '#403831', transparent: true, opacity: 0.7 }));
        edges.applyMatrix4(matrix); edges.userData.featureId = part.id; e.parts.add(edges);
      }
      if (part.kind === 'backplate') {
        const xs = slice.contours.flatMap((c) => c.points.filter((_, i) => i % 2 === 0)), ys = slice.contours.flatMap((c) => c.points.filter((_, i) => i % 2 === 1));
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(...xs) - Math.min(...xs) + 30, Math.max(...ys) - Math.min(...ys) + 30), new THREE.MeshBasicMaterial({ color: '#78848b', transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
        const wallMatrix = matrix.clone();
        wallMatrix.setPosition(new THREE.Vector3(...part.origin).addScaledVector(new THREE.Vector3(...part.n), part.thickness / 2 + (part.wallOffset ?? 0) + 0.1));
        wall.applyMatrix4(wallMatrix); e.channels.add(wall);
      }
    }
    for (const channel of set?.assembly?.channels ?? []) {
      const feature = useKerros.getState().features.find((f) => f.id === channel.id);
      if (!feature?.enabled || !(channel.width > 0 && channel.height > 0)) continue;
      const a = new THREE.Vector3(...channel.start), b = new THREE.Vector3(...channel.end), d = b.clone().sub(a);
      const selected = selectedId === channel.id;
      const tube = feature.params.shape !== 'strip';
      const makeEnvelope = (width: number, height: number, radius: number) => {
        const shape = new THREE.Shape();
        const r = Math.min(Math.max(0, radius), width / 2, height / 2);
        if (tube) shape.absarc(0, 0, width / 2, 0, Math.PI * 2, false);
        else if (r === 0) { shape.moveTo(-width / 2, -height / 2); shape.lineTo(width / 2, -height / 2); shape.lineTo(width / 2, height / 2); shape.lineTo(-width / 2, height / 2); shape.closePath(); }
        else {
          for (let q = 0; q < 4; q++) shape.absarc((q === 0 || q === 3 ? 1 : -1) * (width / 2 - r), (q < 2 ? 1 : -1) * (height / 2 - r), r, q * Math.PI / 2, (q + 1) * Math.PI / 2, false);
          shape.closePath();
        }
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: d.length(), steps: 1, bevelEnabled: false, curveSegments: 24 });
        geometry.translate(0, 0, -d.length() / 2); return geometry;
      };
      const clearance = Number(feature.params.clearance || 0), radius = Number(feature.params.cornerRadius || 0);
      const mesh = new THREE.Mesh(makeEnvelope(channel.width, channel.height, radius + clearance), new THREE.MeshBasicMaterial({ color: '#70d8ee', transparent: true, opacity: selected ? 0.3 : 0.14, depthWrite: false }));
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...channel.u), new THREE.Vector3(...channel.v), d.clone().normalize()));
      e.channels.add(mesh);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: '#b6f4ff', depthTest: false })); e.channels.add(line);
      const component = mesh.clone();
      component.geometry = makeEnvelope(Math.max(0.01, channel.width - clearance * 2), Math.max(0.01, channel.height - clearance * 2), radius);
      component.material = new THREE.MeshBasicMaterial({ color: '#ebfbff', transparent: true, opacity: 0.3, depthWrite: false });
      e.channels.add(component);
    }
    if (fitted.current !== set?.assembly?.id && set?.slices.length) { e.fit(); fitted.current = set.assembly?.id; }
  }, [set, selectedId]);
  useEffect(() => {
    const e = engine.current; if (!e || e.dragging) return;
    const part = set?.slices.find((s) => s.part?.id === selectedId)?.part;
    if (!part || pending || (gizmoMode === 'rotate' && part.kind !== 'rib')) { e.transform.detach(); return; }
    e.proxy.position.set(...part.origin); e.proxy.rotation.set(0, 0, 0);
    e.transform.setMode(gizmoMode); e.transform.setSpace('world');
    e.transform.showX = gizmoMode === 'translate'; e.transform.showY = gizmoMode === 'translate'; e.transform.showZ = true;
    e.transform.setTranslationSnap(snap ? SNAP_TRANSLATE_MM : null);
    e.transform.setRotationSnap(snap ? SNAP_ROTATE_DEG * Math.PI / 180 : null);
    e.transform.attach(e.proxy);
  }, [set, selectedId, gizmoMode, snap, pending]);
  useEffect(() => { engine.current?.fit(); }, [view]);
  return <section className="assembly-canvas">
    <div ref={host} className="assembly-three" />
    <div className="assembly-overlay"><strong>Assembly</strong><span>{pending ? 'Rebuilding…' : `${set?.slices.length ?? 0} parts`}</span><button className="btn" onClick={() => engine.current?.fit()}>Fit view</button></div>
    <div className="assembly-caption">{!set?.slices.length ? 'Add a source shape, then create Radial ribs or Linear ribs.' : 'Click a part to select · drag to orbit · scroll to zoom'}<br />{report && !pending && !report.cuttable && 'Some parts need attention. Read the assembly checks in the inspector.'}</div>
  </section>;
}
