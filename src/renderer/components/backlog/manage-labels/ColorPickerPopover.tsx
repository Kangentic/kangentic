import React, { useState, useEffect, useRef } from 'react';
import { Palette } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';

export const PRESET_COLORS = [
  '#6b7280', '#ef4444', '#f43f5e', '#f97316',
  '#f59e0b', '#10b981', '#06b6d4', '#3b82f6',
  '#8b5cf6', '#ec4899', '#78716c',
];

/**
 * Fixed-position color picker popover. Anchors to `triggerRef`, falls
 * back above the trigger if there isn't room below, and flips left if
 * it would overflow the viewport.
 *
 * Closes on outside click OR Escape. Escape capture stops propagation
 * so it doesn't also close the outer popover that hosts the color
 * button.
 */
export function ColorPickerPopover({
  color,
  triggerRef,
  onChange,
  onClose,
}: {
  color: string;
  triggerRef: React.RefObject<HTMLElement | null>;
  onChange: (color: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [hexInput, setHexInput] = useState(color);
  const isCustomColor = !PRESET_COLORS.includes(color);

  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!triggerRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = 200;
    const popoverHeight = 300;
    let top = triggerRect.bottom + 4;
    let left = triggerRect.left;
    if (left + popoverWidth > window.innerWidth - 16) left = window.innerWidth - popoverWidth - 16;
    if (top + popoverHeight > window.innerHeight - 16) top = triggerRect.top - popoverHeight - 4;
    setPosition({ top, left });
  }, [triggerRef]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [onClose, triggerRef]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="fixed z-[60] bg-surface-raised border border-edge rounded-lg shadow-xl p-2"
      style={{ top: position.top, left: position.left }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="grid grid-cols-6 gap-1.5 place-items-center">
        {PRESET_COLORS.map((presetColor) => (
          <button
            key={presetColor}
            type="button"
            onClick={() => {
              onChange(presetColor);
              setHexInput(presetColor);
              setShowCustomPicker(false);
              onClose();
            }}
            className={`w-6 h-6 rounded-full border-2 transition-all ${
              color === presetColor ? 'border-white/60 scale-110' : 'border-transparent hover:border-fg-faint'
            }`}
            style={{ backgroundColor: presetColor }}
          />
        ))}
        <button
          type="button"
          onClick={() => setShowCustomPicker(!showCustomPicker)}
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
            isCustomColor
              ? 'border-white/60 scale-110'
              : showCustomPicker
                ? 'border-white/60 bg-surface-hover'
                : 'border-edge-input hover:border-fg-muted bg-surface-raised'
          }`}
          style={isCustomColor ? { backgroundColor: color } : undefined}
          title="Custom color"
        >
          <Palette size={10} className={isCustomColor ? 'text-white' : 'text-fg-muted'} />
        </button>
      </div>

      {showCustomPicker && (
        <div className="mt-3 space-y-2">
          <HexColorPicker
            color={color}
            onChange={(newColor) => { onChange(newColor); setHexInput(newColor); }}
            className="!w-full"
          />
          <input
            type="text"
            value={hexInput}
            onChange={(event) => {
              const value = event.target.value;
              setHexInput(value);
              if (/^#[0-9a-fA-F]{6}$/.test(value)) onChange(value.toLowerCase());
            }}
            onBlur={() => {
              if (!/^#[0-9a-fA-F]{6}$/.test(hexInput)) setHexInput(color);
            }}
            className="w-full bg-surface border border-edge-input rounded px-3 py-1.5 text-sm text-fg font-mono focus:outline-none focus:border-accent"
            placeholder="#000000"
            maxLength={7}
          />
        </div>
      )}
    </div>
  );
}
