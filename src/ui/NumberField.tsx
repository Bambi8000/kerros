import { useState } from 'react';

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
 * Round the display, not the model. Keep an in-progress edit until blur;
 * external changes (including clamps and gizmos) replace the draft.
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
  const [draft, setDraft] = useState<{ value: number; text: string } | null>(null);
  const display = String(Number(value.toFixed(2)));
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="number"
          value={draft?.value === value ? draft.text : display}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const text = e.target.value;
            const next = Number(text);
            const valid = text !== '' && Number.isFinite(next);
            setDraft({ value: valid ? next : value, text });
            if (valid) onChange(next);
          }}
          onBlur={(e) => {
            setDraft(null);
            e.currentTarget.scrollLeft = 0;
          }}
        />
        {unit ? <span className="field-unit">{unit}</span> : null}
      </span>
    </label>
  );
}
