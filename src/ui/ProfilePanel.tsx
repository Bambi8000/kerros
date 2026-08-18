import { PREVIEW_RESOLUTIONS, SLICE_RESOLUTIONS, useKerros } from '../core/store';
import { layerPitch } from '../core/types';
import type { GapReport, SliceSet } from '../core/slice';
import { LAYER_CUT, kerfTestDocument, writeDxfR12 } from '../core/dxf';
import type { DxfDocument } from '../core/dxf';
import { NumberField } from './NumberField';
import { downloadText } from './download';

interface Props {
  /** Latest slicing result, so this panel can report what came out. */
  slices: SliceSet | null;
  reports: GapReport[];
}

export function ProfilePanel({ slices, reports }: Props) {
  const machine = useKerros((s) => s.machine);
  const material = useKerros((s) => s.material);
  const stack = useKerros((s) => s.stack);
  const seed = useKerros((s) => s.seed);
  const previewRes = useKerros((s) => s.previewRes);
  const setMachine = useKerros((s) => s.setMachine);
  const setMaterial = useKerros((s) => s.setMaterial);
  const setStack = useKerros((s) => s.setStack);
  const setSeed = useKerros((s) => s.setSeed);
  const setPreviewRes = useKerros((s) => s.setPreviewRes);
  const mode = useKerros((s) => s.mode);
  const sliceRes = useKerros((s) => s.sliceRes);
  const setSliceRes = useKerros((s) => s.setSliceRes);
  const sliceTolerance = useKerros((s) => s.sliceTolerance);
  const setSliceTolerance = useKerros((s) => s.setSliceTolerance);
  const sliceSmoothing = useKerros((s) => s.sliceSmoothing);
  const setSliceSmoothing = useKerros((s) => s.setSliceSmoothing);
  const hideAbove = useKerros((s) => s.hideAbove);
  const setHideAbove = useKerros((s) => s.setHideAbove);
  const fitToLayer = useKerros((s) => s.sliceFitToLayer);
  const setFitToLayer = useKerros((s) => s.setSliceFitToLayer);
  const minFeature = useKerros((s) => s.minFeature);
  const setMinFeature = useKerros((s) => s.setMinFeature);
  const currentLayer = useKerros((s) => s.currentLayer);

  const total = slices?.slices.length ?? 0;
  const layerIndex = total > 0 ? Math.min(Math.max(currentLayer, 1), total) : 0;
  const slice = layerIndex > 0 ? slices!.slices[layerIndex - 1] : null;
  const report = layerIndex > 0 ? reports[layerIndex - 1] : null;
  const flaggedLayers = reports.filter((r) => r.tooThin).length;

  const exportLayer = () => {
    if (!slice) return;
    const doc: DxfDocument = {
      polylines: slice.contours.map((contour) => ({
        points: contour.points,
        layer: LAYER_CUT,
        closed: true,
      })),
      circles: slice.circles.map((circle) => ({
        x: circle.x,
        y: circle.y,
        r: circle.r,
        layer: LAYER_CUT,
      })),
    };
    const number = String(slice.index).padStart(3, '0');
    downloadText(`kerros-layer-${number}.dxf`, writeDxfR12(doc));
  };

  const exportKerfTest = () => {
    downloadText('kerros-kerf-test.dxf', writeDxfR12(kerfTestDocument()));
  };

  const pitch = layerPitch(material, stack);
  const usableW = machine.bedWidth - machine.margin * 2;
  const usableH = machine.bedHeight - machine.margin * 2;

  return (
    <>
      <div className="group">
        <div className="group-head">Machine</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={machine.name}
              onChange={(e) => setMachine({ name: e.target.value })}
            />
          </span>
        </label>
        <NumberField
          label="Bed width"
          value={machine.bedWidth}
          unit="mm"
          min={1}
          onChange={(bedWidth) => setMachine({ bedWidth })}
        />
        <NumberField
          label="Bed height"
          value={machine.bedHeight}
          unit="mm"
          min={1}
          onChange={(bedHeight) => setMachine({ bedHeight })}
        />
        <NumberField
          label="Sheet margin"
          value={machine.margin}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(margin) => setMachine({ margin })}
        />
        <div className="derived">
          Usable sheet {usableW} × {usableH} mm
        </div>
      </div>

      <div className="group">
        <div className="group-head">Material</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={material.name}
              onChange={(e) => setMaterial({ name: e.target.value })}
            />
          </span>
        </label>
        <NumberField
          label="Thickness"
          value={material.thickness}
          unit="mm"
          step={0.1}
          min={0.1}
          onChange={(thickness) => setMaterial({ thickness })}
        />
        <NumberField
          label="Kerf"
          value={material.kerf}
          unit="mm"
          step={0.01}
          min={0}
          onChange={(kerf) => setMaterial({ kerf })}
        />
        <label className="field field-stacked">
          <span className="field-label">Notes</span>
          <textarea
            rows={2}
            value={material.notes}
            onChange={(e) => setMaterial({ notes: e.target.value })}
          />
        </label>
        {material.kerf <= 0 ? (
          <div className="warn">
            Kerf is zero. Cut the kerf test figure in this material and enter
            the measured value before exporting.
          </div>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">Stack</div>
        <NumberField
          label="Spacer height"
          value={stack.spacerHeight}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(spacerHeight) => setStack({ spacerHeight })}
        />
        <div className="derived derived-strong">
          Layer pitch {pitch.toFixed(2)} mm
          <span className="derived-sub">
            {material.thickness} mm material + {stack.spacerHeight} mm spacer
          </span>
        </div>
      </div>

      <div className="group">
        <div className="group-head">Preview</div>
        <label className="field">
          <span className="field-label">Resolution</span>
          <span className="field-input">
            <select
              value={previewRes}
              onChange={(e) => setPreviewRes(Number(e.target.value))}
            >
              {PREVIEW_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} samples
                </option>
              ))}
            </select>
          </span>
        </label>
        <div className="derived">
          Samples along the longest axis. Preview only — slicing gets its own,
          finer grid.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Slicing</div>
        <label className="field">
          <span className="field-label">Resolution</span>
          <span className="field-input">
            <select value={sliceRes} onChange={(e) => setSliceRes(Number(e.target.value))}>
              {SLICE_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} samples
                </option>
              ))}
            </select>
          </span>
        </label>
        <NumberField
          label="Simplify"
          value={sliceTolerance}
          unit="mm"
          step={0.01}
          min={0}
          max={2}
          onChange={setSliceTolerance}
        />
        <NumberField
          label="Smoothing"
          value={sliceSmoothing}
          step={1}
          min={0}
          max={3}
          onChange={setSliceSmoothing}
        />
        {mode === 'slice' ? (
          <label className="field">
            <span className="field-label">Fit to layer</span>
            <span className="field-input field-check">
              <input
                type="checkbox"
                checked={fitToLayer}
                onChange={(e) => setFitToLayer(e.target.checked)}
              />
              <span className="field-unit-wide">rescale to each layer</span>
            </span>
          </label>
        ) : null}
        {mode === 'stack' ? (
          <label className="field">
            <span className="field-label">Hide above</span>
            <span className="field-input field-check">
              <input
                type="checkbox"
                checked={hideAbove}
                onChange={(e) => setHideAbove(e.target.checked)}
              />
              <span className="field-unit-wide">cut away upper layers</span>
            </span>
          </label>
        ) : null}
        {mode !== 'model' ? (
          <div className="derived">
            Arrow keys or [ and ] step layers. Home and End jump to the bottom
            and top.
          </div>
        ) : null}
        {slices ? (
          <div className="derived derived-strong">
            {slices.slices.length} layers
            <span className="derived-sub">
              {slices.planesExamined} planes examined · {slices.step.toFixed(3)} mm
              sample
            </span>
          </div>
        ) : (
          <div className="derived">
            Open Slice or Stack to slice. Contours are not kerf-compensated yet —
            that lands with DXF export in M3.
          </div>
        )}
      </div>

      <div className="group">
        <div className="group-head">Checks</div>
        <NumberField
          label="Min feature"
          value={minFeature}
          unit="mm"
          step={0.1}
          min={0}
          max={10}
          onChange={setMinFeature}
        />
        <div className="derived">
          Checked against whichever is larger, this or two kerfs. Below that a
          wall burns through however good the geometry is.
        </div>
        {flaggedLayers > 0 ? (
          <div className="warn">
            {flaggedLayers} of {total} layers have a feature narrower than the
            limit
            {report?.tooThin
              ? `, including this one at ${report.minGap.toFixed(2)} mm`
              : ''}
            . They are ringed in the slice inspector.
          </div>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">Export</div>
        <button
          type="button"
          className="btn btn-wide"
          disabled={!slice}
          onClick={exportLayer}
        >
          {slice ? `Export layer ${slice.index} as DXF` : 'Export layer as DXF'}
        </button>
        <button type="button" className="btn btn-wide" onClick={exportKerfTest}>
          Export kerf test
        </button>
        <div className="derived">
          DXF R12, layer {LAYER_CUT}, millimetres. Contours are kerf-compensated
          at {material.kerf} mm; the kerf test deliberately is not — that is
          what makes it a measurement. Nesting several layers onto one sheet
          arrives in M4.
        </div>
        {material.kerf <= 0 ? (
          <div className="warn">
            Kerf is zero, so nothing is compensated. Cut the kerf test, measure
            it, and enter the real number before cutting parts.
          </div>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">Seed</div>
        <NumberField label="Global seed" value={seed} step={1} min={0} onChange={setSeed} />
        <div className="derived">Same seed, same geometry, every evaluation</div>
      </div>
    </>
  );
}
