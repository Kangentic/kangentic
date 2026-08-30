import { useState, useRef, useEffect, type ReactNode } from 'react';
import { MoreHorizontal, Check } from 'lucide-react';
import { usePopoverPosition } from '../hooks/usePopoverPosition';
import { OverlayPopover } from './OverlayPopover';

interface KebabMenuProps {
  /** Render menu items. Call `close` to dismiss the menu after an action. */
  children: (close: () => void) => ReactNode;
  /** Trigger glyph. Defaults to the three-dot kebab. Pass another lucide icon
   *  when the menu is a named affordance rather than a generic action list
   *  (e.g. the diff toolbar's "view options" sliders). */
  icon?: ReactNode;
  /** Trigger tooltip. Defaults to 'Actions'. */
  title?: string;
  /** Override the trigger's classes so the button can match a host toolbar's
   *  own button styling instead of the default header treatment. */
  triggerClassName?: string;
  /** Test id for the trigger button. */
  triggerTestId?: string;
  /** Test id for the portaled menu surface. */
  menuTestId?: string;
}

const DEFAULT_TRIGGER_CLASS = 'p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors';

/**
 * Reusable kebab (three-dot) menu button with click-outside dismissal and
 * smart popover positioning. Used by TaskDetailHeader, CommandBarOverlay, and
 * the Changes diff toolbar's view-options menu.
 */
export function KebabMenu({ children, icon, title = 'Actions', triggerClassName, triggerTestId, menuTestId }: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Fixed positioning + a body portal so the menu (and its flyout submenus) escape
  // a clipping ancestor - a window frame's `overflow-hidden` was cropping the
  // "Move to" / "Commands" flyouts when the task detail became a window.
  const { style } = usePopoverPosition(containerRef, popoverRef, open, { mode: 'dropdown', strategy: 'fixed' });

  // Close on click outside. The popover is portaled OUT of `containerRef`, so a
  // click inside it must also count as "inside" (else selecting an item, or
  // opening a flyout, would dismiss the menu).
  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideTrigger = containerRef.current?.contains(target);
      const insidePopover = popoverRef.current?.contains(target);
      if (!insideTrigger && !insidePopover) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [open]);

  // Escape closes the MENU, not the window behind it. An open menu is the
  // transient in-gesture shape `.claude/rules/keybindings-registry.md` calls
  // out: the host dialog / pop-out window dismisses itself on a bubble-phase
  // document Escape, so without a capture-phase intercept the first Escape
  // over an open menu closes the user's whole task window. Gated on `open`, so
  // a plain Escape still reaches the dialog when no menu is showing.
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="relative flex-shrink-0" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className={triggerClassName ?? DEFAULT_TRIGGER_CLASS}
        title={title}
        aria-expanded={open}
        data-testid={triggerTestId}
      >
        {icon ?? <MoreHorizontal size={16} />}
      </button>
      <OverlayPopover
        open={open}
        popoverRef={popoverRef}
        style={style}
        portal
        role="menu"
        className="fixed min-w-[170px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-[2147483646] py-1"
        data-testid={menuTestId}
      >
        {children(close)}
      </OverlayPopover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable menu item primitives
// ---------------------------------------------------------------------------

const ITEM_CLASS = 'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-fg-tertiary hover:bg-surface-hover hover:text-fg';
const DESTRUCTIVE_CLASS = 'w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-red-400 hover:bg-red-400/10 hover:text-red-300';

interface MenuItemProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  'data-testid'?: string;
}

export function KebabMenuItem({ icon, label, onClick, destructive, disabled, ...rest }: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${destructive ? DESTRUCTIVE_CLASS : ITEM_CLASS}${disabled ? ' opacity-50' : ''}`}
      {...rest}
    >
      {icon}
      {label}
    </button>
  );
}

export function KebabMenuDivider() {
  return <div className="my-1 mx-2 border-t border-edge-input/50" />;
}

interface MenuCheckItemProps {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Shown as the item's tooltip - use it to explain a disabled state. */
  title?: string;
  'data-testid'?: string;
}

/**
 * A checkable menu row: a persistent VIEW OPTION rather than a one-shot action.
 * Exists so preference toggles can live behind one labelled menu instead of a
 * row of icon-only buttons nobody can read without hovering (the pattern VS
 * Code's diff `...` menu and GitHub's diff settings both use). The checkmark
 * column is always reserved so labels align whether or not they are checked.
 */
export function KebabMenuCheckItem({ label, checked, onChange, disabled, title, ...rest }: MenuCheckItemProps) {
  return (
    <button
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      title={title}
      className={`${ITEM_CLASS}${disabled ? ' opacity-50 cursor-default hover:bg-transparent hover:text-fg-tertiary' : ''}`}
      {...rest}
    >
      <span className="flex w-3.5 flex-shrink-0 items-center justify-center">
        {checked && <Check size={12} className="text-accent" />}
      </span>
      {label}
    </button>
  );
}
