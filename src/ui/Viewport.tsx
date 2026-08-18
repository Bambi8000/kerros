import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { SNAP_ROTATE_DEG, SNAP_TRANSLATE_MM, useKerros } from '../core/store';
import type { ViewName } from '../core/store';
import { evaluateGridSampled, findModule, nearestFeatureIndex, num } from '../core/sdf';
import type { Params } from '../core/sdf';
import { surfaceNets } from '../core/surfaceNets';
import { buildGeometry } from '../core/mesh';
import { circleFitsInPart, groupContours } from '../core/slice';
import type { SliceSet } from '../core/slice';
import { rodDiameter, rodSpan } from '../core/rig';
import { socketDiameter } from '../core/fixture';
import {
  composeField,
  fixturesFromFeatures,
  hasRotation,
  hasTransform,
  isFieldFeature,
  rodsFromFeatures,
  transformOriginOf,
} from '../core/store';
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
  sheet: 0xc9bfb2,
  sheetCurrent: 0xe04a2f,
  rod: 0x8d8a86,
  rodSelected: 0xe04a2f,
  fixture: 0x4a9fd8,
  fixtureSelected: 0xe04a2f,
  brush: 0xe04a2f,
  stroke: 0xe0a02f,
};

/** A new point is taken once the cursor has moved this fraction of a radius. */
const STROKE_SPACING = 0.35;

interface ViewportProps {
  /** Slices to show in stack mode. Null while modelling or still computing. */
  slices: SliceSet | null;
}

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

export function Viewport({ slices }: ViewportProps) {
  const view = useKerros((s) => s.view);
  const mode = useKerros((s) => s.mode);
  const currentLayer = useKerros((s) => s.currentLayer);
  const hideAbove = useKerros((s) => s.hideAbove);
  const machine = useKerros((s) => s.machine);
  const features = useKerros((s) => s.features);
  const previewRes = useKerros((s) => s.previewRes);
  const displayMode = useKerros((s) => s.displayMode);
  const sculptMode = useKerros((s) => s.sculptMode);
  const brushRadius = useKerros((s) => s.brushRadius);
  const selectedId = useKerros((s) => s.selectedId);
  const gizmoMode = useKerros((s) => s.gizmoMode);
  const snapEnabled = useKerros((s) => s.snapEnabled);

  const [stats, setStats] = useState<Stats | null>(null);
  const fixtureCount = features.filter((f) => f.kind.startsWith('fixture:') && f.enabled).length;

  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const bedRef = useRef<THREE.Group | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const stackRef = useRef<THREE.Group | null>(null);
  const rodsRef = useRef<THREE.Group | null>(null);
  const fixturesRef = useRef<THREE.Group | null>(null);
  const brushRef = useRef<THREE.Mesh | null>(null);
  const strokeRef = useRef<THREE.Group | null>(null);
  const paintRef = useRef<{ id: string; points: number[] } | null>(null);
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

    const stack = new THREE.Group();
    scene.add(stack);
    stackRef.current = stack;

    const rods = new THREE.Group();
    scene.add(rods);
    rodsRef.current = rods;

    const fixtures = new THREE.Group();
    scene.add(fixtures);
    fixturesRef.current = fixtures;

    // Brush cursor and the stroke being laid down. Both are overlays: the field
    // is only re-evaluated when the stroke is finished, so the drag stays
    // responsive on a shape that takes a quarter of a second to sample.
    const brush = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: COLORS.brush,
        wireframe: true,
        transparent: true,
        opacity: 0.5,
      }),
    );
    brush.visible = false;
    scene.add(brush);
    brushRef.current = brush;

    const strokes = new THREE.Group();
    scene.add(strokes);
    strokeRef.current = strokes;

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

    /** Where the ray meets the model, or null. */
    const surfaceAt = (event: PointerEvent): THREE.Vector3 | null => {
      const cam = cameraRef.current;
      const target = modelRef.current;
      if (!cam || !target) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, cam);
      const hits = raycaster.intersectObjects(target.children, true);
      return hits.length > 0 ? hits[0].point.clone() : null;
    };

    /** Redraw the stroke in progress as a plain line through its points. */
    const showStroke = () => {
      const group = strokeRef.current;
      const paint = paintRef.current;
      if (!group) return;
      disposeChildren(group);
      if (!paint || paint.points.length < 6) return;

      const points: THREE.Vector3[] = [];
      for (let i = 0; i < paint.points.length; i += 3) {
        points.push(
          new THREE.Vector3(paint.points[i], paint.points[i + 1], paint.points[i + 2]),
        );
      }
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: COLORS.stroke }),
        ),
      );
    };

    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;

      const state = useKerros.getState();
      if (!state.sculptMode || state.mode !== 'model' || event.button !== 0) return;

      const hit = surfaceAt(event);
      if (!hit) return;

      // Orbit is on the right button while sculpting, and turned off outright
      // for the length of a stroke so a slip cannot spin the model mid-line.
      if (controlsRef.current) controlsRef.current.enabled = false;
      paintRef.current = { id: state.ensureSculpt(), points: [hit.x, hit.y, hit.z] };
      renderer.domElement.setPointerCapture(event.pointerId);
      showStroke();
    };

    const onPointerMoveSculpt = (event: PointerEvent) => {
      const state = useKerros.getState();
      const brush = brushRef.current;

      if (!state.sculptMode || state.mode !== 'model') {
        if (brush) brush.visible = false;
        return;
      }

      const hit = surfaceAt(event);

      if (brush) {
        brush.visible = hit !== null;
        if (hit) {
          brush.position.copy(hit);
          brush.scale.setScalar(Math.max(state.brushRadius, 0.2));
        }
      }

      const paint = paintRef.current;
      if (!paint || !hit) return;

      const n = paint.points.length;
      const dx = hit.x - paint.points[n - 3];
      const dy = hit.y - paint.points[n - 2];
      const dz = hit.z - paint.points[n - 1];
      const step = Math.max(state.brushRadius, 0.2) * STROKE_SPACING;
      if (dx * dx + dy * dy + dz * dz < step * step) return;

      paint.points.push(hit.x, hit.y, hit.z);
      showStroke();
    };

    const finishStroke = (event: PointerEvent) => {
      const paint = paintRef.current;
      paintRef.current = null;
      if (controlsRef.current) controlsRef.current.enabled = true;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }

      const group = strokeRef.current;
      if (group) disposeChildren(group);
      if (!paint || paint.points.length < 3) return;

      const state = useKerros.getState();
      state.addStroke(paint.id, {
        op: state.brushOp,
        radius: state.brushRadius,
        k: state.brushOp.startsWith('smooth') ? state.brushBlend : 0,
        points: paint.points,
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      if (paintRef.current) {
        finishStroke(event);
        return;
      }

      // While sculpting the left button belongs to the brush, never to picking.
      if (useKerros.getState().sculptMode) return;

      // An orbit drag or a gizmo drag is not a selection click.
      if (Math.abs(event.clientX - downX) > CLICK_SLOP_PX) return;
      if (Math.abs(event.clientY - downY) > CLICK_SLOP_PX) return;
      if (draggingRef.current) return;

      const cam = cameraRef.current;
      const target = modelRef.current;
      if (!cam || !target) return;
      if (useKerros.getState().mode !== 'model') return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, cam);

      const { features: current, selectFeature } = useKerros.getState();

      // Rods are real meshes and thin, so they get first refusal — otherwise
      // a rod inside the form could never be clicked.
      // Rods and fixture ghosts get first refusal: they are thin or inside the
      // form, and could never be clicked otherwise.
      const pickable = [
        ...(rodsRef.current ? rodsRef.current.children : []),
        ...(fixturesRef.current ? fixturesRef.current.children : []),
      ];
      if (pickable.length > 0) {
        const hits = raycaster.intersectObjects(pickable, false);
        if (hits.length > 0) {
          const id = hits[0].object.userData.featureId;
          if (typeof id === 'string') {
            selectFeature(id);
            return;
          }
        }
      }

      const hits = raycaster.intersectObjects(target.children, true);

      if (hits.length === 0) {
        selectFeature(null);
        return;
      }

      const p = hits[0].point;
      const shapes = current.filter(isFieldFeature);
      const index = nearestFeatureIndex(shapes, p.x, p.y, p.z);
      selectFeature(index >= 0 ? shapes[index].id : null);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMoveSculpt);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', () => {
      if (brushRef.current) brushRef.current.visible = false;
    });

    /* -------------------- keyboard -------------------- */

    const onKeyDown = (event: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      const state = useKerros.getState();
      const key = event.key.toLowerCase();
      if (key === 'm' || key === 'g') state.setGizmoMode('translate');
      else if (key === 'r') state.setGizmoMode('rotate');
      else if (event.key === 'Escape') state.selectFeature(null);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMoveSculpt);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      disposeChildren(bed);
      disposeChildren(model);
      disposeChildren(stack);
      disposeChildren(rods);
      disposeChildren(fixtures);
      disposeChildren(strokes);
      brush.geometry.dispose();
      (brush.material as THREE.Material).dispose();
      scene.remove(brush);
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
      stackRef.current = null;
      rodsRef.current = null;
      fixturesRef.current = null;
      brushRef.current = null;
      strokeRef.current = null;
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
      const state = useKerros.getState();
      const id = state.selectedId;
      if (!proxy || !id) return;

      const feature = state.features.find((f) => f.id === id);
      if (feature && !hasRotation(feature)) {
        state.setTransform(id, {
          px: tidy(proxy.position.x),
          py: tidy(proxy.position.y),
          pz: tidy(proxy.position.z),
        });
        return;
      }

      const euler = new THREE.Euler().setFromQuaternion(proxy.quaternion, EULER_ORDER);
      state.setTransform(id, {
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

  /*
   * While sculpting, the left button paints and the right one orbits.
   *
   * Swapping the buttons rather than making sculpting modal-and-blocking means
   * the model can still be turned mid-session, which matters: you sculpt one
   * side, turn it, sculpt the other.
   */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.mouseButtons = sculptMode
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    if (!sculptMode && brushRef.current) brushRef.current.visible = false;
  }, [sculptMode, view, mode]);

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

    // A shell or a pattern has no position: it acts on the whole form. Giving
    // it a gizmo let a drag write transform parameters nothing reads, which
    // looked exactly like a broken drag.
    if (!hasTransform(feature)) {
      gizmo.detach();
      return;
    }

    // Reset every axis on attach: a previous selection must not leave an
    // axis switched off on the next one.
    gizmo.showX = true;
    gizmo.showY = true;
    gizmo.showZ = true;

    // Rods and windows move in all three axes but have no orientation to set:
    // a rod turned about its own axis is unchanged, and a window is aimed by
    // its angle parameter. Translate is the only mode they get.
    if (!hasRotation(feature)) gizmo.setMode('translate');

    applyTransform(proxy, feature.params);
    if (!hasRotation(feature)) {
      const [ox, oy, oz] = transformOriginOf(feature);
      proxy.position.set(ox, oy, oz);
      proxy.rotation.set(0, 0, 0);
    }
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
    if (!hasRotation(feature)) {
      if (!draggingRef.current && proxyRef.current) {
        const [ox, oy, oz] = transformOriginOf(feature);
        proxyRef.current.position.set(ox, oy, oz);
        proxyRef.current.rotation.set(0, 0, 0);
      }
      return;
    }

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

  // Rods, drawn at clearance diameter over their span. They are geometry you
  // can point at, which is what makes click-to-select and dragging work.
  useEffect(() => {
    const group = rodsRef.current;
    if (!group) return;

    disposeChildren(group);
    if (mode === 'slice') return;

    for (const rod of rodsFromFeatures(features)) {
      const [low, high] = rodSpan(rod);
      const length = Math.max(high - low, 0.5);
      const geometry = new THREE.CylinderGeometry(
        rodDiameter(rod) / 2,
        rodDiameter(rod) / 2,
        length,
        20,
      );
      // Cylinders are built along Y; the world is Z up.
      geometry.rotateX(Math.PI / 2);

      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: rod.id === selectedId ? COLORS.rodSelected : COLORS.rod,
          roughness: 0.35,
          metalness: 0.6,
        }),
      );
      mesh.position.set(rod.x, rod.y, low + length / 2);
      mesh.userData.featureId = rod.id;
      group.add(mesh);
    }
  }, [features, selectedId, mode]);

  /*
   * Fixture ghosts.
   *
   * Fixtures and perforation are cut per slice, not carved out of the field, so
   * the model preview cannot show them as holes — that only happens in Slice,
   * Stack and Sheet. But placing them happens here, with a gizmo, and a gizmo
   * attached to nothing visible is no way to aim a socket. So each fixture is
   * drawn as the volume it will remove: see-through, so it reads as void rather
   * than as material, and clickable, so it can be picked like a rod.
   */
  useEffect(() => {
    const group = fixturesRef.current;
    if (!group) return;

    disposeChildren(group);
    if (mode !== 'model') return;

    for (const spec of fixturesFromFeatures(features, 0)) {
      const height = Math.max(spec.length, 0.5);
      const selected = spec.id === selectedId;
      const material = new THREE.MeshStandardMaterial({
        color: selected ? COLORS.fixtureSelected : COLORS.fixture,
        roughness: 0.4,
        metalness: 0,
        transparent: true,
        opacity: selected ? 0.5 : 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const holder = new THREE.Object3D();
      holder.position.set(spec.x, spec.y, spec.z);
      holder.rotation.set(0, 0, (spec.rot * Math.PI) / 180);

      const addCylinder = (d: number, x = 0, y = 0) => {
        const geometry = new THREE.CylinderGeometry(d / 2, d / 2, height, 24);
        geometry.rotateX(Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, 0);
        mesh.userData.featureId = spec.id;
        holder.add(mesh);
      };

      const addBox = (w: number, d: number) => {
        const geometry = new THREE.BoxGeometry(w, d, height);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.featureId = spec.id;
        holder.add(mesh);
      };

      if (spec.kind === 'socket') {
        addCylinder(socketDiameter(spec));
        const screws = Math.max(Math.round(spec.screws), 0);
        if (screws > 0 && spec.screwDiameter > 0) {
          const ring = Math.max(spec.boltCircle, 0) / 2;
          for (let i = 0; i < screws; i++) {
            const a = (i / screws) * Math.PI * 2;
            addCylinder(spec.screwDiameter, ring * Math.cos(a), ring * Math.sin(a));
          }
        }
      } else if (spec.kind === 'cable') {
        if (spec.shape === 'slot') addBox(Math.max(spec.slotLength, 1), Math.max(spec.diameter, 1));
        else addCylinder(Math.max(spec.diameter, 0.5));
      } else {
        addBox(Math.max(spec.width, 1), Math.max(spec.depth, 1));
      }

      group.add(holder);
    }
  }, [features, selectedId, mode]);

  // Only one of the two 3D representations is on screen at a time.
  useEffect(() => {
    if (modelRef.current) modelRef.current.visible = mode !== 'stack';
    if (stackRef.current) stackRef.current.visible = mode === 'stack';
    if (fixturesRef.current) fixturesRef.current.visible = mode === 'model';
    if (brushRef.current && mode !== 'model') brushRef.current.visible = false;
    if (selectionRef.current) selectionRef.current.visible = mode === 'model';
    if (mode !== 'model') gizmoRef.current?.detach();
  }, [mode]);

  // Exploded stack: each layer extruded to real material thickness and placed
  // at its real z, so the gaps you see are the spacers you will actually cut.
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;

    disposeChildren(stack);
    if (mode !== 'stack' || !slices) return;

    const plain = new THREE.MeshStandardMaterial({
      color: COLORS.sheet,
      roughness: 0.7,
      metalness: 0.02,
    });
    const highlighted = new THREE.MeshStandardMaterial({
      color: COLORS.sheetCurrent,
      roughness: 0.5,
      metalness: 0.02,
    });

    for (const slice of slices.slices) {
      if (hideAbove && slice.index > currentLayer) continue;

      for (const group of groupContours(slice.contours)) {
        const shape = new THREE.Shape();
        const outer = group.outer.points;
        shape.moveTo(outer[0], outer[1]);
        for (let i = 2; i < outer.length; i += 2) shape.lineTo(outer[i], outer[i + 1]);
        shape.closePath();

        for (const hole of group.holes) {
          const path = new THREE.Path();
          path.moveTo(hole.points[0], hole.points[1]);
          for (let i = 2; i < hole.points.length; i += 2) {
            path.lineTo(hole.points[i], hole.points[i + 1]);
          }
          path.closePath();
          shape.holes.push(path);
        }

        // Only rod holes that genuinely fit inside this part. A hole that
        // crosses a contour is not a hole, it is a bite out of the edge, and
        // feeding it to the tessellator produces a fan of garbage across the
        // whole layer. It is still drawn in the slice inspector, where the
        // thin-feature warning is what the maker needs to see.
        for (const circle of slice.circles) {
          if (!circleFitsInPart(group, circle)) continue;
          const path = new THREE.Path();
          path.absarc(circle.x, circle.y, circle.r, 0, Math.PI * 2, true);
          shape.holes.push(path);
        }

        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth: slices.thickness,
          bevelEnabled: false,
          curveSegments: 16,
        });
        const mesh = new THREE.Mesh(
          geometry,
          slice.index === currentLayer ? highlighted : plain,
        );
        mesh.position.z = slice.zBottom;
        stack.add(mesh);
      }
    }
  }, [mode, slices, currentLayer, hideAbove]);

  // Re-evaluate the feature tree and rebuild the preview mesh.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const model = modelRef.current;
      if (!model) return;

      if (useKerros.getState().mode === 'stack') return;

      const started = performance.now();
      // The composed field, so a window shows as a gap in the preview rather
      // than appearing only once the model is sliced.
      const state = useKerros.getState();
      const field = composeField(
        features,
        state.material.kerf,
        state.seed,
        state.material.thickness,
        state.material.thickness + state.stack.spacerHeight,
      );
      const grid = evaluateGridSampled(field.sample, field.bounds, previewRes);
      const mesh = surfaceNets(grid);
      const elapsed = performance.now() - started;

      disposeChildren(model);

      if (mesh.triangleCount > 0) {
        const geometry = buildGeometry(mesh);

        if (displayMode === 'wire') {
          const edges = new THREE.WireframeGeometry(geometry);
          model.add(
            new THREE.LineSegments(
              edges,
              new THREE.LineBasicMaterial({
                color: COLORS.model,
                transparent: true,
                opacity: 0.35,
              }),
            ),
          );
          geometry.dispose();
        } else {
          const xray = displayMode === 'xray';
          const material = new THREE.MeshStandardMaterial({
            color: COLORS.model,
            roughness: xray ? 0.4 : 0.62,
            metalness: 0.02,
            transparent: xray,
            // Ghosting needs both: the far side visible through the near one,
            // and no depth writes so rods inside are not hidden by the shell.
            opacity: xray ? 0.26 : 1,
            depthWrite: !xray,
            side: xray ? THREE.DoubleSide : THREE.FrontSide,
          });
          model.add(new THREE.Mesh(geometry, material));
        }
      }

      setStats({
        triangles: mesh.triangleCount,
        dims: grid.dims.join('×'),
        step: grid.step,
        ms: elapsed,
      });
    }, EVAL_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [features, previewRes, mode, displayMode]);

  return (
    <div className="viewport">
      <div className="viewport-canvas" ref={mountRef} />
      <div className="viewport-hud">
        <span className="hud-view">{view}</span>
        <span className="hud-note">
          {mode === 'stack'
            ? 'Exploded stack at real layer pitch'
            : sculptMode
              ? `Sculpting · left drag paints, right drag orbits · brush ${brushRadius} mm`
              : `Click a shape to select · M move · R rotate · Esc deselect${
                displayMode === 'solid' ? '' : ` · ${displayMode}`
              }${
                fixtureCount > 0
                  ? ` · ${fixtureCount} fixture${fixtureCount === 1 ? '' : 's'} shown as ghosts, cut per slice`
                  : ''
              }`}
        </span>
        {mode === 'stack' && slices ? (
          <span className="hud-stats">
            {slices.slices.length} layers · pitch {slices.pitch.toFixed(2)} mm ·
            {' '}
            {slices.thickness.toFixed(2)} mm sheet
          </span>
        ) : null}
        {mode !== 'stack' && stats && stats.triangles > 0 ? (
          <span className="hud-stats">
            {stats.dims} samples @ {stats.step.toFixed(2)} mm ·{' '}
            {stats.triangles.toLocaleString('en-US')} tris · {stats.ms.toFixed(0)} ms
          </span>
        ) : null}
      </div>
    </div>
  );
}
