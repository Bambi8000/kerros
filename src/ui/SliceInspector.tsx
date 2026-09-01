import { useEffect, useMemo, useRef, useState } from 'react';
// Aliased: the DOM has a `PointerEvent` of its own, and the two are not the
// same type. Naming it here keeps which one is meant obvious at the handlers.
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useKerros } from '../core/store';
import { groupContours, pointInRing } from '../core/slice';
import type { CircleHole, Contour, GapReport, Slice, SliceSet } from '../core/slice';

const COLORS = {
  background: '#121110',
  grid: '#241f1c',
  gridMajor: '#2f2926',
  axis: '#3a3330',
  fill: 'rgba(210, 200, 188, 0.10)',
  cut: '#e04a2f',
  ghost: 'rgba(210, 200, 188, 0.16)',
  label: '#9a918a',
  warn: '#d9a441',
  selected: '#f0b429',
  measure: '#5fb3d4',
  /*
   * A pin joins two sheets, so on any one sheet half its holes carry on
   * upwards and half downwards. Two colours because a ring of identical holes
   * hides the interleave, which is the one thing about pins worth seeing.
   */
  pinUp: '#6bbf8a',
  pinDown: '#c07ad4',
  paint: '#e6c34a',
  carve: '#e04a2f',
};

/** How close to a hole's edge still counts as pointing at it, in screen pixels. */
const GRAB_SLOP_PX = 4;

/**
 * What the pointer is doing.
 *
 * A layer of intent rather than a drag handler, because a drag is not the only
 * thing that will want the left button here. A push brush belongs in this view
 * for the same reasons a drag does — one layer at a time, true scale, the
 * neighbours visible — and if the drag were wired straight into the canvas
 * events, the brush would be written on top of it and the two would argue over
 * the same button. Model mode already learned this: sculpting is a *mode*, and
 * orbit moves to the right button for its duration.
 */
type SliceTool = 'select' | 'measure' | 'paint';

/** Where a measured end landed, and on what. */
interface Snap {
  x: number;
  y: number;
  /** What it caught: an outline, the rim of a hole, its centre, or nothing. */
  on: 'edge' | 'rim' | 'centre' | 'free';
}

/**
 * How close a measuring end has to be to catch, in screen pixels.
 *
 * Generous, because the point of snapping is that a wall thickness measured by
 * eye is not a measurement. A free point is still available by holding Alt.
 */
const SNAP_PX = 10;

interface DragState {
  owner: string;
  /** Where the pointer took hold, in model millimetres. */
  startX: number;
  startY: number;
  /** How far it has come since, mm. A delta needs no origin and cannot be in
   *  the wrong frame — which an attached fixture's stored position would be. */
  dx: number;
  dy: number;
  /** Released, waiting for the slices to catch up. */
  settling: boolean;
}

/** Screen and world agree only if they are derived once, so the draw records them. */
interface ViewTransform {
  width: number;
  height: number;
  scale: number;
  cx: number;
  cy: number;
}

/** Drawn margin around the fitted extent, as a fraction of the canvas. */
const FIT_MARGIN = 0.12;

interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function emptyExtent(): Extent {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function growExtent(extent: Extent, points: number[]) {
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < extent.minX) extent.minX = points[i];
    if (points[i] > extent.maxX) extent.maxX = points[i];
    if (points[i + 1] < extent.minY) extent.minY = points[i + 1];
    if (points[i + 1] > extent.maxY) extent.maxY = points[i + 1];
  }
}

function extentOf(slices: Slice[]): Extent | null {
  const extent = emptyExtent();
  let any = false;
  for (const slice of slices) {
    for (const contour of slice.contours) {
      growExtent(extent, contour.points);
      any = true;
    }
  }
  return any ? extent : null;
}

interface Props {
  slices: SliceSet | null;
  reports: GapReport[];
  ms: number;
  pending: boolean;
}

export function SliceInspector({ slices, reports, ms, pending }: Props) {
  const currentLayer = useKerros((s) => s.currentLayer);
  const fitToLayer = useKerros((s) => s.sliceFitToLayer);
  const setCurrentLayer = useKerros((s) => s.setCurrentLayer);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const features = useKerros((s) => s.features);
  const selectedId = useKerros((s) => s.selectedId);
  const selectFeature = useKerros((s) => s.selectFeature);
  const moveOriginWorldBy = useKerros((s) => s.moveOriginWorldBy);
  const togglePin = useKerros((s) => s.togglePin);
  /** The one pin last pointed at, so Backspace knows which to take out. */
  const [pickedPin, setPickedPin] = useState<{ owner: string; key: string } | null>(null);

  /**
   * The transform the last paint used.
   *
   * Written by the draw rather than computed twice. The scale depends on the
   * measured canvas, and a hit test that worked it out for itself would agree
   * with the picture only until one of the two was edited.
   */
  const viewRef = useRef<ViewTransform | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** The slice set that was on screen when a drag was released. */
  const settledAgainst = useRef<SliceSet | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hovering, setHovering] = useState(false);
  const [tool, setTool] = useState<SliceTool>('select');
  /**
   * Onion skin: the sheets either side, drawn behind this one.
   *
   * Off by default, because most of the time a part is read on its own and two
   * extra outlines are noise. It earns its place while a layer is being edited,
   * where a stroke drawn against its neighbours is a different stroke from one
   * drawn against nothing.
   */
  const [onion, setOnion] = useState(false);
  const ensurePaint = useKerros((s) => s.ensurePaint);
  const addStroke = useKerros((s) => s.addStroke);
  const brushRadius = useKerros((s) => s.brushRadius);
  const [carving, setCarving] = useState(false);
  /**
   * The stroke being laid down, in model millimetres.
   *
   * Held here and committed on release. The field is not re-evaluated while the
   * button is down — a sculpt stroke learned that first and a dragged hole
   * learned it again: writing on every move restarts the 250 ms slice and the
   * line arrives a quarter of a second behind the hand.
   */
  const [painting, setPainting] = useState<number[] | null>(null);
  const paintingRef = useRef<number[] | null>(null);
  /** Where the stroke began, so Shift can draw straight back to it. */
  const paintStartRef = useRef<[number, number, number] | null>(null);
  const setBrushRadius = useKerros((s) => s.setBrushRadius);
  const [measure, setMeasure] = useState<{ from: Snap; to: Snap | null } | null>(null);
  const [cursor, setCursor] = useState<Snap | null>(null);

  const total = slices?.slices.length ?? 0;
  const layerIndex = total > 0 ? Math.min(Math.max(currentLayer, 1), total) : 0;
  const slice = total > 0 ? slices!.slices[layerIndex - 1] : null;
  const report: GapReport | null = layerIndex > 0 ? (reports[layerIndex - 1] ?? null) : null;

  /**
   * The drawing extent.
   *
   * By default this is the whole model's footprint, held constant across every
   * layer. Stepping through a stack is how you read the form narrowing, and
   * refitting each layer to the canvas hides exactly that — a 20 mm cap would
   * fill the view the same as a 200 mm base. Fit-to-layer stays available for
   * inspecting detail on a small layer.
   */
  const modelExtent = useMemo(() => (slices ? extentOf(slices.slices) : null), [slices]);

  const extent = useMemo(() => {
    if (!slice) return null;
    if (!fitToLayer) return modelExtent;
    const own = emptyExtent();
    for (const contour of slice.contours) growExtent(own, contour.points);
    return own;
  }, [slice, fitToLayer, modelExtent]);

  /** The widest layer, drawn faintly as a reference outline. */
  const widest = useMemo(() => {
    if (!slices) return null;
    let best: Slice | null = null;
    let bestArea = -Infinity;
    for (const candidate of slices.slices) {
      const area = candidate.contours.reduce((sum, c) => sum + c.area, 0);
      if (area > bestArea) {
        bestArea = area;
        best = candidate;
      }
    }
    return best;
  }, [slices]);

  /**
   * Which features can be taken hold of here.
   *
   * Perforation is left out on purpose. Its holes are generated in their
   * hundreds and no single one has a position of its own — grabbing the one
   * under the cursor would drag the whole lattice by whichever hole happened to
   * be there, which is not what the gesture looks like it does. They carry an
   * owner anyway, because stamping it costs nothing and the pattern inspector
   * may want it later.
   */
  const grabbable = useMemo(() => {
    const out = new Set<string>();
    for (const f of features) {
      if (!f.enabled) continue;
      if (f.stage === 'PATTERN') continue;
      if (f.kind === 'rod' || f.stage === 'RIG') out.add(f.id);
    }
    return out;
  }, [features]);

  /** Screen point to model millimetres, through the transform the paint used. */
  const toWorld = (clientX: number, clientY: number): [number, number] | null => {
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!canvas || !view) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return [
      (px - view.width / 2) / view.scale + view.cx,
      view.cy - (py - view.height / 2) / view.scale,
    ];
  };

  /**
   * What is under the point, preferring the smallest thing there.
   *
   * A socket hole can sit inside a Wago pocket, and pointing at the small one
   * should get the small one — the same rule the sheet view uses when a part
   * rests inside a ring's waste.
   */
  const hitAt = (wx: number, wy: number): { owner: string; pinKey?: string } | null => {
    if (!slice) return null;
    const view = viewRef.current;
    const slop = view ? GRAB_SLOP_PX / view.scale : 0.5;

    let best: { owner: string; pinKey?: string } | null = null;
    let bestSize = Infinity;

    for (const circle of slice.circles as CircleHole[]) {
      if (!circle.owner || !grabbable.has(circle.owner)) continue;
      const d = Math.hypot(wx - circle.x, wy - circle.y);
      if (d <= circle.r + slop && circle.r < bestSize) {
        best = { owner: circle.owner, pinKey: circle.pinKey };
        bestSize = circle.r;
      }
    }

    for (const contour of slice.contours as Contour[]) {
      if (!contour.owner || !grabbable.has(contour.owner)) continue;
      if (!pointInRing(contour.points, wx, wy)) continue;
      const size = Math.sqrt(Math.abs(contour.area));
      if (size < bestSize) {
        best = { owner: contour.owner };
        bestSize = size;
      }
    }

    return best;
  };

  /**
   * The nearest thing worth measuring to.
   *
   * A wall measured by eye is not a measurement, so an end catches the real
   * geometry: the nearest point on any outline or hole, the rim of a drilled
   * circle, or its centre. Alt holds it free for the cases where the answer is
   * not on an edge — the gap between two parts, say.
   *
   * Centres beat rims and rims beat edges when several are in range, because a
   * centre is the thing somebody is usually after and it is the one that cannot
   * be hit by accident.
   */
  const snapAt = (wx: number, wy: number, free: boolean): Snap => {
    if (free || !slice) return { x: wx, y: wy, on: 'free' };
    const view = viewRef.current;
    const reach = view ? SNAP_PX / view.scale : 1;

    let best: Snap | null = null;
    let bestD = reach;
    const offer = (x: number, y: number, on: Snap['on'], bias: number) => {
      const d = Math.hypot(x - wx, y - wy) - bias;
      if (d < bestD) {
        bestD = d;
        best = { x, y, on };
      }
    };

    for (const circle of slice.circles) {
      offer(circle.x, circle.y, 'centre', reach * 0.6);
      const away = Math.hypot(wx - circle.x, wy - circle.y);
      if (away > 1e-9) {
        offer(
          circle.x + ((wx - circle.x) / away) * circle.r,
          circle.y + ((wy - circle.y) / away) * circle.r,
          'rim',
          reach * 0.3,
        );
      }
    }

    for (const contour of slice.contours) {
      const pts = contour.points;
      for (let i = 0; i < pts.length; i += 2) {
        const j = (i + 2) % pts.length;
        const ax = pts[i];
        const ay = pts[i + 1];
        const ex = pts[j] - ax;
        const ey = pts[j + 1] - ay;
        const len2 = ex * ex + ey * ey;
        let t = len2 > 0 ? ((wx - ax) * ex + (wy - ay) * ey) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        offer(ax + ex * t, ay + ey * t, 'edge', 0);
      }
    }

    return best ?? { x: wx, y: wy, on: 'free' };
  };

  const onMeasureDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;
    const point = snapAt(world[0], world[1], event.altKey);
    // A finished measurement is replaced rather than extended: the second click
    // ends one and the third starts the next, which is how a tape measure goes.
    if (!measure || measure.to) setMeasure({ from: point, to: null });
    else setMeasure({ ...measure, to: point });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    if (tool === 'measure') {
      onMeasureDown(event);
      return;
    }

    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;

    if (tool === 'paint') {
      if (!slice) return;
      const started = [world[0], world[1], slice.z];
      paintStartRef.current = [world[0], world[1], slice.z];
      paintingRef.current = started;
      setPainting(started);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    // Below here is the select tool only. The guard sits *after* the branches
    // above rather than before them, or a tool added later is unreachable —
    // which is the same shape as the dispatch that hid the fixture inspector.
    if (tool !== 'select') return;

    const hit = hitAt(world[0], world[1]);
    if (!hit) return;
    const owner = hit.owner;

    // Remembered so Backspace knows which pin, not just which feature: a pin is
    // one of a ring and the ring is one feature, so selecting the feature alone
    // cannot say what to take out.
    setPickedPin(hit.pinKey ? { owner, key: hit.pinKey } : null);

    selectFeature(owner);

    // The pointer's own starting point, not the feature's. Everything below is
    // a delta, so the hole is held exactly where it was grabbed for free.
    const state: DragState = {
      owner,
      startX: world[0],
      startY: world[1],
      dx: 0,
      dy: 0,
      settling: false,
    };
    dragRef.current = state;
    setDrag(state);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /**
   * Nothing is written to the store while the button is down.
   *
   * The first version wrote on every move and drew the preview as the distance
   * from the *stored* position — which the previous move had just updated, so
   * the offset was always about zero and the hole did not appear to move at
   * all. What did move was the slicing, 250 ms behind and restarted by every
   * write, so the hole sat still and then jumped when the hand stopped.
   *
   * A sculpt stroke had the same problem and the same answer: do not re-evaluate
   * during the drag. Draw the offset from where the feature was when the drag
   * began, and commit once on release.
   */
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;

    if (tool === 'measure') {
      setCursor(snapAt(world[0], world[1], event.altKey));
      return;
    }

    if (tool === 'paint') {
      const active = paintingRef.current;
      if (!active) {
        setCursor({ x: world[0], y: world[1], on: 'free' });
        return;
      }

      /*
       * Shift draws straight back to where the stroke began.
       *
       * A modifier rather than a fourth button: it is the convention everywhere
       * else, it costs no room in the bar, and it can be taken up and put down
       * in the middle of a gesture — start a curve, hold Shift, and the tail
       * runs straight to where you started.
       */
      const start = paintStartRef.current;
      if (event.shiftKey && start) {
        const straight = [start[0], start[1], start[2], world[0], world[1], start[2]];
        paintingRef.current = straight;
        setPainting(straight);
        return;
      }
      // A point every third of a brush width: dense enough to read as a tube,
      // sparse enough to store. The same rule the 3D brush uses.
      const lastX = active[active.length - 3];
      const lastY = active[active.length - 2];
      if (Math.hypot(world[0] - lastX, world[1] - lastY) < brushRadius * 0.35) return;
      const next = [...active, world[0], world[1], active[2]];
      paintingRef.current = next;
      setPainting(next);
      return;
    }

    const active = dragRef.current;
    if (!active || active.settling) {
      setHovering(hitAt(world[0], world[1]) !== null);
      return;
    }

    const next = {
      ...active,
      dx: Math.round((world[0] - active.startX) * 10) / 10,
      dy: Math.round((world[1] - active.startY) * 10) / 10,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const endPaint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const points = paintingRef.current;
    paintingRef.current = null;
    paintStartRef.current = null;
    setPainting(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!points || points.length < 3) return;
    // The feature is made on release, not on arming the tool: a tool picked up
    // and put down again should leave nothing behind.
    /*
     * The stroke carries its own operation, because `SculptStroke` already
     * does. One brush feature then holds both what was painted on and what was
     * carved off, which is how a person works — rather than a feature per
     * direction and a tree full of them.
     */
    addStroke(ensurePaint(), {
      op: carving ? 'subtract' : 'union',
      k: 0,
      radius: brushRadius,
      points,
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool === 'paint') {
      endPaint(event);
      return;
    }
    const active = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!active || active.settling) return;

    if (active.dx === 0 && active.dy === 0) {
      // A click that selected something and moved nothing. Writing a zero move
      // would still touch the tree and cost a re-slice for no change.
      dragRef.current = null;
      setDrag(null);
      return;
    }
    moveOriginWorldBy(active.owner, active.dx, active.dy);

    /*
     * The offset stays on screen until the new slices arrive.
     *
     * Clearing it here would put the hole back where it started for the quarter
     * second the re-slice takes, and then jump it forward — the same flinch,
     * just moved to the end of the gesture.
     */
    const settling = { ...active, settling: true };
    dragRef.current = settling;
    setDrag(settling);
    settledAgainst.current = slices;
  };

  /**
   * Backspace takes the pin under the last click out, and puts it back.
   *
   * The same gesture the sheet view uses to unpin a part, and for the same
   * reason: the thing was pointed at, so the keyboard should act on it. A pin
   * removed by hand is not counted as a miss — it never had to fit — but it
   * still counts as absent for the structural check, so emptying a gap says so
   * rather than quietly leaving two sheets unfastened.
   */
  useEffect(() => {
    if (!pickedPin) return;
    const onKey = (event: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      togglePin(pickedPin.owner, pickedPin.key);
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickedPin, togglePin]);

  /**
   * The wheel sizes the brush while the tool is out.
   *
   * There is no zoom in this view to argue with — the scale is fixed to the
   * model's footprint on purpose — so the wheel is free, and sizing a brush is
   * what a hand already on the mouse wants to do.
   *
   * Attached here rather than as `onWheel`, because React registers that one
   * passively: `preventDefault` would do nothing and the page would scroll out
   * from under the brush.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tool !== 'paint') return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const step = brushRadius <= 2 ? 0.2 : brushRadius <= 6 ? 0.5 : 1;
      setBrushRadius(Math.round((brushRadius - Math.sign(event.deltaY) * step) * 100) / 100);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [tool, brushRadius, setBrushRadius]);

  /** Escape puts the tape away. Changing layer keeps it, which is the point. */
  useEffect(() => {
    if (tool !== 'measure') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (measure) setMeasure(null);
      else setTool('select');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, measure]);

  /** Drop the preview once the geometry underneath it has actually changed. */
  useEffect(() => {
    if (!dragRef.current?.settling) return;
    if (slices === settledAgainst.current) return;
    dragRef.current = null;
    setDrag(null);
  }, [slices]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (width === 0 || height === 0) return;

      // Only the drawing buffer is sized here. The element's layout size comes
      // from CSS: giving the canvas a pixel width makes it an intrinsic size
      // the grid has to honour, and since that width is measured back off the
      // grid the two grow each other until the layout falls apart.
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, width, height);

      if (!slice || !extent) return;

      const spanX = Math.max(extent.maxX - extent.minX, 1);
      const spanY = Math.max(extent.maxY - extent.minY, 1);
      const scale = Math.min(width / spanX, height / spanY) * (1 - FIT_MARGIN * 2);
      const cx = (extent.minX + extent.maxX) / 2;
      const cy = (extent.minY + extent.maxY) / 2;

      const toScreenX = (x: number) => width / 2 + (x - cx) * scale;
      const toScreenY = (y: number) => height / 2 - (y - cy) * scale;

      // The one place these numbers exist. Hit testing reads them back rather
      // than deriving its own, so the picture and the pointer cannot disagree.
      viewRef.current = { width, height, scale, cx, cy };

      // 10 mm grid, heavier every 50 mm.
      const gridSpan = Math.max(spanX, spanY) * 1.5;
      ctx.lineWidth = 1;
      for (let g = Math.floor((cx - gridSpan) / 10) * 10; g <= cx + gridSpan; g += 10) {
        ctx.strokeStyle = g % 50 === 0 ? COLORS.gridMajor : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(toScreenX(g), 0);
        ctx.lineTo(toScreenX(g), height);
        ctx.stroke();
      }
      for (let g = Math.floor((cy - gridSpan) / 10) * 10; g <= cy + gridSpan; g += 10) {
        ctx.strokeStyle = g % 50 === 0 ? COLORS.gridMajor : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(0, toScreenY(g));
        ctx.lineTo(width, toScreenY(g));
        ctx.stroke();
      }

      ctx.strokeStyle = COLORS.axis;
      ctx.beginPath();
      ctx.moveTo(toScreenX(0), 0);
      ctx.lineTo(toScreenX(0), height);
      ctx.moveTo(0, toScreenY(0));
      ctx.lineTo(width, toScreenY(0));
      ctx.stroke();

      /*
       * Slicing is debounced, so during a drag the geometry on screen is up to
       * a quarter of a second behind the hand. Offsetting the thing being
       * dragged by how far it has gone since costs nothing and is the
       * difference between dragging and pushing something sticky.
       *
       * This has to reach polygons as well as circles. The first version
       * offset only the circles, so a rod or a socket followed the hand while a
       * leg hole or a Wago pocket — which are contours, not circles — sat still
       * and jumped at the end. Same bug as before, hiding in the other half of
       * the geometry.
       */
      const liveDX = (owner?: string) => (drag && owner === drag.owner ? drag.dx : 0);
      const liveDY = (owner?: string) => (drag && owner === drag.owner ? drag.dy : 0);

      const tracePath = (contours: { points: number[]; owner?: string }[]) => {
        const path = new Path2D();
        for (const contour of contours) {
          const pts = contour.points;
          const ox = liveDX(contour.owner);
          const oy = liveDY(contour.owner);
          path.moveTo(toScreenX(pts[0] + ox), toScreenY(pts[1] + oy));
          for (let i = 2; i < pts.length; i += 2) {
            path.lineTo(toScreenX(pts[i] + ox), toScreenY(pts[i + 1] + oy));
          }
          path.closePath();
        }
        return path;
      };

      /*
       * The sheets either side, in the same two colours the pin holes use:
       * green is the one above, violet the one below. One convention for
       * "which way through the stack" rather than two.
       *
       * Not turned, even when the stack is twisted. This view draws parts as
       * the laser cuts them, and a neighbour turned here would be a picture of
       * something that is never cut that way.
       */
      if (onion && slices) {
        ctx.lineWidth = 1;
        for (const [step, colour] of [
          [-1, COLORS.pinDown],
          [1, COLORS.pinUp],
        ] as [number, string][]) {
          const neighbour = slices.slices.find((s2) => s2.index === slice.index + step);
          if (!neighbour) continue;
          ctx.save();
          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = colour;
          ctx.stroke(tracePath(neighbour.contours));
          for (const circle of neighbour.circles) {
            ctx.beginPath();
            ctx.arc(toScreenX(circle.x), toScreenY(circle.y), circle.r * scale, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      } else if (!fitToLayer && widest && widest.index !== slice.index) {
        // One reference at a time: the widest layer says how the form narrows,
        // the onion skin says what is next to this sheet, and both at once is
        // three outlines nobody can read apart.
        ctx.strokeStyle = COLORS.ghost;
        ctx.lineWidth = 1;
        ctx.stroke(tracePath(widest.contours));
      }

      for (const group of groupContours(slice.contours)) {
        const path = tracePath([group.outer, ...group.holes]);
        for (const circle of slice.circles) {
          const ox = circle.x + liveDX(circle.owner);
          const oy = circle.y + liveDY(circle.owner);
          path.moveTo(toScreenX(ox + circle.r), toScreenY(oy));
          path.arc(toScreenX(ox), toScreenY(oy), circle.r * scale, 0, Math.PI * 2);
        }
        ctx.fillStyle = COLORS.fill;
        ctx.fill(path, 'evenodd');
        ctx.strokeStyle = COLORS.cut;
        ctx.lineWidth = 1.5;
        ctx.stroke(path);
      }

      // What is selected, so a click has visible consequences and the inspector
      // on the right is obviously about the thing under the cursor.
      if (selectedId) {
        ctx.strokeStyle = COLORS.selected;
        ctx.lineWidth = 2;
        for (const circle of slice.circles) {
          if (circle.owner !== selectedId) continue;
          const ox = circle.x + liveDX(circle.owner);
          const oy = circle.y + liveDY(circle.owner);
          ctx.beginPath();
          ctx.arc(toScreenX(ox), toScreenY(oy), circle.r * scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const contour of slice.contours) {
          if (contour.owner !== selectedId) continue;
          ctx.stroke(tracePath([contour]));
        }
      }

      /*
       * Pin holes in the colour of where they go, after the selection ring.
       *
       * Order matters and the first attempt had it backwards: the selection
       * highlight strokes every hole belonging to the selected feature, so
       * drawing the pin colours first meant they were painted over in amber the
       * moment the pins feature was the selected one — which is exactly when
       * anybody looks at them.
       *
       * They stay in the filled path above, so they still read as material
       * removed; this only re-strokes them.
       */
      for (const circle of slice.circles) {
        if (circle.pinTo === undefined) continue;
        ctx.strokeStyle = circle.pinTo > slice.index ? COLORS.pinUp : COLORS.pinDown;
        ctx.lineWidth = 2;
        const ox = circle.x + liveDX(circle.owner);
        const oy = circle.y + liveDY(circle.owner);
        ctx.beginPath();
        ctx.arc(toScreenX(ox), toScreenY(oy), circle.r * scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      // The pin Backspace would take out, ringed outside its own colour so the
      // key has something to aim at without hiding which way the pin goes.
      if (pickedPin) {
        const target = slice.circles.find(
          (c) => c.owner === pickedPin.owner && c.pinKey === pickedPin.key,
        );
        if (target) {
          ctx.strokeStyle = COLORS.selected;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(
            toScreenX(target.x + liveDX(target.owner)),
            toScreenY(target.y + liveDY(target.owner)),
            target.r * scale + 4,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
      }

      // Ring the narrowest place so it can be found rather than hunted for.
      if (report?.tooThin && report.at) {
        ctx.strokeStyle = COLORS.warn;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(toScreenX(report.at[0]), toScreenY(report.at[1]), 12, 0, Math.PI * 2);
        ctx.stroke();
      }

      /*
       * The measurement, over everything else.
       *
       * Drawn last so it is never buried, and with its ends marked by what they
       * caught: a ring for a centre, a square for a rim or an edge, a bare
       * cross for a free point. The mark is the difference between a number you
       * can act on and one you have to check.
       */
      if (measure) {
        const live = measure.to ?? cursor;
        const mark = (point: Snap) => {
          const sx = toScreenX(point.x);
          const sy = toScreenY(point.y);
          ctx.beginPath();
          if (point.on === 'centre') ctx.arc(sx, sy, 5, 0, Math.PI * 2);
          else if (point.on === 'free') {
            ctx.moveTo(sx - 5, sy);
            ctx.lineTo(sx + 5, sy);
            ctx.moveTo(sx, sy - 5);
            ctx.lineTo(sx, sy + 5);
          } else ctx.rect(sx - 4, sy - 4, 8, 8);
          ctx.stroke();
        };

        ctx.strokeStyle = COLORS.measure;
        ctx.lineWidth = 1.5;
        mark(measure.from);

        if (live) {
          ctx.setLineDash(measure.to ? [] : [5, 4]);
          ctx.beginPath();
          ctx.moveTo(toScreenX(measure.from.x), toScreenY(measure.from.y));
          ctx.lineTo(toScreenX(live.x), toScreenY(live.y));
          ctx.stroke();
          ctx.setLineDash([]);
          mark(live);

          const mm = Math.hypot(live.x - measure.from.x, live.y - measure.from.y);
          const mx = (toScreenX(measure.from.x) + toScreenX(live.x)) / 2;
          const my = (toScreenY(measure.from.y) + toScreenY(live.y)) / 2;
          const text = `${mm.toFixed(2)} mm`;
          ctx.font = '12px ui-monospace, monospace';
          const pad = 4;
          const w = ctx.measureText(text).width;
          ctx.fillStyle = COLORS.background;
          ctx.fillRect(mx - w / 2 - pad, my - 18, w + pad * 2, 16);
          ctx.fillStyle = COLORS.measure;
          ctx.fillText(text, mx - w / 2, my - 6);
        }
      } else if (tool === 'measure' && cursor) {
        ctx.strokeStyle = COLORS.measure;
        ctx.lineWidth = 1.5;
        const sx = toScreenX(cursor.x);
        const sy = toScreenY(cursor.y);
        ctx.beginPath();
        if (cursor.on === 'centre') ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        else ctx.rect(sx - 4, sy - 4, 8, 8);
        ctx.stroke();
      }

      /*
       * The stroke being laid down, as a plain line.
       *
       * The field is not touched until the button comes up, so this overlay is
       * the only feedback during the gesture — the same arrangement the 3D
       * brush uses, and for the same reason: on a shape that takes a quarter of
       * a second to sample, that is the difference between painting and
       * waiting.
       */
      if (painting && painting.length >= 3) {
        ctx.strokeStyle = carving ? COLORS.carve : COLORS.paint;
        ctx.lineWidth = Math.max(brushRadius * 2 * scale, 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.moveTo(toScreenX(painting[0]), toScreenY(painting[1]));
        for (let i = 3; i < painting.length; i += 3) {
          ctx.lineTo(toScreenX(painting[i]), toScreenY(painting[i + 1]));
        }
        if (painting.length === 3) ctx.lineTo(toScreenX(painting[0]), toScreenY(painting[1]));
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
      } else if (tool === 'paint' && cursor) {
        // The brush itself, so its size is a thing you see rather than a number
        // you remember.
        ctx.strokeStyle = carving ? COLORS.carve : COLORS.paint;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(toScreenX(cursor.x), toScreenY(cursor.y), brushRadius * scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Scale bar, so the eye has something absolute to hold on to.
      const barLength = 10 * scale;
      ctx.strokeStyle = COLORS.label;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(16, height - 22);
      ctx.lineTo(16 + barLength, height - 22);
      ctx.moveTo(16, height - 26);
      ctx.lineTo(16, height - 18);
      ctx.moveTo(16 + barLength, height - 26);
      ctx.lineTo(16 + barLength, height - 18);
      ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('10 mm', 16, height - 30);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [slice, extent, fitToLayer, widest, report, selectedId, drag, tool, measure, cursor, pickedPin, onion, slices, painting, carving, brushRadius]);

  const selected = features.find((f) => f.id === selectedId) ?? null;
  const selectedHere =
    selected !== null &&
    grabbable.has(selected.id) &&
    slice !== null &&
    (slice.circles.some((c) => c.owner === selected.id) ||
      slice.contours.some((c) => c.owner === selected.id));
  const selectedIsRod = selected?.kind === 'rod';
  const selectedIsLegs = selected?.kind === 'legs';
  const selectedIsPins = selected?.kind === 'pins';
  const pinsUp = slice ? slice.circles.filter((c) => c.pinTo !== undefined && c.pinTo > slice.index).length : 0;
  const pinsDown = slice ? slice.circles.filter((c) => c.pinTo !== undefined && c.pinTo < slice.index).length : 0;

  const partCount = slice ? groupContours(slice.contours).length : 0;
  const holeCount = slice ? slice.contours.filter((c) => c.isHole).length : 0;
  const area = slice ? slice.contours.reduce((sum, c) => sum + c.area, 0) : 0;

  return (
    <div className="slice-view">
      <div className="slice-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{
            cursor:
              tool === 'measure' || tool === 'paint'
                ? 'crosshair'
                : drag
                  ? 'grabbing'
                  : hovering
                    ? 'grab'
                    : 'default',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHovering(false)}
        />
        {!slice ? (
          <div className="slice-placeholder">
            {pending ? 'Slicing…' : 'Nothing to slice. Add a shape first.'}
          </div>
        ) : null}
      </div>

      <div className="slice-bar">
        {/*
          Two tools, one pointer layer. A push brush will be a third rather than
          a second set of canvas handlers, which is the whole reason the layer
          is there.
        */}
        <button
          type="button"
          className={`btn${tool === 'paint' && !carving ? ' is-active' : ''}`}
          title="Paint material onto this sheet"
          onClick={() => {
            setCarving(false);
            setTool(tool === 'paint' && !carving ? 'select' : 'paint');
            setMeasure(null);
          }}
        >
          Paint
        </button>
        <button
          type="button"
          className={`btn${tool === 'paint' && carving ? ' is-active' : ''}`}
          title="Carve material off this sheet"
          onClick={() => {
            setCarving(true);
            setTool(tool === 'paint' && carving ? 'select' : 'paint');
            setMeasure(null);
          }}
        >
          Carve
        </button>
        {tool === 'paint' ? (
          <label className="slice-brush" title="Brush radius. The wheel over the canvas does this too.">
            <input
              type="number"
              value={brushRadius}
              step={brushRadius <= 2 ? 0.2 : 0.5}
              min={0.2}
              max={60}
              onChange={(e) => setBrushRadius(Number(e.target.value))}
            />
            mm
          </label>
        ) : null}
        <button
          type="button"
          className={`btn${onion ? ' is-active' : ''}`}
          title="Show the sheets either side: violet below, green above"
          onClick={() => setOnion(!onion)}
        >
          Onion
        </button>
        <button
          type="button"
          className={`btn${tool === 'measure' ? ' is-active' : ''}`}
          title="Measure between two points. Alt for a free point, Esc to clear."
          onClick={() => {
            setTool(tool === 'measure' ? 'select' : 'measure');
            setMeasure(null);
            setCursor(null);
          }}
        >
          Measure
        </button>
        <button
          type="button"
          className="btn"
          disabled={layerIndex <= 1}
          onClick={() => setCurrentLayer(layerIndex - 1)}
        >
          ↓ Lower
        </button>
        <input
          type="range"
          min={1}
          max={Math.max(total, 1)}
          value={layerIndex || 1}
          disabled={total === 0}
          onChange={(e) => setCurrentLayer(Number(e.target.value))}
        />
        <button
          type="button"
          className="btn"
          disabled={total === 0 || layerIndex >= total}
          onClick={() => setCurrentLayer(layerIndex + 1)}
        >
          ↑ Higher
        </button>

        <span className="slice-readout">
          {tool === 'paint' ? (
            `${carving ? 'Carving' : 'Painting'} layer ${layerIndex} · brush ${brushRadius} mm · wheel resizes, Shift draws straight, and it lands on this sheet only`
          ) : tool === 'measure' ? (
            (() => {
              const live = measure?.to ?? cursor;
              if (!measure || !live) {
                return 'Measure — click a point, then another. Alt holds it free of the geometry.';
              }
              const dx = live.x - measure.from.x;
              const dy = live.y - measure.from.y;
              const named = { edge: 'outline', rim: 'hole rim', centre: 'hole centre', free: 'free' };
              return `${Math.hypot(dx, dy).toFixed(2)} mm · dx ${dx.toFixed(2)} · dy ${dy.toFixed(
                2,
              )} · ${named[measure.from.on]} to ${named[live.on]}`;
            })()
          ) : slice ? (
            <>
              Layer {layerIndex} / {total} · z {slice.z.toFixed(2)} mm ·{' '}
              {partCount} {partCount === 1 ? 'part' : 'parts'}
              {holeCount > 0 ? ` · ${holeCount} holes` : ''} ·{' '}
              {area.toFixed(0)} mm² · sliced in {ms.toFixed(0)} ms
              {onion ? (
                <span className="slice-note"> · onion: violet below, green above</span>
              ) : null}
              {report?.tooThin ? (
                <span className="slice-warn">
                  {' '}
                  · narrowest feature {report.minGap.toFixed(2)} mm
                </span>
              ) : null}
              {selectedHere ? (
                <span className="slice-note">
                  {' '}
                  · {selected?.name}
                  {/*
                    A rod is one rod. Dragging its hole here looks like editing
                    this sheet and is not — the same rod goes through every
                    sheet it reaches, and they all move together. Better said
                    out loud than discovered on the bed.
                  */}
                  {selectedIsPins
                    ? ` — ${pinsUp} joining the sheet above, ${pinsDown} the sheet below${
                        pickedPin ? ' · Backspace takes this one out' : ''
                      }`
                    : selectedIsRod
                    ? ' — moving a rod moves it on every layer it reaches'
                    : selectedIsLegs
                      ? /*
                          One hole, but the whole set moves. `px`/`py` is the
                          axis the legs are arranged around, not this hole's
                          own place, and a gesture that moves more than it
                          appears to should say so before it surprises anybody.
                        */
                        ' — dragging one leg moves the whole set, on every layer'
                      : ' — drag to move, or type exact numbers on the right'}
                </span>
              ) : null}
            </>
          ) : (
            'No layers'
          )}
        </span>
      </div>
    </div>
  );
}
