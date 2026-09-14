import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationTrigger, AutomationType, Swimlane } from '../../../../shared/types';
import { OverlayPopover } from '../../OverlayPopover';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { automationIcon } from './automation-icons';
import { TRIGGER_LABELS, describeDraft, pickerTypes, type AutomationDraft } from './automation-drafts';

/**
 * The one way to add an automation: a picker with two groups.
 *
 * "New automation" offers every stable type, with one the column cannot run
 * shown as a DISABLED option whose own description line says why, rather than
 * hidden. Hiding it would leave the user hunting for a type they know exists.
 *
 * "Copy existing" is how a row moves between columns, because an automation
 * belongs to exactly one column. It was "Copy from another column", which spent
 * four words on something each row already prints for itself ("Planning, on
 * exit"), and read long beside the two-word group above it.
 *
 * It carried a note, "A copy is independent of the original.", and that is
 * gone. "Copy" already means an independent thing everywhere else in software,
 * so the line answered a question nobody asks, on every open, to be learned
 * once - the standing-copy test in `ui-conventions.md`.
 */

export interface AddAutomationPickerProps {
  anchor: HTMLElement;
  column: Swimlane;
  trigger: AutomationTrigger;
  /** Every other column's rows, for the copy group. */
  otherColumns: Array<{ column: Swimlane; drafts: AutomationDraft[] }>;
  onPickType: (type: AutomationType) => void;
  onPickCopy: (source: AutomationDraft) => void;
  onClose: () => void;
}

export function AddAutomationPicker(props: AddAutomationPickerProps) {
  const [filter, setFilter] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement>(props.anchor);
  anchorRef.current = props.anchor;

  const { style, placement } = usePopoverPosition(anchorRef, menuRef, true, {
    mode: 'dropdown',
    strategy: 'fixed',
    // LEFT-aligned, not the default `'auto'`. Auto anchors the edge nearest the
    // viewport edge, which is the right thing for a small trigger like a kebab
    // but wrong for this one: "Add automation" is a full-width dashed control,
    // so right-aligning hung the menu off its far corner, nowhere near where
    // the pointer actually was, and floated it over the rows above. Aligning to
    // the control's left edge makes it read as belonging to the control.
    preferRight: false,
  });

  // Click outside to dismiss. This menu had ESCAPE only, so a click anywhere
  // else left it open over the board and the user had to find the keyboard to
  // be rid of it.
  //
  // Both refs are checked, because the menu is PORTALED out of the anchor's
  // subtree: a click inside it reads as "outside" to a container-only test, so
  // choosing an option would close the menu before the option's own click ran.
  // That is the exact trap `popover-escapes-clipping.md` records for every
  // portaled menu. The ANCHOR is excluded too, since its own handler owns the
  // open state; closing here would just let its click reopen the menu.
  //
  // Capture phase, so it runs before anything inside the board manager can stop
  // the event on its way up.
  const onClose = props.onClose;
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [onClose]);

  const needle = filter.trim().toLowerCase();
  const matches = (text: string): boolean => !needle || text.toLowerCase().includes(needle);

  const types = useMemo(
    () => pickerTypes(props.column, props.trigger).filter((entry) => matches(AUTOMATION_MANIFEST[entry.type].label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `matches` closes over `needle`, which is the real dependency
    [props.column, props.trigger, needle],
  );

  const copies = useMemo(
    () => props.otherColumns.flatMap(({ column, drafts }) =>
      drafts
        .filter((draft) => matches(draft.name) || matches(column.name))
        .map((draft) => ({ column, draft }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same
    [props.otherColumns, needle],
  );

  return (
    <OverlayPopover
      open
      popoverRef={menuRef}
      style={style}
      portal
      transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
      // 26rem, not the old `w-80` (20rem). Every type's one-line description
      // wrapped to two at that width ("Sends an HTTP request. Retries a network
      // error or a 5xx." is the longest), which made a four-item list read as a
      // wall of text and pushed the copy-from-another-column group below the
      // fold. The descriptions are written to one line, so the menu is sized to
      // hold one line.
      className="fixed z-[2147483646] w-[26rem] max-h-96 overflow-y-auto rounded-lg border border-edge bg-surface-raised shadow-xl"
      data-testid="column-automation-picker"
    >
      <div className="sticky top-0 border-b border-edge/60 bg-surface-raised p-2">
        <input
          autoFocus
          data-testid="column-automation-picker-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search automations"
          // Capture + stop, so Escape closes the picker without also reaching
          // the dialog's own Escape listener and closing Board setup.
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }}
          className="w-full rounded border border-edge-input bg-surface-control px-2 py-1 text-xs text-fg-tertiary placeholder-fg-muted focus:border-accent focus:outline-none"
        />
      </div>

      <PickerGroup label="New automation">
        {types.map(({ type, runnable }) => {
          const entry = AUTOMATION_MANIFEST[type];
          const TypeIcon = automationIcon(entry.icon);
          return (
            <button
              key={type}
              type="button"
              data-testid="column-automation-picker-type"
              data-type={type}
              aria-disabled={!runnable.ok}
              // A disabled button fires no mouse events, so the tooltip lives on
              // a wrapper rather than here.
              onClick={runnable.ok ? () => props.onPickType(type) : undefined}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left ${runnable.ok ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-not-allowed opacity-55'}`}
            >
              <TypeIcon size={14} className="mt-0.5 shrink-0 text-fg-muted" />
              <span className="min-w-0">
                <span className="block text-xs text-fg">{entry.label}</span>
                <span className="block text-[11px] text-fg-faint">
                  {runnable.ok ? entry.description : runnable.reason}
                </span>
              </span>
            </button>
          );
        })}
      </PickerGroup>

      {copies.length > 0 && (
        <PickerGroup label="Copy existing">
          {copies.map(({ column, draft }) => {
            // A copy row IS an automation of a known type, so it carries the
            // same glyph as the New automation rows above, the row in the list,
            // and the Type field. This group was the last place the type was
            // identified by its sentence alone.
            const CopyIcon = automationIcon(AUTOMATION_MANIFEST[draft.type].icon);
            return (
            <button
              key={`${column.id}:${draft.id}`}
              type="button"
              data-testid="column-automation-picker-copy"
              data-name={draft.name}
              data-type={draft.type}
              data-column-id={column.id}
              onClick={() => props.onPickCopy(draft)}
              className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-surface-hover"
            >
              <CopyIcon size={14} className="mt-0.5 shrink-0 text-fg-muted" />
              <span className="min-w-0">
                <span className="block truncate text-xs text-fg">{draft.name}</span>
                <span className="block truncate text-[11px] text-fg-faint">{describeDraft(draft)}</span>
                <span className="block text-[11px] text-fg-muted">
                  {column.name}, {TRIGGER_LABELS[draft.trigger].toLowerCase()}
                </span>
              </span>
            </button>
            );
          })}
        </PickerGroup>
      )}

      {types.length === 0 && copies.length === 0 && (
        <p className="px-3 py-3 text-xs text-fg-faint">Nothing matches that.</p>
      )}
    </OverlayPopover>
  );
}

function PickerGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-edge/40 py-1 last:border-b-0">
      <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">{label}</p>
      {children}
    </div>
  );
}
