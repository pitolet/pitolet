import { Select as BaseSelect } from '@base-ui-components/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useMemo } from 'react';
import './Select.css';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
}

export interface SelectProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  /** Compact width control for inspector rows. */
  className?: string;
  disabled?: boolean;
}

export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  className = '',
  disabled,
}: SelectProps<V>) {
  const items = useMemo(
    () => options.map((o) => ({ value: o.value, label: o.label })),
    // Re-map only when the actual option values change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.map((o) => `${o.value}:${o.label}`).join('|')],
  );
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
      items={items}
    >
      <BaseSelect.Trigger className={`ptl-select-trigger ${className}`}>
        <BaseSelect.Value />
        <BaseSelect.Icon className="ptl-select-icon">
          <ChevronsUpDown size={12} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} className="ptl-select-positioner">
          <BaseSelect.Popup className="ptl-select-popup">
            {options.map((option) => (
              <BaseSelect.Item key={option.value} value={option.value} className="ptl-select-item">
                <BaseSelect.ItemIndicator className="ptl-select-item-indicator">
                  <Check size={12} />
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
