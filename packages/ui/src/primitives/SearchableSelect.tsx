import { Combobox as BaseCombobox } from '@base-ui-components/react/combobox';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import './SearchableSelect.css';

export interface SearchableSelectOption<V extends string = string> {
  value: V;
  label: string;
}

export interface SearchableSelectGroup<V extends string = string> {
  label: string;
  options: readonly SearchableSelectOption<V>[];
}

export interface SearchableSelectProps<V extends string = string> {
  value: V | '';
  onValueChange: (value: V) => void;
  groups: readonly SearchableSelectGroup<V>[];
  ariaLabel: string;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
}

type ComboboxGroup<V extends string> = {
  value: string;
  items: SearchableSelectOption<V>[];
};

/** A compact inspector picker that stays useful when the option list gets long. */
export function SearchableSelect<V extends string = string>({
  value,
  onValueChange,
  groups,
  ariaLabel,
  placeholder = 'Search…',
  emptyMessage = 'No matches',
  className = '',
  disabled,
}: SearchableSelectProps<V>) {
  const items = useMemo<ComboboxGroup<V>[]>(
    () =>
      groups
        .map((group) => ({ value: group.label, items: [...group.options] }))
        .filter((group) => group.items.length > 0),
    [groups],
  );
  const selected = useMemo(
    () => items.flatMap((group) => group.items).find((option) => option.value === value) ?? null,
    [items, value],
  );
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(selected?.label ?? '');

  useEffect(() => {
    if (!open) setInputValue(selected?.label ?? '');
  }, [open, selected?.label]);

  return (
    <BaseCombobox.Root<SearchableSelectOption<V>>
      items={items}
      value={selected ?? undefined}
      open={open}
      onOpenChange={setOpen}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
      onValueChange={(option) => {
        if (!option) return;
        setInputValue(option.label);
        onValueChange(option.value);
      }}
      isItemEqualToValue={(option, current) => option.value === current.value}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      autoHighlight
      disabled={disabled}
    >
      <div className={`ptl-search-select-control ${className}`}>
        <BaseCombobox.Input
          className="ptl-search-select-input"
          aria-label={ariaLabel}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
        />
        <BaseCombobox.Trigger
          className="ptl-search-select-trigger"
          aria-label={`Open ${ariaLabel}`}
        >
          <ChevronsUpDown size={12} />
        </BaseCombobox.Trigger>
      </div>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={4} className="ptl-search-select-positioner">
          <BaseCombobox.Popup className="ptl-search-select-popup">
            <BaseCombobox.List className="ptl-search-select-list">
              <BaseCombobox.Collection>
                {(group: ComboboxGroup<V>) => (
                  <BaseCombobox.Group
                    key={group.value}
                    items={group.items}
                    className="ptl-search-select-group"
                  >
                    <BaseCombobox.GroupLabel className="ptl-search-select-group-label">
                      {group.value}
                    </BaseCombobox.GroupLabel>
                    <BaseCombobox.Collection>
                      {(option: SearchableSelectOption<V>) => (
                        <BaseCombobox.Item
                          key={option.value}
                          value={option}
                          className="ptl-search-select-item"
                        >
                          <span>{option.label}</span>
                          <BaseCombobox.ItemIndicator className="ptl-search-select-item-indicator">
                            <Check size={12} />
                          </BaseCombobox.ItemIndicator>
                        </BaseCombobox.Item>
                      )}
                    </BaseCombobox.Collection>
                  </BaseCombobox.Group>
                )}
              </BaseCombobox.Collection>
            </BaseCombobox.List>
            <BaseCombobox.Empty className="ptl-search-select-empty">
              {emptyMessage}
            </BaseCombobox.Empty>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
