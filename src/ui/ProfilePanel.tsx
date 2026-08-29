import { useState } from 'react';
import { PREVIEW_RESOLUTIONS, SLICE_RESOLUTIONS, useKerros } from '../core/store';
import { layerPitch } from '../core/types';
import type { GapReport, SliceSet } from '../core/slice';
import { kerfTestDocument, writeDxfR12 } from '../core/dxf';
import { assemblyDocument, manifestText, sheetToDxf } from '../core/job';
import { writePdf } from '../core/pdf';
import { KERROS_VERSION } from '../version';
import { parseProject, projectFilename, serializeProject } from '../core/project';
import { NumberField } from './NumberField';
import {
  currentExportFolder,
  forgetExportFolder,
  isNative,
  openText,
  saveMany,
  saveText,
} from './download';
import type { SaveOutcome } from './download';
import type { SheetResult } from './useSheets';

interface Props {
  /** Latest slicing result, so this panel can report what came out. */
  slices: SliceSet | null;
  reports: GapReport[];
  sheets: SheetResult;
  /** Sheets each pins feature left held on one side only. */
  pinLoose: Record<string, number[]>;
}

export function ProfilePanel({ slices, reports, sheets, pinLoose }: Props) {
  const projectName = useKerros((s) => s.projectName);
  const setProjectName = useKerros((s) => s.setProjectName);
  const trueShape = useKerros((s) => s.trueShapeNesting);
  const setTrueShapeNesting = useKerros((s) => s.setTrueShapeNesting);
  const nestCell = useKerros((s) => s.nestCell);
  const setNestCell = useKerros((s) => s.setNestCell);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [folder, setFolder] = useState<string | null>(currentExportFolder());

  /** One place to announce what a save did, so every button behaves the same. */
  const announce = (outcome: SaveOutcome) => {
    setFolder(currentExportFolder());
    if (outcome.cancelled) {
      setNotice(null);
      return;
    }
    setNotice({ kind: outcome.ok ? 'ok' : 'bad', text: outcome.message });
  };
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
  const currentSheet = useKerros((s) => s.currentSheet);
  const partGap = useKerros((s) => s.partGap);
  const setPartGap = useKerros((s) => s.setPartGap);
  const labelHeight = useKerros((s) => s.labelHeight);
  const setLabelHeight = useKerros((s) => s.setLabelHeight);
  const ringWidth = useKerros((s) => s.ringWidth);
  const setRingWidth = useKerros((s) => s.setRingWidth);
  const makeSpacers = useKerros((s) => s.makeSpacers);
  const setMakeSpacers = useKerros((s) => s.setMakeSpacers);
  const clearAllPlacements = useKerros((s) => s.clearAllPlacements);
  const rodCount = useKerros(
    (s) => s.features.filter((f) => f.kind === 'rod' && f.enabled).length,
  );
  const fluteDirection = useKerros((s) => s.fluteDirection);
  const setFluteDirection = useKerros((s) => s.setFluteDirection);
  const flutePitch = useKerros((s) => s.flutePitch);
  const setFlutePitch = useKerros((s) => s.setFlutePitch);
  const scatterAngle = useKerros((s) => s.scatterAngle);
  const setScatterAngle = useKerros((s) => s.setScatterAngle);

  const collidingSheets = Object.entries(sheets.reports)
    .filter(([, report]) => report.colliding.length > 0)
    .map(([index]) => index);
  const tightSheets = Object.entries(sheets.reports)
    .filter(([, report]) => report.tight.length > 0)
    .map(([index]) => index);
  const closestGap = Object.values(sheets.reports).reduce(
    (min, report) => Math.min(min, report.closest),
    Infinity,
  );

  const total = slices?.slices.length ?? 0;
  const layerIndex = total > 0 ? Math.min(Math.max(currentLayer, 1), total) : 0;
  const report = layerIndex > 0 ? reports[layerIndex - 1] : null;
  const flaggedLayers = reports.filter((r) => r.tooThin).length;

  /** Every sheet any pins feature left half-fastened, named once. */
  const looseSheets = Array.from(new Set(Object.values(pinLoose).flat())).sort((a, b) => a - b);

  const sheetCount = sheets.sheets.length;
  const sheetIndex = sheetCount > 0 ? Math.min(Math.max(currentSheet, 1), sheetCount) : 0;
  const spacerTotal = sheets.spacers.reduce((sum, plan) => sum + plan.total, 0);
  const spacerMismatch =
    makeSpacers &&
    stack.spacerHeight > 0 &&
    Math.abs(sheets.spacerAchieved - stack.spacerHeight) > 1e-6;

  const sheetFile = (target: SheetResult['sheets'][number]) => ({
    name: `kerros-${target.material}-sheet-${String(target.ordinal).padStart(2, '0')}.dxf`,
    contents: writeDxfR12(sheetToDxf(target)),
  });

  const exportSheet = async (which: number) => {
    const target = sheets.sheets[which - 1];
    if (!target) return;
    announce(await saveText(sheetFile(target)));
  };

  const exportAllSheets = async () => {
    announce(await saveMany(sheets.sheets.map(sheetFile)));
  };

  const exportManifest = async () => {
    if (!slices) return;
    announce(
      await saveText(
        {
          name: 'kerros-manifest.txt',
          contents: manifestText({
        set: slices,
        sheets: sheets.sheets,
        spacers: sheets.spacers,
        machineName: machine.name,
        materialName: material.name,
        thickness: material.thickness,
        kerf: material.kerf,
        spacerHeight: stack.spacerHeight,
        spacerAchieved: sheets.spacerAchieved,
            version: KERROS_VERSION,
          }),
        },
        'text/plain',
      ),
    );
  };

  /**
   * The pages that go to the bench with the parts.
   *
   * A separate button from the manifest rather than a replacement for it. The
   * manifest is text that gets printed and marked up with a pencil; this is
   * drawings, and what it is for is telling one part from another — which is
   * the thing that turned out to be hard once there was a pile to sort.
   */
  const exportAssembly = async () => {
    if (!slices) return;
    announce(
      await saveText(
        {
          name: 'kerros-assembly.pdf',
          contents: writePdf(
            assemblyDocument({
              set: slices,
              sheets: sheets.sheets,
              spacers: sheets.spacers,
              machineName: machine.name,
              materialName: material.name,
              thickness: material.thickness,
              kerf: material.kerf,
              spacerHeight: stack.spacerHeight,
              spacerAchieved: sheets.spacerAchieved,
              version: KERROS_VERSION,
              // A ring is what you pick up off the bench, so the gaps are given
              // in rings — and 0 means the rings are the stock.
              // Read here rather than from `ringT` below, which is declared
              // further down the component: this closure would reach it fine,
              // but a value used above its own declaration is the shape of a
              // bug this file has already had once.
              ringThickness:
                (stack.spacerThickness ?? 0) > 0
                  ? (stack.spacerThickness as number)
                  : material.thickness,
              projectName,
            }),
          ),
        },
        'application/pdf',
      ),
    );
  };

  const saveProject = async () => {
    const data = useKerros.getState().projectData();
    announce(
      await saveText(
        {
          name: projectFilename(data.name),
          contents: serializeProject(data, KERROS_VERSION, new Date().toISOString()),
        },
        'application/json',
      ),
    );
  };

  const loadProject = async () => {
    const picked = await openText(['json'], '.json,.kerros.json,application/json');
    if (!picked) return;

    const result = parseProject(picked.contents);
    if (!result.ok || !result.data) {
      setNotice({ kind: 'bad', text: result.error ?? 'That file could not be read.' });
      return;
    }

    useKerros.getState().applyProject(result.data, result.nextFeatureNumber);
    setNotice({
      kind: 'ok',
      text:
        result.warnings.length > 0
          ? `Opened with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}: ${result.warnings[0]}`
          : 'Opened',
    });
  };

  const exportKerfTest = async () => {
    announce(
      await saveText({
        name: 'kerros-kerf-test.dxf',
        contents: writeDxfR12(kerfTestDocument()),
      }),
    );
  };

  /**
   * The pitch to show.
   *
   * The planned stack is the truth once it exists, because gaps are whole rings
   * and can differ between the bottom and the top. `layerPitch` is the fallback
   * for before anything has been sliced, and it quantises the same way.
   */
  /**
   * The gap a ring count actually produces.
   *
   * A gap is whole rings and a ring is one sheet of its own material, so these
   * are the numbers the stack will be built from — not the ones typed in.
   */
  const ringT = (stack.spacerThickness ?? 0) > 0 ? (stack.spacerThickness as number) : material.thickness;
  const ringsAt = (mm: number) => (ringT > 0 ? Math.max(Math.round(Math.max(mm, 0) / ringT), 0) : 0);
  const ringsLow = ringsAt(stack.spacerHeight);
  const ringsHigh = ringsAt(stack.spacerHeightTop ?? stack.spacerHeight);
  /*
   * Three states, not two.
   *
   * Asking for different gaps and getting different gaps are not the same
   * thing: 3 mm and 4 mm are both one 3 mm ring, so the stack comes out uniform
   * while the two numbers on screen say it should not. That case needs its own
   * sentence — it is the one where a control appears to do something and does
   * nothing, which is the failure this panel exists to prevent.
   */
  const gapTop = stack.spacerHeightTop ?? stack.spacerHeight;
  const asked = Math.abs(gapTop - stack.spacerHeight) > 1e-9;
  const graded = ringsLow !== ringsHigh;
  const gradeLow = (Math.min(ringsLow, ringsHigh) * ringT).toFixed(2);
  const gradeHigh = (Math.max(ringsLow, ringsHigh) * ringT).toFixed(2);
  const gradeSteps = Math.abs(ringsHigh - ringsLow) + 1;

  const gaps = slices?.planes.map((plane) => plane.gapAbove) ?? [];
  const pitchLow = gaps.length > 0 ? material.thickness + Math.min(...gaps) : layerPitch(material, stack);
  const pitchHigh = gaps.length > 0 ? material.thickness + Math.max(...gaps) : pitchLow;
  const pitchVaries = Math.abs(pitchHigh - pitchLow) > 1e-9;
  const usableW = machine.bedWidth - machine.margin * 2;
  const usableH = machine.bedHeight - machine.margin * 2;

  return (
    <>
      <div className="group">
        <div className="group-head">Project</div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="field-input">
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </span>
        </label>
        <button type="button" className="btn btn-wide" onClick={() => void saveProject()}>
          Save project
        </button>
        <button type="button" className="btn btn-wide" onClick={() => void loadProject()}>
          Open project…
        </button>
        {notice ? (
          <div className={notice.kind === 'bad' ? 'warn' : 'derived'}>{notice.text}</div>
        ) : null}
        <div className="derived">
          A .kerros.json holds the profiles, the whole feature tree, the seed
          and every hand placement — everything needed to cut this lamp again.
          What mode you had open and what was selected is not part of the
          design, so it is not saved.
        </div>
      </div>

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
          label="Ring thickness"
          value={stack.spacerThickness ?? 0}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(spacerThickness) => setStack({ spacerThickness })}
        />
        <div className="derived">
          {(stack.spacerThickness ?? 0) === 0
            ? `0 follows the stock, so rings are ${material.thickness} mm.`
            : ringT === material.thickness
              ? `Rings are ${ringT} mm, the same as the stock.`
              : `Rings are cut from ${ringT} mm material, not the ${material.thickness} mm stock.`}
        </div>
        <NumberField
          label={asked ? 'Gap at the bottom' : 'Spacer height'}
          value={stack.spacerHeight}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(spacerHeight) => setStack({ spacerHeight })}
        />
        <NumberField
          label="Gap at the top"
          value={stack.spacerHeightTop ?? stack.spacerHeight}
          unit="mm"
          step={0.5}
          min={0}
          onChange={(spacerHeightTop) => setStack({ spacerHeightTop })}
        />
        {/*
          A gradient is only as smooth as the ring material lets it be, and the
          number of steps it can actually take is not something anyone can work
          out from two millimetre readings. Saying it here is the difference
          between a dial that works and one that appears not to.
        */}
        {graded ? (
          <div className="derived">
            {`${ringT} mm rings, so the gap goes ${gradeLow} → ${gradeHigh} mm in ${gradeSteps} steps.`}
          </div>
        ) : asked ? (
          <div className="warn">
            {`${stack.spacerHeight} mm and ${gapTop} mm are both ${ringsLow} ${
              ringsLow === 1 ? 'ring' : 'rings'
            } of ${ringT} mm, so the stack comes out uniform at ${gradeLow} mm. Rings of ${Math.abs(
              gapTop - stack.spacerHeight,
            ).toFixed(2)} mm or thinner would grade it, and so would gaps further apart.`}
          </div>
        ) : (
          <div className="derived">
            Both gaps the same, so the stack is uniform. Set them apart to open
            it out or close it up as it rises.
          </div>
        )}
        <div className="derived derived-strong">
          {pitchVaries
            ? `Layer pitch ${pitchLow.toFixed(2)}–${pitchHigh.toFixed(2)} mm`
            : `Layer pitch ${pitchLow.toFixed(2)} mm`}
          <span className="derived-sub">
            {material.thickness} mm material +{' '}
            {pitchVaries
              ? `${(pitchLow - material.thickness).toFixed(2)}–${(pitchHigh - material.thickness).toFixed(2)} mm spacer`
              : `${(pitchLow - material.thickness).toFixed(2)} mm spacer`}
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
        {/*
          Loose sheets belong here rather than only in the pins panel. A
          thin wall is a warning about how a part will cut; a sheet fastened on
          one side is a warning about whether the lamp stands up, and that is
          the sort of thing somebody checks once before exporting rather than by
          clicking through features.
        */}
        {looseSheets.length > 0 ? (
          <div className="warn">
            {looseSheets.length === 1 ? 'Sheet' : 'Sheets'} {looseSheets.join(', ')}{' '}
            {looseSheets.length === 1 ? 'is' : 'are'} pinned on one side only.
            The pins in the gap beside {looseSheets.length === 1 ? 'it' : 'them'}{' '}
            did not fit both sheets, so the stack is not fastened through there.
          </div>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">Stock grain</div>
        <label className="field">
          <span className="field-label">Flutes</span>
          <span className="field-input">
            <select
              value={fluteDirection}
              onChange={(e) =>
                setFluteDirection(e.target.value as 'none' | 'horizontal' | 'vertical')
              }
            >
              <option value="none">None (plain sheet)</option>
              <option value="horizontal">Horizontal</option>
              <option value="vertical">Vertical</option>
            </select>
          </span>
        </label>
        {fluteDirection !== 'none' ? (
          <NumberField
            label="Flute pitch"
            value={flutePitch}
            unit="mm"
            step={0.5}
            min={0.5}
            max={30}
            onChange={setFlutePitch}
          />
        ) : null}
        <NumberField
          label="Scatter ±"
          value={scatterAngle}
          unit="°"
          step={5}
          min={0}
          max={180}
          onChange={setScatterAngle}
        />
        <div className="derived">
          Corrugated board has flutes running one way inside it, and a cut edge
          exposes them. Cut every part at the same angle and every layer's edge
          looks identical and passes light identically. The Scatter button in
          the sheet view turns each part by a seeded random angle within this
          limit — same seed, same lamp.
        </div>
      </div>

      <div className="group">
        <div className="group-head">Nesting</div>
        <NumberField
          label="Part gap"
          value={partGap}
          unit="mm"
          step={0.5}
          min={0}
          max={50}
          onChange={setPartGap}
        />
        <NumberField
          label="Label size"
          value={labelHeight}
          unit="mm"
          step={0.5}
          min={0}
          max={20}
          onChange={setLabelHeight}
        />
        <label className="field">
          <span className="field-label">Spacers</span>
          <span className="field-input field-check">
            <input
              type="checkbox"
              checked={makeSpacers}
              onChange={(e) => setMakeSpacers(e.target.checked)}
            />
            <span className="field-unit-wide">cut spacer rings</span>
          </span>
        </label>
        {makeSpacers ? (
          <NumberField
            label="Ring width"
            value={ringWidth}
            unit="mm"
            step={0.5}
            min={0.5}
            max={40}
            onChange={setRingWidth}
          />
        ) : null}
        {sheetCount > 0 ? (
          <div className="derived derived-strong">
            {sheetCount} {sheetCount === 1 ? 'sheet' : 'sheets'}, {sheets.partCount} parts
            <span className="derived-sub">
              {total} layers
              {spacerTotal > 0 ? ` + ${spacerTotal} spacer rings` : ''}
              {sheets.busy
                ? ' · nesting…'
                : sheets.ms > 0
                  ? ` · packed in ${sheets.ms} ms`
                  : ''}
            </span>
          </div>
        ) : sheets.busy ? (
          // Packing runs in the worker, so an empty readout here means it has
          // not landed yet, not that there is nothing to nest. True shape takes
          // about half a second on a real lamp and longer in the native shell.
          <div className="derived">Nesting the job onto the bed…</div>
        ) : (
          <div className="derived">Open Sheet to nest the job onto the bed.</div>
        )}
        {makeSpacers && rodCount === 0 ? (
          <div className="derived">
            No spacer rings, because there are no rods. A ring fills the gap
            between two layers on a rod, so rods come first — add one with
            &ldquo;Add rod&rdquo; in the feature tree.
          </div>
        ) : null}
        {makeSpacers && rodCount > 0 && spacerTotal === 0 && total > 1 ? (
          <div className="derived">
            No spacer rings: no rod reaches two layers, so there are no gaps to
            fill. Check each rod&rsquo;s Z position and length.
          </div>
        ) : null}
        {/*
          This used to threaten that the stack would not close on the rods, and
          that threat is no longer true: the model is planned on the gap the
          rings can make, so what gets cut and what gets built agree. What is
          left is worth saying anyway — the lamp is not quite the one that was
          asked for, and a number typed in came back different.
        */}
        {spacerMismatch ? (
          <div className="derived">
            {stack.spacerHeight} mm was asked for and {sheets.spacerAchieved} mm
            is what whole {ringT} mm rings make, so that is what the layers are
            planned on. Use a multiple of {ringT} mm, or thinner rings, to get
            the gap you meant.
          </div>
        ) : null}
        {sheets.unplaced.length > 0 ? (
          <div className="warn">
            {sheets.unplaced.length} parts do not fit the bed at all. They are
            left out of every sheet.
          </div>
        ) : null}
        {sheets.pinnedCount > 0 ? (
          <>
            <button type="button" className="btn btn-wide" onClick={clearAllPlacements}>
              Unpin all {sheets.pinnedCount} parts
            </button>
            <div className="derived">
              Pinned parts stay where you put them when the job is nested again.
              Drag in the Sheet view, arrow keys to nudge, Backspace to unpin.
            </div>
          </>
        ) : null}
        {collidingSheets.length > 0 ? (
          <div className="warn">
            Cut outlines actually meet on{' '}
            {collidingSheets.length === 1 ? 'sheet' : 'sheets'}{' '}
            {collidingSheets.join(', ')}. Those parts are drawn in amber and
            will burn into each other. Nothing stops you exporting it — the
            check is a warning, not a lock.
          </div>
        ) : null}
        {collidingSheets.length === 0 && tightSheets.length > 0 ? (
          <div className="derived">
            Closest approach {closestGap.toFixed(2)} mm, under the {partGap} mm
            part gap, on{' '}
            {tightSheets.length === 1 ? 'sheet' : 'sheets'} {tightSheets.join(', ')}.
            Those outlines are dimmed. Nothing overlaps, so this is only worth a
            look if the material chars easily.
          </div>
        ) : null}
      </div>

      <div className="group">
        <div className="group-head">Export</div>
        <button
          type="button"
          className="btn btn-wide"
          disabled={sheetIndex === 0 || sheets.busy}
          onClick={() => void exportSheet(sheetIndex)}
        >
          {sheetIndex > 0 ? `Export sheet ${sheetIndex} as DXF` : 'Export sheet as DXF'}
        </button>
        <button
          type="button"
          className="btn btn-wide"
          disabled={sheetCount === 0 || sheets.busy}
          onClick={() => void exportAllSheets()}
        >
          {sheetCount > 1 ? `Export all ${sheetCount} sheets` : 'Export all sheets'}
        </button>
        <button
          type="button"
          className="btn btn-wide"
          disabled={!slices || sheets.busy}
          onClick={() => void exportManifest()}
        >
          Export build manifest
        </button>
        <button
          type="button"
          className="btn btn-wide"
          disabled={!slices || sheets.busy}
          onClick={() => void exportAssembly()}
        >
          Export assembly PDF
        </button>
        <button type="button" className="btn btn-wide" onClick={() => void exportKerfTest()}>
          Export kerf test
        </button>
        {/* The kerf test is a fixed figure and owes nothing to the nesting, so
            it stays live. The three above write the layout, and while a pack is
            in flight the layout on screen is the previous one — exporting it
            would put a file on disk that does not match the bed. */}
        {sheets.busy ? (
          <div className="derived">
            Nesting in progress, so the sheet exports are held until it lands.
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">Nesting</span>
          <span className="field-input">
            <select
              value={trueShape ? 'shape' : 'box'}
              onChange={(e) => setTrueShapeNesting(e.target.value === 'shape')}
            >
              <option value="box">Bounding box · fast</option>
              <option value="shape">True shape · uses the holes</option>
            </select>
          </span>
        </label>
        {trueShape ? (
          <>
            <NumberField
              label="Nest grid"
              value={nestCell}
              unit="mm"
              step={0.5}
              min={0.5}
              max={6}
              onChange={setNestCell}
            />
            <div className="derived">
              Packs against the real outline, so a small part can sit inside a
              ring&rsquo;s hole. Costs about half a second per layout, which is
              worth paying when you are about to buy material.
              <br />
              A finer grid is not reliably better: greedy packing is not monotonic
              in resolution, and on one real job 1.5 mm needed six sheets where
              both 1 mm and 2 mm needed seven. Try a couple of values before
              cutting and keep whichever wins.
            </div>
          </>
        ) : (
          <div className="derived">
            Bounding-box shelves. Every part reserves a rectangle, so the inside
            of every ring is waste — which on a lamp is most of the sheet.
          </div>
        )}
        {isNative() ? (
          <>
            {folder ? (
              <>
                <div className="derived">
                  Batch exports go to <code>{folder}</code>, chosen once for this
                  session.
                </div>
                <button
                  type="button"
                  className="btn btn-wide"
                  onClick={() => {
                    forgetExportFolder();
                    setFolder(null);
                    setNotice(null);
                  }}
                >
                  Choose another folder
                </button>
              </>
            ) : (
              <div className="derived">
                Exporting all sheets asks for a folder once and writes them all
                there.
              </div>
            )}
          </>
        ) : null}
        <div className="derived">
          DXF R12, millimetres, CUT and ENGRAVE layers. Cuts are
          kerf-compensated at {material.kerf} mm; the kerf test deliberately is
          not — that is what makes it a measurement. Layer numbers are engraved
          as stroke polylines rather than DXF text, which laser front-ends
          handle inconsistently.
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
