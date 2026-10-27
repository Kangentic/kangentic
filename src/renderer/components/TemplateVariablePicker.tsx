import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { OverlayPopover } from './OverlayPopover';
import { Tooltip } from './Tooltip';
import { usePopoverPosition } from '../hooks/usePopoverPosition';
import { templateVarsFor, type TaskTemplateContextName } from '../../shared/task-template-vars';
import { translateText } from '../i18n/translate';

/**
 * The "Template variable" inserter that sits under a field taking template
 * variables: the Edit automation dialog's fields, and Settings' Workflow agent
 * prompt.
 *
 * This replaced a row of ten always-on `{{chip}}` buttons. Ten monospace tokens
 * are a wall of syntax the user has to read past to reach the field they
 * actually came for, and their names alone do not say what they resolve to -
 * `{{task_xml}}` and `{{description}}` are not self-explanatory. One pill opens
 * a list that can afford to carry each variable's meaning.
 *
 * It lists one context of the shared catalog (`templateVarsFor`), so a field is
 * never offered a variable that cannot resolve where it is used.
 *
 * Portal + `strategy: 'fixed'` is not optional: the board manager's detail form
 * and the settings panel are scroll containers, so an in-flow menu is clipped to
 * them (see `.claude/rules/popover-escapes-clipping.md`). The outside-click
 * handler checks BOTH refs for the same reason - once portaled, a click inside
 * the menu is "outside" the trigger's subtree.
 */
export function TemplateVariablePicker({ onInsert, context, testId = 'template-variable' }: {
  onInsert: (variable: string) => void;
  context: TaskTemplateContextName;
  /** The trigger is `<testId>-trigger` and the menu `<testId>-menu`. */
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const variables = useMemo(() => templateVarsFor(context), [context]);

  const { style } = usePopoverPosition(
    buttonRef as React.RefObject<HTMLElement>,
    menuRef as React.RefObject<HTMLElement>,
    open,
    { mode: 'dropdown', strategy: 'fixed' },
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        data-testid={`${testId}-trigger`}
        className="inline-flex cursor-pointer items-center gap-1 rounded border border-edge/40 bg-surface-control/40 px-2 py-1 text-xs text-fg-muted transition-colors hover:border-edge hover:text-fg focus:outline-none focus-visible:border-accent"
      >
        <Plus size={13} />
        Template variable
      </button>

      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        className="fixed z-[2147483646] w-80 overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
        data-testid={`${testId}-menu`}
      >
        <div className="max-h-72 overflow-y-auto py-1">
          {variables.map((templateVar) => (
            <button
              key={templateVar.name}
              type="button"
              onClick={() => {
                onInsert(templateVar.chip);
                setOpen(false);
              }}
              className="flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover"
            >
              <span className="font-mono text-xs text-fg">{templateVar.chip}</span>
              {/* Clamped: a couple of these descriptions are written for the docs
                  tables and run long. The full text stays available on hover. */}
              <Tooltip label={translateText(templateVar.description)}>
                <span className="line-clamp-1 text-[11px] text-fg-faint">
                  {translateText(templateVar.description)}
                </span>
              </Tooltip>
              {/* Shown only where empty is the NORMAL state, not merely a
                  possible one, so it stays a warning rather than noise. */}
              {templateVar.availability && (
                <span className="text-[11px] text-fg-muted">{translateText(templateVar.availability)}</span>
              )}
            </button>
          ))}
        </div>
      </OverlayPopover>
    </>
  );
}
