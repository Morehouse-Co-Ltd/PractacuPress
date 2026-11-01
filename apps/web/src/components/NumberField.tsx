import { Field, Input } from './ui';

/** 带单位与范围收敛的数字输入，设置页共用。 */
export function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="input-suffix">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange(
              Number.isFinite(next) ? Math.min(max, Math.max(min, Math.round(next))) : min,
            );
          }}
        />
        <span>{unit}</span>
      </div>
    </Field>
  );
}
