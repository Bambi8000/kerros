import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useKerros } from '../core/store';
import type { ViewName } from '../core/store';

/**
 * Kerros world convention, fixed here and nowhere else:
 *   - Z is up. Slices stack along +Z, rods run along Z.
 *   - 1 three.js unit = 1 mm.
 * three.js defaults to Y-up, so every camera sets `up` explicitly.
 */

/** Half-height of the orthographic frustum, mm. */
const ORTHO_EXTENT = 320;

const COLORS = {
  background: 0x121110,
  grid: 0x2c2926,
  gridCenter: 0x3d3936,
  bed: 0x6f6862,
  bedMargin: 0x3f3a36,
  zAxis: 0x4a9fd8,
};

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
  return view === 'top'
    ? new THREE.Vector3(0, 0, 0)
    : new THREE.Vector3(0, 0, 60);
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

function disposeGroup(group: THREE.Group) {
  group.traverse((obj) => {
    const line = obj as THREE.Line;
    line.geometry?.dispose();
    const mat = line.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
  group.clear();
}

export function Viewport() {
  const view = useKerros((s) => s.view);
  const machine = useKerros((s) => s.machine);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const bedRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  // Renderer, scene and render loop. Created once.
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

    // Vertical reference so Z-up reads at a glance.
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

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(200, -300, 400);
    scene.add(key);

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

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      disposeGroup(bed);
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
    };
  }, []);

  // Camera and controls, rebuilt whenever the view changes.
  useEffect(() => {
    const mount = mountRef.current;
    const renderer = rendererRef.current;
    if (!mount || !renderer) return;

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

    return () => {
      controls.dispose();
      controlsRef.current = null;
      cameraRef.current = null;
    };
  }, [view]);

  // Bed outline follows the machine profile. No bed size is ever hardcoded.
  useEffect(() => {
    const bed = bedRef.current;
    if (!bed) return;
    disposeGroup(bed);

    bed.add(makeRect(machine.bedWidth, machine.bedHeight, 0, COLORS.bed, 0.85));
    const usableW = Math.max(machine.bedWidth - machine.margin * 2, 1);
    const usableH = Math.max(machine.bedHeight - machine.margin * 2, 1);
    bed.add(makeRect(usableW, usableH, 0, COLORS.bedMargin, 0.9));
  }, [machine.bedWidth, machine.bedHeight, machine.margin]);

  return (
    <div className="viewport">
      <div className="viewport-canvas" ref={mountRef} />
      <div className="viewport-hud">
        <span className="hud-view">{view}</span>
        <span className="hud-note">Z up · 1 unit = 1 mm · grid 10 mm</span>
      </div>
    </div>
  );
}
