import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { SNAP_ROTATE_DEG, SNAP_TRANSLATE_MM, useKerros } from '../core/store';
import type { ViewName } from '../core/store';
import { evaluateGrid, findModule, nearestFeatureIndex, num } from '../core/sdf';
import type { Params } from '../core/sdf';
import { surfaceNets } from '../core/surfaceNets';
import { buildGeometry } from '../core/mesh';
import type { Feature } from '../core/types';

/**
 * Kerros world convention, fixed here and nowhere else:
 *   - Z is up. Slices stack along +Z, rods run along Z.
 *   - 1 three.js unit = 1 mm.
 * three.js defaults to Y-up, so every camera sets `up` explicitly.
 *
 * Rotation convention: our fields use R = Rz·Ry·Rx, which is three.js Euler
 * order 'ZYX'. Every conversion in this file passes that order explicitly.
 * `tools/validate-sdf.mjs` pins the matrix composition so the two cannot
 * drift apart.
 */

const EULER_ORDER = 'ZYX';
const DEG = Math.PI / 180;

/** Half-height of the orthographic frustum, mm. */
const ORTHO_EXTENT = 320;

/** Editing settles before the grid is resampled, so dragging stays smooth. */
const EVAL_DEBOUNCE_MS = 120;

/** Pointer movement below this is a click, above it is an orbit drag. */
const CLICK_SLOP_PX = 4;

const COLORS = {
  background: 0x121110,
  grid: 0x2c2926,
  gridCenter: 0x3d3936,
  bed: 0x6f6862,
  bedMargin: 0x3f3a36,
  zAxis: 0x4a9fd8,
  model: 0xd2c8bc,
  selection: 0xe04a2f,
};

interface Stats {
  triangles: number;
  dims: string;
  step: number;
  ms: number;
}

function makeCamera(view: ViewName, width: number, height: number) {
  const aspect = width / height;

  if (view === 'persp') {
    const cam = new THREE.PerspectiveCamera(45, aspect, 1, 8000);
    cam.up.set(0, 0, 1);
    cam.position.set(340, -440, 320);
    return cam;
  }

  const cam = new THREE.OrthographicCamera(
    -ORTHO_EXTENT * aspect,
    ORTHO_EXTENT * aspect,
    ORTHO_EXTENT,
    -ORTHO_EXTENT,
    -8000,
    8000,
  );

  if (view === 'top') {
    cam.up.set(0, 1, 0);
    cam.position.set(0, 0, 1000);
  } else if (view === 'front') {
    cam.up.set(0, 0, 1);
    cam.position.set(0, -1000, 0);
  } else {
    cam.up.set(0, 0, 1);
    cam.position.set(1000, 0, 0);
  }
  return cam;
}

function targetFor(view: ViewName) {
  return view === 'top' ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(0, 0, 60);
}

function makeRect(w: number, h: number, z: number, color: number, opacity: number) {
  const points = [
    new THREE.Vector3(-w / 2, -h / 2, z),
    new THREE.Vector3(w / 2, -h / 2, z),
    new THREE.Vector3(w / 2, h / 2, z),
    new THREE.Vector3(-w / 2, h / 2, z),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return new THREE.LineLoop(geometry, material);
}

function disposeChildren(group: THREE.Object3D) {
  const doomed: THREE.Object3D[] = [];
  group.traverse((obj) => {
    if (obj !== group) doomed.push(obj);
  });
  for (const obj of doomed) {
    const drawable = obj as THREE.Mesh;
    drawable.geometry?.dispose();
    const mat = drawable.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  }
  group.clear();
}

/** Place an object at a feature's transform, in our rotation order. */
function applyTransform(obj: THREE.Object3D, params: Params) {
  obj.position.set(num(params, 'px', 0), num(params, 'py', 0), num(params, 'pz', 0));
  obj.rotation.set(
    num(params, 'rx', 0) * DEG,
    num(params, 'ry', 0) * DEG,
    num(params, 'rz', 0) * DEG,
    EULER_ORDER,
  );
}

/** Nearest 0.1 — gizmo drags should not write sixteen decimal places. */
function tidy(value: number) {
  return Math.round(value * 10) / 10;
}

/** Wireframe box around the selected feature's own bounds. */
function makeSelectionOutline(feature: Feature): THREE.Object3D | null {
  const mod = findModule(feature.kind);
  if (!mod) return null;

  const b = mod.bounds(feature.params);
  const sx = Math.max(b[3] - b[0], 0.1);
  const sy = Math.max(b[4] - b[1], 0.1);
  const sz = Math.max(b[5] - b[2], 0.1);

  const box = new THREE.BoxGeometry(sx, sy, sz);
  box.translate((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
  const edges = new THREE.EdgesGeometry(box);
  box.dispose();

  const lines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({
      color: COLORS.selection,
      transparent: true,
      opacity: 0.55,
    }),
  );

  const holder = new THREE.Object3D();
  applyTransform(holder, feature.params);
  holder.add(lines);
  return holder;
}

export function Viewport() {
  const view = useKerros((s) => s.view);
  const machine = useKerros((s) => s.machine);
  const features = useKerros((s) => s.features);
  const previewRes = useKerros((s) => s.previewRes);
  const selectedId = useKerros((s) => s.selectedId);
  const gizmoMode = useKerros((s) => s.gizmoMode);
  const snapEnabled = useKerros((s) => s.snapEnabled);

  const [stats, setStats] = useState<Stats | null>(null);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const bedRef = useRef<THREE.Group | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const selectionRef = useRef<THREE.Group | null>(null);
  const proxyRef = useRef<THREE.Object3D | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gizmoRef = useRef<TransformControls | null>(null);
  const draggingRef = useRef(false);

  // Renderer, scene, picking and render loop. Created once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth || 1, mount.clientHeight || 1, false);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.background);
    sceneRef.current = scene;

    // 800 mm of grid at 10 mm cells, laid on XY because Z is up.
    const grid = new THREE.GridHelper(800, 80, COLORS.gridCenter, COLORS.grid);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const axes = new THREE.AxesHelper(60);
    scene.add(axes);

    const zLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 240),
      ]),
      new THREE.LineBasicMaterial({
        color: COLORS.zAxis,
        transparent: true,
        opacity: 0.35,
      }),
    );
    scene.add(zLine);

    const bed = new THREE.Group();
    scene.add(bed);
    bedRef.current = bed;

    const model = new THREE.Group();
    scene.add(model);
    modelRef.current = model;

    const selection = new THREE.Group();
    scene.add(selection);
    selectionRef.current = selection;

    // The gizmo drives this stand-in; its transform is copied into the
    // feature's parameters, which stay the single source of truth.
    const proxy = new THREE.Object3D();
    scene.add(proxy);
    proxyRef.current = proxy;

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(220, -320, 420);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd0e0, 0.5);
    fill.position.set(-260, 200, -120);
    scene.add(fill);

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controlsRef.current?.update();
      const cam = cameraRef.current;
      if (cam) renderer.render(scene, cam);
    };
    frame = requestAnimationFrame(tick);

    const resize = () => {
      const el = mountRef.current;
      const cam = cameraRef.current;
      if (!el || !cam) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      if (cam instanceof THREE.PerspectiveCamera) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      } else if (cam instanceof THREE.OrthographicCamera) {
        const aspect = w / h;
        cam.left = -ORTHO_EXTENT * aspect;
        cam.right = ORTHO_EXTENT * aspect;
        cam.top = ORTHO_EXTENT;
        cam.bottom = -ORTHO_EXTENT;
        cam.updateProjectionMatrix();
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    /* -------------------- click to select -------------------- */

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;

    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent) => {
      // An orbit drag or a gizmo drag is not a selection click.
      if (Math.abs(event.clientX - downX) > CLICK_SLOP_PX) return;
      if (Math.abs(event.clientY - downY) > CLICK_SLOP_PX) return;
      if (draggingRef.current) return;

      const cam = cameraRef.current;
      const target = modelRef.current;
      if (!cam || !target) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, cam);

      const hits = raycaster.intersectObjects(target.children, true);
      const { features: current, selectFeature } = useKerros.getState();

      if (hits.length === 0) {
        selectFeature(null);
        return;
      }

      const p = hits[0].point;
      const shapes = current.filter((f) => f.stage === 'SHAPE');
      const index = nearestFeatureIndex(shapes, p.x, p.y, p.z);
      selectFeature(index >= 0 ? shapes[index].id : null);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    /* -------------------- keyboard -------------------- */

    const onKeyDown = (event: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      const state = useKerros.getState();
      if (event.key === 'g' || event.key === 'G') state.setGizmoMode('translate');
      else if (event.key === 'r' || event.key === 'R') state.setGizmoMode('rotate');
      else if (event.key === 'Escape') state.selectFeature(null);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      disposeChildren(bed);
      disposeChildren(model);
      disposeChildren(selection);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      axes.geometry.dispose();
      (axes.material as THREE.Material).dispose();
      zLine.geometry.dispose();
      (zLine.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      rendererRef.current = null;
      sceneRef.current = null;
      bedRef.current = null;
      modelRef.current = null;
      selectionRef.current = null;
      proxyRef.current = null;
    };
  }, []);

  // Camera, orbit controls and the transform gizmo, rebuilt per view.
  useEffect(() => {
    const mount = mountRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!mount || !renderer || !scene) return;

    const w = mount.clientWidth || 1;
    const h = mount.clientHeight || 1;
    const camera = makeCamera(view, w, h);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(targetFor(view));
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableRotate = view === 'persp';
    controls.update();
    controlsRef.current = controls;

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSpace('world');

    // three r169 split the gizmo's visuals out of the controls object.
    const withHelper = gizmo as unknown as { getHelper?: () => THREE.Object3D };
    const helper =
      typeof withHelper.getHelper === 'function'
        ? withHelper.getHelper()
        : (gizmo as unknown as THREE.Object3D);
    scene.add(helper);
    gizmoRef.current = gizmo;

    const onDraggingChanged = (event: { value: boolean }) => {
      draggingRef.current = event.value;
      controls.enabled = !event.value;
    };

    const onObjectChange = () => {
      const proxy = proxyRef.current;
      const id = useKerros.getState().selectedId;
      if (!proxy || !id) return;

      const euler = new THREE.Euler().setFromQuaternion(proxy.quaternion, EULER_ORDER);
      useKerros.getState().setTransform(id, {
        px: tidy(proxy.position.x),
        py: tidy(proxy.position.y),
        pz: tidy(proxy.position.z),
        rx: tidy(euler.x / DEG),
        ry: tidy(euler.y / DEG),
        rz: tidy(euler.z / DEG),
      });
    };

    gizmo.addEventListener('dragging-changed', onDraggingChanged);
    gizmo.addEventListener('objectChange', onObjectChange);

    return () => {
      gizmo.removeEventListener('dragging-changed', onDraggingChanged);
      gizmo.removeEventListener('objectChange', onObjectChange);
      gizmo.detach();
      scene.remove(helper);
      gizmo.dispose();
      gizmoRef.current = null;
      draggingRef.current = false;
      controls.dispose();
      controlsRef.current = null;
      cameraRef.current = null;
    };
  }, [view]);

  // Gizmo mode and snapping.
  useEffect(() => {
    const gizmo = gizmoRef.current;
    if (!gizmo) return;
    gizmo.setMode(gizmoMode);
    gizmo.setTranslationSnap(snapEnabled ? SNAP_TRANSLATE_MM : null);
    gizmo.setRotationSnap(snapEnabled ? SNAP_ROTATE_DEG * DEG : null);
  }, [gizmoMode, snapEnabled, view]);

  // Attach the gizmo to the selected feature, or hide it.
  useEffect(() => {
    const gizmo = gizmoRef.current;
    const proxy = proxyRef.current;
    if (!gizmo || !proxy) return;

    const feature = useKerros.getState().features.find((f) => f.id === selectedId);
    if (!feature) {
      gizmo.detach();
      return;
    }

    applyTransform(proxy, feature.params);
    gizmo.attach(proxy);

    return () => {
      gizmo.detach();
    };
  }, [selectedId, view]);

  // Keep the proxy and the selection outline in step with the parameters,
  // including edits typed into the inspector. Skipped mid-drag so the gizmo
  // is never fighting the value it just wrote.
  useEffect(() => {
    const selection = selectionRef.current;
    if (!selection) return;

    disposeChildren(selection);

    const feature = features.find((f) => f.id === selectedId);
    if (!feature) return;

    const outline = makeSelectionOutline(feature);
    if (outline) selection.add(outline);

    if (!draggingRef.current && proxyRef.current) {
      applyTransform(proxyRef.current, feature.params);
    }
  }, [features, selectedId]);

  // Bed outline follows the machine profile. No bed size is ever hardcoded.
  useEffect(() => {
    const bed = bedRef.current;
    if (!bed) return;
    disposeChildren(bed);

    bed.add(makeRect(machine.bedWidth, machine.bedHeight, 0, COLORS.bed, 0.85));
    const usableW = Math.max(machine.bedWidth - machine.margin * 2, 1);
    const usableH = Math.max(machine.bedHeight - machine.margin * 2, 1);
    bed.add(makeRect(usableW, usableH, 0, COLORS.bedMargin, 0.9));
  }, [machine.bedWidth, machine.bedHeight, machine.margin]);

  // Re-evaluate the feature tree and rebuild the preview mesh.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const model = modelRef.current;
      if (!model) return;

      const shapes = features.filter((f) => f.stage === 'SHAPE');
      const started = performance.now();
      const grid = evaluateGrid(shapes, previewRes);
      const mesh = surfaceNets(grid);
      const elapsed = performance.now() - started;

      disposeChildren(model);

      if (mesh.triangleCount > 0) {
        const material = new THREE.MeshStandardMaterial({
          color: COLORS.model,
          roughness: 0.62,
          metalness: 0.02,
        });
        model.add(new THREE.Mesh(buildGeometry(mesh), material));
      }

      setStats({
        triangles: mesh.triangleCount,
        dims: grid.dims.join('×'),
        step: grid.step,
        ms: elapsed,
      });
    }, EVAL_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [features, previewRes]);

  return (
    <div className="viewport">
      <div className="viewport-canvas" ref={mountRef} />
      <div className="viewport-hud">
        <span className="hud-view">{view}</span>
        <span className="hud-note">
          Click a shape to select · G move · R rotate · Esc deselect
        </span>
        {stats && stats.triangles > 0 ? (
          <span className="hud-stats">
            {stats.dims} samples @ {stats.step.toFixed(2)} mm ·{' '}
            {stats.triangles.toLocaleString('en-US')} tris · {stats.ms.toFixed(0)} ms
          </span>
        ) : null}
      </div>
    </div>
  );
}
