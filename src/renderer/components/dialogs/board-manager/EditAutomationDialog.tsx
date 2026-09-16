import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Zap } from 'lucide-react';
import { AUTOMATION_MANIFEST, EXIT_GROUP_BUDGET_MS, stableAutomationTypes } from '../../../../shared/automation-manifest';
import type { AutomationField } from '../../../../shared/automation-manifest';
import type { AutomationTrigger, AutomationType, Swimlane } from '../../../../shared/types';
import { BaseDialog, DialogFooterActions } from '../BaseDialog';
import { Select } from '../../settings/shared';
import { FIELD_CONTROL_CLASS } from '../../Field';
import { SETTING_DESCRIPTION_CLASS, SETTING_LABEL_CLASS } from '../../SettingText';
import { SegmentedControl, type SegmentedControlOption } from '../../SegmentedControl';
import { AutomationTypePicker } from './AutomationTypePicker';
import { TemplateTextField, type TemplateTextFieldInsert } from '../../TemplateTextField';
import {
  findNameConflict,
  formatHeaderLines,
  parseHeaderLines,
  spliceAtRange,
  type AutomationDraft,
} from './automation-drafts';

/**
 * The ONE place an automation is edited: name, type, the type's own fields, and
 * when it runs. Nothing else.
 *
 * Everything type-specific is rendered from the manifest, so a new automation
 * type needs no change here at all.
 */

/**
 * The types that can outlast the exit budget, and so are worth warning about.
 *
 * A notify is instant and a message is bounded by the scheduler's own ladder, so
 * neither of those can meaningfully hit the cap. Naming the two that can keeps
 * the line off three quarters of the rows that would never see it fire.
 */
const SLOW_TYPES = new Set<AutomationType>(['run_script', 'webhook']);

/**
 * Module scope, not an inline literal: `SegmentedControl` keys its measuring
 * effect on `options`, and this dialog re-renders on every keystroke in Name or
 * any text field, so a fresh array per render would tear down and rebuild the
 * control's ResizeObserver (and force a synchronous layout read) per character.
 */
const TRIGGER_OPTIONS: SegmentedControlOption<AutomationTrigger>[] = [
  { value: 'enter', label: 'On enter', testId: 'edit-automation-trigger-enter' },
  { value: 'exit', label: 'On exit', testId: 'edit-automation-trigger-exit' },
];

/**
 * The exit-only variant To Do and Done need, cached by REASON so the same
 * array instance comes back for the same column kind. Mirrors
 * `WorktreePlacementControl`'s `blockedOptionsFor`, and for the same reason:
 * a fresh array would defeat the memo above.
 */
const blockedTriggerOptions = new Map<string, SegmentedControlOption<AutomationTrigger>[]>();
function triggerOptionsFor(column: Swimlane): SegmentedControlOption<AutomationTrigger>[] {
  if (column.role !== 'todo' && column.role !== 'done') return TRIGGER_OPTIONS;
  const reason = `Nothing runs when a task enters ${column.name}.`;
  const cached = blockedTriggerOptions.get(reason);
  if (cached) return cached;
  const built: SegmentedControlOption<AutomationTrigger>[] = [
    { ...TRIGGER_OPTIONS[0], disabled: true, title: reason },
    TRIGGER_OPTIONS[1],
  ];
  blockedTriggerOptions.set(reason, built);
  return built;
}

/** Moved verbatim from BoardManagerDialog, where it carried the same comment. */
const AUTO_COMMAND_MODE_OPTIONS: SegmentedControlOption<string>[] = [
  { value: 'immediate', label: 'Run immediately', icon: <Zap size={14} />, testId: 'auto-command-mode-immediate' },
  { value: 'deferred', label: 'Wait for current turn', icon: <Clock size={14} />, testId: 'auto-command-mode-deferred' },
];

export interface EditAutomationDialogProps {
  draft: AutomationDraft;
  column: Swimlane;
  isNew: boolean;
  /** The column's other rows, for the uniqueness check. */
  takenNames: string[];
  /** The template-variable inserter, passed as a render prop so it stays in one place. */
  templatePicker: (onInsert: (variable: string) => void) => React.ReactNode;
  onDone: (draft: AutomationDraft) => void;
  onCancel: () => void;
}

export function EditAutomationDialog(props: EditAutomationDialogProps) {
  // A LOCAL copy: Done applies it to the board draft, Cancel discards it. That
  // is what makes the dialog safe to experiment in.
  const [local, setLocal] = useState<AutomationDraft>(props.draft);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const entry = AUTOMATION_MANIFEST[local.type];
  const conflict = findNameConflict(
    props.takenNames.map((name, index) => ({ id: `taken:${index}`, name } as AutomationDraft)),
    local.name,
  );
  const nameEmpty = local.name.trim() === '';
  const blocked = nameEmpty || conflict !== null;

  const triggerOptions = useMemo(() => triggerOptionsFor(props.column), [props.column]);

  const setConfigValue = (key: string, value: unknown): void => {
    setLocal((current) => ({ ...current, config: { ...current.config, [key]: value } }));
  };

  // Mount only, and deliberately not on every focus: a new row arrives named
  // "New run script", which is a placeholder rather than a choice, so the first
  // keystroke should replace it. Re-selecting whenever the field regains focus
  // would eat what the user had already typed on the way back from the Script
  // box.
  useEffect(() => {
    if (props.isNew) nameRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only, see above
  }, []);


  return (
    <BaseDialog
      onClose={props.onCancel}
      testId="edit-automation-dialog"
      // The picker adds the row and opens this dialog on it, so a fresh
      // automation arrived at a window titled "Edit automation" for something
      // that did not exist a moment ago. `isNew` already distinguishes the two
      // (it selects the generated name for overtyping); the title now says so.
      title={props.isNew ? 'Add automation' : 'Edit automation'}
      className="w-[640px]"
      // The standard footer slot, not a `<footer>` among the children. As a
      // child it sat INSIDE the body's own padding, so it carried the body
      // inset plus its own and sat lower than every other dialog's footer.
      footer={
        <DialogFooterActions
          onCancel={props.onCancel}
          onConfirm={() => props.onDone(local)}
          confirmLabel="Done"
          confirmDisabled={blocked}
          cancelTestId="edit-automation-cancel"
          confirmTestId="edit-automation-done"
        />
      }
    >
      {/* No padding of its own. `BaseDialog` already wraps children in
          `px-4 py-4`, so the `px-5 py-4` this used to add landed on top of it
          and inset the body 36px against the header's 16px. */}
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className={SETTING_LABEL_CLASS}>Name</span>
          <input
            ref={nameRef}
            autoFocus
            data-testid="edit-automation-name"
            value={local.name}
            aria-invalid={conflict !== null}
            onChange={(event) => setLocal((current) => ({ ...current, name: event.target.value }))}
            className={`${FIELD_CONTROL_CLASS} ${conflict ? 'border-warning' : ''}`}
          />
          {conflict && (
            // Short on purpose: the field is about 310px wide, and naming the
            // column as well wrapped this to two lines.
            <span data-testid="edit-automation-name-error" className="text-[11px] text-warning">
              Already used on this column.
            </span>
          )}
        </label>

        {/* A <div>, not a <label>: the control is a button, and a label
            wrapping one steals its click. */}
        <div className="flex flex-col gap-1">
          <span className={SETTING_LABEL_CLASS}>Type</span>
          {/* Carries each type's icon, which a native <select> cannot: an
              <option> holds text only. The row and the Add automation menu both
              show the glyph, so the one place the type is CHOSEN was the only
              place without it. */}
          <AutomationTypePicker
            testId="edit-automation-type"
            ariaLabel="Type"
            value={local.type}
            // Just the offerable set. The picker lists the current value too,
            // which is what keeps a legacy row's type readable.
            options={stableAutomationTypes()}
            onChange={(type) => setLocal((current) => ({ ...current, type }))}
          />
        </div>

        {/* A hidden field is declared so its value round-trips through a save,
            not so the dialog offers it. See `AutomationField.hidden`. */}
        {entry.fields.filter((field) => !field.hidden).map((field) => (
          <ManifestField
            key={field.key}
            field={field}
            value={(local.config as Record<string, unknown>)[field.key]}
            onChange={(value) => setConfigValue(field.key, value)}
            templatePicker={props.templatePicker}
          />
        ))}

        <div className="flex flex-col gap-1">
          <span className={SETTING_LABEL_CLASS}>When</span>
          {/* `self-start` because this wrapper is a flex COLUMN. A flex item is
              blockified, so the control's own `inline-flex` stops sizing to its
              options and `align-items: stretch` runs it the full width of the
              dialog, which is not a shape a two-option control has any use for.
              `SettingField` avoids this by wrapping children in a plain block,
              which is why the same control hugs its content in the Column
              Manager's Conversation card. */}
          <SegmentedControl
            quiet
            className="self-start"
            ariaLabel="When"
            testId="edit-automation-trigger"
            options={triggerOptions}
            value={local.trigger}
            onChange={(trigger) => setLocal((current) => ({ ...current, trigger }))}
          />
          {/* Shown only on exit, and only for a type that can actually take a
              while. The cap is real and nothing else says it: an exit group
              shares EXIT_GROUP_BUDGET_MS in aggregate whatever the adapters
              declare, so a script written for the five minutes its own default
              allows is killed at sixty seconds and the rows behind it are
              skipped. Learning that at runtime, from a run log, is learning it
              too late. This passes the essential-and-non-obvious bar the other
              hints in this dialog are held to: it changes what you build. */}
          {local.trigger === 'exit' && SLOW_TYPES.has(local.type) && (
            <p data-testid="edit-automation-exit-budget" className={SETTING_DESCRIPTION_CLASS}>
              {`On exit, this column's automations share ${Math.round(EXIT_GROUP_BUDGET_MS / 1000)} seconds in total. Put longer work on enter.`}
            </p>
          )}
        </div>
      </div>

    </BaseDialog>
  );
}

/** One field, rendered from its manifest declaration. No type branching. */
function ManifestField({ field, value, onChange, templatePicker }: {
  field: AutomationField;
  value: unknown;
  onChange: (value: unknown) => void;
  templatePicker: EditAutomationDialogProps['templatePicker'];
}) {
  const text = typeof value === 'string' ? value : '';
  const testId = `automation-config-${field.key}`;
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  // A highlighted textarea owns its own caret, so the picker button routes
  // through the field rather than through `inputRef`. Only the plain `text`
  // inputs still use `inputRef`, which is why both survive.
  const templateInsertRef = useRef<TemplateTextFieldInsert | null>(null);
  const highlighted = field.kind === 'textarea' && Boolean(field.templateVariables);

  /**
   * Insert at the CARET, not at the end.
   *
   * The rAF is load-bearing, and it is the same one the shipped message field
   * carried: `onChange` re-renders the controlled input, and setting the
   * selection before that paint lands puts the caret back at the end of the old
   * value.
   */
  const insertAtCaret = (variable: string): void => {
    if (highlighted) {
      templateInsertRef.current?.(variable);
      return;
    }
    const node = inputRef.current;
    if (!node) {
      onChange(text + variable);
      return;
    }
    const { text: next, cursor } = spliceAtRange(
      text,
      node.selectionStart ?? text.length,
      node.selectionEnd ?? text.length,
      variable,
    );
    onChange(next);
    window.requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className={SETTING_LABEL_CLASS}>{field.label}</span>
        {field.templateVariables && templatePicker(insertAtCaret)}
      </div>

      {field.kind === 'textarea' && highlighted && (
        <TemplateTextField
          value={text}
          onChange={onChange}
          // Every automation runs on a move, so this is the catalog that can
          // actually resolve here. A spawn prompt would pass 'spawn'.
          context="automation"
          testId={testId}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          ariaLabel={field.label}
          insertRef={templateInsertRef}
        />
      )}

      {field.kind === 'textarea' && !highlighted && (
        <textarea
          ref={(node) => { inputRef.current = node; }}
          data-testid={testId}
          value={text}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="w-full resize-y rounded border border-edge-input bg-surface-control px-3 py-1.5 text-sm text-fg-tertiary placeholder-fg-muted focus:border-accent focus:outline-none"
        />
      )}

      {field.kind === 'text' && (
        <input
          ref={(node) => { inputRef.current = node; }}
          data-testid={testId}
          value={text}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={FIELD_CONTROL_CLASS}
        />
      )}

      {field.kind === 'number' && (
        // The input takes its content width rather than the row's, so the unit
        // sits against the number instead of a box-width away from it.
        <div className="flex items-center gap-2">
          <div className="w-24">
            <input
              type="number"
              data-testid={testId}
              value={typeof value === 'number' ? value : (field.defaultValue as number ?? '')}
              min={field.min}
              max={field.max}
              onChange={(event) => onChange(Number(event.target.value))}
              className={FIELD_CONTROL_CLASS}
            />
          </div>
          {field.unit && <span className={SETTING_DESCRIPTION_CLASS}>{field.unit}</span>}
        </div>
      )}

      {field.kind === 'select' && (
        <Select
          data-testid={testId}
          value={text || String(field.defaultValue ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      )}

      {field.kind === 'segmented' && (
        <SegmentedControl
          quiet
          // Sizes to its options rather than stretching. See the When field.
          className="self-start"
          ariaLabel={field.label}
          testId={testId}
          // The mode options are module scope for the same ResizeObserver
          // reason as the trigger options above.
          options={field.key === 'mode' ? AUTO_COMMAND_MODE_OPTIONS : (field.options ?? []).map((option) => ({
            value: option.value,
            label: option.label,
            testId: option.testId,
          }))}
          value={text || String(field.defaultValue ?? '')}
          onChange={(next) => onChange(next)}
        />
      )}

      {field.kind === 'headers' && (
        <textarea
          data-testid={testId}
          rows={2}
          value={formatHeaderLines(value as Record<string, string> | undefined)}
          onChange={(event) => onChange(parseHeaderLines(event.target.value))}
          className="w-full resize-y rounded border border-edge-input bg-surface-control px-3 py-1.5 font-mono text-xs text-fg-tertiary placeholder-fg-muted focus:border-accent focus:outline-none"
        />
      )}

      {field.hint && <span className="text-[11px] text-fg-faint">{field.hint}</span>}
    </div>
  );
}
