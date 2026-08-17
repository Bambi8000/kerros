import { PREVIEW_RESOLUTIONS, useKerros } from '../core/store';
import { layerPitch } from '../core/types';
import { NumberField } from './NumberField';

export function ProfilePanel() {
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
        <div className="group-head">Seed</div>
        <NumberField label="Global seed" value={seed} step={1} min={0} onChange={setSeed} />
        <div className="derived">Same seed, same geometry, every evaluation</div>
      </div>
    </>
  );
}
