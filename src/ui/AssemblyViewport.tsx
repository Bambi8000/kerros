import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SliceSet } from '../core/slice';
import type { Feature } from '../core/types';
import { rodFromFeature, rodPose } from '../core/rig';
import { groupContours } from '../core/slice';
import { channelAngles, ribAnglePreview, ribAngleTargets, ribAngleValue, freePlateAngles, isFreePlate } from '../core/assembly';
import type { RibAngleScope } from '../core/assembly';
import type { GizmoMode } from '../core/store';
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
export function AssemblyViewport({ set: incoming, sourceFeatures, pending }: { set: SliceSet | null; sourceFeatures: Feature[] | null; pending: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<SceneState | null>(null);
  const [dragging, setDragging] = useState(false);
  const features = useKerros((s) => s.features);
  const projectRevision = useKerros((s) => s.projectRevision);
  // A finished worker reply must not replace the meshes under a held handle.
  const shown = useRef({ set: incoming, sourceFeatures, projectRevision });
  if (!dragging || shown.current.projectRevision !== projectRevision) shown.current = { set: incoming, sourceFeatures, projectRevision };
  const set = shown.current.set, sources = shown.current.sourceFeatures;
  const frames = useMemo(() => ribAnglePreview(set, sources, features), [set, sources, features]);
  const frameRef = useRef(frames); frameRef.current = frames;
  const current = useRef(set); current.current = set;
  const selectedId = useKerros((s) => s.selectedId);
  const view = useKerros((s) => s.view);
  const gizmoMode = useKerros((s) => s.gizmoMode);
  const snap = useKerros((s) => s.snapEnabled);
  const angleScope = useKerros((s) => s.assemblyAngleScope);
  const anglePreview = (dragging && features.some((f) => f.id === selectedId && (isFreePlate(f) || (gizmoMode === 'rotate' && f.kind === 'assembly:rib')))) || (pending && frames !== null);
  const report = set?.assembly;

  useEffect(() => {
    const element = host.current!;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#191715');
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20000); camera.up.set(0, 0, 1);
    camera.position.set(240, -360, 250);
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Assembly preview. Select a part, rod or LED channel to inspect it.');
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
    let dragProject = -1;
    let dragMode: GizmoMode = 'translate', dragScope: RibAngleScope = 'selected';
    let dragChannel: NonNullable<SliceSet['assembly']>['channels'][number] | undefined;
    let dragPart: SliceSet['slices'][number]['part'];
    let originals: { object: THREE.Object3D; matrix: THREE.Matrix4; pivot: THREE.Vector3 }[] = [];
    transform.addEventListener('dragging-changed', (event) => {
      const dragging = event.value === true;
      state.dragging = dragging; orbit.enabled = !dragging;
      setDragging(dragging);
      const store = useKerros.getState();
      if (dragging) {
        dragProject = store.projectRevision;
        dragStart = proxy.position.clone(); dragId = store.selectedId || '';
        dragMode = store.gizmoMode;
        dragChannel = current.current?.assembly?.channels.find((c) => c.id === dragId);
        dragPart = frameRef.current?.get(dragId) ?? current.current?.slices.find((s) => s.part?.id === dragId)?.part;
        dragScope = store.assemblyAngleScope;
        const feature = store.features.find((f) => f.id === dragId);
        const layout = store.features.find((f) => f.id === feature?.params.groupId);
        angleStart = feature && layout ? ribAngleValue(feature, layout, dragScope) : 0;
        const targets = new Set(ribAngleTargets(store.features, dragId, dragScope));
        originals = [...parts.children, ...channels.children].flatMap((object) => {
          if (dragChannel && object.userData.featureId === dragId) {
            object.updateMatrix();
            return [{ object, matrix: object.matrix.clone(), pivot: dragStart.clone() }];
          }
          const part = frameRef.current?.get(object.userData.featureId) ?? current.current?.slices.find((s) => s.part?.id === object.userData.featureId)?.part;
          if (!part || !(dragMode === 'rotate' && !dragChannel && feature && !isFreePlate(feature) ? targets.has(part.id) : part.id === dragId)) return [];
          object.updateMatrix();
          return [{ object, matrix: object.matrix.clone(), pivot: new THREE.Vector3(...part.origin) }];
        });
      } else if (dragId) {
        const feature = store.features.find((f) => f.id === dragId);
        const layout = store.features.find((f) => f.id === feature?.params.groupId);
        if (feature?.kind === 'rod' && dragChannel && store.projectRevision === dragProject) {
          const rod = rodFromFeature(feature), pose = rodPose(rod);
          const rotation = new THREE.Euler((rod.rx || 0) * Math.PI / 180, (rod.ry || 0) * Math.PI / 180, (rod.rz || 0) * Math.PI / 180, 'ZYX');
          const q = new THREE.Quaternion().setFromEuler(rotation);
          const position = new THREE.Vector3(...pose.centre);
          if (dragMode === 'rotate') rotation.setFromQuaternion(q.premultiply(proxy.quaternion), 'ZYX');
          else position.add(proxy.position.clone().sub(dragStart));
          store.setTransformWorld(dragId, position.toArray(), [rotation.x, rotation.y, rotation.z].map(THREE.MathUtils.radToDeg) as [number, number, number]);
        } else if (feature && layout && store.projectRevision === dragProject) {
          if (isFreePlate(feature) && dragPart) {
            if (dragMode === 'rotate') {
              const u = new THREE.Vector3(...dragPart.u).applyQuaternion(proxy.quaternion);
              const v = new THREE.Vector3(...dragPart.v).applyQuaternion(proxy.quaternion);
              store.setFreePlatePose(dragId, freePlateAngles(u.toArray(), v.toArray(), Number(layout.params.angle || 0)));
            } else {
              const delta = proxy.position.clone().sub(dragStart).applyAxisAngle(new THREE.Vector3(0, 0, 1), -Number(layout.params.angle || 0) * Math.PI / 180);
              store.setFreePlatePose(dragId, { plateX: Number(feature.params.plateX || 0) + delta.x, plateY: Number(feature.params.plateY || 0) + delta.y, plateZ: Number(feature.params.plateZ || 0) + delta.z });
            }
          } else if (dragMode === 'rotate' && dragChannel) {
            const u = new THREE.Vector3(...dragChannel.u).applyQuaternion(proxy.quaternion);
            const v = new THREE.Vector3(...dragChannel.v).applyQuaternion(proxy.quaternion);
            store.setAssemblyChannelPose(dragId, channelAngles(u.toArray(), v.toArray(), Number(layout.params.angle || 0)));
          } else if (dragMode === 'rotate' && feature.kind === 'assembly:rib') store.setAssemblyAngle(dragId, angleStart + THREE.MathUtils.radToDeg(proxy.rotation.z), dragScope);
          else {
            const delta = proxy.position.clone().sub(dragStart).applyAxisAngle(new THREE.Vector3(0, 0, 1), -Number(layout.params.angle || 0) * Math.PI / 180);
            if (dragChannel) store.setAssemblyChannelPose(dragId, { px: dragChannel.localOrigin[0] + delta.x, py: dragChannel.localOrigin[1] + delta.y, pz: dragChannel.localOrigin[2] + delta.z });
            else store.setTransform(dragId, { px: Number(feature.params.px || 0) + delta.x, py: Number(feature.params.py || 0) + delta.y, pz: Number(feature.params.pz || 0) + delta.z });
          }
        }
        proxy.rotation.set(0, 0, 0); dragId = ''; dragChannel = undefined; dragPart = undefined;
      }
    });
    transform.addEventListener('objectChange', () => {
      if (!state.dragging) return;
      for (const { object, matrix, pivot } of originals) {
        const change = new THREE.Matrix4();
        if (dragMode === 'rotate') {
          change.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(proxy.quaternion)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
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
      const hit = ray.intersectObjects([...parts.children, ...channels.children], true).find((hit) => hit.object.userData.featureId);
      if (hit) {
        const store = useKerros.getState();
        const slice = current.current?.slices.find(s => s.part?.id === hit.object.userData.featureId);
        store.selectFeature(slice?.part?.featureId ?? String(hit.object.userData.featureId));
        const index = slice?.index;
        if (index) store.setCurrentLayer(index);
      }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    const onKey = (event: KeyboardEvent) => {
      if (state.dragging || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return;
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
        const color = part.id === selectedId || part.featureId === selectedId ? '#e89155' : part.gridAxis === 'y' ? '#b4b8a1' : part.kind === 'rib' ? '#d9c9ac' : '#778c91';
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
      if (feature.kind === 'rod') {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(channel.width / 2, channel.width / 2, d.length(), 32),
          new THREE.MeshStandardMaterial({ color: selected ? '#e89155' : '#aeb7bf', roughness: 0.35, metalness: 0.6 }));
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
        mesh.userData.featureId = channel.id; e.channels.add(mesh); continue;
      }
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
      mesh.userData.featureId = channel.id;
      e.channels.add(mesh);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: '#b6f4ff', depthTest: false }));
      line.userData.featureId = channel.id; e.channels.add(line);
      const component = mesh.clone();
      component.geometry = makeEnvelope(Math.max(0.01, channel.width - clearance * 2), Math.max(0.01, channel.height - clearance * 2), radius);
      component.material = new THREE.MeshBasicMaterial({ color: '#ebfbff', transparent: true, opacity: 0.3, depthWrite: false });
      e.channels.add(component);
    }
    if (fitted.current !== set?.assembly?.id && set?.slices.length) { e.fit(); fitted.current = set.assembly?.id; }
  }, [set]);
  useEffect(() => {
    const e = engine.current; if (!e || e.dragging || !frames) return;
    // Numeric edits and repeated drags use absolute frames derived from the
    // retained result, never cumulative rotations of already moved meshes.
    for (const object of e.parts.children) {
      const part = frames.get(object.userData.featureId);
      if (!part) continue;
      const matrix = new THREE.Matrix4().makeBasis(new THREE.Vector3(...part.u), new THREE.Vector3(...part.v), new THREE.Vector3(...part.n));
      matrix.setPosition(new THREE.Vector3(...part.origin).addScaledVector(new THREE.Vector3(...part.n), -part.thickness / 2));
      matrix.decompose(object.position, object.quaternion, object.scale);
    }
  }, [set, frames, dragging]);
  useEffect(() => {
    const e = engine.current; if (!e || e.dragging) return;
    const targets = new Set(ribAngleTargets(useKerros.getState().features, selectedId ?? '', angleScope));
    for (const object of e.parts.children) {
      const part = set?.slices.find((s) => s.part?.id === object.userData.featureId)?.part;
      if (!part) continue;
      const selected = part.id === selectedId || part.featureId === selectedId, grouped = targets.has(part.id) && angleScope !== 'selected';
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        object.material.color.set(selected ? '#e89155' : grouped ? '#d5a36a' : part.gridAxis === 'y' ? '#b4b8a1' : part.kind === 'rib' ? '#d9c9ac' : '#778c91');
        const waitingSupport = anglePreview && part.kind !== 'rib' && part.kind !== 'plate';
        object.material.transparent = waitingSupport; object.material.opacity = waitingSupport ? 0.3 : 1;
        object.material.depthWrite = !waitingSupport;
      }
      if (object instanceof THREE.LineSegments && object.material instanceof THREE.LineBasicMaterial) object.material.color.set(selected || grouped ? '#ffc389' : '#403831');
    }
    for (const object of e.channels.children) {
      if (object.userData.featureId && object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) object.material.color.set(object.userData.featureId === selectedId ? '#e89155' : '#aeb7bf');
      if (object.userData.featureId && object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) object.material.opacity = object.userData.featureId === selectedId ? 0.3 : 0.14;
    }
  }, [set, selectedId, angleScope, anglePreview, dragging]);
  useEffect(() => {
    const e = engine.current; if (!e || e.dragging) return;
    let part = set?.slices.find((s) => s.part?.id === selectedId)?.part;
    if (part?.gridAxis) { e.transform.detach(); return; }
    if (part && frames?.has(part.id)) part = frames.get(part.id);
    if (gizmoMode === 'rotate' && part?.kind === 'rib') {
      const targets = ribAngleTargets(useKerros.getState().features, selectedId ?? '', angleScope);
      // If the inspected rib is outside Odd/Even, put the handle on a member
      // that will actually move. Translation still uses only the inspected rib.
      if (!targets.includes(part.id)) part = set?.slices.find((s) => s.part && targets.includes(s.part.id))?.part;
    }
    const channel = set?.assembly?.channels.find((c) => c.id === selectedId);
    const enabledChannel = channel && useKerros.getState().features.some((f) => f.id === channel.id && f.enabled) && channel.width > 0 && channel.height > 0;
    const livePlacement = part && frames?.has(part.id) && (part.kind === 'plate' || (gizmoMode === 'rotate' && part.kind === 'rib'));
    if ((!part && !enabledChannel) || (pending && !livePlacement) || (gizmoMode === 'rotate' && !enabledChannel && part?.kind !== 'rib' && part?.kind !== 'plate')) { e.transform.detach(); return; }
    e.proxy.position.set(...(enabledChannel ? channel.origin : part!.origin)); e.proxy.rotation.set(0, 0, 0);
    e.transform.setMode(gizmoMode); e.transform.setSpace('world');
    e.transform.showX = gizmoMode === 'translate' || Boolean(enabledChannel) || part?.kind === 'plate'; e.transform.showY = e.transform.showX; e.transform.showZ = true;
    e.transform.setTranslationSnap(snap ? SNAP_TRANSLATE_MM : null);
    e.transform.setRotationSnap(snap ? SNAP_ROTATE_DEG * Math.PI / 180 : null);
    e.transform.attach(e.proxy);
  }, [set, selectedId, gizmoMode, snap, pending, angleScope, frames, dragging]);
  useEffect(() => { engine.current?.fit(); }, [view]);
  return <section className="assembly-canvas">
    <div ref={host} className="assembly-three" />
    <div className="assembly-overlay"><strong>Assembly</strong><span>{anglePreview ? dragging ? 'Placement preview' : 'Placement preview · checking cuts…' : pending ? 'Rebuilding…' : `${set?.slices.length ?? 0} parts`}</span><button className="btn" onClick={() => engine.current?.fit()}>Fit view</button></div>
    <div className="assembly-caption">{anglePreview ? 'Live placement using the last cut outlines. Joints, supports and cut checks update after editing.' : !set?.slices.length ? pending ? 'Building the first assembly preview…' : report ? 'No parts were produced. Check the assembly settings and messages in the inspector.' : 'Add a source shape, then create Grid, Radial ribs or Linear ribs.' : set.slices.some(s => s.part?.gridAxis) ? 'Click a grid part to inspect its plane · edit spacing and offsets in the inspector · drag to orbit' : report?.channels.some((c) => c.id === selectedId) ? `${features.find((f) => f.id === selectedId)?.kind === 'rod' ? 'Rod' : 'LED channel'} · M to move · R to rotate · drag a handle · cuts update on release` : 'Click a part, rod or LED channel to select · drag to orbit · scroll to zoom'}<br />{report && !pending && !dragging && !report.cuttable && 'Some parts need attention. Read the assembly checks in the inspector.'}</div>
  </section>;
}
