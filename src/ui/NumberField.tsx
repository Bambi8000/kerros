interface NumberFieldProps {
  label: string;
  value: number;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}

/**
 * Numeric input. Text is kept editable while typing (so backspacing a value
 * does not snap it back), and only finite numbers reach the store.
 */
export function NumberField({
  label,
  value,
  unit,
  step = 1,
  min,
  max,
  onChange,
}: NumberFieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (e.target.value !== '' && Number.isFinite(next)) onChange(next);
          }}
        />
        {unit ? <span className="field-unit">{unit}</span> : null}
      </span>
    </label>
  );
}
