import React from 'react';

interface ButtonGroupOption<T extends string> {
  value: T;
  label: string;
}

interface ButtonGroupProps<T extends string> {
  options: ButtonGroupOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}

export function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: ButtonGroupProps<T>) {
  const padding = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';

  return (
    <div className="flex items-center gap-0.5 bg-surface/50 rounded-lg p-0.5 border border-edge/30">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`${padding} font-medium rounded-md transition-colors ${
            value === option.value
              ? 'bg-surface-raised text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
